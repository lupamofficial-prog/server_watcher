import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, nextPairState, PairState } from '../backend/engine/state';
import { isBlockedHostname, isBlockedIp } from '../shared/ssrf';
import { makeToken, parseToken, signRequest } from '../shared/signing';

const p = (region: string, probeOnline: boolean, state: 'UP' | 'DOWN' | 'DEGRADED' | 'UNKNOWN') => ({ region, probeOnline, state });

test('state machine: UP -> DEGRADED -> DOWN -> DEGRADED -> UP', () => {
  let s: PairState = { state: 'UNKNOWN', failStreak: 0, okStreak: 0 };
  const run = (ok: boolean) => (s = nextPairState(s, ok, 3, 2)).state;
  assert.equal(run(true), 'UP');
  assert.equal(run(false), 'DEGRADED'); // one failed check never alerts
  assert.equal(run(false), 'DEGRADED');
  assert.equal(run(false), 'DOWN'); // failureThreshold = 3
  assert.equal(run(true), 'DEGRADED');
  assert.equal(run(true), 'UP'); // recoveryThreshold = 2
});

test('a single blip recovers without going DOWN', () => {
  let s: PairState = { state: 'UP', failStreak: 0, okStreak: 5 };
  s = nextPairState(s, false, 3, 2);
  assert.equal(s.state, 'DEGRADED');
  s = nextPairState(nextPairState(s, true, 3, 2), true, 3, 2);
  assert.equal(s.state, 'UP');
});

test('regional classification', () => {
  assert.equal(classify([p('RU', true, 'DOWN'), p('EU', true, 'UP')], ['RU', 'EU']).classification, 'RU_UNAVAILABLE');
  assert.equal(classify([p('RU', true, 'DOWN'), p('EU', true, 'DOWN')], ['RU', 'EU']).classification, 'GLOBAL_OUTAGE');
  assert.equal(classify([p('RU', true, 'UP'), p('EU', true, 'UP')], ['RU', 'EU']).classification, 'HEALTHY');
  assert.equal(classify([p('RU', true, 'UP'), p('EU', true, 'DOWN')], ['RU', 'EU']).classification, 'REGIONAL_OUTAGE');
});

test('offline RU probe never produces "DOWN in Russia"', () => {
  const a = classify([p('RU', false, 'DOWN'), p('EU', true, 'UP')], ['RU', 'EU']);
  assert.equal(a.status, 'UNKNOWN');
  assert.equal(a.classification, 'PROBE_UNAVAILABLE');
});

test('SSRF guard', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '100.64.0.1']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ['1.1.1.1', '104.16.0.1', '2606:4700::1111']) assert.equal(isBlockedIp(ip), false, ip);
  for (const h of ['localhost', 'foo.internal', 'metadata.google.internal', '169.254.169.254', '10.1.1.1']) assert.equal(isBlockedHostname(h), true, h);
  assert.equal(isBlockedHostname('cdn.example.com'), false);
});

test('signing: token round trip and signature binds method/path/body', () => {
  const token = makeToken('m'.repeat(32), 'abcdefghij1234', 3);
  const t = parseToken(token)!;
  assert.equal(t.probeId, 'abcdefghij1234');
  assert.equal(t.version, 3);
  const base = { ts: '1', nonce: 'n', method: 'POST', path: '/a', body: '{}' };
  const sig = signRequest(t.secret, base);
  assert.notEqual(sig, signRequest(t.secret, { ...base, body: '{"x":1}' }));
  assert.notEqual(sig, signRequest(t.secret, { ...base, path: '/b' }));
  assert.equal(parseToken('garbage'), null);
});

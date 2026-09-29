// HMAC request signing between Backend and Probe.
//
// * Each probe has its own secret = HMAC(PROBE_SIGNING_SECRET, "probe:<id>:<version>"); the backend never
//   stores it, the probe stores it inside its token: "<probeId>.<version>.<secret>".
// * Every request carries: X-Probe-Id, X-Probe-Key-Version, X-Timestamp, X-Nonce, X-Signature where
//   signature = HMAC(secret, "<ts>\n<nonce>\n<METHOD>\n<path>\n<sha256(body)>").
// * The backend rejects stale timestamps (>60s skew) and re-used nonces (replay protection).
// * Responses are signed too, bound to the request nonce, so a probe never executes forged jobs.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from './util';

export const MAX_SKEW_MS = 60_000;

export function deriveProbeSecret(master: string, probeId: string, version: number): string {
  return createHmac('sha256', master).update(`probe:${probeId}:${version}`).digest('hex');
}

export function makeToken(master: string, probeId: string, version: number): string {
  return `${probeId}.${version}.${deriveProbeSecret(master, probeId, version)}`;
}

export function parseToken(token: string): { probeId: string; version: number; secret: string } | null {
  const m = /^([a-z0-9]{10,40})\.(\d{1,6})\.([a-f0-9]{64})$/.exec(token.trim());
  return m ? { probeId: m[1], version: Number(m[2]), secret: m[3] } : null;
}

export function signRequest(
  secret: string,
  p: { ts: string; nonce: string; method: string; path: string; body: string },
): string {
  return createHmac('sha256', secret)
    .update(`${p.ts}\n${p.nonce}\n${p.method.toUpperCase()}\n${p.path}\n${sha256Hex(p.body)}`)
    .digest('hex');
}

export function signResponse(secret: string, p: { ts: string; nonce: string; status: number; body: string }): string {
  return createHmac('sha256', secret)
    .update(`resp\n${p.ts}\n${p.nonce}\n${p.status}\n${sha256Hex(p.body)}`)
    .digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

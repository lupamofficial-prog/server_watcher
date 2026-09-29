import { Probe } from '@prisma/client';
import { MAX_SKEW_MS, deriveProbeSecret, safeEqualHex, signRequest } from '../shared/signing';
import { config } from './config';
import { prisma } from './db';

const NONCE_TTL_MS = MAX_SKEW_MS * 2 + 5000;
const seenNonces = new Map<string, number>(); // "probeId:nonce" -> expiry

setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of seenNonces) if (exp < now) seenNonces.delete(k);
}, 30_000).unref();

export class AuthError extends Error {
  constructor(message: string, public status = 401) {
    super(message);
  }
}

export interface AuthedProbe { probe: Probe; secret: string; ts: string; nonce: string }

export async function authenticateProbe(
  headers: Record<string, string | string[] | undefined>,
  method: string,
  path: string,
  rawBody: string,
): Promise<AuthedProbe> {
  const h = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const probeId = h('x-probe-id');
  const version = Number(h('x-probe-key-version'));
  const ts = h('x-timestamp');
  const nonce = h('x-nonce');
  const signature = h('x-signature');
  if (!probeId || !ts || !nonce || !signature || !Number.isInteger(version)) throw new AuthError('missing auth headers');
  if (!/^[a-f0-9]{16,64}$/.test(nonce)) throw new AuthError('bad nonce');

  const skew = Math.abs(Date.now() - Number(ts));
  if (!(skew <= MAX_SKEW_MS)) throw new AuthError('timestamp out of range: check the probe host clock');

  const probe = await prisma.probe.findUnique({ where: { id: probeId } });
  // Same error for unknown probe / wrong version / bad signature: don't leak which probes exist.
  if (!probe || !probe.enabled || probe.secretVersion !== version) throw new AuthError('invalid credentials');

  const secret = deriveProbeSecret(config.signingSecret, probe.id, probe.secretVersion);
  const expected = signRequest(secret, { ts, nonce, method, path, body: rawBody });
  if (!safeEqualHex(expected, signature)) throw new AuthError('invalid credentials');

  const key = `${probe.id}:${nonce}`;
  if (seenNonces.has(key)) throw new AuthError('replayed request');
  seenNonces.set(key, Date.now() + NONCE_TTL_MS);
  return { probe, secret, ts, nonce };
}

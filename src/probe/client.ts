import { randomBytes } from 'node:crypto';
import { API_PREFIX } from '../shared/contracts';
import { parseToken, safeEqualHex, signRequest, signResponse } from '../shared/signing';

export class BackendError extends Error {
  constructor(message: string, public readonly status?: number, public readonly fatal = false) {
    super(message);
  }
}

/** Signed HTTP client. The token never leaves the machine; only HMAC signatures do. */
export class BackendClient {
  private readonly secret: string;
  private readonly probeId: string;
  private readonly version: number;

  constructor(private readonly baseUrl: string, token: string) {
    const t = parseToken(token);
    if (!t) throw new Error('PROBE_TOKEN is malformed (expected "<id>.<version>.<secret>")');
    this.secret = t.secret;
    this.probeId = t.probeId;
    this.version = t.version;
  }

  async call<T>(path: string, body: unknown, timeoutMs = 15_000): Promise<T> {
    const fullPath = `${API_PREFIX}${path}`;
    const raw = JSON.stringify(body ?? {});
    const ts = String(Date.now());
    const nonce = randomBytes(16).toString('hex');
    const signature = signRequest(this.secret, { ts, nonce, method: 'POST', path: fullPath, body: raw });

    let res: Response;
    try {
      res = await fetch(this.baseUrl + fullPath, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-probe-id': this.probeId,
          'x-probe-key-version': String(this.version),
          'x-timestamp': ts,
          'x-nonce': nonce,
          'x-signature': signature,
        },
        body: raw,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new BackendError(`backend unreachable: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      let hint = '';
      try { hint = (JSON.parse(text) as { error?: string }).error ?? ''; } catch { /* ignore */ }
      throw new BackendError(`auth rejected (${res.status}) ${hint}`.trim(), res.status, true);
    }
    if (!res.ok) throw new BackendError(`backend HTTP ${res.status}`, res.status);
    const expected = signResponse(this.secret, { ts, nonce, status: res.status, body: text });
    if (!safeEqualHex(expected, res.headers.get('x-signature') ?? '')) {
      throw new BackendError('response signature mismatch (wrong PROBE_TOKEN/BACKEND_URL or tampering)', res.status, true);
    }
    return JSON.parse(text) as T;
  }
}

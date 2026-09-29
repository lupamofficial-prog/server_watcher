import { createHash } from 'node:crypto';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** Sleep that resolves early (returns true) when the signal aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(true); }, { once: true });
  });
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

import { readFileSync } from 'node:fs';
import http, { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createLogger } from '../../shared/logger';
import { API_PREFIX, HeartbeatRequest, HeartbeatResponse, PollResponse, parseResultPayload } from '../../shared/contracts';
import { signResponse } from '../../shared/signing';
import { config } from '../config';
import { prisma } from '../db';
import { AuthError, AuthedProbe, authenticateProbe } from '../probeAuth';
import { probeWake } from '../engine/bus';
import { claimJobs } from '../engine/jobs';
import { onHeartbeat } from '../engine/probes';
import { recordResult } from '../engine/evaluator';

const log = createLogger('http');
const MAX_BODY = 256 * 1024;
export const health = { schedulerTickAt: Date.now() };

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// crude brute-force guard for failed authentication attempts
const failures = new Map<string, { n: number; reset: number }>();
function tooManyFailures(ip: string): boolean {
  const f = failures.get(ip);
  return !!f && f.reset > Date.now() && f.n >= 30;
}
function noteFailure(ip: string) {
  const f = failures.get(ip);
  if (!f || f.reset < Date.now()) failures.set(ip, { n: 1, reset: Date.now() + 60_000 });
  else f.n++;
}

function send(res: ServerResponse, status: number, body: string, type = 'application/json', extra: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

function waitForWake(probeId: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); probeWake.off(probeId, done); resolve(); };
    const t = setTimeout(done, ms);
    probeWake.once(probeId, done);
  });
}

async function handleProbeApi(auth: AuthedProbe, endpoint: string, body: unknown, ip: string | undefined, closed: () => boolean): Promise<unknown> {
  const { probe } = auth;
  switch (endpoint) {
    case '/heartbeat': {
      const hb = body as HeartbeatRequest;
      await onHeartbeat(probe, hb, ip);
      const out: HeartbeatResponse = {
        probe: { id: probe.id, name: probe.name, region: probe.region, countryCode: probe.countryCode, location: probe.location },
      };
      return out;
    }
    case '/poll': {
      const max = Number((body as { maxJobs?: number }).maxJobs) || 1;
      await prisma.probe.updateMany({ where: { id: probe.id, status: 'ONLINE' }, data: { lastSeenAt: new Date() } });
      const deadline = Date.now() + config.longPollMs;
      let jobs = await claimJobs(probe.id, max);
      while (!jobs.length && Date.now() < deadline && !closed()) {
        await waitForWake(probe.id, 1500);
        jobs = await claimJobs(probe.id, max);
      }
      const out: PollResponse = { jobs };
      return out;
    }
    case '/results': {
      const r = parseResultPayload(body);
      if (!r) throw new HttpError(400, 'malformed result');
      const job = await prisma.checkJob.findFirst({ where: { id: r.jobId, probeId: probe.id } });
      if (!job) throw new HttpError(404, 'unknown job');
      if (job.status === 'DONE' || job.status === 'EXPIRED') throw new HttpError(409, 'job is not active');
      await recordResult(probe, job, r);
      return { ok: true };
    }
    default:
      throw new HttpError(404, 'not found');
  }
}

function publicBase(req: IncomingMessage): string {
  if (config.publicUrl) return config.publicUrl;
  return `http://${req.headers.host ?? `localhost:${config.port}`}`;
}

function renderScript(req: IncomingMessage): string {
  const file = join(__dirname, '..', '..', '..', 'probe', 'install.sh');
  return readFileSync(file, 'utf8').replaceAll('__BACKEND_URL__', publicBase(req)).replaceAll('__PROBE_IMAGE__', config.probeImage);
}

export function startHttpServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress;
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        const stale = Date.now() - health.schedulerTickAt > 60_000;
        await prisma.$queryRaw`SELECT 1`;
        return send(res, stale ? 503 : 200, JSON.stringify({ ok: !stale, schedulerTickAgeMs: Date.now() - health.schedulerTickAt }));
      }
      if (req.method === 'GET' && url.pathname === '/install.sh') {
        return send(res, 200, renderScript(req), 'text/x-shellscript; charset=utf-8'); // contains no secrets
      }
      if (req.method === 'POST' && url.pathname.startsWith(API_PREFIX + '/')) {
        if (ip && tooManyFailures(ip)) throw new HttpError(429, 'too many failed attempts');
        const raw = await readBody(req);
        let auth: AuthedProbe;
        try {
          auth = await authenticateProbe(req.headers, 'POST', url.pathname, raw);
        } catch (e) {
          if (e instanceof AuthError && ip) noteFailure(ip);
          throw e;
        }
        let parsed: unknown;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'invalid json'); }
        let closed = false;
        req.on('close', () => { closed = true; });
        const result = await handleProbeApi(auth, url.pathname.slice(API_PREFIX.length), parsed, ip, () => closed);
        const out = JSON.stringify(result);
        return send(res, 200, out, 'application/json', {
          'x-signature': signResponse(auth.secret, { ts: auth.ts, nonce: auth.nonce, status: 200, body: out }),
        });
      }
      send(res, 404, JSON.stringify({ error: 'not found' }));
    } catch (e) {
      if (e instanceof AuthError) return send(res, e.status, JSON.stringify({ error: e.message }));
      if (e instanceof HttpError) return send(res, e.status, JSON.stringify({ error: e.message }));
      log.error('request_failed', { path: url.pathname, err: e });
      if (!res.headersSent) send(res, 500, JSON.stringify({ error: 'internal error' }));
    }
  });
  server.keepAliveTimeout = 65_000;
  server.listen(config.port, () => log.info('http_listening', { port: config.port }));
  return server;
}

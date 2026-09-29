import { hostname as osHostname } from 'node:os';
import { writeFileSync } from 'node:fs';
import { createLogger } from '../shared/logger';
import { abortableSleep, errMessage } from '../shared/util';
import type { HeartbeatResponse, PollResponse, ProbeJob, ResultPayload } from '../shared/contracts';
import { BackendClient, BackendError } from './client';
import { getStrategy } from './checks/registry';
import { emptyResult } from './checks/network';

const VERSION = '1.0.0';
const log = createLogger('probe');
const HEALTH_FILE = '/tmp/probe-ok';
const STATUS_FILE = '/tmp/probe-status.json';

const backendUrl = (process.env.BACKEND_URL ?? '').replace(/\/+$/, '');
const token = process.env.PROBE_TOKEN ?? '';
const maxConcurrency = Math.max(1, Number(process.env.PROBE_CONCURRENCY ?? 10));
if (!backendUrl || !token) {
  log.error('config_missing', { hint: 'BACKEND_URL and PROBE_TOKEN are required' });
  process.exit(1);
}

let client: BackendClient;
try {
  client = new BackendClient(backendUrl, token);
} catch (e) {
  log.error('config_invalid', { err: e });
  process.exit(1);
}

const stop = new AbortController();
const startedAt = Date.now();
let active = 0;
let identity: HeartbeatResponse['probe'] | null = null;
const unsent: Array<{ result: ResultPayload; at: number }> = []; // results waiting for the backend to come back

function markHealthy() {
  try {
    writeFileSync(HEALTH_FILE, String(Date.now()));
    writeFileSync(STATUS_FILE, JSON.stringify({ connected: true, probe: identity, at: new Date().toISOString() }));
  } catch { /* read-only fs is fine */ }
}

async function heartbeatLoop() {
  let backoff = 1000;
  while (!stop.signal.aborted) {
    try {
      const res = await client.call<HeartbeatResponse>('/heartbeat', {
        version: VERSION, hostname: osHostname(), uptimeSec: Math.round((Date.now() - startedAt) / 1000), activeJobs: active,
      });
      if (!identity) log.info('backend_connected', { probe: res.probe.name, region: res.probe.region });
      identity = res.probe;
      markHealthy();
      backoff = 1000;
      await flushUnsent();
      await abortableSleep(15_000, stop.signal);
    } catch (e) {
      log.warn('heartbeat_failed', { err: e });
      if (e instanceof BackendError && e.fatal) backoff = 60_000; // bad token/clock: don't hammer
      await abortableSleep(backoff + Math.random() * 500, stop.signal);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

async function submit(result: ResultPayload): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await client.call('/results', result);
      log.info('check_reported', { checkId: result.jobId, success: result.success });
      return true;
    } catch (e) {
      if (e instanceof BackendError && e.status === 409) return true; // job no longer active -> drop
      if (attempt === 3) log.warn('result_submit_failed', { checkId: result.jobId, err: e });
      else await abortableSleep(500 * attempt, stop.signal);
    }
  }
  return false;
}

async function flushUnsent() {
  const cutoff = Date.now() - 10 * 60_000;
  while (unsent.length) {
    const item = unsent[0];
    if (item.at < cutoff) { unsent.shift(); continue; }
    if (!(await submit(item.result))) return;
    unsent.shift();
  }
}

async function runJob(job: ProbeJob) {
  active++;
  log.info('check_started', { checkId: job.id, host: job.target.hostname, kind: job.kind });
  let result: ResultPayload;
  try {
    const strategy = getStrategy(job.target.checkType);
    if (!strategy) {
      result = emptyResult(job.id);
      result.errorType = 'UNSUPPORTED_CHECK';
      result.errorMessage = `unsupported check type ${job.target.checkType}`;
    } else {
      result = await strategy.run(job.id, job.target);
    }
  } catch (e) {
    result = emptyResult(job.id);
    result.errorType = 'PROBE_INTERNAL';
    result.errorMessage = errMessage(e);
    log.error('check_failed', { checkId: job.id, err: e });
  } finally {
    active--;
  }
  if (!(await submit(result))) {
    unsent.push({ result, at: Date.now() });
    if (unsent.length > 1000) unsent.shift();
  }
}

async function pollLoop() {
  let backoff = 1000;
  while (!stop.signal.aborted) {
    const capacity = maxConcurrency - active;
    if (capacity <= 0) { await abortableSleep(300, stop.signal); continue; }
    try {
      const res = await client.call<PollResponse>('/poll', { maxJobs: capacity }, 45_000);
      backoff = 1000;
      const now = Date.now();
      for (const job of res.jobs) {
        if (Date.parse(job.expiresAt) < now) continue; // too late, backend already gave up on it
        void runJob(job);
      }
    } catch (e) {
      log.warn('poll_failed', { err: e });
      await abortableSleep(backoff + Math.random() * 500, stop.signal);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info('shutdown', { signal: sig });
    stop.abort();
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
process.on('unhandledRejection', (e) => log.error('unhandled_rejection', { err: e }));

log.info('probe_starting', { version: VERSION, backend: backendUrl, concurrency: maxConcurrency });
void Promise.all([heartbeatLoop(), pollLoop()]).then(() => process.exit(0));

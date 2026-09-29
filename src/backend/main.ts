import { createLogger } from '../shared/logger';
import { errMessage, sleep } from '../shared/util';
import { config } from './config';
import { prisma } from './db';
import { createBot, runBot } from './bot';
import { evaluateTarget } from './engine/evaluator';
import { initIncidentManager, reconcileAll } from './engine/incidents';
import { expireStaleJobs, scheduleDueJobs } from './engine/jobs';
import { sweepOfflineProbes } from './engine/probes';
import { runRetention } from './engine/retention';
import { health, startHttpServer } from './http/server';
import { deliverPending, registerAdapter } from './notify/service';
import { TelegramAdapter } from './notify/telegram';

const log = createLogger('backend');
const stop = new AbortController();

/** Runs fn forever, never overlapping itself; errors (e.g. PostgreSQL restarting) are logged and retried. */
function every(name: string, intervalMs: number, fn: () => Promise<void>, initialDelayMs = 0) {
  void (async () => {
    await sleep(initialDelayMs);
    while (!stop.signal.aborted) {
      try {
        await fn();
      } catch (e) {
        log.error('loop_failed', { loop: name, err: e });
      }
      await sleep(intervalMs);
    }
  })();
}

async function main() {
  log.info('starting', { adminIds: config.adminIds.length, publicUrl: config.publicUrl || '(unset)' });
  const server = startHttpServer(); // up first so /healthz answers even while the DB is still coming up

  for (;;) { // wait for PostgreSQL (compose already gates on healthcheck; this covers later restarts too)
    try { await prisma.$queryRaw`SELECT 1`; break; } catch (e) { log.warn('waiting_for_database', { err: errMessage(e) }); await sleep(2000); }
  }

  const bot = createBot();
  registerAdapter(new TelegramAdapter(bot));
  initIncidentManager();

  // bootstrap: system state only (no demo data). Make sure every target has an aggregate state row.
  for (const t of await prisma.monitoringTarget.findMany({ select: { id: true } })) await evaluateTarget(t.id).catch(() => {});

  every('scheduler', 1000, async () => {
    await scheduleDueJobs();
    await expireStaleJobs();
    health.schedulerTickAt = Date.now();
  });
  every('probe-heartbeat-sweep', 10_000, sweepOfflineProbes, 5000);
  every('alert-delivery', 2000, deliverPending);
  every('incident-reconcile', 60_000, reconcileAll, 10_000);
  every('retention', 3_600_000, runRetention, 60_000);
  void runBot(bot, stop.signal);

  const shutdown = async (sig: string) => {
    log.info('shutdown', { signal: sig });
    stop.abort();
    server.close();
    setTimeout(() => process.exit(0), 3000).unref();
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (e) => log.error('unhandled_rejection', { err: e }));
main().catch((e) => { log.error('fatal', { err: e }); process.exit(1); });

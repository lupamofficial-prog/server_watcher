import { randomUUID } from 'node:crypto';
import { createLogger } from '../../shared/logger';
import type { ProbeJob } from '../../shared/contracts';
import { config } from '../config';
import { prisma } from '../db';
import { probeWake } from './bus';

const log = createLogger('scheduler');
const JOB_GRACE_MS = 30_000; // on top of the target timeout: covers poll latency + result upload

/**
 * Scheduler tick. Creates one PENDING job per due (probe,target) pair. Guarantees:
 *  - no overlapping checks: a partial unique index allows only one active SCHEDULED job per pair;
 *  - dedup / multi-instance safe: FOR UPDATE SKIP LOCKED + ON CONFLICT DO NOTHING;
 *  - probes that are offline or disabled and targets that are disabled are never scheduled.
 */
export async function scheduleDueJobs(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ probeId: string }>>`
    WITH due AS (
      SELECT pt."probeId", pt."targetId", t."timeoutMs", t."intervalSeconds"
      FROM "ProbeTarget" pt
      JOIN "MonitoringTarget" t ON t.id = pt."targetId" AND t.enabled
      JOIN "Probe" p ON p.id = pt."probeId" AND p.enabled AND p.status = 'ONLINE'
      WHERE pt."nextRunAt" <= now()
        AND NOT EXISTS (
          SELECT 1 FROM "CheckJob" j
          WHERE j."targetId" = pt."targetId" AND j."probeId" = pt."probeId"
            AND j.kind = 'SCHEDULED' AND j.status IN ('PENDING', 'RUNNING'))
      ORDER BY pt."nextRunAt"
      LIMIT 500
      FOR UPDATE OF pt SKIP LOCKED
    ), ins AS (
      INSERT INTO "CheckJob" (id, "targetId", "probeId", kind, status, "createdAt", "expiresAt")
      SELECT gen_random_uuid()::text, "targetId", "probeId", 'SCHEDULED', 'PENDING', now(),
             now() + (due."timeoutMs" + ${JOB_GRACE_MS}) * interval '1 millisecond'
      FROM due
      ON CONFLICT ("targetId", "probeId") WHERE kind = 'SCHEDULED' AND status IN ('PENDING', 'RUNNING') DO NOTHING
      RETURNING "targetId", "probeId", "expiresAt"
    )
    UPDATE "ProbeTarget" pt
    SET "nextRunAt" = ins."expiresAt" + interval '1 second'  -- safety net; real value is set when the result arrives
    FROM ins
    WHERE pt."targetId" = ins."targetId" AND pt."probeId" = ins."probeId"
    RETURNING pt."probeId"`;
  for (const id of new Set(rows.map((r) => r.probeId))) probeWake.emit(id);
  return rows.length;
}

/** Jobs a probe never answered (crash, network) are expired; the pair is rescheduled after one interval. */
export async function expireStaleJobs(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH exp AS (
      UPDATE "CheckJob" SET status = 'EXPIRED'
      WHERE status IN ('PENDING', 'RUNNING') AND "expiresAt" < now()
      RETURNING id, "targetId", "probeId", kind
    ), fix AS (
      UPDATE "ProbeTarget" pt
      SET "nextRunAt" = now() + t."intervalSeconds" * interval '1 second'
      FROM exp JOIN "MonitoringTarget" t ON t.id = exp."targetId"
      WHERE exp.kind = 'SCHEDULED' AND pt."targetId" = exp."targetId" AND pt."probeId" = exp."probeId"
      RETURNING pt."targetId"
    )
    SELECT id FROM exp`;
  if (rows.length) log.warn('CHECK_FAILED', { reason: 'job_expired_without_result', count: rows.length });
  return rows.length;
}

/** Called by the probe long-poll: atomically claims pending jobs for that probe. */
export async function claimJobs(probeId: string, max: number): Promise<ProbeJob[]> {
  const claimed = await prisma.$queryRaw<Array<{ id: string; targetId: string; kind: 'SCHEDULED' | 'MANUAL'; expiresAt: Date }>>`
    UPDATE "CheckJob" SET status = 'RUNNING', "claimedAt" = now()
    WHERE id IN (
      SELECT id FROM "CheckJob"
      WHERE "probeId" = ${probeId} AND status = 'PENDING' AND "expiresAt" > now()
      ORDER BY (kind = 'MANUAL') DESC, "createdAt"
      LIMIT ${Math.max(1, Math.min(max, 50))}
      FOR UPDATE SKIP LOCKED)
    RETURNING id, "targetId", kind, "expiresAt"`;
  if (!claimed.length) return [];
  const targets = await prisma.monitoringTarget.findMany({ where: { id: { in: [...new Set(claimed.map((c) => c.targetId))] } } });
  const byId = new Map(targets.map((t) => [t.id, t]));
  const jobs: ProbeJob[] = [];
  for (const c of claimed) {
    const t = byId.get(c.targetId);
    if (!t) continue;
    log.info('CHECK_STARTED', { checkId: c.id, target: t.name, probeId, kind: c.kind });
    jobs.push({
      id: c.id, kind: c.kind, expiresAt: c.expiresAt.toISOString(),
      target: {
        hostname: t.hostname, protocol: t.protocol === 'http' ? 'http' : 'https', port: t.port, path: t.path,
        expectedStatusCodes: t.expectedStatusCodes, timeoutMs: t.timeoutMs, certWarnDays: t.certWarnDays,
        allowPrivate: t.allowPrivate, checkType: t.checkType,
      },
    });
  }
  return jobs;
}

/** "Check now": one high-priority job per online probe of the target. Returns the batch id. */
export async function createManualBatch(targetId: string): Promise<{ batchId: string; probes: number }> {
  const target = await prisma.monitoringTarget.findUnique({ where: { id: targetId } });
  if (!target) throw new Error('target not found');
  const pairs = await prisma.probeTarget.findMany({ where: { targetId, probe: { enabled: true, status: 'ONLINE' } } });
  const batchId = randomUUID();
  const expiresAt = new Date(Date.now() + target.timeoutMs + JOB_GRACE_MS);
  await prisma.checkJob.createMany({
    data: pairs.map((p) => ({ targetId, probeId: p.probeId, kind: 'MANUAL' as const, batchId, expiresAt })),
  });
  for (const p of pairs) probeWake.emit(p.probeId);
  return { batchId, probes: pairs.length };
}

export async function waitForBatch(batchId: string, maxMs: number): Promise<{ done: boolean }> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const open = await prisma.checkJob.count({ where: { batchId, status: { in: ['PENDING', 'RUNNING'] } } });
    if (open === 0) return { done: true };
    await new Promise((r) => setTimeout(r, 400));
  }
  return { done: false };
}

export const longPollMs = config.longPollMs;

import { createLogger } from '../../shared/logger';
import { config } from '../config';
import { prisma } from '../db';

const log = createLogger('retention');

/**
 * Data lifecycle (all idempotent, runs hourly):
 *   raw CheckResult  --keep RAW_RETENTION_DAYS (7d)-->  deleted
 *   hourly aggregate --built from raw, keep HOURLY_RETENTION_DAYS (90d)-->  deleted
 *   daily aggregate  --built from hourly, kept long-term (a few bytes per target/probe/day)
 * Hours are re-aggregated only inside the raw window minus one day, so a partially deleted hour is never overwritten.
 */
export async function runRetention(): Promise<void> {
  const rawDays = config.rawRetentionDays;
  await prisma.$executeRaw`
    INSERT INTO "CheckAggregate" ("targetId","probeId",granularity,bucket,total,ok,"avgLatencyMs","maxLatencyMs")
    SELECT "targetId","probeId",'HOUR'::"Granularity", date_trunc('hour', "createdAt"),
           count(*)::int, (count(*) FILTER (WHERE success))::int,
           round(avg("totalLatencyMs") FILTER (WHERE success))::int, max("totalLatencyMs")
    FROM "CheckResult"
    WHERE kind = 'SCHEDULED'
      AND "createdAt" >= now() - make_interval(days => (${rawDays - 1})::int)
      AND "createdAt" < date_trunc('hour', now())
    GROUP BY 1,2,4
    ON CONFLICT ("targetId","probeId",granularity,bucket) DO UPDATE
      SET total = EXCLUDED.total, ok = EXCLUDED.ok, "avgLatencyMs" = EXCLUDED."avgLatencyMs", "maxLatencyMs" = EXCLUDED."maxLatencyMs"`;

  await prisma.$executeRaw`
    INSERT INTO "CheckAggregate" ("targetId","probeId",granularity,bucket,total,ok,"avgLatencyMs","maxLatencyMs")
    SELECT "targetId","probeId",'DAY'::"Granularity", date_trunc('day', bucket),
           sum(total)::int, sum(ok)::int,
           round(sum("avgLatencyMs"::numeric * ok) / NULLIF(sum(ok) FILTER (WHERE "avgLatencyMs" IS NOT NULL), 0))::int,
           max("maxLatencyMs")
    FROM "CheckAggregate"
    WHERE granularity = 'HOUR' AND bucket < date_trunc('day', now())
      AND bucket >= now() - make_interval(days => (${rawDays + 1})::int)
    GROUP BY 1,2,4
    ON CONFLICT ("targetId","probeId",granularity,bucket) DO UPDATE
      SET total = EXCLUDED.total, ok = EXCLUDED.ok, "avgLatencyMs" = EXCLUDED."avgLatencyMs", "maxLatencyMs" = EXCLUDED."maxLatencyMs"`;

  const rawCut = new Date(Date.now() - rawDays * 86_400_000);
  const hourCut = new Date(Date.now() - config.hourlyRetentionDays * 86_400_000);
  const dayAgo = new Date(Date.now() - 86_400_000);
  const [raw, hourly, jobs, alerts] = await Promise.all([
    prisma.checkResult.deleteMany({ where: { createdAt: { lt: rawCut } } }),
    prisma.checkAggregate.deleteMany({ where: { granularity: 'HOUR', bucket: { lt: hourCut } } }),
    prisma.checkJob.deleteMany({ where: { status: { in: ['DONE', 'EXPIRED'] }, createdAt: { lt: dayAgo } } }),
    prisma.alert.deleteMany({ where: { status: { in: ['SENT', 'FAILED'] }, createdAt: { lt: hourCut } } }),
  ]);
  log.info('retention_done', { rawDeleted: raw.count, hourlyDeleted: hourly.count, jobsDeleted: jobs.count, alertsDeleted: alerts.count });
}

import { CheckJob, Prisma, Probe } from '@prisma/client';
import { createLogger } from '../../shared/logger';
import { ResultPayload } from '../../shared/contracts';
import { prisma } from '../db';
import { bus } from './bus';
import { classify, nextPairState } from './state';
import { pairViews, describeReason, toRegionDetails } from './snapshot';
import { publish } from '../notify/service';

const log = createLogger('engine');

/** Persist a probe's result, advance the per-pair state machine and re-evaluate the target. */
export async function recordResult(probe: Probe, job: CheckJob, r: ResultPayload): Promise<void> {
  const target = await prisma.monitoringTarget.findUnique({ where: { id: job.targetId } });
  if (!target) return;
  const finished = new Date(Math.min(Date.parse(r.finishedAt) || Date.now(), Date.now()));

  await prisma.$transaction(async (tx) => {
    // Idempotent completion: only the first result for a RUNNING job wins.
    const claimed = await tx.checkJob.updateMany({
      where: { id: job.id, status: { in: ['RUNNING', 'PENDING'] } },
      data: { status: 'DONE', completedAt: new Date() },
    });
    if (claimed.count === 0) return;

    await tx.checkResult.create({
      data: {
        jobId: job.id, targetId: job.targetId, probeId: probe.id, kind: job.kind, createdAt: finished,
        success: r.success, failedStage: r.failedStage,
        dnsSuccess: r.dnsSuccess, dnsLatencyMs: r.dnsLatencyMs, tcpSuccess: r.tcpSuccess, tcpLatencyMs: r.tcpLatencyMs,
        tlsSuccess: r.tlsSuccess, tlsLatencyMs: r.tlsLatencyMs, httpSuccess: r.httpSuccess, httpStatus: r.httpStatus,
        httpLatencyMs: r.httpLatencyMs, totalLatencyMs: r.totalLatencyMs, resolvedIp: r.resolvedIp,
        tlsCertExpiresAt: r.tlsCertExpiresAt ? new Date(r.tlsCertExpiresAt) : null, tlsCertDaysLeft: r.tlsCertDaysLeft,
        errorType: r.errorType, errorMessage: r.errorMessage,
      },
    });

    // Manual "check now" results are shown to the admin but never move the state machine.
    if (job.kind !== 'SCHEDULED') return;
    const pair = await tx.probeTarget.findUnique({ where: { probeId_targetId: { probeId: probe.id, targetId: target.id } } });
    if (!pair) return;
    const next = nextPairState(pair, r.success, target.failureThreshold, target.recoveryThreshold);
    await tx.probeTarget.update({
      where: { probeId_targetId: { probeId: probe.id, targetId: target.id } },
      data: {
        ...next,
        stateSince: next.state !== pair.state ? new Date() : undefined,
        lastCheckAt: finished,
        nextRunAt: new Date(Date.now() + target.intervalSeconds * 1000),
        lastError: r.success ? null : `${r.errorType ?? 'FAILED'}: ${r.errorMessage ?? ''}`.slice(0, 300),
      },
    });
    if (next.state !== pair.state) {
      log.info('STATE_CHANGED', { scope: 'probe-target', targetId: target.id, probe: probe.name, from: pair.state, to: next.state, checkId: job.id });
    }
  });

  log.info('CHECK_COMPLETED', { checkId: job.id, target: target.name, probe: probe.name, success: r.success, ms: r.totalLatencyMs, err: r.errorType });

  if (job.kind === 'SCHEDULED') {
    if (r.success && r.tlsCertDaysLeft !== null && r.tlsCertDaysLeft <= target.certWarnDays) {
      const day = new Date().toISOString().slice(0, 10);
      await publish('CERT_EXPIRING', `cert:${target.id}:${day}`, {
        kind: 'CERT_EXPIRING', targetId: target.id, targetName: target.name, hostname: target.hostname,
        daysLeft: r.tlsCertDaysLeft, expiresAt: r.tlsCertExpiresAt ?? '', probeName: probe.name,
      });
    }
    await evaluateTarget(target.id);
  }
}

/** Recompute the cross-probe aggregate (status + classification) and emit an event. */
export async function evaluateTarget(targetId: string): Promise<void> {
  const target = await prisma.monitoringTarget.findUnique({ where: { id: targetId } });
  if (!target) return;
  const views = (await pairViews(targetId)).filter((v) => v.probe.enabled);
  const agg = classify(
    views.map((v) => ({ region: v.probe.region, probeOnline: v.probe.status === 'ONLINE', state: v.pair.state })),
    target.regions,
  );
  const reason = agg.status === 'DOWN' ? describeReason(views, agg.downRegions) : null;
  const regionStates = agg.regionStates as unknown as Prisma.InputJsonValue;

  const prev = await prisma.targetState.findUnique({ where: { targetId } });
  const changed = !prev || prev.status !== agg.status;
  await prisma.targetState.upsert({
    where: { targetId },
    create: { targetId, status: agg.status, classification: agg.classification, regionStates, reason },
    update: {
      status: agg.status, classification: agg.classification, regionStates, reason,
      ...(changed ? { since: new Date() } : {}),
    },
  });
  if (changed) log.info('STATE_CHANGED', { scope: 'target', target: target.name, from: prev?.status ?? 'NONE', to: agg.status, classification: agg.classification });
  bus.emitEvent('target.evaluated', targetId);
}

export async function evaluateAllForProbe(probeId: string) {
  const rows = await prisma.probeTarget.findMany({ where: { probeId }, select: { targetId: true } });
  for (const r of rows) await evaluateTarget(r.targetId);
}

export { toRegionDetails };

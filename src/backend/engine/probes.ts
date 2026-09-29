import { Probe } from '@prisma/client';
import { createLogger } from '../../shared/logger';
import type { HeartbeatRequest } from '../../shared/contracts';
import { config } from '../config';
import { prisma } from '../db';
import { publish } from '../notify/service';
import { evaluateAllForProbe } from './evaluator';

const log = createLogger('probes');

/** Heartbeat = liveness. Coming back from OFFLINE triggers a recovery alert and a re-evaluation. */
export async function onHeartbeat(probe: Probe, hb: HeartbeatRequest, ip: string | undefined): Promise<void> {
  const wasOffline = probe.status === 'OFFLINE';
  const first = probe.status === 'UNKNOWN';
  await prisma.probe.update({
    where: { id: probe.id },
    data: {
      lastSeenAt: new Date(), version: String(hb.version ?? '').slice(0, 32) || null, publicIp: ip?.slice(0, 64),
      ...(probe.status !== 'ONLINE' ? { status: 'ONLINE', statusSince: new Date() } : {}),
    },
  });
  if (first) log.info('PROBE_CONNECTED', { probe: probe.name, region: probe.region, version: hb.version });
  if (wasOffline) {
    const downSec = Math.round((Date.now() - probe.statusSince.getTime()) / 1000);
    log.info('PROBE_CONNECTED', { probe: probe.name, region: probe.region, afterOfflineSec: downSec });
    await publish('PROBE_RECOVERED', `probe-up:${probe.id}:${probe.statusSince.getTime()}`, {
      kind: 'PROBE_RECOVERED', probeName: probe.name, region: probe.region, downSec,
    });
  }
  if (wasOffline || first) {
    // its pairs become authoritative again; run everything right away instead of waiting for the interval
    await prisma.probeTarget.updateMany({ where: { probeId: probe.id }, data: { nextRunAt: new Date() } });
    await evaluateAllForProbe(probe.id);
  }
}

/** Marks probes with stale heartbeats OFFLINE. Their targets become UNKNOWN in that region (never "DOWN"). */
export async function sweepOfflineProbes(): Promise<void> {
  const cutoff = new Date(Date.now() - config.probeOfflineAfterSec * 1000);
  const stale = await prisma.probe.findMany({ where: { enabled: true, status: 'ONLINE', lastSeenAt: { lt: cutoff } } });
  for (const p of stale) {
    const res = await prisma.probe.updateMany({ where: { id: p.id, status: 'ONLINE' }, data: { status: 'OFFLINE', statusSince: new Date() } });
    if (res.count === 0) continue;
    log.warn('PROBE_DISCONNECTED', { probe: p.name, region: p.region, lastSeenAt: p.lastSeenAt });
    await prisma.checkJob.updateMany({ where: { probeId: p.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
    await publish('PROBE_DOWN', `probe-down:${p.id}:${p.lastSeenAt?.getTime()}`, {
      kind: 'PROBE_DOWN', probeName: p.name, region: p.region, lastSeenAt: p.lastSeenAt?.toISOString() ?? null,
    });
    await evaluateAllForProbe(p.id);
  }
}

/** Materialise probe<->target assignments from Target.regions (adds missing, drops probes of removed regions). */
export async function syncTargetAssignments(targetId: string): Promise<void> {
  const target = await prisma.monitoringTarget.findUnique({ where: { id: targetId } });
  if (!target) return;
  const probes = await prisma.probe.findMany({ where: { region: { in: target.regions } } });
  await prisma.probeTarget.createMany({
    data: probes.map((p) => ({ probeId: p.id, targetId, nextRunAt: new Date(Date.now() + Math.random() * target.intervalSeconds * 1000) })),
    skipDuplicates: true,
  });
  await prisma.probeTarget.deleteMany({ where: { targetId, probe: { region: { notIn: target.regions } } } });
}

/** A new probe joins every target that requires its region. */
export async function syncProbeAssignments(probeId: string): Promise<void> {
  const probe = await prisma.probe.findUnique({ where: { id: probeId } });
  if (!probe) return;
  const targets = await prisma.monitoringTarget.findMany({ where: { regions: { has: probe.region } } });
  await prisma.probeTarget.createMany({
    data: targets.map((t) => ({ probeId, targetId: t.id, nextRunAt: new Date(Date.now() + Math.random() * t.intervalSeconds * 1000) })),
    skipDuplicates: true,
  });
}

import { createLogger } from '../../shared/logger';
import { config } from '../config';
import { prisma } from '../db';
import { bus } from './bus';
import { pairViews, describeReason, toRegionDetails } from './snapshot';
import { publish } from '../notify/service';

const log = createLogger('incidents');

/**
 * Incident manager. Reconciles the *desired* state (TargetState) with incidents. It is idempotent, so it
 * is safe to call after every evaluation and periodically (crash-safe: a missed event is healed on the next call).
 * Alerts are sent only on transitions: an incident opens once (DOWN alert) and closes once (RECOVERED alert).
 */
export async function reconcile(targetId: string): Promise<void> {
  const target = await prisma.monitoringTarget.findUnique({ where: { id: targetId }, include: { state: true } });
  if (!target?.state) return;
  const state = target.state;
  const open = await prisma.incident.findFirst({ where: { targetId, resolvedAt: null }, orderBy: { startedAt: 'desc' } });
  const regionStates = state.regionStates as Record<string, string>;
  const downRegions = Object.entries(regionStates).filter(([, s]) => s === 'DOWN').map(([r]) => r);

  if (state.status === 'DOWN') {
    const views = await pairViews(targetId);
    const regions = toRegionDetails(views, regionStates);
    if (!open) {
      const incident = await prisma.incident.create({
        data: { targetId, classification: state.classification, affectedRegions: downRegions, reason: state.reason },
      });
      log.info('INCIDENT_CREATED', { incidentId: incident.id, target: target.name, classification: state.classification });
      await publish('TARGET_DOWN', `down:${incident.id}`, {
        kind: 'TARGET_DOWN', targetId, targetName: target.name, hostname: target.hostname,
        classification: state.classification, reason: state.reason, note: null,
        startedAt: incident.startedAt.toISOString(), regions, downRegions,
      }, incident.id);
      return;
    }
    if (open.classification !== state.classification || open.reason !== state.reason || open.affectedRegions.join() !== downRegions.join()) {
      await prisma.incident.update({
        where: { id: open.id },
        data: { classification: state.classification, affectedRegions: downRegions, reason: state.reason ?? open.reason },
      });
    }
    // Optional reminder for long outages (disabled by default: REMINDER_MINUTES=0).
    if (config.reminderMinutes > 0) {
      const last = open.lastReminderAt ?? open.startedAt;
      if (Date.now() - last.getTime() >= config.reminderMinutes * 60_000) {
        const n = Math.floor((Date.now() - open.startedAt.getTime()) / (config.reminderMinutes * 60_000));
        await prisma.incident.update({ where: { id: open.id }, data: { lastReminderAt: new Date() } });
        await publish('TARGET_REMINDER', `reminder:${open.id}:${n}`, {
          kind: 'TARGET_REMINDER', targetId, targetName: target.name, hostname: target.hostname,
          classification: state.classification, reason: state.reason, note: null,
          startedAt: open.startedAt.toISOString(), regions, downRegions,
        }, open.id);
      }
    }
    return;
  }

  if (state.status === 'UP' && open) {
    const resolvedAt = new Date();
    await prisma.incident.update({ where: { id: open.id }, data: { resolvedAt } });
    const views = await pairViews(targetId);
    log.info('INCIDENT_RESOLVED', { incidentId: open.id, target: target.name, durationSec: Math.round((resolvedAt.getTime() - open.startedAt.getTime()) / 1000) });
    await publish('TARGET_RECOVERED', `recovered:${open.id}`, {
      kind: 'TARGET_RECOVERED', targetId, targetName: target.name, hostname: target.hostname,
      startedAt: open.startedAt.toISOString(), resolvedAt: resolvedAt.toISOString(),
      durationSec: Math.round((resolvedAt.getTime() - open.startedAt.getTime()) / 1000),
      regions: toRegionDetails(views, regionStates),
    }, open.id);
  }
  // DEGRADED / UNKNOWN with an open incident: stay open, stay quiet.
}

export async function reconcileAll() {
  const states = await prisma.targetState.findMany({ select: { targetId: true } });
  for (const s of states) await reconcile(s.targetId);
}

/** Target disabled or removed from monitoring: close silently so incidents don't hang forever. */
export async function closeIncidents(targetId: string) {
  await prisma.incident.updateMany({ where: { targetId, resolvedAt: null }, data: { resolvedAt: new Date() } });
}

export function initIncidentManager() {
  bus.onEvent('target.evaluated', (id) => {
    reconcile(id).catch((e) => log.error('reconcile_failed', { targetId: id, err: e }));
  });
}

export { describeReason };

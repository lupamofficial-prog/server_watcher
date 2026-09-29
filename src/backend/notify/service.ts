import { AlertType, Prisma } from '@prisma/client';
import { createLogger } from '../../shared/logger';
import { errMessage } from '../../shared/util';
import { prisma } from '../db';
import type { AlertPayload, NotificationAdapter } from './types';

const log = createLogger('notify');
const adapters = new Map<string, NotificationAdapter>();
export const registerAdapter = (a: NotificationAdapter) => adapters.set(a.channel, a);

/**
 * Outbox pattern: alerts are first written to the DB (unique dedupeKey => at most one per event and
 * recipient, no matter how many times the engine re-evaluates), then delivered with retries.
 */
export async function publish(type: AlertType, eventKey: string, payload: AlertPayload, incidentId?: string) {
  for (const adapter of adapters.values()) {
    for (const recipient of adapter.recipients()) {
      try {
        await prisma.alert.create({
          data: {
            type, channel: adapter.channel, recipient, incidentId,
            dedupeKey: `${eventKey}:${adapter.channel}:${recipient}`,
            payload: payload as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e; // duplicate = already published, exactly what we want
      }
    }
  }
}

const MAX_ATTEMPTS = 30;
let running = false;

export async function deliverPending() {
  if (running) return;
  running = true;
  try {
    const due = await prisma.alert.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    for (const alert of due) {
      const adapter = adapters.get(alert.channel);
      try {
        if (!adapter) throw new Error(`no adapter for channel ${alert.channel}`);
        await adapter.send(alert.recipient, alert.payload as unknown as AlertPayload);
        await prisma.alert.update({ where: { id: alert.id }, data: { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 }, lastError: null } });
        log.info('ALERT_SENT', { alertId: alert.id, type: alert.type, channel: alert.channel });
      } catch (e) {
        const attempts = alert.attempts + 1;
        const backoffSec = Math.min(30 * 2 ** Math.min(attempts, 6), 900); // 1m .. 15m
        await prisma.alert.update({
          where: { id: alert.id },
          data: {
            attempts, lastError: errMessage(e).slice(0, 300),
            status: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
            nextAttemptAt: new Date(Date.now() + backoffSec * 1000),
          },
        });
        log.warn('ALERT_FAILED', { alertId: alert.id, type: alert.type, attempts, err: e });
      }
    }
  } finally {
    running = false;
  }
}

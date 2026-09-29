import { CheckResult, Probe, ProbeTarget } from '@prisma/client';
import { prisma } from '../db';
import type { RegionDetail } from '../notify/types';

export interface PairView {
  probe: Probe;
  pair: ProbeTarget;
  last: CheckResult | null;
}

/** Latest known picture of a target, one entry per assigned probe. */
export async function pairViews(targetId: string): Promise<PairView[]> {
  const pairs = await prisma.probeTarget.findMany({ where: { targetId }, include: { probe: true } });
  const views: PairView[] = [];
  for (const p of pairs) {
    const last = await prisma.checkResult.findFirst({ where: { targetId, probeId: p.probeId }, orderBy: { createdAt: 'desc' } });
    views.push({ probe: p.probe, pair: p, last });
  }
  return views.sort((a, b) => a.probe.region.localeCompare(b.probe.region) || a.probe.name.localeCompare(b.probe.name));
}

export function toRegionDetails(views: PairView[], regionStates: Record<string, string>): RegionDetail[] {
  const byRegion = new Map<string, RegionDetail>();
  for (const [region, state] of Object.entries(regionStates)) byRegion.set(region, { region, state, probes: [] });
  for (const v of views) {
    const d = byRegion.get(v.probe.region) ?? { region: v.probe.region, state: 'UNKNOWN', probes: [] };
    d.probes.push({
      name: v.probe.name,
      online: v.probe.status === 'ONLINE',
      state: v.pair.state,
      errorType: v.pair.state === 'UP' ? null : v.last?.errorType,
      errorMessage: v.pair.state === 'UP' ? null : v.last?.errorMessage,
      latencyMs: v.last?.totalLatencyMs,
    });
    byRegion.set(v.probe.region, d);
  }
  return [...byRegion.values()].sort((a, b) => (a.region === 'RU' ? -1 : b.region === 'RU' ? 1 : a.region.localeCompare(b.region)));
}

export function describeReason(views: PairView[], downRegions: string[]): string | null {
  const bad = views.find((v) => v.pair.state === 'DOWN' && downRegions.includes(v.probe.region) && v.probe.status === 'ONLINE');
  if (!bad) return null;
  const l = bad.last;
  const stage = l?.failedStage ? `${l.failedStage}: ` : '';
  return `${stage}${l?.errorType ?? 'FAILED'}${l?.errorMessage ? ` — ${l.errorMessage}` : ''}`.slice(0, 300);
}

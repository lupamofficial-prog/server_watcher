// Pure state-machine logic (no I/O) so it can be unit-tested and reasoned about in isolation.
//
// Per (probe,target):
//   UNKNOWN --ok--> UP
//   UP      --fail--> DEGRADED --(failStreak >= failureThreshold)--> DOWN
//   DOWN    --ok--> DEGRADED --(okStreak >= recoveryThreshold)--> UP
// Per target (across probes): regions are reduced to one state each, then classified (see classify()).

export type Health = 'UNKNOWN' | 'UP' | 'DEGRADED' | 'DOWN';
export type Classification =
  | 'HEALTHY' | 'DEGRADED' | 'RU_UNAVAILABLE' | 'REGIONAL_OUTAGE' | 'GLOBAL_OUTAGE' | 'PROBE_UNAVAILABLE' | 'UNKNOWN';

export interface PairState { state: Health; failStreak: number; okStreak: number }

export function nextPairState(cur: PairState, success: boolean, failureThreshold: number, recoveryThreshold: number): PairState {
  if (success) {
    const okStreak = cur.okStreak + 1;
    if (cur.state === 'UNKNOWN' || cur.state === 'UP') return { state: 'UP', failStreak: 0, okStreak };
    return { state: okStreak >= recoveryThreshold ? 'UP' : 'DEGRADED', failStreak: 0, okStreak };
  }
  const failStreak = cur.failStreak + 1;
  const state: Health = failStreak >= failureThreshold ? 'DOWN' : cur.state === 'DOWN' ? 'DOWN' : 'DEGRADED';
  return { state, failStreak, okStreak: 0 };
}

export interface PairInput { region: string; probeOnline: boolean; state: Health }

export interface Aggregate {
  status: Health;
  classification: Classification;
  regionStates: Record<string, Health>;
  downRegions: string[];
  note: string | null; // e.g. "not confirmed by an external probe"
}

/** Reduce the online probes of one region to a single region state. */
export function regionState(states: Health[]): Health {
  const known = states.filter((s) => s !== 'UNKNOWN');
  if (!known.length) return 'UNKNOWN';
  if (known.every((s) => s === 'DOWN')) return 'DOWN';
  if (known.every((s) => s === 'UP')) return 'UP';
  return 'DEGRADED'; // mixed results between probes of the same region
}

/**
 * Regional diagnostics. Probes that are offline are *ignored* (their region becomes UNKNOWN):
 * we never claim "target is down in Russia" when it may just be the Russian probe that died.
 */
export function classify(pairs: PairInput[], requiredRegions: string[]): Aggregate {
  const regions = new Set<string>([...requiredRegions, ...pairs.map((p) => p.region)]);
  const regionStates: Record<string, Health> = {};
  for (const r of regions) {
    regionStates[r] = regionState(pairs.filter((p) => p.region === r && p.probeOnline).map((p) => p.state));
  }
  const entries = Object.entries(regionStates);
  if (!entries.length) return { status: 'UNKNOWN', classification: 'UNKNOWN', regionStates, downRegions: [], note: null };

  const downs = entries.filter(([, s]) => s === 'DOWN').map(([r]) => r);
  const known = entries.filter(([, s]) => s !== 'UNKNOWN');
  const working = known.filter(([, s]) => s === 'UP' || s === 'DEGRADED');
  const unknownRegions = entries.filter(([, s]) => s === 'UNKNOWN').map(([r]) => r);
  const primary = regions.has('RU') ? 'RU' : entries[0][0];

  if (downs.length) {
    const ru = downs.includes('RU');
    if (working.length) {
      return { status: 'DOWN', classification: ru ? 'RU_UNAVAILABLE' : 'REGIONAL_OUTAGE', regionStates, downRegions: downs, note: null };
    }
    if (regions.size >= 2 && unknownRegions.length === 0) {
      return { status: 'DOWN', classification: 'GLOBAL_OUTAGE', regionStates, downRegions: downs, note: null };
    }
    return {
      status: 'DOWN',
      classification: ru ? 'RU_UNAVAILABLE' : 'REGIONAL_OUTAGE',
      regionStates,
      downRegions: downs,
      note: unknownRegions.length ? `not confirmed: no live probe in ${unknownRegions.join(', ')}` : 'no second region to compare with',
    };
  }
  if (regionStates[primary] === 'UNKNOWN') {
    return { status: 'UNKNOWN', classification: 'PROBE_UNAVAILABLE', regionStates, downRegions: [], note: `no live probe in ${primary}` };
  }
  if (known.some(([, s]) => s === 'DEGRADED')) {
    return { status: 'DEGRADED', classification: 'DEGRADED', regionStates, downRegions: [], note: null };
  }
  return { status: 'UP', classification: 'HEALTHY', regionStates, downRegions: [], note: unknownRegions.length ? `no live probe in ${unknownRegions.join(', ')}` : null };
}

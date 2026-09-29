// Wire contract between Backend and Probe. Dependency-free on purpose (the probe image has no node_modules).

export const API_PREFIX = '/api/probe';

export type CheckTypeName = 'NETWORK' | 'XRAY_E2E';
export type StageName = 'DNS' | 'TCP' | 'TLS' | 'HTTP';

export interface JobTarget {
  hostname: string;
  protocol: 'http' | 'https';
  port: number;
  path: string;
  expectedStatusCodes: number[];
  timeoutMs: number;
  certWarnDays: number;
  allowPrivate: boolean;
  checkType: CheckTypeName;
}

export interface ProbeJob {
  id: string; // correlation id
  kind: 'SCHEDULED' | 'MANUAL';
  target: JobTarget;
  expiresAt: string;
}

export interface PollRequest { maxJobs: number }
export interface PollResponse { jobs: ProbeJob[] }

export interface HeartbeatRequest { version: string; hostname?: string; uptimeSec: number; activeJobs: number }
export interface HeartbeatResponse {
  probe: { id: string; name: string; region: string; countryCode: string; location: string };
}

export interface ResultPayload {
  jobId: string;
  finishedAt: string;
  success: boolean;
  failedStage: StageName | null;
  dnsSuccess: boolean | null;
  dnsLatencyMs: number | null;
  tcpSuccess: boolean | null;
  tcpLatencyMs: number | null;
  tlsSuccess: boolean | null;
  tlsLatencyMs: number | null;
  httpSuccess: boolean | null;
  httpStatus: number | null;
  httpLatencyMs: number | null;
  totalLatencyMs: number | null;
  resolvedIp: string | null;
  tlsCertExpiresAt: string | null;
  tlsCertDaysLeft: number | null;
  errorType: string | null;
  errorMessage: string | null;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : isNum(v) ? Math.round(v) : undefined);
const boolOrNull = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'boolean' ? v : undefined);
const strOrNull = (v: unknown, max: number) => (v === null || v === undefined ? null : typeof v === 'string' ? v.slice(0, max) : undefined);

/** Validates + normalises an untrusted result body from a probe. Returns null when malformed. */
export function parseResultPayload(raw: unknown): ResultPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.jobId !== 'string' || typeof r.success !== 'boolean') return null;
  const finished = typeof r.finishedAt === 'string' ? new Date(r.finishedAt) : new Date();
  const stage = r.failedStage;
  if (stage !== null && stage !== undefined && !['DNS', 'TCP', 'TLS', 'HTTP'].includes(stage as string)) return null;
  const out: ResultPayload = {
    jobId: r.jobId,
    finishedAt: (isNaN(finished.getTime()) ? new Date() : finished).toISOString(),
    success: r.success,
    failedStage: (stage as StageName | null | undefined) ?? null,
    dnsSuccess: boolOrNull(r.dnsSuccess) as boolean | null,
    dnsLatencyMs: numOrNull(r.dnsLatencyMs) as number | null,
    tcpSuccess: boolOrNull(r.tcpSuccess) as boolean | null,
    tcpLatencyMs: numOrNull(r.tcpLatencyMs) as number | null,
    tlsSuccess: boolOrNull(r.tlsSuccess) as boolean | null,
    tlsLatencyMs: numOrNull(r.tlsLatencyMs) as number | null,
    httpSuccess: boolOrNull(r.httpSuccess) as boolean | null,
    httpStatus: numOrNull(r.httpStatus) as number | null,
    httpLatencyMs: numOrNull(r.httpLatencyMs) as number | null,
    totalLatencyMs: numOrNull(r.totalLatencyMs) as number | null,
    resolvedIp: strOrNull(r.resolvedIp, 64) as string | null,
    tlsCertExpiresAt: strOrNull(r.tlsCertExpiresAt, 40) as string | null,
    tlsCertDaysLeft: numOrNull(r.tlsCertDaysLeft) as number | null,
    errorType: strOrNull(r.errorType, 64) as string | null,
    errorMessage: strOrNull(r.errorMessage, 500) as string | null,
  };
  for (const v of Object.values(out)) if (v === undefined) return null;
  return out;
}

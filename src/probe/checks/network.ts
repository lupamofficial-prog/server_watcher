import type { JobTarget, ResultPayload } from '../../shared/contracts';
import { CheckContext, CheckStage, CheckStrategy, StageError } from './types';
import { dnsStage, httpStage, tcpStage, tlsStage } from './stages';

export function emptyResult(jobId: string): ResultPayload {
  return {
    jobId, finishedAt: new Date().toISOString(), success: false, failedStage: null,
    dnsSuccess: null, dnsLatencyMs: null, tcpSuccess: null, tcpLatencyMs: null,
    tlsSuccess: null, tlsLatencyMs: null, httpSuccess: null, httpStatus: null, httpLatencyMs: null,
    totalLatencyMs: null, resolvedIp: null, tlsCertExpiresAt: null, tlsCertDaysLeft: null,
    errorType: null, errorMessage: null,
  };
}

/** DNS -> TCP -> TLS -> HTTP. Stops at the first failing stage so the failure is precisely attributed. */
export class NetworkCheck implements CheckStrategy {
  readonly type = 'NETWORK' as const;
  constructor(private readonly stages: CheckStage[] = [dnsStage, tcpStage, tlsStage, httpStage]) {}

  async run(jobId: string, target: JobTarget): Promise<ResultPayload> {
    const startedAt = Date.now();
    const ctx: CheckContext = { target, startedAt, deadline: startedAt + target.timeoutMs, result: emptyResult(jobId) };
    const t0 = performance.now();
    try {
      for (const stage of this.stages) {
        if (!stage.applies(ctx)) continue;
        try {
          await stage.run(ctx);
        } catch (e) {
          ctx.result.failedStage = stage.name;
          if (e instanceof StageError) {
            ctx.result.errorType = e.errorType;
            ctx.result.errorMessage = e.message;
          } else {
            ctx.result.errorType = `${stage.name}_ERROR`;
            ctx.result.errorMessage = (e as Error).message;
          }
          const flag = `${stage.name.toLowerCase()}Success` as 'dnsSuccess' | 'tcpSuccess' | 'tlsSuccess' | 'httpSuccess';
          if (ctx.result[flag] === null && !(stage.name === 'DNS' && /^\d/.test(target.hostname))) ctx.result[flag] = false;
          return this.finish(ctx, t0, false);
        }
      }
      return this.finish(ctx, t0, true);
    } finally {
      ctx.socket?.destroy();
    }
  }

  private finish(ctx: CheckContext, t0: number, success: boolean): ResultPayload {
    ctx.result.success = success;
    ctx.result.totalLatencyMs = Math.max(1, Math.round(performance.now() - t0));
    ctx.result.finishedAt = new Date().toISOString();
    return ctx.result;
  }
}

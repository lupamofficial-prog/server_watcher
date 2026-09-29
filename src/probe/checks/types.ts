import type { CheckTypeName, JobTarget, ResultPayload, StageName } from '../../shared/contracts';

/** A whole check type (NETWORK, XRAY_E2E, ...). Add a new type = implement this + register it. */
export interface CheckStrategy {
  readonly type: CheckTypeName;
  run(jobId: string, target: JobTarget): Promise<ResultPayload>;
}

export class StageError extends Error {
  constructor(public readonly errorType: string, message: string) {
    super(message);
  }
}

/** Mutable state shared by the stages of the NETWORK pipeline. */
export interface CheckContext {
  target: JobTarget;
  startedAt: number;
  deadline: number;
  ip?: string;
  family?: 4 | 6;
  socket?: import('node:net').Socket;
  result: ResultPayload;
}

/** One step (DNS, TCP, TLS, HTTP) of the NETWORK pipeline. */
export interface CheckStage {
  readonly name: StageName;
  applies(ctx: CheckContext): boolean;
  run(ctx: CheckContext): Promise<void>;
}

export const remaining = (ctx: CheckContext) => ctx.deadline - Date.now();

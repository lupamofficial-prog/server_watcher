import type { JobTarget, ResultPayload } from '../../shared/contracts';
import { CheckStrategy } from './types';
import { emptyResult } from './network';

/**
 * PLACEHOLDER for the stage-2 VPN end-to-end check.
 *
 * Planned flow: start a throw-away Xray client (monitoring subscription, VLESS+XHTTP via the CDN under test),
 * fetch a control endpoint *through* the tunnel and report the same ResultPayload (latency of the tunnel
 * round-trip in httpLatencyMs). Everything else (scheduling, state machine, alerts) already works with any
 * CheckStrategy, so only this class + a registry entry are needed.
 */
export class XrayE2ECheck implements CheckStrategy {
  readonly type = 'XRAY_E2E' as const;
  async run(jobId: string, _target: JobTarget): Promise<ResultPayload> {
    const r = emptyResult(jobId);
    r.errorType = 'NOT_IMPLEMENTED';
    r.errorMessage = 'XRAY_E2E check is not implemented in this probe version';
    return r;
  }
}

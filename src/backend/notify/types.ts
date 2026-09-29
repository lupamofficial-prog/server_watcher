export interface RegionDetail {
  region: string;
  state: string;
  probes: Array<{ name: string; online: boolean; state: string; errorType?: string | null; errorMessage?: string | null; latencyMs?: number | null }>;
}

export type AlertPayload =
  | {
      kind: 'TARGET_DOWN' | 'TARGET_REMINDER';
      targetId: string; targetName: string; hostname: string;
      classification: string; reason: string | null; note: string | null;
      startedAt: string; regions: RegionDetail[]; downRegions: string[];
    }
  | {
      kind: 'TARGET_RECOVERED';
      targetId: string; targetName: string; hostname: string;
      startedAt: string; resolvedAt: string; durationSec: number; regions: RegionDetail[];
    }
  | { kind: 'PROBE_DOWN'; probeName: string; region: string; lastSeenAt: string | null }
  | { kind: 'PROBE_RECOVERED'; probeName: string; region: string; downSec: number }
  | { kind: 'CERT_EXPIRING'; targetId: string; targetName: string; hostname: string; daysLeft: number; expiresAt: string; probeName: string };

/** Adapter contract: Telegram is just one implementation (Email/Webhook/Discord can be added the same way). */
export interface NotificationAdapter {
  readonly channel: string;
  recipients(): string[];
  send(recipient: string, payload: AlertPayload): Promise<void>;
}

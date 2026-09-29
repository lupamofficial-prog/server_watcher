function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Environment variable ${name} is required (see .env.example)`);
  return v;
}
const int = (name: string, def: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
};

export const config = {
  port: int('PORT', 3000),
  publicUrl: (process.env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
  telegramToken: req('TELEGRAM_BOT_TOKEN'),
  adminIds: req('TELEGRAM_ADMIN_IDS').split(/[\s,;]+/).filter(Boolean).map(String),
  signingSecret: (() => {
    const s = req('PROBE_SIGNING_SECRET');
    if (s.length < 24) throw new Error('PROBE_SIGNING_SECRET must be at least 24 characters (openssl rand -hex 32)');
    return s;
  })(),
  probeImage: process.env.PROBE_IMAGE ?? 'ghcr.io/OWNER/haze-monitor-probe:latest',

  // defaults for new targets
  defaultInterval: int('CHECK_INTERVAL', 30),
  defaultTimeoutMs: int('CHECK_TIMEOUT', 5000),
  defaultFailureThreshold: int('FAILURE_THRESHOLD', 3),
  defaultRecoveryThreshold: int('RECOVERY_THRESHOLD', 2),

  // engine tuning (rarely changed)
  probeOfflineAfterSec: int('PROBE_OFFLINE_AFTER', 90),
  reminderMinutes: Number(process.env.REMINDER_MINUTES ?? 0), // 0 = never remind
  rawRetentionDays: int('RAW_RETENTION_DAYS', 7),
  hourlyRetentionDays: int('HOURLY_RETENTION_DAYS', 90),
  longPollMs: 20_000,
};

export function isAdmin(id: number | string | undefined): boolean {
  return id !== undefined && config.adminIds.includes(String(id));
}

import { Bot } from 'grammy';
import { config } from '../config';
import { ago, clock, duration, esc, ms, regionFlag, regionName, stateEmoji } from './fmt';
import type { AlertPayload, NotificationAdapter, RegionDetail } from './types';

const CLASS_TITLE: Record<string, string> = {
  RU_UNAVAILABLE: 'Недоступность со стороны РФ',
  REGIONAL_OUTAGE: 'Региональная недоступность',
  GLOBAL_OUTAGE: 'Глобальная авария (сервер/CDN/DNS/hostname)',
  PROBE_UNAVAILABLE: 'Probe недоступен — данных недостаточно',
  DEGRADED: 'Деградация',
  HEALTHY: 'Всё в порядке',
  UNKNOWN: 'Неизвестно',
};

function regionLines(regions: RegionDetail[]): string {
  return regions
    .map((r) => {
      const probes = r.probes
        .map((p) => (!p.online ? `${esc(p.name)} ⚪ probe offline` : `${esc(p.name)} ${stateEmoji(p.state)}${p.latencyMs ? ` ${ms(p.latencyMs)}` : ''}`))
        .join(', ');
      const word = r.state === 'UP' ? 'доступен' : r.state === 'DOWN' ? 'недоступен' : r.state === 'DEGRADED' ? 'нестабильно' : 'нет данных';
      return `${regionFlag(r.region)} <b>${esc(regionName(r.region))}:</b> ${stateEmoji(r.state)} ${word}${probes ? `\n    <i>${probes}</i>` : ''}`;
    })
    .join('\n');
}

export function formatAlert(p: AlertPayload): string {
  switch (p.kind) {
    case 'TARGET_DOWN':
    case 'TARGET_REMINDER': {
      const where =
        p.classification === 'RU_UNAVAILABLE' ? 'недоступен из России'
        : p.classification === 'REGIONAL_OUTAGE' ? `недоступен: ${p.downRegions.map(regionName).join(', ')}`
        : p.classification === 'GLOBAL_OUTAGE' ? 'недоступен глобально'
        : 'недоступен';
      const head = p.kind === 'TARGET_REMINDER' ? `🔴 <b>${esc(p.targetName)}</b> всё ещё ${where}` : `🔴 <b>${esc(p.targetName)}</b> ${where}`;
      return [
        head,
        p.reason ? `\n<b>Ошибка:</b>\n${esc(p.reason)}` : '',
        `\n${regionLines(p.regions)}`,
        `\n<b>Предварительная классификация:</b>\n${esc(CLASS_TITLE[p.classification] ?? p.classification)}${p.note ? `\n<i>${esc(p.note)}</i>` : ''}`,
        `\n<b>Начало:</b> ${clock(p.startedAt)}${p.kind === 'TARGET_REMINDER' ? `\n<b>Длительность:</b> ${duration((Date.now() - Date.parse(p.startedAt)) / 1000)}` : ''}`,
        `<code>${esc(p.hostname)}</code>`,
      ].filter(Boolean).join('\n');
    }
    case 'TARGET_RECOVERED': {
      const lat = p.regions.flatMap((r) => r.probes.map((x) => x.latencyMs)).filter((x): x is number => !!x);
      return [
        `🟢 <b>${esc(p.targetName)}</b> восстановлен`,
        `\n<b>Недоступность:</b>\n${duration(p.durationSec)}`,
        `\n${regionLines(p.regions)}`,
        lat.length ? `\n<b>Response:</b>\n${Math.round(lat.reduce((a, b) => a + b, 0) / lat.length)} ms` : '',
        `\n<b>Начало:</b> ${clock(p.startedAt)}\n<b>Конец:</b> ${clock(p.resolvedAt)}`,
      ].filter(Boolean).join('\n');
    }
    case 'PROBE_DOWN':
      return `🔴 <b>Probe ${esc(p.probeName)}</b> (${esc(regionName(p.region))}) недоступен\n\nПоследний heartbeat: ${ago(p.lastSeenAt)}\n\n⚠️ Пока probe оффлайн, состояние targets в регионе <b>${esc(p.region)}</b> считается неизвестным — сообщения «недоступен» по нему отправляться не будут.`;
    case 'PROBE_RECOVERED':
      return `🟢 <b>Probe ${esc(p.probeName)}</b> (${esc(regionName(p.region))}) снова на связи\n\nБыл недоступен: ${duration(p.downSec)}`;
    case 'CERT_EXPIRING':
      return `⚠️ <b>${esc(p.targetName)}</b>: TLS-сертификат истекает через <b>${p.daysLeft} дн.</b>\n\nДо: ${clock(p.expiresAt)}\nHost: <code>${esc(p.hostname)}</code>\nВидит probe: ${esc(p.probeName)}`;
  }
}

export class TelegramAdapter implements NotificationAdapter {
  readonly channel = 'telegram';
  constructor(private readonly bot: Bot) {}
  recipients() { return config.adminIds; }
  async send(recipient: string, payload: AlertPayload) {
    await this.bot.api.sendMessage(recipient, formatAlert(payload), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  }
}

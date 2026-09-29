import { InlineKeyboard } from 'grammy';
import { CheckResult, MonitoringTarget, Probe } from '@prisma/client';
import { prisma } from '../db';
import { pairViews, PairView } from '../engine/snapshot';
import { ago, clock, duration, esc, ms, pct, regionFlag, regionName, stateEmoji } from '../notify/fmt';

export interface View { text: string; kb: InlineKeyboard }

const TYPE_ICON: Record<string, string> = { ORIGIN: '🖥', CDN: '☁️', PANEL: '🎛', SUBSCRIPTION: '🔗', API: '🔌', CUSTOM: '🔧' };
export const typeIcon = (t: string) => TYPE_ICON[t] ?? '🔧';
const back = (to = 'home') => new InlineKeyboard().text('◀️ Назад', to);

const rank: Record<string, number> = { DOWN: 3, DEGRADED: 2, UNKNOWN: 1, UP: 0 };
const worst = (states: string[]) => states.reduce((a, b) => (rank[b] > rank[a] ? b : a), 'UP');

type TargetRow = MonitoringTarget & { state: { status: string; classification: string; regionStates: unknown } | null; group: { name: string; flag: string; sortOrder: number } | null };

const targetStatus = (t: TargetRow) => (!t.enabled ? 'PAUSED' : t.state?.status ?? 'UNKNOWN');
const statusIcon = (s: string) => (s === 'PAUSED' ? '⏸' : stateEmoji(s));

async function loadTargets(where: object = {}): Promise<TargetRow[]> {
  return prisma.monitoringTarget.findMany({ where, include: { state: true, group: true }, orderBy: { name: 'asc' } }) as unknown as TargetRow[];
}

export async function dashboard(): Promise<View> {
  const [targets, probes] = await Promise.all([loadTargets(), prisma.probe.findMany({ orderBy: [{ region: 'asc' }, { name: 'asc' }] })]);
  const active = targets.filter((t) => t.enabled);
  const overall = active.length ? worst(active.map((t) => t.state?.status ?? 'UNKNOWN')) : 'UNKNOWN';
  const lines: string[] = [`${stateEmoji(overall)} <b>Infrastructure</b>`, ''];

  if (probes.length) {
    lines.push('📡 <b>Probes</b>');
    for (const p of probes) {
      const st = !p.enabled ? '⏸ выключен' : p.status === 'ONLINE' ? '🟢 Online' : p.status === 'OFFLINE' ? `🔴 Offline (${ago(p.lastSeenAt)})` : '⚪ ожидает подключения';
      lines.push(`${regionFlag(p.region)} ${esc(p.name)} — ${st}`);
    }
    lines.push('');
  } else {
    lines.push('📡 Probes ещё не добавлены: ⚙️ Настройки → Probes → ➕\n');
  }

  const groups = new Map<string, { title: string; order: number; items: TargetRow[] }>();
  for (const t of targets) {
    const key = t.group?.name ?? '~';
    if (!groups.has(key)) groups.set(key, { title: t.group ? `${t.group.flag} ${t.group.name}` : '📦 Без группы', order: t.group?.sortOrder ?? 999, items: [] });
    groups.get(key)!.items.push(t);
  }
  for (const g of [...groups.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))) {
    lines.push(`<b>${esc(g.title)}</b>`);
    for (const t of g.items) lines.push(`${typeIcon(t.type)} ${esc(t.name)}  ${statusIcon(targetStatus(t))}`);
    lines.push('');
  }
  if (!targets.length) lines.push('Targets ещё не добавлены: ⚙️ Настройки → Targets → ➕');
  lines.push(`<i>Обновлено: ${clock(new Date())}</i>`);

  const kb = new InlineKeyboard()
    .text('🔄 Обновить', 'home').row()
    .text('🌐 Серверы', 'srv').text('☁️ CDN', 'cdn').row()
    .text('📡 Probes', 'probes').text('🚨 Инциденты', 'inc').row()
    .text('📊 Статистика', 'stats').text('⚙️ Настройки', 'set');
  return { text: trim(lines.join('\n')), kb };
}

const trim = (s: string) => (s.length > 3900 ? s.slice(0, 3900) + '\n…' : s);

export async function targetList(kind: 'srv' | 'cdn'): Promise<View> {
  const all = await loadTargets({ enabled: undefined });
  const rows = all.filter((t) => (kind === 'cdn' ? t.type === 'CDN' : t.type !== 'CDN'));
  const kb = new InlineKeyboard();
  for (const t of rows.slice(0, 60)) kb.text(`${statusIcon(targetStatus(t))} ${t.name}`, `t:${t.id}`).row();
  kb.text('◀️ Назад', 'home');
  return { text: kind === 'cdn' ? '☁️ <b>CDN</b>' + (rows.length ? '' : '\n\nПусто.') : '🌐 <b>Серверы</b>' + (rows.length ? '' : '\n\nПусто.'), kb };
}

function stageLine(r: CheckResult): string {
  const parts: string[] = [];
  if (r.dnsSuccess !== null || r.dnsLatencyMs !== null) parts.push(`DNS: ${r.dnsSuccess === false ? '✖' : ms(r.dnsLatencyMs)}`);
  if (r.tcpSuccess !== null || r.tcpLatencyMs !== null) parts.push(`TCP: ${r.tcpSuccess === false ? '✖' : ms(r.tcpLatencyMs)}`);
  if (r.tlsSuccess !== null || r.tlsLatencyMs !== null) parts.push(`TLS: ${r.tlsSuccess === false ? '✖' : ms(r.tlsLatencyMs)}`);
  if (r.httpSuccess !== null || r.httpLatencyMs !== null) parts.push(`HTTP: ${ms(r.httpLatencyMs)}${r.httpStatus ? ` (${r.httpStatus})` : ''}`);
  return parts.join('\n');
}

function probeBlock(v: PairView): string {
  const p = v.probe;
  const head = `${regionFlag(p.region)} <b>${esc(regionName(p.region))}</b> · ${esc(p.name)}`;
  if (!p.enabled) return `${head}\n⏸ probe выключен`;
  if (p.status !== 'ONLINE') return `${head}\n⚪ probe offline (${p.lastSeenAt ? `последний контакт ${ago(p.lastSeenAt)}` : 'ещё не подключался'}) — данные могут быть устаревшими`;
  const r = v.last;
  if (!r) return `${head}\n⚪ данных ещё нет`;
  const icon = stateEmoji(v.pair.state);
  if (r.success) return `${head}\n${icon} Доступен\n${stageLine(r)}`;
  return `${head}\n${icon} ${v.pair.state === 'DOWN' ? 'Недоступен' : 'Сбой проверки'} — ${r.failedStage ?? ''} ${esc(r.errorType ?? '')}\n<i>${esc(r.errorMessage ?? '')}</i>\n${stageLine(r)}`;
}

export async function uptime(targetId: string, hours: number) {
  const since = new Date(Date.now() - hours * 3_600_000);
  const [total, ok] = await Promise.all([
    prisma.checkResult.count({ where: { targetId, kind: 'SCHEDULED', createdAt: { gte: since } } }),
    prisma.checkResult.count({ where: { targetId, kind: 'SCHEDULED', success: true, createdAt: { gte: since } } }),
  ]);
  return { total, ok };
}

export async function targetCard(id: string, banner = ''): Promise<View> {
  const t = (await prisma.monitoringTarget.findUnique({ where: { id }, include: { state: true, group: true } })) as TargetRow | null;
  if (!t) return { text: 'Target не найден (удалён?)', kb: back() };
  const views = await pairViews(id);
  const up = await uptime(id, 24);
  const status = targetStatus(t);
  const lastAny = views.map((v) => v.last).filter((x): x is CheckResult => !!x).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const cert = views.map((v) => v.last?.tlsCertDaysLeft).filter((x): x is number => typeof x === 'number');
  const cls = t.state && t.enabled && t.state.status !== 'UP' ? `\nКлассификация: <b>${esc(t.state.classification)}</b>` : '';

  const lines = [
    banner,
    `${typeIcon(t.type)} <b>${esc(t.name)}</b>`,
    `<code>${esc(t.protocol)}://${esc(t.hostname)}:${t.port}${esc(t.path)}</code>`,
    '',
    `Status: ${statusIcon(status)} <b>${status === 'PAUSED' ? 'PAUSED' : status}</b>${cls}`,
    '',
    views.length ? views.map(probeBlock).join('\n\n') : '⚠️ Нет назначенных probes (регионы: ' + esc(t.regions.join(', ')) + ')',
    '',
    lastAny?.resolvedIp ? `IP:\n<code>${esc(lastAny.resolvedIp)}</code>\n` : '',
    `Last check:\n${ago(lastAny?.createdAt)}`,
    '',
    `Uptime 24h:\n${pct(up.ok, up.total)}`,
    cert.length ? `\n🔒 TLS сертификат: ещё ${Math.min(...cert)} дн.` : '',
    `\n<i>каждые ${t.intervalSeconds}с · timeout ${t.timeoutMs / 1000}с · пороги ${t.failureThreshold}/${t.recoveryThreshold} · коды ${t.expectedStatusCodes.join(',')}</i>`,
  ];

  const kb = new InlineKeyboard()
    .text('🔄 Проверить сейчас', `tc:${id}`).row()
    .text(t.enabled ? '⏸ Пауза' : '▶️ Включить', `tt:${id}`).text('✏️ Изменить', `te:${id}`).row()
    .text('🚨 Инциденты', `ti:${id}`).text('🗑 Удалить', `td:${id}`).row()
    .text('◀️ Назад', t.type === 'CDN' ? 'cdn' : 'srv');
  return { text: trim(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()), kb };
}

export async function probesList(): Promise<View> {
  const probes = await prisma.probe.findMany({ orderBy: [{ region: 'asc' }, { name: 'asc' }] });
  const kb = new InlineKeyboard();
  const lines = ['📡 <b>Probes</b>', ''];
  for (const p of probes) {
    const icon = !p.enabled ? '⏸' : p.status === 'ONLINE' ? '🟢' : p.status === 'OFFLINE' ? '🔴' : '⚪';
    lines.push(`${icon} ${regionFlag(p.region)} <b>${esc(p.name)}</b> — ${esc(p.region)}, ${p.status === 'ONLINE' ? 'на связи' : `контакт: ${p.lastSeenAt ? ago(p.lastSeenAt) : 'не подключался'}`}`);
    kb.text(`${icon} ${p.name}`, `p:${p.id}`).row();
  }
  if (!probes.length) lines.push('Пока нет ни одного probe.');
  kb.text('➕ Добавить probe', 'pa').row().text('◀️ Назад', 'home');
  return { text: lines.join('\n'), kb };
}

export async function probeCard(id: string): Promise<View> {
  const p = await prisma.probe.findUnique({ where: { id }, include: { _count: { select: { targets: true } } } });
  if (!p) return { text: 'Probe не найден', kb: back('probes') };
  const st = !p.enabled ? '⏸ выключен' : p.status === 'ONLINE' ? '🟢 ONLINE' : p.status === 'OFFLINE' ? '🔴 OFFLINE' : '⚪ ещё не подключался';
  const text = [
    `${regionFlag(p.region)} <b>${esc(p.name)}</b>`,
    `Статус: ${st}`,
    `Регион: ${esc(p.region)}${p.countryCode ? ` · ${esc(p.countryCode)}` : ''}${p.location ? ` · ${esc(p.location)}` : ''}`,
    `Последний heartbeat: ${ago(p.lastSeenAt)}`,
    p.publicIp ? `IP: <code>${esc(p.publicIp)}</code>` : '',
    p.version ? `Версия: ${esc(p.version)}` : '',
    `Targets: ${p._count.targets}`,
    `Создан: ${clock(p.createdAt)}`,
  ].filter(Boolean).join('\n');
  const kb = new InlineKeyboard()
    .text('🔑 Токен / установка', `pk:${id}`).row()
    .text(p.enabled ? '⏸ Выключить' : '▶️ Включить', `pt:${id}`).text('♻️ Новый токен', `pr:${id}`).row()
    .text('🗑 Удалить', `pd:${id}`).row()
    .text('◀️ Назад', 'probes');
  return { text, kb };
}

export async function incidentsView(targetId?: string): Promise<View> {
  const where = targetId ? { targetId } : {};
  const [open, recent] = await Promise.all([
    prisma.incident.findMany({ where: { ...where, resolvedAt: null }, include: { target: true }, orderBy: { startedAt: 'desc' } }),
    prisma.incident.findMany({ where: { ...where, resolvedAt: { not: null } }, include: { target: true }, orderBy: { startedAt: 'desc' }, take: 10 }),
  ]);
  const lines = ['🚨 <b>Инциденты</b>', ''];
  lines.push(open.length ? '<b>Активные:</b>' : '✅ Активных инцидентов нет');
  for (const i of open) lines.push(`🔴 <b>${esc(i.target.name)}</b> · ${esc(i.classification)}\n   с ${clock(i.startedAt)} (${duration((Date.now() - i.startedAt.getTime()) / 1000)})${i.reason ? `\n   <i>${esc(i.reason)}</i>` : ''}`);
  if (recent.length) {
    lines.push('', '<b>Недавно закрытые:</b>');
    for (const i of recent) lines.push(`🟢 ${esc(i.target.name)} · ${esc(i.classification)}\n   ${clock(i.startedAt)} → ${duration(((i.resolvedAt ?? new Date()).getTime() - i.startedAt.getTime()) / 1000)}`);
  }
  const kb = new InlineKeyboard().text('🔄 Обновить', targetId ? `ti:${targetId}` : 'inc').row().text('◀️ Назад', targetId ? `t:${targetId}` : 'home');
  return { text: trim(lines.join('\n')), kb };
}

export async function statsView(): Promise<View> {
  const rows = await prisma.$queryRaw<Array<{ name: string; region: string; total: number; ok: number; avg: number | null; d7total: number; d7ok: number }>>`
    SELECT t.name, p.region,
      count(*) FILTER (WHERE r."createdAt" > now() - interval '24 hours')::int AS total,
      (count(*) FILTER (WHERE r."createdAt" > now() - interval '24 hours' AND r.success))::int AS ok,
      round(avg(r."totalLatencyMs") FILTER (WHERE r."createdAt" > now() - interval '24 hours' AND r.success))::int AS avg,
      count(*)::int AS d7total, (count(*) FILTER (WHERE r.success))::int AS d7ok
    FROM "CheckResult" r
    JOIN "MonitoringTarget" t ON t.id = r."targetId"
    JOIN "Probe" p ON p.id = r."probeId"
    WHERE r.kind = 'SCHEDULED' AND r."createdAt" > now() - interval '7 days'
    GROUP BY t.name, p.region ORDER BY t.name, p.region`;
  const byTarget = new Map<string, typeof rows>();
  for (const r of rows) byTarget.set(r.name, [...(byTarget.get(r.name) ?? []), r]);
  const lines = ['📊 <b>Статистика</b> (uptime 24ч / 7д, средний ответ)', ''];
  for (const [name, rs] of byTarget) {
    lines.push(`<b>${esc(name)}</b>`);
    for (const r of rs) lines.push(`  ${regionFlag(r.region)} ${esc(r.region)}: ${pct(r.ok, r.total)} / ${pct(r.d7ok, r.d7total)} · ${r.avg ? ms(r.avg) : '—'}`);
  }
  if (!rows.length) lines.push('Данных пока нет.');
  const kb = new InlineKeyboard().text('🔄 Обновить', 'stats').row().text('◀️ Назад', 'home');
  return { text: trim(lines.join('\n')), kb };
}

export function settingsView(): View {
  return {
    text: '⚙️ <b>Настройки</b>',
    kb: new InlineKeyboard().text('🎯 Targets', 's:targets').row().text('🗂 Группы', 's:groups').row().text('📡 Probes', 'probes').row().text('◀️ Назад', 'home'),
  };
}

export async function settingsTargets(): Promise<View> {
  const targets = await loadTargets();
  const kb = new InlineKeyboard();
  for (const t of targets.slice(0, 60)) kb.text(`${statusIcon(targetStatus(t))} ${typeIcon(t.type)} ${t.name}`, `te:${t.id}`).row();
  kb.text('➕ Добавить target', 'ta').row().text('◀️ Назад', 'set');
  return { text: '🎯 <b>Targets</b>\nВыберите target для редактирования или добавьте новый.', kb };
}

export async function groupsView(): Promise<View> {
  const groups = await prisma.infraGroup.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: { _count: { select: { targets: true } } } });
  const kb = new InlineKeyboard();
  for (const g of groups) kb.text(`🗑 ${g.flag} ${g.name} (${g._count.targets})`, `gd:${g.id}`).row();
  kb.text('➕ Добавить группу', 'ga').row().text('◀️ Назад', 'set');
  return {
    text: '🗂 <b>Группы инфраструктуры</b>\nГруппа объединяет origin/CDN/subscription одной ноды.\nНажмите на группу, чтобы удалить (targets останутся без группы).',
    kb,
  };
}

export type { Probe };

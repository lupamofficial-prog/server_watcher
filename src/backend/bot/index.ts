import { Bot, Context, InlineKeyboard } from 'grammy';
import { Prisma, TargetType } from '@prisma/client';
import { createLogger } from '../../shared/logger';
import { isBlockedHostname, isValidHostname } from '../../shared/ssrf';
import { makeToken } from '../../shared/signing';
import { errMessage, sleep } from '../../shared/util';
import { config, isAdmin } from '../config';
import { prisma } from '../db';
import { closeIncidents } from '../engine/incidents';
import { evaluateAllForProbe, evaluateTarget } from '../engine/evaluator';
import { createManualBatch, waitForBatch } from '../engine/jobs';
import { syncProbeAssignments, syncTargetAssignments } from '../engine/probes';
import { esc, regionFlag } from '../notify/fmt';
import * as V from './views';

const log = createLogger('bot');
const TYPES: TargetType[] = ['ORIGIN', 'CDN', 'PANEL', 'SUBSCRIPTION', 'API', 'CUSTOM'];

type Session =
  | { kind: 'addTarget'; step: string; d: Record<string, any> }
  | { kind: 'editTarget'; targetId: string; field: string }
  | { kind: 'addProbe'; step: string; d: Record<string, any> }
  | { kind: 'addGroup'; step: string; d: Record<string, any> };
const sessions = new Map<number, Session>();
const checking = new Set<string>();

// ---------------------------------------------------------------- helpers
async function show(ctx: Context, v: V.View) {
  const opts = { parse_mode: 'HTML' as const, reply_markup: v.kb, link_preview_options: { is_disabled: true } };
  try {
    if (ctx.callbackQuery) await ctx.editMessageText(v.text, opts);
    else await ctx.reply(v.text, opts);
  } catch (e) {
    if (!/message is not modified/i.test(errMessage(e))) throw e;
  }
}
const cancelKb = () => new InlineKeyboard().text('✖️ Отмена', 'wc');
const backKb = (to: string) => new InlineKeyboard().text('◀️ Назад', to);
const rowsOf = (items: Array<[string, string]>, per = 3, kb = new InlineKeyboard()) => {
  items.forEach(([label, data], i) => { kb.text(label, data); if ((i + 1) % per === 0) kb.row(); });
  return items.length % per ? kb.row() : kb;
};
const publicBase = () => config.publicUrl || 'http://<IP-этого-сервера>:3000';

function extractHost(raw: string): string {
  const s = raw.trim().toLowerCase();
  try { return new URL(/^[a-z]+:\/\//.test(s) ? s : `https://${s}`).hostname; } catch { return s; }
}

async function knownRegions(): Promise<string[]> {
  const rs = await prisma.probe.findMany({ distinct: ['region'], select: { region: true } });
  return [...new Set([...rs.map((r) => r.region), ...(rs.length ? [] : ['RU', 'EU'])])].sort();
}

// ---------------------------------------------------------------- target field editing
const CHOICES: Record<string, { label: string; values: Array<[string, string]> }> = {
  type: { label: 'Тип', values: TYPES.map((t) => [`${V.typeIcon(t)} ${t}`, t]) },
  protocol: { label: 'Протокол', values: [['HTTPS', 'https'], ['HTTP', 'http']] },
  intervalSeconds: { label: 'Интервал', values: [10, 15, 30, 60, 120, 300].map((n) => [`${n} с`, String(n)]) },
  timeoutMs: { label: 'Timeout', values: [2000, 3000, 5000, 10000, 15000].map((n) => [`${n / 1000} с`, String(n)]) },
  failureThreshold: { label: 'Порог падения (подряд неудач → DOWN)', values: [1, 2, 3, 4, 5].map((n) => [String(n), String(n)]) },
  recoveryThreshold: { label: 'Порог восстановления (подряд успехов → UP)', values: [1, 2, 3, 4, 5].map((n) => [String(n), String(n)]) },
  certWarnDays: { label: 'Предупреждать о сертификате за (дней)', values: [3, 7, 14, 30].map((n) => [`${n} дн`, String(n)]) },
};
const TEXT_FIELDS: Record<string, string> = { name: 'Имя', hostname: 'Hostname', port: 'Порт', path: 'Path', expectedStatusCodes: 'Допустимые HTTP-коды (через запятую)' };

type TargetLike = { allowPrivate: boolean };
function parseField(field: string, raw: string, t: TargetLike): { data: Prisma.MonitoringTargetUpdateInput } | { error: string } {
  const v = raw.trim();
  switch (field) {
    case 'name':
      return v.length >= 2 && v.length <= 60 ? { data: { name: v } } : { error: 'Имя: 2–60 символов' };
    case 'hostname': {
      const h = extractHost(v);
      if (!isValidHostname(h)) return { error: 'Некорректный hostname' };
      if (!t.allowPrivate && isBlockedHostname(h)) return { error: 'Внутренние адреса запрещены SSRF-защитой. Сначала включите «Разрешить внутренние адреса».' };
      return { data: { hostname: h } };
    }
    case 'port': {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 65535 ? { data: { port: n } } : { error: 'Порт: 1–65535' };
    }
    case 'path': {
      const p = v.startsWith('/') ? v : `/${v}`;
      return p.length <= 300 && !/\s/.test(p) ? { data: { path: p } } : { error: 'Некорректный path' };
    }
    case 'expectedStatusCodes': {
      const codes = v.split(/[\s,;]+/).filter(Boolean).map(Number);
      return codes.length && codes.every((c) => Number.isInteger(c) && c >= 100 && c <= 599) ? { data: { expectedStatusCodes: [...new Set(codes)] } } : { error: 'Пример: 200,301,302,403,404' };
    }
  }
  return { error: 'Неизвестное поле' };
}

async function editMenu(id: string): Promise<V.View> {
  const t = await prisma.monitoringTarget.findUnique({ where: { id }, include: { group: true } });
  if (!t) return { text: 'Target не найден', kb: backKb('s:targets') };
  const kb = new InlineKeyboard();
  const btn = (label: string, f: string) => kb.text(label, `tef:${id}:${f}`);
  btn('Имя', 'name'); btn('Hostname', 'hostname'); kb.row();
  btn('Порт', 'port'); btn('Path', 'path'); btn('Протокол', 'protocol'); kb.row();
  btn('Тип', 'type'); btn('Группа', 'group'); kb.row();
  btn('Интервал', 'intervalSeconds'); btn('Timeout', 'timeoutMs'); kb.row();
  btn('Порог падения', 'failureThreshold'); btn('Порог восст.', 'recoveryThreshold'); kb.row();
  btn('HTTP-коды', 'expectedStatusCodes'); btn('Серт (дни)', 'certWarnDays'); kb.row();
  btn('Регионы', 'regions'); btn('Probes', 'probes'); kb.row();
  kb.text(`${t.allowPrivate ? '✅' : '⬜'} Внутренние адреса`, `tef:${id}:allowPrivate`).row();
  kb.text('◀️ К target', `t:${id}`);
  const text = [
    `✏️ <b>${esc(t.name)}</b> · ${V.typeIcon(t.type)} ${t.type}`,
    `<code>${t.protocol}://${esc(t.hostname)}:${t.port}${esc(t.path)}</code>`,
    `Группа: ${t.group ? esc(t.group.name) : '—'} · регионы: ${esc(t.regions.join('+'))}`,
    `Интервал ${t.intervalSeconds}с · timeout ${t.timeoutMs / 1000}с · пороги ${t.failureThreshold}/${t.recoveryThreshold}`,
    `Коды: ${t.expectedStatusCodes.join(',')} · серт: предупреждать за ${t.certWarnDays} дн.`,
  ].join('\n');
  return { text, kb };
}

async function applyTargetUpdate(id: string, data: Prisma.MonitoringTargetUpdateInput, regionsChanged = false) {
  await prisma.monitoringTarget.update({ where: { id }, data });
  if (regionsChanged) await syncTargetAssignments(id);
  if ('intervalSeconds' in data || 'hostname' in data || 'port' in data || 'path' in data || 'protocol' in data) {
    await prisma.probeTarget.updateMany({ where: { targetId: id }, data: { nextRunAt: new Date() } }); // re-check with new settings right away
  }
  await evaluateTarget(id);
}

// ---------------------------------------------------------------- add-target wizard
const T_STEPS = ['name', 'type', 'hostname', 'protocol', 'port', 'path', 'group', 'regions', 'interval', 'timeout', 'confirm'];

async function targetWizard(s: Extract<Session, { kind: 'addTarget' }>): Promise<V.View> {
  const d = s.d;
  const head = '➕ <b>Новый target</b>\n\n';
  switch (s.step) {
    case 'name': return { text: head + 'Название?\nНапример: <code>Germany CDN #2</code>', kb: cancelKb() };
    case 'type': return { text: head + 'Тип?', kb: rowsOf(TYPES.map((t) => [`${V.typeIcon(t)} ${t}`, `w:${t}`] as [string, string]), 2, new InlineKeyboard()).text('✖️ Отмена', 'wc') };
    case 'hostname': return { text: head + 'Hostname?\nНапример: <code>cdn2.example.com</code>', kb: cancelKb() };
    case 'private':
      return { text: head + `⚠️ <code>${esc(d.hostname)}</code> — внутренний адрес. SSRF-защита блокирует такие проверки, если явно не разрешить.\nРазрешить для этого target?`, kb: new InlineKeyboard().text('Разрешить', 'w:yes').text('Изменить hostname', 'w:no').row().text('✖️ Отмена', 'wc') };
    case 'protocol': return { text: head + 'Протокол?', kb: new InlineKeyboard().text('HTTPS', 'w:https').text('HTTP', 'w:http').row().text('✖️ Отмена', 'wc') };
    case 'port': {
      const def = d.protocol === 'http' ? 80 : 443;
      return { text: head + `Порт? Нажмите кнопку или отправьте число.`, kb: new InlineKeyboard().text(`${def} (по умолчанию)`, `w:${def}`).row().text('✖️ Отмена', 'wc') };
    }
    case 'path': return { text: head + 'Path для HTTP-проверки? Отправьте текст или нажмите кнопку.', kb: new InlineKeyboard().text('/', 'w:/').row().text('✖️ Отмена', 'wc') };
    case 'group': {
      const groups = await prisma.infraGroup.findMany({ orderBy: { name: 'asc' } });
      const kb = new InlineKeyboard();
      for (const g of groups) kb.text(`${g.flag} ${g.name}`, `w:${g.id}`).row();
      kb.text('Без группы', 'w:none').text('➕ Новая группа', 'w:newgroup').row().text('✖️ Отмена', 'wc');
      return { text: head + 'Группа инфраструктуры (нода)?', kb };
    }
    case 'newgroup': return { text: head + 'Название новой группы? (например «Germany LTE»)', kb: cancelKb() };
    case 'regions': {
      const regs = await knownRegions();
      const kb = new InlineKeyboard();
      for (const r of regs) kb.text(`${d.regions.includes(r) ? '✅' : '⬜'} ${regionFlag(r)} ${r}`, `w:r:${r}`);
      kb.row().text('Готово ▶️', 'w:rdone').row().text('✖️ Отмена', 'wc');
      return { text: head + 'Из каких регионов проверять? (probes этих регионов назначатся автоматически)', kb };
    }
    case 'interval': return { text: head + 'Интервал проверки?', kb: rowsOf([10, 15, 30, 60, 120, 300].map((n) => [`${n} с`, `w:${n}`] as [string, string]), 3).text('✖️ Отмена', 'wc') };
    case 'timeout': return { text: head + 'Timeout?', kb: rowsOf([2, 3, 5, 10, 15].map((n) => [`${n} с`, `w:${n * 1000}`] as [string, string]), 3).text('✖️ Отмена', 'wc') };
    default: {
      const g = d.groupId ? (await prisma.infraGroup.findUnique({ where: { id: d.groupId } }))?.name : '—';
      return {
        text: head + [
          `<b>${esc(d.name)}</b> · ${d.type}`, `<code>${d.protocol}://${esc(d.hostname)}:${d.port}${esc(d.path)}</code>`,
          `Группа: ${esc(g)} · регионы: ${esc(d.regions.join('+'))}`, `Интервал ${d.intervalSeconds}с · timeout ${d.timeoutMs / 1000}с`,
          '', 'Пороги (3/2) и допустимые HTTP-коды можно изменить после создания.',
        ].join('\n'),
        kb: new InlineKeyboard().text('✅ Создать', 'w:create').text('✖️ Отмена', 'wc'),
      };
    }
  }
}

async function targetWizardAdvance(ctx: Context, s: Extract<Session, { kind: 'addTarget' }>, input: string, fromButton: boolean) {
  const d = s.d;
  const err = async (m: string) => { await ctx.reply(`⚠️ ${m}`); };
  const next = async (step: string) => { s.step = step; await show(ctx, await targetWizard(s)); };
  const reply = async (step: string) => { s.step = step; const v = await targetWizard(s); await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.kb }); };
  const go = fromButton ? next : reply;

  switch (s.step) {
    case 'name': {
      const r = parseField('name', input, { allowPrivate: false });
      if ('error' in r) return err(r.error);
      if (await prisma.monitoringTarget.findUnique({ where: { name: input.trim() } })) return err('Target с таким именем уже есть');
      d.name = input.trim(); return go('type');
    }
    case 'type':
      if (!TYPES.includes(input as TargetType)) return;
      d.type = input; return go('hostname');
    case 'hostname': {
      const h = extractHost(input);
      if (!isValidHostname(h)) return err('Некорректный hostname');
      d.hostname = h; d.allowPrivate = false;
      if (isBlockedHostname(h)) return go('private');
      return go('protocol');
    }
    case 'private':
      if (input === 'yes') { d.allowPrivate = true; return go('protocol'); }
      return go('hostname');
    case 'protocol':
      if (input !== 'http' && input !== 'https') return;
      d.protocol = input; return go('port');
    case 'port': {
      const r = parseField('port', input, { allowPrivate: true });
      if ('error' in r) return err(r.error);
      d.port = Number(input); return go('path');
    }
    case 'path': {
      const r = parseField('path', input, { allowPrivate: true });
      if ('error' in r) return err(r.error);
      d.path = input.startsWith('/') ? input : `/${input}`; return go('group');
    }
    case 'group':
      if (input === 'newgroup') return next('newgroup');
      d.groupId = input === 'none' ? null : input;
      if (!d.regions) d.regions = (await knownRegions()).slice();
      return go('regions');
    case 'newgroup': {
      const name = input.trim();
      if (name.length < 2 || name.length > 40) return err('Название группы: 2–40 символов');
      const g = await prisma.infraGroup.upsert({ where: { name }, update: {}, create: { name } });
      d.groupId = g.id;
      if (!d.regions) d.regions = (await knownRegions()).slice();
      return go('regions');
    }
    case 'regions':
      if (input.startsWith('r:')) {
        const r = input.slice(2);
        d.regions = d.regions.includes(r) ? d.regions.filter((x: string) => x !== r) : [...d.regions, r];
        return next('regions');
      }
      if (input === 'rdone') {
        if (!d.regions.length) return err('Выберите хотя бы один регион');
        return go('interval');
      }
      return;
    case 'interval': d.intervalSeconds = Number(input); return go('timeout');
    case 'timeout': d.timeoutMs = Number(input); return go('confirm');
    case 'confirm': {
      if (input !== 'create') return;
      try {
        const t = await prisma.monitoringTarget.create({
          data: {
            name: d.name, type: d.type, hostname: d.hostname, protocol: d.protocol, port: d.port, path: d.path,
            groupId: d.groupId ?? null, regions: d.regions, intervalSeconds: d.intervalSeconds, timeoutMs: d.timeoutMs,
            allowPrivate: !!d.allowPrivate, failureThreshold: config.defaultFailureThreshold, recoveryThreshold: config.defaultRecoveryThreshold,
          },
        });
        await syncTargetAssignments(t.id);
        await evaluateTarget(t.id);
        sessions.delete(ctx.from!.id);
        log.info('target_created', { target: t.name, by: ctx.from?.id });
        return show(ctx, await V.targetCard(t.id, '✅ Target создан и уже мониторится'));
      } catch (e) {
        return err(`Не удалось создать: ${errMessage(e)}`);
      }
    }
  }
}

// ---------------------------------------------------------------- probe / group wizards
async function probeWizard(s: Extract<Session, { kind: 'addProbe' }>): Promise<V.View> {
  const head = '➕ <b>Новый probe</b>\n\n';
  if (s.step === 'name') return { text: head + 'Имя probe?\nНапример: <code>RU-Moscow-1</code> или <code>DE-Frankfurt-1</code>', kb: cancelKb() };
  if (s.step === 'region') {
    const regs = [...new Set(['RU', 'EU', ...(await knownRegions())])];
    return { text: head + 'Регион? Кнопка или текст (латиница, например <code>US</code>).\n<b>RU</b> — источник истины «доступно ли из России», <b>EU</b> — внешняя точка.', kb: rowsOf(regs.map((r) => [`${regionFlag(r)} ${r}`, `w:${r}`] as [string, string]), 3).text('✖️ Отмена', 'wc') };
  }
  return { text: head + 'Страна (ISO-код, например <code>DE</code>) — кнопка или текст.', kb: rowsOf(['RU', 'DE', 'NL', 'FI', 'PL', 'SE'].map((c) => [c, `w:${c}`] as [string, string]), 3).text('Пропустить', 'w:-').row().text('✖️ Отмена', 'wc') };
}

function probeInstallView(name: string, token: string, banner: string): V.View {
  const base = publicBase();
  const text = [
    banner,
    `<b>${esc(name)}</b>`,
    '',
    'Установка на VPS (нужен только Docker):',
    `<pre>curl -fsSL ${esc(base)}/install.sh | PROBE_TOKEN=${esc(token)} bash</pre>`,
    'Или вручную: <code>git clone …; cd server_watcher/probe; cp .env.example .env</code> и в .env укажите:',
    `<pre>BACKEND_URL=${esc(base)}\nPROBE_TOKEN=${esc(token)}</pre>`,
    '⚠️ Токен — секрет. Удалите это сообщение после установки.',
    config.publicUrl ? '' : '⚠️ PUBLIC_URL не задан в .env — подставьте реальный адрес backend.',
  ].filter(Boolean).join('\n');
  return { text, kb: new InlineKeyboard().text('🗑 Удалить сообщение', 'delmsg').row().text('📡 К probes', 'probes') };
}

async function probeWizardAdvance(ctx: Context, s: Extract<Session, { kind: 'addProbe' }>, input: string, fromButton: boolean) {
  const d = s.d;
  const go = async (step: string) => {
    s.step = step;
    const v = await probeWizard(s);
    if (fromButton) await show(ctx, v); else await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.kb });
  };
  if (s.step === 'name') {
    const name = input.trim();
    if (!/^[\w.\- ]{2,40}$/.test(name)) return void ctx.reply('⚠️ Имя: 2–40 символов (буквы, цифры, - _ .)');
    if (await prisma.probe.findUnique({ where: { name } })) return void ctx.reply('⚠️ Probe с таким именем уже есть');
    d.name = name; return go('region');
  }
  if (s.step === 'region') {
    const region = input.trim().toUpperCase();
    if (!/^[A-Z]{2,8}$/.test(region)) return void ctx.reply('⚠️ Регион: 2–8 латинских букв');
    d.region = region; return go('country');
  }
  const cc = input.trim().toUpperCase();
  if (cc !== '-' && !/^[A-Z]{2}$/.test(cc)) return void ctx.reply('⚠️ Код страны: 2 буквы или «Пропустить»');
  const probe = await prisma.probe.create({ data: { name: d.name, region: d.region, countryCode: cc === '-' ? '' : cc } });
  await syncProbeAssignments(probe.id);
  sessions.delete(ctx.from!.id);
  log.info('probe_created', { probe: probe.name, by: ctx.from?.id });
  return show(ctx, probeInstallView(probe.name, makeToken(config.signingSecret, probe.id, probe.secretVersion), '✅ Probe создан'));
}

// ---------------------------------------------------------------- bot
export function createBot(): Bot {
  const bot = new Bot(config.telegramToken);

  bot.use(async (ctx, next) => {
    if (!isAdmin(ctx.from?.id)) {
      log.warn('unauthorized_access', { userId: ctx.from?.id, chatType: ctx.chat?.type });
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: '⛔ Доступ запрещён', show_alert: true }).catch(() => {});
      else if (ctx.chat?.type === 'private') await ctx.reply('⛔ Доступ запрещён.').catch(() => {});
      return;
    }
    await next();
  });

  const home = async (ctx: Context) => { sessions.delete(ctx.from!.id); await show(ctx, await V.dashboard()); };
  bot.command(['start', 'menu'], async (ctx) => { await ctx.reply('👋 <b>Haze Monitor</b>', { parse_mode: 'HTML' }); await show(ctx, await V.dashboard()); });
  bot.command('cancel', async (ctx) => { sessions.delete(ctx.from!.id); await ctx.reply('Отменено.'); });

  bot.on('message:text', async (ctx) => {
    const s = sessions.get(ctx.from.id);
    const text = ctx.message.text;
    if (!s) return void (await show(ctx, await V.dashboard()));
    if (s.kind === 'addTarget') return targetWizardAdvance(ctx, s, text, false);
    if (s.kind === 'addProbe') return probeWizardAdvance(ctx, s, text, false);
    if (s.kind === 'addGroup') {
      const name = text.trim();
      if (s.step === 'name') {
        if (name.length < 2 || name.length > 40) return void ctx.reply('⚠️ Название: 2–40 символов');
        s.d.name = name; s.step = 'flag';
        return void ctx.reply('Emoji-флаг группы (например 🇩🇪) или «-»:');
      }
      await prisma.infraGroup.upsert({ where: { name: s.d.name }, update: { flag: name === '-' ? '🌐' : name.slice(0, 8) }, create: { name: s.d.name, flag: name === '-' ? '🌐' : name.slice(0, 8) } });
      sessions.delete(ctx.from.id);
      return show(ctx, await V.groupsView());
    }
    if (s.kind === 'editTarget') {
      const t = await prisma.monitoringTarget.findUnique({ where: { id: s.targetId } });
      if (!t) { sessions.delete(ctx.from.id); return void ctx.reply('Target не найден'); }
      const r = parseField(s.field, text, t);
      if ('error' in r) return void ctx.reply(`⚠️ ${r.error}`);
      try {
        await applyTargetUpdate(t.id, r.data);
      } catch (e) {
        return void ctx.reply(`⚠️ ${(e as { code?: string }).code === 'P2002' ? 'Такое имя уже занято' : errMessage(e)}`);
      }
      sessions.delete(ctx.from.id);
      return show(ctx, await editMenu(t.id));
    }
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const uid = ctx.from.id;
    const [cmd, a, b, c] = data.split(':');
    try {
      await ctx.answerCallbackQuery().catch(() => {});
      switch (cmd) {
        case 'home': return await home(ctx);
        case 'srv': case 'cdn': return await show(ctx, await V.targetList(cmd));
        case 'probes': return await show(ctx, await V.probesList());
        case 'inc': return await show(ctx, await V.incidentsView());
        case 'ti': return await show(ctx, await V.incidentsView(a));
        case 'stats': return await show(ctx, await V.statsView());
        case 'set': return await show(ctx, V.settingsView());
        case 's': return await show(ctx, a === 'targets' ? await V.settingsTargets() : a === 'groups' ? await V.groupsView() : V.settingsView());
        case 'delmsg': return void (await ctx.deleteMessage().catch(() => {}));
        case 'wc': sessions.delete(uid); return await home(ctx);

        // ---- targets
        case 't': return await show(ctx, await V.targetCard(a));
        case 'tc': return void runCheck(ctx, a);
        case 'tt': {
          const t = await prisma.monitoringTarget.findUnique({ where: { id: a } });
          if (!t) return await home(ctx);
          await prisma.monitoringTarget.update({ where: { id: a }, data: { enabled: !t.enabled } });
          if (t.enabled) await closeIncidents(a);
          else await prisma.probeTarget.updateMany({ where: { targetId: a }, data: { nextRunAt: new Date() } });
          return await show(ctx, await V.targetCard(a, t.enabled ? '⏸ Мониторинг приостановлен' : '▶️ Мониторинг включён'));
        }
        case 'td': {
          const t = await prisma.monitoringTarget.findUnique({ where: { id: a } });
          return await show(ctx, { text: `🗑 Удалить <b>${esc(t?.name)}</b>?\nИстория проверок и инцидентов будет удалена.`, kb: new InlineKeyboard().text('Да, удалить', `tdy:${a}`).text('Отмена', `t:${a}`) });
        }
        case 'tdy': await prisma.monitoringTarget.delete({ where: { id: a } }).catch(() => {}); log.info('target_deleted', { id: a, by: uid }); return await show(ctx, await V.settingsTargets());
        case 'ta': sessions.set(uid, { kind: 'addTarget', step: 'name', d: {} }); return await show(ctx, await targetWizard({ kind: 'addTarget', step: 'name', d: {} }));
        case 'te': sessions.delete(uid); return await show(ctx, await editMenu(a));
        case 'tef': return await editField(ctx, a, b);
        case 'tev': return await setChoice(ctx, a, b, c);
        case 'trg': { // toggle region on an existing target
          const t = await prisma.monitoringTarget.findUnique({ where: { id: a } });
          if (!t) return;
          const regions = t.regions.includes(b) ? t.regions.filter((r) => r !== b) : [...t.regions, b];
          if (!regions.length) return void ctx.answerCallbackQuery({ text: 'Нужен хотя бы один регион', show_alert: true });
          await applyTargetUpdate(a, { regions }, true);
          return await show(ctx, await regionsView(a));
        }
        case 'tpt': { // toggle explicit probe assignment
          const key = { probeId_targetId: { probeId: b, targetId: a } };
          if (await prisma.probeTarget.findUnique({ where: key })) await prisma.probeTarget.delete({ where: key });
          else await prisma.probeTarget.create({ data: { probeId: b, targetId: a } });
          await evaluateTarget(a);
          return await show(ctx, await probesAssignView(a));
        }

        // ---- probes
        case 'p': return await show(ctx, await V.probeCard(a));
        case 'pa': sessions.set(uid, { kind: 'addProbe', step: 'name', d: {} }); return await show(ctx, await probeWizard({ kind: 'addProbe', step: 'name', d: {} }));
        case 'pt': {
          const p = await prisma.probe.findUnique({ where: { id: a } });
          if (p) { await prisma.probe.update({ where: { id: a }, data: { enabled: !p.enabled } }); await evaluateAllForProbe(a); }
          return await show(ctx, await V.probeCard(a));
        }
        case 'pk': case 'prc': {
          const p = await prisma.probe.findUnique({ where: { id: a } });
          if (!p) return;
          const upd = cmd === 'prc' ? await prisma.probe.update({ where: { id: a }, data: { secretVersion: { increment: 1 } } }) : p;
          return await show(ctx, probeInstallView(upd.name, makeToken(config.signingSecret, upd.id, upd.secretVersion), cmd === 'prc' ? '♻️ Токен обновлён, старый больше не работает' : '🔑 Данные для установки'));
        }
        case 'pr': return await show(ctx, { text: '♻️ Выпустить новый токен? Работающий probe с текущим токеном будет отключён, пока вы не обновите его .env.', kb: new InlineKeyboard().text('Да', `prc:${a}`).text('Отмена', `p:${a}`) });
        case 'pd': return await show(ctx, { text: '🗑 Удалить probe? Его история проверок будет удалена.', kb: new InlineKeyboard().text('Да, удалить', `pdy:${a}`).text('Отмена', `p:${a}`) });
        case 'pdy': {
          const affected = await prisma.probeTarget.findMany({ where: { probeId: a }, select: { targetId: true } });
          await prisma.probe.delete({ where: { id: a } }).catch(() => {});
          for (const t of affected) await evaluateTarget(t.targetId);
          return await show(ctx, await V.probesList());
        }

        // ---- groups
        case 'ga': sessions.set(uid, { kind: 'addGroup', step: 'name', d: {} }); return await show(ctx, { text: '➕ Название группы? (например «Germany LTE»)', kb: cancelKb() });
        case 'gd': await prisma.infraGroup.delete({ where: { id: a } }).catch(() => {}); return await show(ctx, await V.groupsView());

        // ---- wizard buttons
        case 'w': {
          const s = sessions.get(uid);
          const value = data.slice(2);
          if (!s) return await home(ctx);
          if (s.kind === 'addTarget') return await targetWizardAdvance(ctx, s, value, true);
          if (s.kind === 'addProbe') return await probeWizardAdvance(ctx, s, value, true);
          return;
        }
      }
    } catch (e) {
      log.error('callback_failed', { data: data.slice(0, 40), err: e });
      await ctx.reply(`⚠️ Ошибка: ${esc(errMessage(e))}`, { parse_mode: 'HTML' }).catch(() => {});
    }
  });

  async function editField(ctx: Context, id: string, field: string) {
    const t = await prisma.monitoringTarget.findUnique({ where: { id } });
    if (!t) return;
    if (field in TEXT_FIELDS) {
      sessions.set(ctx.from!.id, { kind: 'editTarget', targetId: id, field });
      const cur = field === 'expectedStatusCodes' ? t.expectedStatusCodes.join(',') : String((t as Record<string, unknown>)[field]);
      return show(ctx, { text: `✏️ <b>${TEXT_FIELDS[field]}</b>\nСейчас: <code>${esc(cur)}</code>\n\nОтправьте новое значение:`, kb: new InlineKeyboard().text('✖️ Отмена', `te:${id}`) });
    }
    if (field in CHOICES) {
      const ch = CHOICES[field];
      const kb = rowsOf(ch.values.map(([l, v]) => [l, `tev:${id}:${field}:${v}`] as [string, string]), 3).text('◀️ Назад', `te:${id}`);
      return show(ctx, { text: `✏️ <b>${ch.label}</b>`, kb });
    }
    if (field === 'allowPrivate') {
      await applyTargetUpdate(id, { allowPrivate: !t.allowPrivate });
      return show(ctx, await editMenu(id));
    }
    if (field === 'group') {
      const groups = await prisma.infraGroup.findMany({ orderBy: { name: 'asc' } });
      const kb = new InlineKeyboard();
      for (const g of groups) kb.text(`${g.id === t.groupId ? '✅ ' : ''}${g.flag} ${g.name}`, `tev:${id}:group:${g.id}`).row();
      kb.text('Без группы', `tev:${id}:group:none`).row().text('◀️ Назад', `te:${id}`);
      return show(ctx, { text: '✏️ <b>Группа</b>\n(новые группы: ⚙️ Настройки → Группы)', kb });
    }
    if (field === 'regions') return show(ctx, await regionsView(id));
    if (field === 'probes') return show(ctx, await probesAssignView(id));
  }

  async function setChoice(ctx: Context, id: string, field: string, value: string) {
    if (field === 'group') await applyTargetUpdate(id, { group: value === 'none' ? { disconnect: true } : { connect: { id: value } } });
    else if (field === 'type') await applyTargetUpdate(id, { type: value as TargetType });
    else if (field === 'protocol') await applyTargetUpdate(id, { protocol: value });
    else if (field in CHOICES) await applyTargetUpdate(id, { [field]: Number(value) } as Prisma.MonitoringTargetUpdateInput);
    return show(ctx, await editMenu(id));
  }

  async function regionsView(id: string): Promise<V.View> {
    const t = await prisma.monitoringTarget.findUnique({ where: { id } });
    const regs = [...new Set([...(await knownRegions()), ...(t?.regions ?? [])])].sort();
    const kb = new InlineKeyboard();
    for (const r of regs) kb.text(`${t?.regions.includes(r) ? '✅' : '⬜'} ${regionFlag(r)} ${r}`, `trg:${id}:${r}`);
    kb.row().text('◀️ Назад', `te:${id}`);
    return { text: '✏️ <b>Регионы</b>\nProbes этих регионов проверяют target. Изменение пересобирает назначение probes.', kb };
  }

  async function probesAssignView(id: string): Promise<V.View> {
    const [probes, pairs] = await Promise.all([prisma.probe.findMany({ orderBy: [{ region: 'asc' }, { name: 'asc' }] }), prisma.probeTarget.findMany({ where: { targetId: id } })]);
    const on = new Set(pairs.map((p) => p.probeId));
    const kb = new InlineKeyboard();
    for (const p of probes) kb.text(`${on.has(p.id) ? '✅' : '⬜'} ${regionFlag(p.region)} ${p.name}`, `tpt:${id}:${p.id}`).row();
    kb.text('◀️ Назад', `te:${id}`);
    return { text: '✏️ <b>Probes для этого target</b>\nТочечное назначение поверх регионов (смена регионов пересоберёт список).', kb };
  }

  async function runCheck(ctx: Context, id: string) {
    const chatId = ctx.chat!.id, msgId = ctx.callbackQuery!.message!.message_id;
    if (checking.has(`${chatId}:${id}`)) return;
    checking.add(`${chatId}:${id}`);
    const edit = async (v: V.View) => {
      await ctx.api.editMessageText(chatId, msgId, v.text, { parse_mode: 'HTML', reply_markup: v.kb }).catch((e) => {
        if (!/not modified/i.test(errMessage(e))) log.warn('edit_failed', { err: e });
      });
    };
    try {
      await edit(await V.targetCard(id, '⏳ Выполняется проверка...'));
      const t = await prisma.monitoringTarget.findUnique({ where: { id } });
      if (!t) return;
      const { batchId, probes } = await createManualBatch(id);
      if (!probes) return void (await edit(await V.targetCard(id, '⚠️ Нет ни одного online probe для этого target')));
      const { done } = await waitForBatch(batchId, t.timeoutMs + 15_000);
      await sleep(150);
      await edit(await V.targetCard(id, done ? '✅ Проверка завершена' : '⚠️ Часть probes не ответила вовремя'));
    } catch (e) {
      log.error('manual_check_failed', { targetId: id, err: e });
      await edit(await V.targetCard(id, `⚠️ Ошибка проверки: ${esc(errMessage(e))}`));
    } finally {
      checking.delete(`${chatId}:${id}`);
    }
  }

  bot.catch((err) => log.error('bot_error', { err: err.error }));
  return bot;
}

/** Long polling supervisor: survives Telegram outages / network drops (alerts wait in the DB outbox meanwhile). */
export async function runBot(bot: Bot, signal: AbortSignal) {
  signal.addEventListener('abort', () => void bot.stop().catch(() => {}));
  await bot.api.setMyCommands([{ command: 'start', description: 'Открыть дашборд' }, { command: 'cancel', description: 'Отменить ввод' }]).catch(() => {});
  while (!signal.aborted) {
    try {
      await bot.start({ onStart: (me) => log.info('bot_started', { username: me.username }) });
    } catch (e) {
      if (signal.aborted) return;
      log.error('bot_crashed_restarting', { err: e });
      await sleep(5000);
    }
  }
}

export const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const stateEmoji = (s: string) => ({ UP: '🟢', DEGRADED: '🟡', DOWN: '🔴', UNKNOWN: '⚪' } as Record<string, string>)[s] ?? '⚪';

const REGIONS: Record<string, { flag: string; name: string }> = {
  RU: { flag: '🇷🇺', name: 'Россия' },
  EU: { flag: '🇪🇺', name: 'Европа' },
  US: { flag: '🇺🇸', name: 'США' },
  ASIA: { flag: '🌏', name: 'Азия' },
};
export const regionFlag = (r: string) => REGIONS[r]?.flag ?? '🌐';
export const regionName = (r: string) => REGIONS[r]?.name ?? r;

export function duration(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d) return `${d} д ${h} ч`;
  if (h) return `${h} ч ${m} мин`;
  if (m) return `${m} мин ${s} сек`;
  return `${s} сек`;
}

export const ago = (d: Date | string | null | undefined) => (d ? `${duration((Date.now() - new Date(d).getTime()) / 1000)} назад` : 'никогда');

export function clock(d: Date | string): string {
  const x = new Date(d);
  return x.toLocaleString('ru-RU', { hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const ms = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n} ms`);
export const pct = (ok: number, total: number) => (total ? `${((ok / total) * 100).toFixed(total >= 1000 ? 2 : 1)}%` : '—');

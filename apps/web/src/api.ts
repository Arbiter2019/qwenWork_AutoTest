export async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? data.error ?? `请求失败 (${response.status})`);
  return data;
}
export function duration(ms?: number | null) { if (ms == null) return '—'; if (ms < 1000) return `${Math.round(ms)} 毫秒`; const s = ms / 1000; return s < 60 ? `${s.toFixed(1)} 秒` : `${Math.floor(s / 60)} 分 ${(s % 60).toFixed(0)} 秒`; }
export function percent(value?: number | null) { return value == null ? '—' : `${(value * 100).toFixed(2)}%`; }
export function date(value?: string) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'; }

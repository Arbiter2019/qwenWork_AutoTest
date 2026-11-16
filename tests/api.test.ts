import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/api.ts';
import { Store } from '../packages/storage/src/store.ts';
import { DEFAULT_CONFIG, type AppAdapter } from '../packages/core/src/types.ts';

const resources: { close(): unknown }[] = [];
function configFixture() { const root = mkdtempSync(join(tmpdir(), 'qwen-api-')); resources.push({ close: () => rmSync(root, { recursive: true, force: true }) }); const appPath = join(root, 'QwenWorkCN.app'); mkdirSync(join(appPath, 'Contents/MacOS'), { recursive: true }); writeFileSync(join(appPath, 'Contents/MacOS/QwenWorkCN'), ''); return { appPath, config: join(root, 'config.json') }; }
afterEach(async () => { for (const r of resources.splice(0).reverse()) await r.close(); });
const adapter: AppAdapter = {
  health: async () => ({ connected: true, mode: 'real' }),
  submit: async (_input, id) => ({ taskId: id }),
  inspect: async () => ({ status: 'succeeded', output: 'ok', collection: 'partial' }),
  answer: async () => {}, stop: async () => true,
};
async function setup() { const { config } = configFixture(); const store = new Store(':memory:'); const app = await buildApp({ store, adapter, serveStatic: false, appConfigPath: config, desktopPlatform: 'darwin' }); resources.push(app); return app; }
describe('local API', () => {
  it('validates and saves the selected desktop app path', async () => {
    const { appPath } = configFixture(); const app = await setup();
    expect((await app.inject({ url: '/api/app-config' })).json().platform).toBe('darwin');
    expect((await app.inject({ method: 'POST', url: '/api/app-config', payload: { path: appPath + '/' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/app-config', payload: { path: '/tmp/not-an-app.txt' } })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/app-config' })).json().appPath).toBe(appPath);
  });
  it('preserves selection on cancellation and verifies connection after launching', async () => {
    const { appPath, config } = configFixture(); let selected: string | undefined = appPath; let connected = false, launches = 0;
    const app = await buildApp({ store: new Store(':memory:'), adapter: { ...adapter, health: async () => ({ connected, mode: 'real' }) }, serveStatic: false, appConfigPath: config, desktopPlatform: 'darwin', selectApp: async () => selected, launchDesktopApp: async path => { expect(path).toBe(appPath); launches++; connected = true; } }); resources.push(app);
    const picked = await app.inject({ method: 'POST', url: '/api/app-config/pick', payload: {} }); expect(picked.json().appPath).toBe(appPath);
    selected = undefined; const cancelled = await app.inject({ method: 'POST', url: '/api/app-config/pick', payload: {} }); expect(cancelled.json()).toMatchObject({ cancelled: true, appPath });
    expect((await app.inject({ method: 'POST', url: '/api/app-config/start', payload: {} })).json().adapter.connected).toBe(true); expect(launches).toBe(1);
    await app.inject({ method: 'POST', url: '/api/app-config/start', payload: {} }); expect(launches).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/api/app-config/start', headers: { origin: 'https://evil.example' }, payload: {} })).statusCode).toBe(403);
  });
  it('reports a failed connection without claiming successful startup', async () => {
    const { appPath, config } = configFixture(); const app = await buildApp({ store: new Store(':memory:'), adapter: { ...adapter, health: async () => ({ connected: false, mode: 'real' }) }, serveStatic: false, appConfigPath: config, desktopPlatform: 'darwin', launchDesktopApp: async () => {}, appConnectTimeoutMs: 0 }); resources.push(app);
    await app.inject({ method: 'POST', url: '/api/app-config', payload: { path: appPath } });
    const result = await app.inject({ method: 'POST', url: '/api/app-config/start', payload: {} }); expect(result.statusCode).toBe(409); expect(result.json().message).toContain('正常退出');
  });
  it('downloads a usable template and returns physical error rows', async () => {
    const app = await setup(); const template = await app.inject({ url: '/api/template.csv' });
    expect(template.statusCode).toBe(200); expect(template.headers['content-disposition']).toContain('attachment');
    const valid = await app.inject({ method: 'POST', url: '/api/import', payload: { csv: template.body } });
    expect(valid.json().errors).toEqual([]); expect(valid.json().samples).toHaveLength(2);
    const invalid = await app.inject({ method: 'POST', url: '/api/import', payload: { csv: 'ID,Prompt,专家套件ID,模型类型\n1,a,,其他' } });
    expect(invalid.json().errors[0]).toMatchObject({ row: 2 }); expect(invalid.json().samples).toEqual([]);
  });
  it('rejects nonlocal Host and cross origin mutations', async () => {
    const app = await setup();
    expect((await app.inject({ url: '/api/health', headers: { host: 'evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/import', headers: { origin: 'https://evil.example' }, payload: { csv: '' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/import', headers: { origin: 'http://localhost:4317' }, payload: { csv: '' } })).statusCode).toBe(200);
  });
  it('validates sample IDs and run configuration before submission', async () => {
    const app = await setup(); const samples = [{ id: '1', prompt: 'hello', expertKitId: '', model: '标准' }];
    const invalid = await app.inject({ method: 'POST', url: '/api/runs', payload: { samples, config: { concurrency: 0 } } });
    expect(invalid.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/runs', payload: { samples: [samples[0], samples[0]], config: DEFAULT_CONFIG } })).statusCode).toBe(400);
    const result = await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'api test', samples, config: DEFAULT_CONFIG } });
    expect(result.statusCode).toBe(201); const id = result.json().run.id;
    expect((await app.inject({ url: `/api/runs/${id}` })).json().metrics.total).toBe(1);
    for (const format of ['csv', 'json', 'html']) {
      const file = await app.inject({ url: `/api/runs/${id}/export?format=${format}` });
      expect(file.statusCode).toBe(200); expect(file.headers['content-disposition']).toContain(`.${format}`);
    }
    expect((await app.inject({ url: '/api/runs/missing' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/not-here' })).statusCode).toBe(404);
  });
  it('serializes simultaneous run creation and preserves a completed report against controls', async () => {
    const store = new Store(':memory:');
    const slow: AppAdapter = { ...adapter, health: async () => { await new Promise(r => setTimeout(r, 10)); return { connected: true, mode: 'real' }; }, inspect: async () => ({ status: 'running' }) };
    const app = await buildApp({ store, adapter: slow, serveStatic: false }); resources.push(app);
    const payload = { samples: [{ id: '1', prompt: 'hello', expertKitId: '', model: '标准' }] };
    const results = await Promise.all([app.inject({ method: 'POST', url: '/api/runs', payload }), app.inject({ method: 'POST', url: '/api/runs', payload })]);
    expect(results.map(r => r.statusCode).sort()).toEqual([201, 409]);
    const run = results.find(r => r.statusCode === 201)!.json().run; run.status = 'completed'; store.save(run);
    expect((await app.inject({ method: 'POST', url: `/api/runs/${run.id}/pause`, payload: {} })).statusCode).toBe(409);
    expect(store.get(run.id)?.status).toBe('completed');
  });
  it('routes pause resume stop and manual recheck to the active run', async () => {
    const store = new Store(':memory:'); let focused = false;
    const controlled: AppAdapter = { ...adapter, inspect: async () => ({ status: 'waiting_human', question: { id: 'q', kind: 'text', questions: [{ text: '说明', options: [] }] } }), focus: async () => { focused = true; } };
    const app = await buildApp({ store, adapter: controlled, serveStatic: false }); resources.push(app);
    const start = await app.inject({ method: 'POST', url: '/api/runs', payload: { samples: [{ id: '001', prompt: 'test', model: '标准' }], config: { pollIntervalMs: 10 } } }); const id = start.json().run.id;
    const until = Date.now() + 1000; while (store.get(id)?.samples[0].status !== 'waiting_human' && Date.now() < until) await new Promise(r => setTimeout(r, 10));
    expect((await app.inject({ method: 'POST', url: `/api/runs/${id}/samples/001/focus`, payload: {} })).statusCode).toBe(200); expect(focused).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/api/runs/${id}/pause`, payload: {} })).json().run.paused).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/api/runs/${id}/samples/001/resume`, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/runs/${id}/resume`, payload: {} })).json().run.paused).toBe(false);
    expect((await app.inject({ method: 'POST', url: `/api/runs/${id}/stop`, payload: {} })).json().run.stopRequested).toBe(true);
  });
  it('streams subsequent run changes after the initial SSE response', async () => {
    const store = new Store(':memory:'); const app = await buildApp({ store, adapter: { ...adapter, inspect: async () => ({ status: 'running' }) }, serveStatic: false }); resources.push(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const run = (await app.inject({ method: 'POST', url: '/api/runs', payload: { samples: [{ id: 'sse', prompt: 'test', model: '标准' }], config: { pollIntervalMs: 10 } } })).json().run;
    const abort = new AbortController();
    try {
      const response = await fetch(`${address}/api/runs/${run.id}/events`, { signal: abort.signal }); const reader = response.body!.getReader();
      const first = await reader.read(); expect(new TextDecoder().decode(first.value)).toContain(run.id);
      await app.inject({ method: 'POST', url: `/api/runs/${run.id}/pause`, payload: {} });
      let chunks = ''; const deadline = Date.now() + 1000;
      while (!chunks.includes('"paused":true') && Date.now() < deadline) { const next = await reader.read(); chunks += new TextDecoder().decode(next.value); }
      expect(chunks).toContain('"paused":true');
    } finally { abort.abort(); }
  });
});

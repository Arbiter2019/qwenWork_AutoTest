import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { CSV_TEMPLATE, parseCsv } from '../../../packages/core/src/csv.ts';
import { metrics } from '../../../packages/core/src/metrics.ts';
import { reportCsv, reportHtml, reportJson } from '../../../packages/core/src/report.ts';
import { Scheduler } from '../../../packages/core/src/scheduler.ts';
import type { AppAdapter, RunStore } from '../../../packages/core/src/types.ts';
import { launchApp, pickAppPath, readAppConfig, saveAppPath, validateAppPath } from './app-config.ts';

const sampleSchema = z.object({ id: z.string().trim().min(1).max(500), prompt: z.string().min(1).max(1_000_000).refine(v => !!v.trim(), 'Prompt 必填'), expertKitId: z.string().trim().max(500).default(''), model: z.enum(['标准', '高级']).default('标准') }).strict();
const nonNegative = z.number().int().min(0).max(86_400_000);
const configSchema = z.object({ concurrency: z.number().int().min(1).max(32).optional(), maxRetries: z.number().int().min(0).max(100).optional(), timeoutMs: z.number().int().min(1).max(86_400_000).optional(), batchIntervalMs: nonNegative.optional(), retryInitialMs: nonNegative.optional(), retryStepMs: nonNegative.optional(), retryMaxMs: nonNegative.optional(), pollIntervalMs: z.number().int().min(10).max(60_000).optional() }).strict();
const startSchema = z.object({ name: z.string().trim().max(120).default('测试运行'), samples: z.array(sampleSchema).min(1).max(10_000), config: configSchema.default({}) }).strict().refine(v => new Set(v.samples.map(s => s.id)).size === v.samples.length, 'ID 不可重复');
const localHostname = (host: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host.toLowerCase());
function parseLocalOrigin(value: string): boolean { try { const url = new URL(value); return url.protocol === 'http:' && localHostname(url.hostname) && !url.username && !url.password; } catch { return false; } }

export interface BuildOptions {
  adapter: AppAdapter; store: RunStore; serveStatic?: boolean; staticRoot?: string; recover?: boolean; appConfigPath?: string;
  desktopPlatform?: NodeJS.Platform; selectApp?: () => Promise<string | undefined>; launchDesktopApp?: (path: string) => Promise<void>; appConnectTimeoutMs?: number;
}
export async function buildApp({ adapter, store, serveStatic = true, staticRoot = resolve('dist/web'), recover = false, appConfigPath = resolve('data/app-config.json'), desktopPlatform = process.platform, selectApp = () => pickAppPath(desktopPlatform), launchDesktopApp = path => launchApp(path, process.env.QWEN_CDP_ENDPOINT ?? 'http://127.0.0.1:9229', desktopPlatform), appConnectTimeoutMs = 15_000 }: BuildOptions) {
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });
  const scheduler = new Scheduler(store, adapter);
  let creatingRun = false;
  let appConfig = readAppConfig(appConfigPath, desktopPlatform);
  let appConfigBusy = false;
  async function withAppLock<T>(action: () => Promise<T>): Promise<T> {
    if (appConfigBusy) throw Object.assign(new Error('应用选择或连接正在处理中，请稍候'), { statusCode: 409 });
    appConfigBusy = true; try { return await action(); } finally { appConfigBusy = false; }
  }
  app.addHook('onRequest', async (request, reply) => {
    let hostname = ''; try { hostname = new URL(`http://${request.headers.host ?? ''}`).hostname; } catch {}
    if (!localHostname(hostname)) return reply.code(403).send({ message: '仅允许本机访问' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if ((origin && !parseLocalOrigin(origin)) || request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ message: '不允许跨站修改测试数据' });
      if (!request.headers['content-type']?.startsWith('application/json')) return reply.code(415).send({ message: '请使用 JSON 提交请求' });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ message: error.issues.map(i => `${i.path.join('.') || '输入'}：${i.message}`).join('；') });
    const e = error as Error & { statusCode?: number };
    return reply.code(e.statusCode ?? 400).send({ message: e.statusCode === 413 ? '文件超过 10 MB 限制' : e.message });
  });
  const getRun = (id: string) => { const run = store.get(id); if (!run) throw Object.assign(new Error('测试运行不存在'), { statusCode: 404 }); return run; };
  app.get('/api/health', async () => ({ adapter: await adapter.health() }));
  app.get('/api/app-config', async () => appConfig);
  app.post('/api/app-config', async request => withAppLock(async () => {
    const { path } = z.object({ path: z.string().trim().min(1).max(1000) }).strict().parse(request.body);
    appConfig = saveAppPath(appConfigPath, path, desktopPlatform); return appConfig;
  }));
  app.post('/api/app-config/pick', async () => withAppLock(async () => {
    const path = await selectApp(); if (!path) return { ...appConfig, cancelled: true };
    appConfig = saveAppPath(appConfigPath, path, desktopPlatform); return appConfig;
  }));
  app.post('/api/app-config/start', async () => withAppLock(async () => {
    if (!appConfig.appPath) throw new Error('请先选择千问办公 App 路径');
    const path = validateAppPath(appConfig.appPath, desktopPlatform);
    let health = await adapter.health();
    if (health.connected) return { adapter: health, message: '千问办公已连接，无需重新启动' };
    await launchDesktopApp(path);
    const deadline = Date.now() + appConnectTimeoutMs;
    do {
      health = await adapter.health(); if (health.connected) return { adapter: health, message: '千问办公已连接' };
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    throw Object.assign(new Error('尚未连接千问办公。如果 App 已运行，请先保存任务并正常退出，再点击“启动并连接”；平台不会自动退出 App。'), { statusCode: 409 });
  }));
  app.get('/api/template.csv', async (_request, reply) => reply.type('text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="qwenwork-template.csv"').send(CSV_TEMPLATE));
  app.post('/api/import', async request => { const { csv } = z.object({ csv: z.string().max(10 * 1024 * 1024) }).strict().parse(request.body); const result = parseCsv(csv); return { samples: result.samples, errors: result.errors.map(e => ({ row: e.line, message: e.message })) }; });
  app.get('/api/runs', async () => ({ runs: store.list() }));
  app.post('/api/runs', async (request, reply) => {
    const input = startSchema.parse(request.body);
    if (creatingRun || store.list().some(r => !['completed', 'stopped'].includes(r.status))) return reply.code(409).send({ message: '已有测试运行占用执行器，请先完成或停止该运行' });
    creatingRun = true;
    try {
      const health = await adapter.health(); if (!health.connected || health.mode !== 'real') return reply.code(409).send({ message: health.message || '千问办公未连接，无法启动真实测试' });
      const run = await scheduler.start(input.samples, input.config, input.name || '测试运行'); return reply.code(201).send({ run });
    } finally { creatingRun = false; }
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id', async request => { const run = getRun(request.params.id); return { run, metrics: metrics(run) }; });
  app.post<{ Params: { id: string; action: string } }>('/api/runs/:id/:action', async request => {
    const { id, action } = request.params; const current = getRun(id);
    if (['completed', 'stopped'].includes(current.status)) throw Object.assign(new Error('该测试已结束，不能再修改运行状态'), { statusCode: 409 });
    if (action === 'pause') scheduler.pause(id);
    else if (action === 'resume') await scheduler.resume(id);
    else if (action === 'stop') scheduler.stop(id);
    else throw Object.assign(new Error('操作不存在'), { statusCode: 404 });
    return { run: getRun(id) };
  });
  app.post<{ Params: { id: string; sampleId: string; action: string } }>('/api/runs/:id/samples/:sampleId/:action', async request => {
    const { id, sampleId, action } = request.params; const run = getRun(id); const sample = run.samples.find(s => s.id === sampleId); if (!sample) throw Object.assign(new Error('样本不存在'), { statusCode: 404 });
    if (action === 'focus') { const ref = sample.attempts.at(-1)?.ref; if (!ref) throw new Error('没有已确认的 App 任务ID'); if (!adapter.focus) throw new Error('当前适配器不支持定位，请使用任务ID在 App 中查找'); await adapter.focus(ref); }
    else if (action === 'resume') await scheduler.resolve(id, sampleId, 'recheck');
    else if (action === 'resolve') { const { resolution } = z.object({ resolution: z.enum(['failed', 'stopped']) }).strict().parse(request.body); await scheduler.resolve(id, sampleId, resolution === 'failed' ? 'failed' : 'cancelled'); }
    else throw Object.assign(new Error('操作不存在'), { statusCode: 404 });
    return { run: getRun(id) };
  });
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>('/api/runs/:id/export', async (request, reply) => {
    const run = getRun(request.params.id); const format = z.enum(['csv', 'json', 'html']).parse(request.query.format);
    const types = { csv: 'text/csv; charset=utf-8', json: 'application/json; charset=utf-8', html: 'text/html; charset=utf-8' };
    return reply.type(types[format]).header('content-disposition', `attachment; filename="qwenwork-${run.id}.${format}"`).send({ csv: reportCsv, json: reportJson, html: reportHtml }[format](run));
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/events', async (request, reply) => {
    getRun(request.params.id); reply.hijack(); const res = reply.raw; res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
    const emit = () => { const run = store.get(request.params.id); if (run) res.write(`data: ${JSON.stringify({ run, metrics: metrics(run) })}\n\n`); };
    emit(); const onChange = (run: { id: string }) => { if (run.id === request.params.id) emit(); }; scheduler.on('change', onChange); const timer = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    res.on('close', () => { clearInterval(timer); scheduler.off('change', onChange); });
  });
  if (serveStatic && existsSync(staticRoot)) { await app.register(staticPlugin, { root: staticRoot }); app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ message: '接口不存在' }) : reply.sendFile('index.html')); }
  else app.setNotFoundHandler((_request, reply) => reply.code(404).send({ message: '接口不存在，页面请先运行 npm run build' }));
  app.addHook('onClose', async () => {
    scheduler.dispose();
    for (const run of store.list()) await scheduler.wait(run.id);
    store.close?.();
  });
  if (recover) await scheduler.recover();
  return app;
}

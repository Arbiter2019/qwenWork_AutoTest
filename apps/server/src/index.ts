import { resolve } from 'node:path';
import { buildApp } from './api.ts';
import { Store } from '../../../packages/storage/src/store.ts';
import { QwenAdapter } from '../../../packages/qwen-adapter/src/index.ts';

const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1–65535');
const store = new Store(resolve(process.env.QWEN_TEST_DB ?? 'data/platform.db'));
const adapter = new QwenAdapter({ endpoint: process.env.QWEN_CDP_ENDPOINT ?? 'http://127.0.0.1:9229', dbPath: process.env.QWEN_APP_DB });
const app = await buildApp({ store, adapter, recover: true, appConfigPath: resolve(process.env.QWEN_APP_CONFIG ?? 'data/app-config.json') });
await app.listen({ host: '127.0.0.1', port });
console.log(`千问办公测试平台：http://127.0.0.1:${port}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });

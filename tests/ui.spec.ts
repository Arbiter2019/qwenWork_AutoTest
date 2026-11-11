import { test, expect } from '@playwright/test';

test('CSV 模板紧邻上传入口，导入后展示预览和配置', async ({ page }) => {
  await page.route('**/api/health', r => r.fulfill({ json: { adapter: { connected: true, mode: 'real', version: '2.0.1' } } }));
  await page.route('**/api/runs', r => r.fulfill({ json: { runs: [] } }));
  await page.route('**/api/import', r => r.fulfill({ json: { samples: [{ id: '001', prompt: '请回复测试通过', expertKitId: '', model: '标准' }], errors: [] } }));
  await page.goto(process.env.UI_URL ?? 'http://127.0.0.1:5173');
  await expect(page.getByRole('link', { name: '下载 CSV 模板' })).toHaveAttribute('href', '/api/template.csv');
  await page.locator('input[type=file]').setInputFiles({ name: 'sample.csv', mimeType: 'text/csv', buffer: Buffer.from('ID,Prompt,专家套件ID,模型类型\n001,请回复测试通过,,标准') });
  await expect(page.getByText('请回复测试通过', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始测试' })).toBeEnabled();
  await expect(page.getByLabel('并发数量')).toHaveValue('2');
});

test('连接断开时禁止提交，错误行清楚展示', async ({ page }) => {
  await page.route('**/api/health', r => r.fulfill({ json: { adapter: { connected: false, mode: 'real', message: '请连接千问办公' } } }));
  await page.route('**/api/runs', r => r.fulfill({ json: { runs: [] } }));
  await page.route('**/api/import', r => r.fulfill({ json: { samples: [], errors: [{ row: 3, message: 'ID 重复' }] } }));
  await page.goto(process.env.UI_URL ?? 'http://127.0.0.1:5173');
  await page.locator('input[type=file]').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('ID,Prompt,专家套件ID,模型类型') });
  await expect(page.getByText('第 3 行：ID 重复')).toBeVisible();
  await expect(page.getByRole('button', { name: '开始测试' })).toBeDisabled();
});

test('运行报告可查看实际输入、尝试和导出入口', async ({ page }) => {
  const run = { id: 'run-ui', name: '界面验收', mode: 'real', status: 'completed', createdAt: new Date().toISOString(), currentBatch: 0, paused: false, config: { concurrency: 2, maxRetries: 2 }, samples: [{ id: '001', prompt: '原始输入', model: '标准', expertKitId: '', batch: 0, status: 'succeeded', durationMs: 2100, humanWaitMs: 0, attempts: [{ id: 'attempt-1', index: 0, status: 'succeeded', ref: { taskId: 'app-task-1' }, submittedAt: new Date().toISOString(), actualInput: '实际输入内容', output: '执行结果', collection: 'partial', collectionReason: '仅本机事件', events: [] }] }] };
  await page.route('**/api/health', r => r.fulfill({ json: { adapter: { connected: true, mode: 'real' } } }));
  await page.route('**/api/runs', r => r.fulfill({ json: { runs: [run] } }));
  await page.route('**/api/runs/run-ui', r => r.fulfill({ json: { run, metrics: { total: 1, succeeded: 1, failed: 0, unfinished: 0, firstSuccessRate: 1, overallSuccessRate: 1, averageDurationMs: 2100, humanWaitMs: 0, rateLimitCount: 0 } } }));
  await page.goto(process.env.UI_URL ?? 'http://127.0.0.1:5173');
  await page.getByRole('menuitem', { name: '测试记录' }).click();
  await page.getByRole('button', { name: '查看报告' }).click();
  await expect(page.getByRole('link', { name: 'CSV 明细' })).toHaveAttribute('href', '/api/runs/run-ui/export?format=csv');
  await expect(page.getByRole('link', { name: 'HTML 报告' })).toBeVisible();
  await page.getByRole('button', { name: '查看详情' }).click();
  await expect(page.getByText('app-task-1', { exact: true })).toBeVisible();
  await expect(page.getByText('实际输入内容', { exact: true })).toBeVisible();
  await expect(page.getByText('执行结果', { exact: true })).toBeVisible();
});

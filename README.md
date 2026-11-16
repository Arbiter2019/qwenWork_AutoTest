# 千问办公自动化测试平台

本机单用户测试工具：CSV 导入 → 固定分批执行 → 采集 App 可观测事件 → CSV / JSON / HTML 报告。界面采用 Ant Design。

## 本地启动

需要 Node.js 22.12 或更新的受支持 LTS 版本。建议使用 Node.js 22；首次安装 SQLite 依赖可能需要网络下载预编译组件。

```bash
npm install
npm run build
npm start
```

打开 <http://127.0.0.1:4317>。服务仅绑定本机地址，不支持多人远程访问。

开发前端：`npx vite --config apps/web/vite.config.ts`，执行服务仍需单独运行 `npm start`。

## 连接千问办公

使用已登录的千问办公桌面 App，需要开启仅本机可访问的 Electron 调试端口。请先确认没有运行中任务，再**正常退出**千问办公，不要强制退出或覆盖安装包。

macOS 启动示例：

```bash
open -a /Applications/QwenWorkCN.app --args --remote-debugging-address=127.0.0.1 --remote-debugging-port=9229
```

Windows 使用实际安装的程序路径启动：

```powershell
& "C:\实际安装位置\QwenWorkCN.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9229
```

Windows 启动示例和路径适配不代表本次已完成 Windows 实测。当前 App 版本的能力、真实验收及未覆盖场景以 [验证记录](docs/verification.md) 为准。App 升级可能需要适配器更新。

平台不会修改 App 包或写入 App 数据库，不使用 macOS Accessibility，也不会替你自动登录。调试端口可以控制 App，请保持仅本机监听。

新建测试页的“千问办公 App”卡片支持选择并保存安装路径。macOS 按钮显示“在访达中选择 App”，Windows 显示“浏览本地应用”；“启动并连接”会使用选择的路径启动调试参数并等待回环端口连接。平台不会自动退出已运行的 App；如果端口被已运行实例占用，请先保存任务并正常退出后再启动。

## 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `4317` | 本地 Web 服务端口 |
| `QWEN_CDP_ENDPOINT` | `http://127.0.0.1:9229` | 本机 App 调试地址 |
| `QWEN_APP_DB` | 由适配器按系统解析 | App 的 agents.db 路径，只读 |
| `QWEN_TEST_DB` | `data/platform.db` | 平台自有运行数据 |

`data/` 默认不纳入 Git。Prompt、回复和可观测任务事件保存在本地运行数据库，导出报告也可能包含这些内容。

## CSV 与运行规则

上传入口旁可下载模板，四列表头必须为：

```csv
ID,Prompt,专家套件ID,模型类型
001,请用一句话解释固定分批执行。,,标准
002,请比较方案A与方案B并输出两点建议。,,高级
```

- ID、Prompt 必填；ID 在文件内唯一并按文本处理。专家套件可为空，每行最多一个。
- 本机已验证“外卖经营助手体验版”的套件ID为 `tbsg-business-assistant`；四条业务测试样本见 `examples/business-standard.csv`，导入后将并发设为 4。
- 模型只支持“标准”“高级”，为空默认“标准”。导入错误显示行号，修正前禁止启动。
- 默认并发 2，以固定批次执行；当前批次的全部样本及其重试结束后才启动下一批。
- 默认额外重试 2 次（总计最多 3 次），每次新建 App 任务。系统失败、限频及确认停止后的超时进入重试。
- 默认单次执行超时 10 分钟、批次间隔 10 秒；重试等待 10 秒起，每次增加 5 秒，上限 60 秒。服务端要求更长等待时遵循服务端时间。
- 有选项的 userAskQuestion 每道题选第一项；自由输入和权限确认交给人工。人工等待暂停执行超时计时，但计入样本总耗时。
- 提交或停止结果不明时转人工核对，避免盲目重复提交。平台重启后先恢复核对，再允许新提交。

## 报告口径

成功以 App 明确的任务成功终止状态为准，本期不评价回答质量。

- 一次成功率 = 首次尝试成功样本数 ÷ 导入样本总数。
- 总体成功率 = 最终成功样本数 ÷ 导入样本总数。
- 平均耗时只统计最终成功样本的总耗时，包含重试与等待，不含首次提交前排队。失败耗时另列。
- 中途停止的报告标明未全部完成，分母仍为原导入总数。

CSV 为任务及尝试明细，并增加“关联信息”列，内容是该次尝试的完整关联 JSON（包含 taskId、chatId、subChatId、sessionId、inputId、messageId 等已观测字段）；JSON 保留运行配置、任务关联、回复和事件；HTML 汇总同步展示关联信息。仅采集本平台创建且明确关联的任务；“完整”仅相对已经验证的 App 可观测事件，不承诺服务端内部推理数据。

左侧任务状态通过 DOM MutationObserver 监听并推送给执行器；状态变化和本地消息投影共同采集。`idle`、`unseen` 仅作为状态事件，不能独立证明成功；轮询负责补采断线、未渲染列表项及持久终态。当前版本标准/高级使用的消息投影可以采集回复和工具片段，但不是无遗漏的服务端事件流。

## 验证与规格

```bash
npm test
npm run typecheck
npm run build
npm run test:ui
```

浏览器测试需 Playwright 对应浏览器版本；必要时运行 `npx playwright install chromium`。真实 App 验收消耗正常模型额度，测试报告应区分自动可控适配器测试和真实 App 测试。

- [规格与设计](docs/superpowers/specs/2026-11-11-qwenwork-autotest-design.md)
- [实现计划](docs/superpowers/plans/2026-11-11-qwenwork-autotest.md)
- [验证记录](docs/verification.md)

仓库按用户要求先本地开发，由用户后续手动同步 GitHub。
# qwenWork_AutoTest

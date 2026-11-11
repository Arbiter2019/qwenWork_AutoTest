# 千问办公测试平台 Implementation Plan

**Goal:** 交付本地运行、可观测、可恢复的 CSV 批量测试平台。

**Architecture:** React/Ant Design 控制台通过本地 HTTP 操作执行器。执行器依赖独立 App 适配器和平台自有 SQLite；Playwright/CDP 驱动真实 App，App 数据只读。

**Tech Stack:** Node.js 22、TypeScript、Fastify、SQLite、React、Vite、Ant Design、Playwright、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-11-qwenwork-autotest-design.md`（用户已批准）。

## Global Constraints

- CSV 四列：ID、Prompt、专家套件ID、模型类型；上传旁模板超链接。
- 默认并发 2、额外重试 2、超时 600 秒、批次间隔 10 秒。
- 重试等待 10 秒起、每次增加 5 秒、上限 60 秒；尊重更长的限频等待。
- 固定批次屏障；未知提交/停止必须核对，不自动重复提交。
- 自动追问只选首项；自由输入和权限确认转人工。
- 平均耗时只计成功样本总耗时；两种成功率分母均为导入样本数。
- App 只读数据库、不提取认证信息、不使用 macOS Accessibility。
- 本机回环访问；真实/模拟验证明确区分；本次只声明 Mac 实测。

## Task 1：桌面接入验证与契约

Files: `packages/qwen-adapter/src/*`, `docs/verification.md`。接入探测在本地执行，结果写入验证记录，未交付独立探测脚本。

- [x] 正常退出空闲 App，以回环调试参数启动，确认 CDP targets。
- [x] 查看 DOM 与事件格式，不输出历史消息或凭据。
- [x] 验证提交、模型/专家套件选择与 chat/subChat/session 关联，明确终止事件。
- [x] 两个短任务验证后台并发；采集状态和实际耗时写入证据。
- [x] 定义 `connect/health/submit/observe/answer/stop/reconcile` 适配接口，提交用互斥锁。
- [x] 关键能力已真实验证；完整服务端事件流不可用，按设计标为部分采集，证据见验证记录。

## Task 2：核心与持久化

Files: `packages/core/src/{csv,types,scheduler,metrics,report}.ts`, `packages/storage/src/store.ts`, `tests/core.test.ts`。

Interface: `SampleInput {id,prompt,expertKitId,model}`；`RunConfig {concurrency,maxRetries,timeoutMs,batchIntervalMs,retryInitialMs,retryStepMs,retryMaxMs}`。

- [x] 先写 CSV、批次屏障、重试、限频、停止/恢复、追问及指标测试，确认失败后实现。
- [x] CSV 编码采用 UTF-8/BOM，验证四列表头、重复ID和行号，模板可重新导入。
- [x] 调度以固定 batch 编号和全部终态条件建立屏障，串行操作共享编辑器、后台任务并发执行；新提交同时经过暂停及全局限频门。
- [x] SQLite 保存运行/样本/尝试/事件，提交前落地意图，崩溃恢复先核对。
- [x] 测试 2/2/1 批次、N+1 尝试、10/15…60 秒、50%/75% 指标和 HTML/CSV 转义。

## Task 3：本地服务与报告

Files: `apps/server/src/{index,api}.ts`, `tests/api.test.ts`。

- [x] 先测试 `/api/import`、`/api/runs`、控制操作和三个导出，再实现。
- [x] 仅绑定 127.0.0.1，校验写请求来源，限制上传大小。
- [x] 单运行互斥，SSE 推送与查询返回持久状态。
- [x] 提供模板、CSV/JSON/HTML 下载和任务事件查询；不执行用户提供的命令。

## Task 4：Ant Design 页面

Files: `apps/web/src/{App,ImportPanel,RunView,History}.tsx`, `apps/web/src/styles.css`, `tests/ui.spec.ts`。

- [x] 页面使用 Ant Design 蓝色 #1677ff、白色面板、灰色背景、中文字体、24px 间距。
- [x] 导入与模板超链接、配置、预览、运行控制、样本表及事件抽屉、历史和下载入口。
- [x] 真实连接不可用时禁止真实执行；保留模式标识以区分验证数据，首版页面不提供模拟执行入口。
- [x] 浏览器验证上传、下载、创建、暂停、恢复与报告；检查窄屏布局及控制台错误。

## Task 5：集成与交付

Files: `README.md`, `.gitignore`, `docs/verification.md`。

- [x] 运行类型检查、核心/API 测试、生产构建及浏览器检查。
- [x] 少量真实任务验证 App 标准/高级、并发和报告字段；未覆盖套件/追问明确记录。
- [x] 启动本地生产服务，给出地址、启动命令和数据位置。
- [x] 自审规格 A01–A14，修复缺口；保留本地 Git 提交供用户手动同步。

执行方式：在当前独立新项目目录开发，不创建额外 worktree。按职责可委派独立模块，真实接入由主执行者验证；不推送 GitHub。

完成记录：38 个自动测试、4 个浏览器测试、类型检查与构建通过；最终真实四业务样本并发运行全部成功，3 次限频自动重试，详细指标见 `docs/verification.md`。所有代码保留在本地分支，不推送 GitHub。

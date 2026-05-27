# 联合优化开发计划

## 规划原则

本计划结合 Build Web Apps 和 Codex Security 两条视角：

- Build Web Apps：优先提升 Electron/React 工作台的可用性、性能、可维护性和发布体验。
- Codex Security：每个阶段都保留威胁建模、发现、验证、攻击路径分析和回归门禁，避免功能扩展突破合规边界。

所有提交必须先更新版本号，并通过 `.githooks/pre-commit` 的版本、密钥、生成物和测试检查。

## P0：维护基线和计划收口

目标：

- GitHub 成为唯一维护远程。
- 当前产品主线统一为 Electron + React + TypeScript。
- Python/PyQt6 仅保留为兼容层和回归参考。
- 版本号在桌面端可见，每次提交必须 bump。

验收：

- `origin` 指向 GitHub。
- `package.json`、`package-lock.json` 版本一致。
- `npm run hooks:install` 后提交缺少版本变更会被拦截。
- 旧 PyInstaller 打包入口不再出现在维护计划中。

状态：已完成。

## P1：官方 API 用量历史与趋势

目标：

- 为官方 API 接入配置增加按天用量历史。
- 设置页展示近 7/30 天调用量、失败数、配额耗尽次数和可重试失败趋势。
- 保留结构化错误码、配额重置时间和最近失败原因。

Build Web Apps 要求：

- 趋势面板使用紧凑表格或轻量图表，适合频繁查看。
- 筛选器状态不阻塞主工作台刷新。
- 避免一次性拉取过量历史，默认近 7 天，用户主动切换到 30 天。

Codex Security 要求：

- API Key 不进入趋势数据或审计消息。
- 历史查询参数必须有上限和白名单。
- 配额、认证、限流错误必须保留可审计分类。

验收：

- Repository 提供按天聚合查询。
- ApplicationCore 暴露历史摘要 API。
- Electron IPC 有输入边界校验。
- 设置页展示历史摘要和失败筛选。
- 新增 `official api usage history` 相关回归测试。

状态：已完成。

## P2：工作台前端性能和信息架构

目标：

- 拆分当前大型 `App.tsx`，降低重渲染和维护成本。
- 审计日志、设置页、AI 面板、线索详情等模块按视图拆分。
- 长列表增加分页、窗口化或按需加载策略。

Build Web Apps 要求：

- 消除独立请求 waterfall，刷新流程继续使用并行请求。
- 避免 barrel import 引入 Node-only 或过大模块到 renderer。
- 对搜索结果、审计日志、线索表格使用 `Map`/`Set` 派生索引，避免重复线性查找。
- 对高频输入筛选使用延迟值或显式筛选按钮，保证输入响应。
- 保持工作台密度、扫描效率和当前专业工具风格。

Codex Security 要求：

- Renderer 只能通过 preload 白名单访问能力。
- 新增视图不能直接读取本地文件、环境变量或 Node API。
- 所有新 IPC 参数都要在 main 进程校验。

验收：

- `App.tsx` 拆分为视图组件和共享 hooks。
- Renderer bundle 不包含 Node-only 模块。
- 审计日志和线索列表在 1,000 条内交互不卡顿。
- `npm run build` 输出体积没有异常增长。

## P3：安全专项扫描和高风险边界

目标：

- 建立仓库级威胁模型。
- 对 IPC、URL 请求、密钥、导出、隐私清理、平台采集和手动导入做专项安全扫描。
- 将扫描发现转成测试和开发门禁。

Codex Security 阶段：

- Threat model：更新资产、入口、信任边界、攻击者能力。
- Finding discovery：覆盖 IPC、平台请求、SQLite 查询、文件写入、CSV 导出、密钥存储。
- Validation：只保留可达且有真实影响的候选。
- Attack-path analysis：为有效问题标注来源、控制、sink、影响和严重度。

Build Web Apps 配合：

- 对安全提示、恢复建议、导出预览和隐私清理确认流程做可用性检查。
- 高风险动作保持明确确认，不用隐藏式自动执行。

验收：

- 新增或更新安全扫描报告。
- 新增缺失测试，覆盖 IPC 参数边界、SSRF、导出公式、路径限制和密钥回显。
- 所有高风险平台批量采集限制继续由 manifest 派生。

## P4：发布治理

目标：

- 恢复并验证 `asar` 或明确保留 `asar: false` 的发布理由。
- 完成 Windows 代码签名准备。
- 增加发布前检查清单。

Build Web Apps 要求：

- 发布版启动后 renderer 资源路径、preload、Playwright 浏览器路径和版本显示都正常。
- 发布包首次启动体验清晰，不展示开发日志或底层错误堆栈。

Codex Security 要求：

- 发布包不包含 `.env`、本地数据库、日志、Profile、密钥备份或测试数据。
- 生成 SBOM 或至少记录依赖审计结果。
- 发布前执行 `npm audit --omit=dev`、构建、测试和隐私痕迹检查。

验收：

- `npm run package` 生成可安装包。
- 安装后启动、版本显示、平台状态检查、导出保存对话框可用。
- 发布检查清单记录在文档中。

## P5：平台扩展策略

目标：

- 优先官方 API 和手动导入，减少对高风险登录态网页采集的依赖。
- 新增平台必须先补 manifest、能力策略、合规说明和失败分类。

Build Web Apps 要求：

- 平台中心清晰区分已接入、官方 API 优先、手动导入、计划中和不可执行目标。
- 配置表单展示字段要求、配额、风险和最近失败，不堆叠冗余说明。

Codex Security 要求：

- 高风险登录平台默认单条低频采集。
- 批量采集限制和保护暂停从 manifest 派生。
- 新平台不得绕过登录/验证码/风控，也不得静默保存密码。

验收：

- 每个新增平台都有 manifest 测试。
- 官方 API/手动导入优先的平台不进入真实网页采集链路。
- 风控、限流、权限、登录必需错误都能落审计。

## 每轮开发固定流程

1. 运行 `npm version patch --no-git-tag-version` 或按语义版本手动 bump。
2. 明确本轮改动归属阶段和安全边界。
3. 更新或新增测试。
4. 执行 `npm run check:types`、`npm test`。
5. 涉及发布、IPC、安全、导出、密钥、URL、文件系统时执行 `npm run build` 和 `npm audit --omit=dev`。
6. Python 兼容层变更时执行 `py -3 -m compileall -q core storage network tests` 和 `py -3 -m unittest discover -s tests`。
7. 提交并推送 GitHub。

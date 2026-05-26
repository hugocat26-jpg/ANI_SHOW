# 实施进度

## 当前版本

- 当前版本：`0.1.2`
- 当前维护远程：GitHub `https://github.com/hugocat26-jpg/ANI_SHOW.git`
- 当前产品主线：Electron + React + TypeScript + Playwright + SQLite
- Python/PyQt6 代码定位：历史兼容层和回归参考，不再作为新功能主线
- 旧 PyInstaller 打包入口已移除，发布以 Electron Builder 为准

## 开发钩子与质量门禁

- 已新增版本化 Git hook：`.githooks/pre-commit`，通过 `npm run hooks:install` 安装到本地 `core.hooksPath`。
- hook 入口调用 `scripts/pre-commit.mjs`，阻止提交生成物、运行数据、数据库、日志、`.env`、本地 `config.json` 等文件。
- hook 会对暂存文本做高置信度密钥扫描，拦截真实 API Key 形态，保留测试用短 token 和 `env:VAR_NAME` 引用。
- hook 强制每次提交同时更新 `package.json` 和 `package-lock.json` 的版本号，且两个版本必须一致；推荐用 `npm version patch --no-git-tag-version` 后再提交。
- hook 按变更范围分流：
  - TypeScript/Electron 相关变更：执行 `npx tsc -b` 和 `npm test`。
  - Python 兼容层相关变更：执行 `python/py -m compileall -q core storage network tests` 和 `python/py -m unittest discover -s tests`。
  - 文档等非运行时代码变更：只执行提交内容保护检查和版本检查。

## 已完成

- Electron 主进程、preload、renderer 构建链路可用，并通过 Electron Builder 打包。
- 桌面端显示当前软件版本，版本来自 Electron `app.getVersion()`。
- 平台 manifest/治理元数据、平台能力策略、平台状态检查和账号保护已落地。
- Google/Bing 搜索，YouTube/B站视频解析与评论采集基础能力已落地。
- 抖音、TikTok、小红书、Instagram、微博、知乎、快手、Reddit 等平台已有第一阶段搜索、内容解析和评论解析能力。
- 官方 API 接入配置、Google Custom Search API、YouTube Data API 骨架和用量可观测性已落地。
- 手动导入管线已支持通用评论、微信公众号文章评论、社媒评论、电商评价 CSV，并支持导入预览、重复检测和冲突策略。
- 线索中心、跟进提醒、日历导出、CSV 导出、导出脱敏预览和公式注入防护已落地。
- AI Provider 配置、密钥加密/环境变量引用、密钥备份、失败策略、恢复建议、用量和成本估算已落地。
- 隐私清理预估、Profile 安全删除、本地日志清理和审计日志已落地。
- 审计日志支持按动作前缀、目标类型、关键词和数量上限筛选；桌面端新增“审计日志”入口。
- 手动导入面板显示模板字段、必填字段和冲突策略摘要。

## 当前待办

当前待办已整理到 [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)，按 P1-P5 推进：

1. P1：官方 API 用量历史与趋势。
2. P2：工作台前端性能和信息架构。
3. P3：安全专项扫描和高风险边界。
4. P4：发布治理。
5. P5：平台扩展策略。

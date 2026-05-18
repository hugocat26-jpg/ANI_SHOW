# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

客户线索挖掘PC端工具 — Windows桌面应用，从社交媒体（抖音/小红书/B站/YouTube/Instagram/Facebook）采集评论，通过关键词+大模型双重机制识别购买意向，支持Excel/CSV导出。

## 常用命令

```bash
# 运行（本地模式）
python main.py

# 运行（联网服务器模式）
python main.py --mode server --host 0.0.0.0 --port 8765

# 打包（onedir目录模式，推荐）
python build.py --onedir

# 打包（单文件模式）
python build.py --onefile

# 查看SQLite数据库
sqlite3 ~/.client_lead_miner/data/lead_miner.db
```

## 核心架构

**分层设计**：UI层(PyQt6) → 核心服务层(core/) → 数据层(storage/) + LLM层(llm/)

**关键模式**：
- `BaseScraper` — 爬虫基类（模板方法），6个平台子类各自实现 `get_comments()`，通过 `ScraperFactory.register()` 注册
- `TaskWorker(QThread)` — 采集任务在独立线程执行，通过 `threading.Event` 控制暂停/恢复/停止，`TaskSignals(pyqtSignal)` 线程安全更新UI
- `AppSettings` — 单例配置管理，JSON持久化到 `~/.client_lead_miner/config.json`
- `Database` — 单例数据库，`threading.local()` 保证线程安全，WAL模式
- `IntentRecognizer` — 关键词匹配初筛 → LLM语义校验 → 合并判定意向等级

**采集流程**：`LinkParser.parse(url)` 解析链接 → `TaskManager.create_task()` 创建任务 → `TaskWorker.run()` 执行（scrape → recognize → extract → insert_lead）

## 重要注意事项

- **加密模块导入**：必须用 `from Crypto.Cipher import AES`（不是 `Cryptodome`，pycryptodome 包的模块名是 `Crypto`）
- **浏览器**：仅使用系统Edge浏览器，Playwright配置 `channel="msedge"`，不依赖独立的Chromium安装
- **配置文件路径**：`~/.client_lead_miner/config.json`，API密钥以AES-256-CBC加密存储
- **数据库路径**：`~/.client_lead_miner/data/lead_miner.db`，leads表有 `UNIQUE(user_id, content_id)` 约束用于去重
- **打包产物**：`dist/客户线索挖掘工具/` 目录包含exe和 `_internal/`，两者必须同目录。`dist_clean/` 是整理后的发布目录（含一键安装.bat）
- **打包时注意**：`build.spec` 中 `hiddenimports` 已包含 `playwright.sync_api`、`pandas`、`openpyxl`、`Crypto`

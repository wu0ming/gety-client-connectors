# Gety OpenCode Connector

把本地 OpenCode 的会话历史（`opencode.db`）索引进 Gety，可全文搜索历史 AI
编程对话。

基于官方
[gety-sample-connector](https://github.com/gety-ai/gety-sample-connector)
模板，参考
[gety-codex-connector](https://github.com/gety-ai/gety-codex-connector)
的文档契约实现。

> **实机试用：通过（2026-10-19）**。维护者已实际安装、试用该连接器，功能正常。此为真实使用验证，不代表已覆盖所有系统或 OpenCode/GetY 版本。

## 索引内容

- 每个会话一个文档：`doc_type = opencode:session`，稳定 ID
  `opencode:session:<session_id>`
- 标题：会话标题（默认标题回退为首条用户提问）
- 正文 Markdown：`## Session`（目录/模型/agent/时间）+ 按轮次排列的 `## User` /
  `## OpenCode` 对话；工具调用默认只记一行摘要，工具输出永不索引
- 增量：按 `session_v2.time_updated`
  跟踪，仅重建变化的会话；会话消失时删除对应文档

## 数据源

读取 OpenCode 本地 SQLite 数据库（当前版本 v1.18+ 写入 `session_v2` +
`session_message` 表）。 连接器每次轮询先把 `opencode.db`（含
WAL）复制到临时目录再只读打开，避免与运行中的 OpenCode 抢锁。

目录解析顺序：安装时填写的 `OpenCode data directory` → `XDG_DATA_HOME` →
`%USERPROFILE%\.local\share\opencode`。

## 本地开发

```bash
deno task verify          # 格式化 + lint + 类型检查 + 测试 + 构建
cp .env.example .env      # 可选：自定义 OPENCODE_DIR
deno task runner -- --reset-state   # 本地演练轮询，快照写入 dev/runs/
```

## 安装到 Gety

1. `deno task build`
2. Gety → 设置 → 连接器 → 安装连接器，选择本文件夹（含 `manifest.json`）
3. 按需填写配置项，确认安装

修改代码后：`deno task build` → Gety 中点击 **重启**。

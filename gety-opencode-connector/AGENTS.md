# AGENTS.md — gety-opencode-connector

## 项目概要

把本地 OpenCode 会话历史（SQLite）索引进 Gety 的连接器。基于官方
gety-sample-connector 模板（dev/scripts 目录为模板原样），文档契约参考
gety-codex-connector。

## 关键事实（2026-10-19 实测）

- OpenCode v1.18+ 数据源：`%USERPROFILE%\.local\share\opencode\opencode.db`
  - 权威表：`session_v2`（会话元数据，superset of `session`）+ `session_message`
    （`type` 列存 role：user/assistant/system/synthetic/idle/compaction，
    `data` JSON 内联全部 parts；assistant 的 `content` 是数组：
    text / reasoning / tool / step-start / step-finish）
  - `message` / `part` 表为旧版遗留，已停写，勿用
  - 数据库为 WAL 模式且常被 OpenCode 占用：必须先复制 db + -wal 到临时目录
    再只读打开（见 `openOpencodeDbSnapshot`），勿直连原文件
- 运行时：Gety 内嵌 Deno。本地开发用 `%USERPROFILE%\.local\bin\deno.exe`
  （2.9.7，gh-proxy 镜像下载），需加入 PATH
- `node:sqlite` 在 Deno 2.9 下可用；构建 esbuild `platform: neutral`，
  node 内建模块以 `node:` 前缀 external

## 常用命令

```bash
deno task verify            # fmt + lint + check + test + build（提交前必跑）
deno task runner -- --reset-state   # 本地演练，快照在 dev/runs/
deno task build             # 改源码后必须重新构建（Gety 加载 dist/main.js）
```

## 文档契约（勿破坏）

- `doc_type: opencode:session`，ID：`opencode:session:<ses_id>`（多次轮询稳定）
- 增量依据 `session_v2.time_updated`（epoch ms）；state 含 config_fingerprint，
  配置变更强制全量重建
- 工具调用只索引一行摘要（命令/file_path），工具输出永不索引
- 时间戳一律 RFC 3339（`new Date(ms).toISOString()`）

## 已知限制

- Gety 运行时若内嵌 Deno < 2.2（不支持 node:sqlite），连接器会加载失败——
  届时需换 sql.js(WASM) 或等 Gety 升级
- Trae 侧聊天库（TRAE SOLO CN / Trae CN 的 `ModularData\ai-agent\database.db`）
  是加密 SQLite，无法直接索引；Trae 连接器可用 `~\.trae-cn\memory` 的
  session_memory_*.jsonl 作为替代数据源

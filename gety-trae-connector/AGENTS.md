# AGENTS.md — gety-trae-connector

## 项目概要

把本地 Trae 记忆文件（`~\.trae-cn\memory`）索引进 Gety 的连接器。基于官方
gety-sample-connector 模板（dev/scripts 为模板原样），与 gety-opencode-connector
（同系列，位于 temp_20261015_03）共享文档契约风格。

## 数据源布局（2026-10-19 实测）

```
~\.trae-cn\memory\
├── user_profile.md                      # 全局用户档案
└── projects\<project-slug>\
    ├── project_memory.md                # 项目级记忆
    └── <YYYYMMDD>\
        ├── session_memory_<session_id>.jsonl   # 消息级记忆
        └── topics.md                    # 话题级摘要
```

- JSONL 每行字段：`intent` / `actions[]` / `outcome` / `learned[]` /
  `message_summary_time`（本地时间字符串）/ `message_id` /
  `compact_summary_meta.created_at_ms`（epoch ms，权威时间）
- topics.md 行格式：`[session_id: X | topic_summary_time: T]正文`，无前缀行
  视为上一条的续行
- 文件为明文、无锁，可直接读取；空行/坏行跳过（文件可能正被 Trae 写入）

## 文档契约（勿破坏）

| 来源 | doc_type | ID | 增量依据 |
|---|---|---|---|
| session JSONL | `trae:session` | `trae:session:<sid>` | mtime+size |
| topics.md | `trae:topics` | `trae:topics:<project>:<date>` | mtime+size |
| project_memory.md | `trae:memory` | `trae:memory:<project>` | mtime+size |
| user_profile.md（可选） | `trae:profile` | `trae:profile:user` | mtime+size |

- state 含 config_fingerprint（include_project_memory/include_user_profile），
  配置变更强制全量重建
- 标题：session 取首条 intent；md 文档取首个 `# ` 标题，否则回退
- 时间戳一律 RFC 3339；session 的 doc_updated_at 优先用 created_at_ms

## 常用命令

```bash
deno task verify            # fmt + lint + check + test + build（提交前必跑）
deno task runner -- --reset-state   # 本地演练，快照在 dev/runs/
deno task build             # 改源码后必须重建（Gety 加载 dist/main.js）
```

Deno 2.9.7 在 `%USERPROFILE%\.local\bin\deno.exe`，需先加入 PATH。

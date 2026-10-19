# Gety Trae Connector

将本地 Trae 记忆文件索引到 GetY，方便搜索项目历史、会话摘要和经验记录。

> **实机试用：通过（2026-10-19）**。维护者已实际安装、试用该连接器，功能正常。此为真实使用验证，不代表已覆盖所有系统或 Trae/GetY 版本。

## 能索引什么？

本连接器读取 Trae 在本机保存的 **记忆数据**，并非原始聊天数据库或完整聊天记录。

| 本地文件 | GetY 文档类型 | 是否默认索引 |
| --- | --- | --- |
| `projects/<project>/<YYYYMMDD>/session_memory_<id>.jsonl` | `trae:session`（意图、动作、结果、经验摘要） | 是 |
| `projects/<project>/<YYYYMMDD>/topics.md` | `trae:topics`（话题摘要） | 是 |
| `projects/<project>/project_memory.md` | `trae:memory`（项目记忆） | 是，可关闭 |
| `user_profile.md` | `trae:profile`（全局用户档案） | **否，需要手动开启** |

默认数据目录（Windows）：

```text
%USERPROFILE%\.trae-cn\memory
```

如果你的 Trae 数据保存在其他位置，安装时选择包含 `projects/` 的记忆目录。

## 安装到 GetY

要求：**GetY 0.5.1 或更新版本**（参见 `manifest.json`），并有可运行的 Deno 用于构建（仓库已包含 `dist/main.js`）。

1. 在 `gety-trae-connector` 目录执行 `deno task build`（如使用仓库已提交的 `dist/main.js`，可直接尝试下一步）。
2. 打开 **GetY → 设置 → 连接器 → 安装连接器**。
3. 选择本目录 `gety-trae-connector/`，即包含 `manifest.json` 的目录。
4. 检查记忆目录及隐私选项，确认安装。

## 安装配置

| 配置项 | 默认值 | 用途 |
| --- | --- | --- |
| `memory_dir` | 留空，自动检测 | Trae 记忆目录 |
| `include_project_memory` | `true` | 同步项目级 `project_memory.md` |
| `include_user_profile` | `false` | 可选同步全局用户档案；含个人信息时不建议开启 |

连接器每 **600 秒**按配置轮询一次（`manifest.json`）。只处理匹配目录结构的记忆文件；使用文件修改时间和大小判断增量变化，并在源文件删除或选项变更后同步更新 GetY 文档。

## 开发与检查

在 `gety-trae-connector/` 中运行：

```bash
deno task build           # 构建 dist/main.js
deno task verify          # 格式化、lint、类型检查、单元测试、构建
```

若需本地演练，可参考 `dev/runner.ts` 和 `.env.example`。修改源码后重新运行 `deno task build`，并在 GetY 中重启连接器。

## 隐私与范围

- 本连接器读取本机保存的 Trae 记忆文件，不解密 Trae 的聊天数据库。
- `session_memory_*.jsonl` 是 Trae 保存的 **会话记忆摘要**，不代表完整原文。
- `user_profile.md` 默认不索引，需要显式开启。
- 索引内容会成为 GetY 可搜索文档；请在启用敏感项目记忆或用户档案前检查 GetY 的数据管理方式。

详见仓库 [首页 README](../README.md)。

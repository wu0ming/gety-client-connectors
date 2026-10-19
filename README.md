# GetY Client Connectors

让 GetY 检索多款本地 AI 客户端的会话与记忆。目前在同一仓库维护 **4 款可独立安装的连接器**：

- **DeepSeek Harness（DSH）**：GetY 连接器 + DSH 插件，一键连接，可选择共享工作区（默认全选）。
- **WorkBuddy**：检索本地会话索引与已落盘的 trace；未落盘的云端正文不在覆盖范围内。
- **OpenCode**：从本地 `opencode.db` 索引会话和用户/助手对话；不索引工具输出。
- **Trae**：索引本地记忆摘要、话题、可选项目记忆；全局用户档案默认不索引。

中文文档：[安装与打包](docs/release-readiness.md) ·
[实现经验](docs/connector-playbook.md) · [验证记录](docs/verification.md)。

Four [GetY](https://gety.ai) connectors for searching local AI-client sessions and
memory, plus a reusable development playbook. The maintainer reports that the
new OpenCode and Trae connectors worked on their work computer (2026-10-19).

| Connector | Client | What it indexes | One-click? |
| --- | --- | --- | --- |
| [`dsh/`](dsh/) | DeepSeek Harness | Full session logs (`session.v4.jsonl.zstd`, multi-frame zstd) | Yes — DSH plugin with a workspace picker |
| [`workbuddy/`](workbuddy/) | WorkBuddy | Local session index (SQLite) + local agent traces | Install script (WorkBuddy has no plugin hook) |
| [`gety-opencode-connector/`](gety-opencode-connector/) | OpenCode | Local `opencode.db` sessions and user/assistant messages | Install folder in GetY |
| [`gety-trae-connector/`](gety-trae-connector/) | Trae | Session memory summaries, topics, optional project memory/profile | Install folder in GetY |

Read the reusable guide: **[docs/connector-playbook.md](docs/connector-playbook.md)**.

## DeepSeek Harness

The `dsh/` directory contains both halves:

- `dsh/connector/` — GetY connector. One `dsh:session` document per DSH session,
  with user messages and DSH answers; reasoning, tool outputs, and injected
  context are excluded.
- `dsh/plugin/` — DSH bundle that adds a **GetY connector** page to
  DSH → Plugins. It installs the bundled connector through the local GetY CLI
  and offers a workspace checklist (all selected by default).

The plugin adds a GetY page in DSH with connection status, a connect button,
and a workspace picker.

Quick start: install `dsh/plugin` in DSH, open **Plugins → GetY connector**, click
**Connect GetY**, then choose the shared workspaces. See [dsh/README.md](dsh/README.md).

## WorkBuddy

`workbuddy/connector/` indexes:

- every non-deleted session in `~/.workbuddy/workbuddy.db` (title, workspace,
  model, status, timestamps), and
- user/assistant rounds recovered from `~/.workbuddy/traces/*/*.json`.

WorkBuddy keeps full conversation text in its cloud service, so sessions with no
local trace get a metadata document that says so. The connector is read-only and
never reads credentials or makes network requests.

Install:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-workbuddy.ps1
```

See [workbuddy/README.md](workbuddy/README.md).

## OpenCode

[`gety-opencode-connector/`](gety-opencode-connector/) indexes sessions from the
local OpenCode SQLite database (`opencode.db`), preserving user/assistant
conversation text. Tool outputs are excluded; optional one-line tool call
summaries can be enabled. The connector reads a temporary copy of the database
and its WAL file to avoid locking the live database.

**Install (GetY 0.5.1+):**

```powershell
cd gety-opencode-connector
deno task build
```

Then open **GetY → Settings → Connectors → Install Connector** and select
`gety-opencode-connector/` (the directory containing `manifest.json`).
Leave the data directory blank to auto-detect or select the folder containing
`opencode.db`. See [OpenCode setup and details](gety-opencode-connector/README.md).

## Trae

[`gety-trae-connector/`](gety-trae-connector/) reads local Trae memory files
(default: `%USERPROFILE%\\.trae-cn\\memory`): session summary JSONL,
`topics.md`, optional `project_memory.md`, and optional `user_profile.md`.
It indexes **memory summaries, not Trae's complete chat database**.
Project memory is enabled by default, while user profile indexing is disabled
by default.

**Install (GetY 0.5.1+):**

```powershell
cd gety-trae-connector
deno task build
```

Install `gety-trae-connector/` via the same GetY connector settings page,
then review its local memory directory and privacy options.
See [Trae setup and details](gety-trae-connector/README.md).

## Verify

Run the original DSH / WorkBuddy checks with the Deno bundled in GetY:

```powershell
$deno = "$env:LOCALAPPDATA\Gety\deno.exe"
Push-Location dsh\connector;        & $deno task verify; Pop-Location
Push-Location workbuddy\connector;  & $deno task verify; Pop-Location
```

For the new OpenCode and Trae connectors, run in each directory:

```powershell
Push-Location gety-opencode-connector; deno task verify; Pop-Location
Push-Location gety-trae-connector;     deno task verify; Pop-Location
```

The `verify` tasks format, lint, type-check, test, and build each connector.
The existing GitHub Actions workflow covers the original DSH / WorkBuddy
project checks; it has not been extended here to the new connectors.
Automated checks are separate from installing and trying the plugins in GetY.

**Manual test status:** On **2026-10-19**, the maintainer confirmed successful
testing of the OpenCode and Trae plugins on their work computer. The underlying
test environment and coverage are not documented in this repository.

For a Chinese quick start and the release scope, see
[docs/release-readiness.md](docs/release-readiness.md). To prepare runtime
archives after the checks pass, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\prepare-release.ps1
```

## Repository layout

```text
dsh/
  connector/              GetY connector for DeepSeek Harness
  plugin/                 DSH plugin (Host + Client + bundled connector)
workbuddy/
  connector/              GetY connector for WorkBuddy
gety-opencode-connector/   GetY connector for local OpenCode sessions
gety-trae-connector/      GetY connector for local Trae memories
scripts/
  install-workbuddy.ps1
docs/
  connector-playbook.md   Reusable build guide
  release-readiness.md   Chinese quick start and release scope
.github/workflows/verify.yml
```

## Design principles

- **Local data sources.** The connectors read local database or memory files,
  rather than fetching AI-client conversations from cloud APIs.
- **Minimize sensitive content.** Tool outputs and reasoning are not included
  in indexed chat transcripts. Trae user-profile indexing is opt-in.
- **Stable document IDs.** Use session IDs or source paths so repeat polls
  update the same search documents.
- **Incremental updates.** Re-index changed source data and remove documents
  whose source files/sessions have disappeared.
- **Honest coverage.** WorkBuddy may have cloud-only conversations; Trae
  provides saved memory summaries rather than its full chat text.

## License

MIT — see [LICENSE](LICENSE).

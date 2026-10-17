# GetY Client Connectors

让 GetY 检索 DeepSeek Harness（DSH）与 WorkBuddy 的本地会话。
两套接入方案在同一个仓库维护，可按需独立安装：

- **DSH**：GetY 连接器 + DSH 插件，提供一键连接与工作区分享选择，默认全选。
- **WorkBuddy**：直接安装到 GetY 的连接器，检索本地会话索引与已落盘的 trace；未落盘的云端正文不在覆盖范围内。

中文文档：[安装与打包](docs/release-readiness.md) ·
[实现经验](docs/connector-playbook.md) · [验证记录](docs/verification.md)。

Two [GetY](https://gety.ai) custom connectors that make local AI-client sessions
searchable, plus the playbook distilled from building them.

| Connector | Client | What it indexes | One-click? |
| --- | --- | --- | --- |
| [`dsh/`](dsh/) | DeepSeek Harness | Full session logs (`session.v4.jsonl.zstd`, multi-frame zstd) | Yes — DSH plugin with a workspace picker |
| [`workbuddy/`](workbuddy/) | WorkBuddy | Local session index (SQLite) + local agent traces | Install script (WorkBuddy has no plugin hook) |

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

## Verify

Run both connector checks with the Deno bundled in GetY:

```powershell
$deno = "$env:LOCALAPPDATA\Gety\deno.exe"
Push-Location dsh\connector;        & $deno task verify; Pop-Location
Push-Location workbuddy\connector;  & $deno task verify; Pop-Location
```

The `verify` task runs formatting, linting, type checking, unit tests, and a
build. CI also checks that the DSH plugin's bundled connector matches its
canonical source and checks the plugin JavaScript. These checks do not install
the connectors into a live GetY client.

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
scripts/
  install-workbuddy.ps1
docs/
  connector-playbook.md   Reusable build guide
  release-readiness.md   Chinese quick start and release scope
.github/workflows/verify.yml
```

## Design principles

- **Local only.** Connectors read local session files; no client credentials,
  no network calls.
- **Conversation only.** Tool outputs, reasoning, system prompts, and injected
  context are not indexed.
- **Stable IDs.** One document per session (or orphan trace), keyed by a stable
  UUID/path.
- **Incremental.** mtime/size fingerprints, content hashes, and a parse cache
  keep polls cheap.
- **Honest coverage.** When a client keeps content in the cloud, the document
  says exactly what was and was not indexed.

## License

MIT — see [LICENSE](LICENSE).

# DeepSeek Harness × GetY

Two pieces that make DeepSeek Harness (DSH) sessions searchable in
[GetY](https://gety.ai):

| Part | Directory | Role |
| --- | --- | --- |
| GetY custom connector | `connector/` | Indexes DSH session logs (`session.v4.jsonl.zstd`) as `dsh:session` documents. |
| DSH plugin | `plugin/` | Adds a **GetY connector** page to DSH → Plugins with a one-click connect button and a workspace picker (all selected by default). |

The plugin adds a GetY page in DSH with connection status, a connect button,
and a workspace picker.

## Use

1. Install the GetY connector:
   - open **DSH → Plugins → Installed plugins → GetY connector**, or
   - in GetY open **Settings → Connectors → Install connector** and select
     `connector/`.
2. Click **Connect GetY**. The plugin copies the bundled connector to
   `~/.dsh/gety-connector/connector`, then runs
   `gety connector install / enable / restart / poll`.
3. In **Shared workspaces**, choose which workspaces GetY may index. The
   default is **all workspaces**, including workspaces created later.
4. Search a session title, prompt, or answer in GetY. DSH's GetY MCP tools
   (`ListConnectors`, `Search`, `GetDoc`) keep working as before.

## How it maps documents

DSH writes each session as `session.v4.jsonl.zstd` under
`~/.dsh/sessions/<workspace>/<session>/`. The file is a concatenation of
independent zstd frames, one per appended event. The connector decompresses
them frame by frame with a vendored `fzstd`, then emits one Markdown document
per session:

- **ID**: the DSH session id (`session-...`), stable across polls.
- **Title**: the DSH session title, or the first user prompt.
- **Content**: user messages and DSH text answers, separated by `---`.
  Reasoning, tool outputs, and injected runtime context / skill catalogs are
  never indexed.
- **Metadata**: workspace, workspace id, model, created time, message count,
  tool-call count.
- **Optional**: brief tool-call summaries (config checkbox, off by default) and
  subagent sessions (on by default).

## Workspace sharing

The DSH plugin writes `~/.dsh/gety-connector.json`:

```json
{ "version": 1, "workspaces": null, "updatedAt": "2026-10-17T13:00:00.000Z" }
```

- `null` — every workspace (default).
- `["<workspace-id>", …]` — only those workspaces.
- Deselecting a workspace removes its previously indexed documents on the next
  poll; reselecting restores them.

## Build and test

GetY bundles Deno; use it directly:

```powershell
$deno = "$env:LOCALAPPDATA\Gety\deno.exe"
cd dsh\connector
& $deno task verify   # format, lint, type-check, unit tests, build
```

The connector keeps `@gety-ai/connector-sdk` external (GetY injects it) and
bundles everything else, including `fzstd`, into `dist/main.js`.

## Plugin internals

`plugin/index.js` registers four same-origin routes on DSH's connection service
(`/api/gety/state`, `/api/gety/connect`, `/api/gety/workspaces`,
`/api/gety/sync`) and drives the local GetY CLI. `plugin/client.js` renders the
Plugins-page card through the `plugins.bundle.config` slot. The plugin is a
normal DSH bundle and can be installed from this folder with the plugin manager.

The plugin is linked from its checkout; moving or deleting the folder requires
reinstalling it in DSH.

## Privacy

Everything runs locally. The connector reads `~/.dsh/sessions` and
`~/.dsh/storages/workspace.json`, and writes only
`~/.dsh/gety-connector.json` (workspace selection) plus the copied connector
under `~/.dsh/gety-connector/`. It never indexes tool outputs or injected
context and makes no network requests.

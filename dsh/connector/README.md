# DeepSeek Harness Connector

This GetY custom connector indexes local DeepSeek Harness (DSH) session logs as
searchable markdown documents.

## Scope

- Creates one `dsh:session` document per DSH session log file
  (`~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd`).
- Decompresses the concatenated zstd frames with a vendored copy of `fzstd`.
- Uses the DSH-generated session title when available, otherwise the first user
  prompt.
- Adds a short header with workspace, model, creation time, and message count.
- Indexes user messages and DSH text answers. Reasoning blocks, tool outputs,
  and system-injected context (runtime context, skill catalogs, time snapshots)
  are never indexed.
- Can include brief tool call summaries through a config checkbox. This is off
  by default.
- Can include subagent sessions through a config checkbox. This is on by
  default.
- On later polls, lists session files but only parses files whose mtime or size
  changed. State tracks file fingerprints and the sessions that were indexed, so
  changed files, removed files, and workspace-selection changes update only the
  affected documents.

## Workspace sharing

Workspace selection lives in `~/.dsh/gety-connector.json`, written by the DSH
GetY plugin:

```json
{
  "version": 1,
  "workspaces": null,
  "updatedAt": "2026-10-17T13:00:00.000Z"
}
```

- `workspaces: null` (or a missing file) shares every workspace, including ones
  created later.
- An array of workspace IDs shares only those workspaces.
- Deselecting a workspace removes its previously indexed session documents on
  the next poll.

The connector resolves the DSH home from `DSH_HOME`, then `%USERPROFILE%\.dsh`
on Windows or `$HOME/.dsh` elsewhere.

## Files

- `manifest.json` declares the connector metadata, config form, and
  `dist/main.js` runtime entry.
- `assets/dsh.svg` is the connector icon shown in GetY.
- `src/index.ts` contains the poll/state logic.
- `src/dsh_log.ts` contains zstd frame decoding, DSH event parsing, and markdown
  rendering.
- `src/dsh_home.ts` resolves the DSH home, workspace registry, share config, and
  session files.
- `dist/main.js` is the built entry loaded by GetY.
- `dev/` contains a local SDK shim and lifecycle runners used only for
  development.
- `src/vendor/fzstd.js` is the MIT-licensed `fzstd` decompressor.

## Build

```powershell
$deno = "$env:LOCALAPPDATA\Gety\deno.exe"
& $deno task verify
& $deno task build
```

The build keeps `@gety-ai/connector-sdk` external. GetY supplies the real SDK at
runtime through its import map.

## Test

```powershell
& $deno task test
```

Unit tests cover event parsing, markdown rendering, workspace encoding and
selection, and state transitions. They do not read your real DSH history.

## Live runner

```powershell
& $deno run -A dev/run.ts -- --reset-state
& $deno run -A dev/run.ts -- --tool-calls
```

The runner reads the real DSH session directory, prints the documents the
connector would index, and persists state under `dev/.runner/` for incremental
runs. Each run writes `updates.json`, `deletes.json`, and `state.after.json`
under `dev/runs/<timestamp>/`.

## Install in GetY

1. Run `deno task build` to refresh `dist/main.js`.
2. In GetY: **设置 → 连接器 → 安装连接器**, select this folder.
3. Wait for the first poll, then search for a DSH session title or prompt.

The DSH GetY plugin automates the same steps with
`gety connector install <folder>`.

After changing files under `src/`, run `deno task build`, then use **重启** in
GetY (or `gety connector restart <id>`) to load the new `dist/main.js`.

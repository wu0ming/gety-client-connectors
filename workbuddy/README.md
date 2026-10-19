# WorkBuddy × GetY

A GetY custom connector that makes local WorkBuddy sessions searchable in
[GetY](https://gety.ai). WorkBuddy has no plugin/marketplace hook for this, so
the connector is installed directly into GetY.

> **Manual test: passed (2026-10-19).** The maintainer has installed and used
> this connector successfully. This does not imply compatibility with all
> environments or versions.

## What is indexed

WorkBuddy is cloud-first: the desktop client keeps a local **session index** and
may write local **agent trace** files, while the full conversation text lives in
WorkBuddy's cloud service. The connector therefore indexes two local sources:

1. **`~/.workbuddy/workbuddy.db`** — every non-deleted session row: title,
   workspace (`cwd`), model, status, mode, transport, timestamps, playground /
   automation flags.
2. **`~/.workbuddy/traces/<pid>/trace_*.json`** — local agent traces. When a
   trace carries a `sessionId`, its user prompts and WorkBuddy answers are
   merged into that session's document. Traces without a session id become
   standalone `workbuddy:trace` documents.

One document is emitted per session (`workbuddy:session`) and per orphan trace
(`workbuddy:trace`). Sessions with no local trace still get a metadata document
so their title and workspace remain searchable; the document states explicitly
that WorkBuddy kept the conversation in the cloud.

### What is not indexed

- Tool outputs and reasoning.
- WorkBuddy cloud conversations that were never written to a local trace.
- The WorkBuddy database is opened **read-only**; no WorkBuddy files are
  modified.

This is a deliberate local-only design: no WorkBuddy credentials are read and no
network requests are made by the connector.

## Install

### One command

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-workbuddy.ps1
```

The script copies `workbuddy/connector` to
`%LOCALAPPDATA%\GetYWorkBuddyConnector\connector` and runs:

```text
gety connector install <dir>
gety connector enable <id>
gety connector poll <id>
```

### Manual

1. In GetY: **Settings → Connectors → Install connector**, select
   `workbuddy/connector`.
2. Fill in nothing (no required config) and install.
3. Wait for the first poll. It parses local traces once and then reuses a small
   cache at `%LOCALAPPDATA%\gety-workbuddy-connector\cache-v1.json`.

After changing `src/`, run `deno task build`, then restart the connector in GetY
(or `gety connector restart <id>`).

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `Include tool calls` | off | Add brief tool-call summaries from traces. Tool outputs are never indexed. |
| `Include sessions without local traces` | on | Index title/workspace/metadata for sessions that have no local trace. |

## Build and test

```powershell
$deno = "$env:LOCALAPPDATA\Gety\deno.exe"
cd workbuddy\connector
& $deno task verify   # format, lint, type-check, unit tests, build
```

`@gety-ai/connector-sdk` stays external (GetY injects it). `node:sqlite` is a
Deno built-in at runtime.

Local dry run against the real WorkBuddy home:

```powershell
& $deno run -A dev/run.ts -- --reset-state
```

The runner writes `updates.json`, `deletes.json`, and `state.after.json` under
`dev/runs/<timestamp>/`, and persists incremental state under `dev/.runner/`.

## Environment

| Variable | Default |
| --- | --- |
| `WORKBUDDY_HOME` | `%USERPROFILE%\.workbuddy` (or `$HOME/.workbuddy`) |
| `LOCALAPPDATA` | used for the parse cache on Windows |

## Design notes

- Session rows come from `workbuddy.db` with a read-only SQLite connection.
- Trace parsing takes the last `generation` span in each trace, which contains
  the fullest prompt history for that run, and appends the run's final answer.
- Duplicate prompts/answers are removed when a session has several traces.
- Automation prompts, runtime context, and internal control payloads are
  filtered out.
- A content hash per document avoids re-emitting unchanged documents; the cache
  file avoids re-parsing unchanged traces.
- If `workbuddy.db` cannot be read (for example during an upgrade), the poll is
  skipped without deleting existing documents.

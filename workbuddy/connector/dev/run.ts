/**
 * Local lifecycle runner for the WorkBuddy connector.
 *
 *   deno task runner -- --reset-state
 *   deno task runner -- --tool-calls --json
 */

import WorkBuddyConnector, { type WbState } from "../src/index.ts";

const args = new Set(Deno.args);
const reset = args.has("--reset-state");
const json = args.has("--json");
const statePath = new URL("./.runner/state.json", import.meta.url);
const outDir = new URL("./runs/", import.meta.url);

await Deno.mkdir(new URL("./.runner/", import.meta.url), { recursive: true });
await Deno.mkdir(outDir, { recursive: true });

let lastState: WbState | null = null;
if (!reset) {
  try {
    lastState = JSON.parse(await Deno.readTextFile(statePath)) as WbState;
  } catch {
    lastState = null;
  }
}

const connector = new WorkBuddyConnector();
connector.config = {
  include_tool_calls: args.has("--tool-calls"),
  include_metadata_only_sessions: !args.has("--no-metadata"),
};
connector.lastState = lastState;

const docs: Record<string, unknown>[] = [];
const deletes: string[] = [];
let state: unknown;
for await (const batch of connector.poll()) {
  for (const update of batch.updates) {
    if (update.kind === "upsert") docs.push(update.doc);
    else deletes.push(update.id);
  }
  if (batch.state !== undefined) state = batch.state;
}

if (state !== undefined) {
  await Deno.writeTextFile(statePath, JSON.stringify(state, null, 2));
}

const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(
  ".",
  "-",
);
const runDir = new URL(`${stamp}/`, outDir);
await Deno.mkdir(new URL("docs/", runDir), { recursive: true });
await Deno.writeTextFile(
  new URL("updates.json", runDir),
  JSON.stringify(docs, null, 2),
);
await Deno.writeTextFile(
  new URL("deletes.json", runDir),
  JSON.stringify(deletes, null, 2),
);
await Deno.writeTextFile(
  new URL("state.after.json", runDir),
  JSON.stringify(state, null, 2),
);

if (json) {
  console.log(
    JSON.stringify(
      { docs: docs.length, deletes: deletes.length, runDir: runDir.pathname },
      null,
      2,
    ),
  );
} else {
  console.log(`documents: ${docs.length}`);
  console.log(`deletes:   ${deletes.length}`);
  console.log(`run dir:   ${runDir.pathname}`);
  for (const doc of docs.slice(0, 20)) {
    console.log(`- ${String(doc.id)}  ${String(doc.title)}`);
  }
}

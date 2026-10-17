/** Smoke-test the bundled entry the same way Gety loads it. */

import DshConnector from "../dist/main.js";

const connector = new DshConnector();
connector.config = { include_tool_calls: false, include_subagents: true };
let count = 0;
let state: unknown;
for await (const batch of connector.poll()) {
  count += batch.updates.length;
  if (batch.state !== undefined) state = batch.state;
}
console.log(
  JSON.stringify({
    updates: count,
    files: Object.keys((state as { files?: object })?.files ?? {}).length,
  }),
);

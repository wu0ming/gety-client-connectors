/** Smoke-test the bundled entry the same way Gety loads it. */

import WorkBuddyConnector from "../dist/main.js";

const connector = new WorkBuddyConnector();
connector.config = {
  include_tool_calls: false,
  include_metadata_only_sessions: true,
};
let docs = 0;
let state: unknown;
for await (const batch of connector.poll()) {
  docs += batch.updates.length;
  if (batch.state !== undefined) state = batch.state;
}
const stateInfo = state as { docs?: Record<string, string> };
console.log(
  JSON.stringify({
    updates: docs,
    knownDocs: Object.keys(stateInfo?.docs ?? {}).length,
  }),
);

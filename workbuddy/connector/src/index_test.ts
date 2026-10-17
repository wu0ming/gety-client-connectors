import { DatabaseSync } from "node:sqlite";
import type { DocUpdate } from "@gety-ai/connector-sdk";
import { assertEquals, assertStringIncludes } from "./test_assert.ts";
import WorkBuddyConnector, { type WbState } from "./index.ts";

const sessionId = "11111111-2222-4333-8444-555555555555";
const timestamp = "2026-10-17T10:00:00.000Z";

interface PollSnapshot {
  updates: DocUpdate[];
  state?: WbState;
}

async function poll(connector: WorkBuddyConnector): Promise<PollSnapshot> {
  const result: PollSnapshot = { updates: [] };
  for await (const batch of connector.poll()) {
    result.updates.push(...batch.updates);
    if (batch.state !== undefined) result.state = batch.state as WbState;
  }
  return result;
}

function createDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    create table sessions (
      id text primary key, cwd text, title text, custom_title text, status text,
      created_at integer, updated_at integer, last_activity_at integer,
      deleted_at integer, is_playground integer, mode text, source_mode text,
      model text, group_title text, is_background_automation integer, transport text
    );
  `);
  db.prepare(`
    insert into sessions values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    "C:/synthetic/workspace",
    "Synthetic session",
    "",
    "completed",
    1792231200000,
    1792231260000,
    1792231260000,
    null,
    0,
    "craft",
    "working",
    "hy3",
    "",
    0,
    "local",
  );
  db.close();
}

function traceJson(traceId: string, traceSessionId: string | null): string {
  return JSON.stringify({
    trace: {
      traceId,
      sessionId: traceSessionId,
      startedAt: timestamp,
      endedAt: timestamp,
      modelInfo: { models: ["hy3"] },
    },
    spans: [{
      name: "generation",
      startedAt: timestamp,
      toolInput: JSON.stringify([{
        role: "user",
        content: `<user_query>Searchable ${traceId}</user_query>`,
      }, { role: "assistant", content: `Reply for ${traceId}` }]),
    }],
  });
}

Deno.test("poll lifecycle retains data on read errors and handles deleted sessions", async () => {
  const temp = await Deno.makeTempDir({ prefix: "gety-workbuddy-poll-" });
  const home = `${temp}/workbuddy`;
  const localAppData = `${temp}/appdata`;
  const dbPath = `${home}/workbuddy.db`;
  const traceRoot = `${home}/traces`;
  const bucket = `${traceRoot}/2026-10-17`;
  const attachedTracePath = `${bucket}/trace-attached.json`;
  const orphanTracePath = `${bucket}/trace-orphan.json`;
  const oldHome = Deno.env.get("WORKBUDDY_HOME");
  const oldLocalAppData = Deno.env.get("LOCALAPPDATA");

  try {
    await Deno.mkdir(bucket, { recursive: true });
    await Deno.mkdir(localAppData, { recursive: true });
    createDatabase(dbPath);
    await Deno.env.set("WORKBUDDY_HOME", home);
    await Deno.env.set("LOCALAPPDATA", localAppData);

    const connector = new WorkBuddyConnector();
    connector.config = {
      include_tool_calls: false,
      include_metadata_only_sessions: true,
    };

    const first = await poll(connector);
    const sessionDocId = `wb-session-${sessionId}`;
    assertEquals(
      first.updates.some((update) =>
        update.kind === "upsert" && update.doc.id === sessionDocId
      ),
      true,
    );
    if (first.state === undefined) throw new Error("missing initial state");
    connector.lastState = first.state;

    connector.config.include_tool_calls = true;
    const optionChange = await poll(connector);
    assertEquals(
      optionChange.updates.some((update) =>
        update.kind === "upsert" && update.doc.id === sessionDocId
      ),
      true,
    );
    if (optionChange.state === undefined) {
      throw new Error("missing state after changing render options");
    }
    connector.lastState = optionChange.state;

    connector.config = {
      include_tool_calls: true,
      include_metadata_only_sessions: false,
    };
    const disabledMetadata = await poll(connector);
    assertEquals(disabledMetadata.updates, [{
      kind: "delete",
      id: sessionDocId,
    }]);
    if (disabledMetadata.state === undefined) {
      throw new Error("missing state after disabling metadata-only docs");
    }
    assertEquals(sessionDocId in (disabledMetadata.state.docs ?? {}), false);
    connector.lastState = disabledMetadata.state;

    connector.config.include_metadata_only_sessions = true;
    await Deno.writeTextFile(
      attachedTracePath,
      traceJson("trace-attached", sessionId),
    );
    await Deno.writeTextFile(
      orphanTracePath,
      traceJson("trace-orphan", "missing-from-database"),
    );
    const withTraces = await poll(connector);
    assertEquals(
      withTraces.updates.some((update) =>
        update.kind === "upsert" && update.doc.id === sessionDocId
      ),
      true,
    );
    const orphanDocId = "wb-trace-trace-orphan";
    const orphanDoc = withTraces.updates.find((update) =>
      update.kind === "upsert" && update.doc.id === orphanDocId
    );
    if (orphanDoc?.kind !== "upsert") {
      throw new Error("valid orphan trace was not indexed");
    }
    assertStringIncludes(
      String(orphanDoc.doc.content),
      "Searchable trace-orphan",
    );
    if (withTraces.state === undefined) throw new Error("missing trace state");
    connector.lastState = withTraces.state;

    const db = new DatabaseSync(dbPath);
    db.prepare("update sessions set deleted_at = ? where id = ?").run(
      1792231320000,
      sessionId,
    );
    db.close();
    const deletedSession = await poll(connector);
    assertEquals(
      deletedSession.updates.some((update) =>
        update.kind === "delete" && update.id === sessionDocId
      ),
      true,
    );
    assertEquals(
      deletedSession.updates.some((update) =>
        update.kind === "upsert" && update.doc.id === "wb-trace-trace-attached"
      ),
      false,
    );
    assertEquals(
      deletedSession.updates.some((update) =>
        update.kind === "upsert" && update.doc.id === orphanDocId
      ),
      false,
    );
    if (deletedSession.state === undefined) {
      throw new Error("missing state after deleting session");
    }
    connector.lastState = deletedSession.state;

    await Deno.remove(traceRoot, { recursive: true });
    await Deno.writeTextFile(traceRoot, "temporary traversal failure");
    const traversalFailure = await poll(connector);
    assertEquals(traversalFailure.updates, []);
    assertEquals(traversalFailure.state, undefined);

    await Deno.remove(traceRoot);
    await Deno.mkdir(bucket, { recursive: true });
    await Deno.writeTextFile(
      orphanTracePath,
      `${traceJson("trace-orphan", "missing-from-database")} `,
    );
    const originalReadTextFile = Deno.readTextFile;
    Deno.readTextFile = async (
      ...args: Parameters<typeof Deno.readTextFile>
    ) => {
      if (String(args[0]) === orphanTracePath) {
        throw new Error("synthetic temporary read failure");
      }
      return await originalReadTextFile(...args);
    };
    let readFailure: PollSnapshot;
    try {
      readFailure = await poll(connector);
    } finally {
      Deno.readTextFile = originalReadTextFile;
    }
    assertEquals(readFailure.updates, []);
    assertEquals(readFailure.state, undefined);
    assertEquals(orphanDocId in (connector.lastState?.docs ?? {}), true);
  } finally {
    if (oldHome === undefined) Deno.env.delete("WORKBUDDY_HOME");
    else Deno.env.set("WORKBUDDY_HOME", oldHome);
    if (oldLocalAppData === undefined) Deno.env.delete("LOCALAPPDATA");
    else Deno.env.set("LOCALAPPDATA", oldLocalAppData);
    await Deno.remove(temp, { recursive: true });
  }
});

import { zstdCompressSync } from "node:zlib";
import DshConnector, { type DshState } from "./index.ts";
import { readShareConfig, workspaceDirName } from "./dsh_home.ts";
import { assertEquals } from "./test_assert.ts";

async function expectFailure(action: () => Promise<unknown>): Promise<void> {
  let failed = false;
  try {
    await action();
  } catch {
    failed = true;
  }
  assertEquals(failed, true);
}

async function fixture(action: (home: string, file: string) => Promise<void>) {
  const home = await Deno.makeTempDir();
  const previous = Deno.env.get("DSH_HOME");
  Deno.env.set("DSH_HOME", home);
  try {
    const workspacePath = "/work/demo";
    const folder = `${home}/sessions/${workspaceDirName(workspacePath)}/s1`;
    await Deno.mkdir(folder, { recursive: true });
    await Deno.mkdir(`${home}/storages`);
    await Deno.writeTextFile(
      `${home}/storages/workspace.json`,
      JSON.stringify({
        tables: {
          workspaces: { w1: { path: workspacePath, sessionIds: ["s1"] } },
        },
      }),
    );
    const file = `${folder}/session.v4.jsonl.zstd`;
    const events = [
      {
        type: "session",
        id: "s1",
        cwd: workspacePath,
        createdAt: 1700000000000,
      },
      {
        type: "user/message",
        data: {
          source: { kind: "user" },
          content: [{ type: "text", text: "Hello" }],
        },
      },
    ];
    await Deno.writeFile(
      file,
      zstdCompressSync(events.map((event) => JSON.stringify(event)).join("\n")),
    );
    await action(home, file);
  } finally {
    if (previous === undefined) Deno.env.delete("DSH_HOME");
    else Deno.env.set("DSH_HOME", previous);
    await Deno.remove(home, { recursive: true });
  }
}

async function poll(connector: DshConnector) {
  const results = [];
  for await (const result of connector.poll()) results.push(result);
  return results;
}

Deno.test("DSH sharing config defaults only when absent, rejects malformed selections", async () => {
  await fixture(async (home) => {
    assertEquals((await readShareConfig(home)).workspaces, null);
    for (
      const raw of ["{", "{}", '{"workspaces":[42]}', '{"workspaces":"all"}']
    ) {
      await Deno.writeTextFile(`${home}/gety-connector.json`, raw);
      await expectFailure(() => readShareConfig(home));
    }
  });
});

Deno.test("DSH poll indexes, stays incremental, removes deselected sessions and restores them", async () => {
  await fixture(async (home) => {
    const connector = new DshConnector();
    const first = await poll(connector);
    assertEquals(first.flatMap((r) => r.updates).map((u) => u.kind), [
      "upsert",
    ]);
    connector.lastState = first.at(-1)!.state as DshState;
    assertEquals((await poll(connector)).flatMap((r) => r.updates), []);
    await Deno.writeTextFile(
      `${home}/gety-connector.json`,
      '{"workspaces":[]}',
    );
    const deselected = await poll(connector);
    assertEquals(deselected.flatMap((r) => r.updates), [{
      kind: "delete",
      id: "s1",
    }]);
    connector.lastState = deselected.at(-1)!.state as DshState;
    await Deno.writeTextFile(
      `${home}/gety-connector.json`,
      '{"workspaces":["w1"]}',
    );
    assertEquals(
      (await poll(connector)).flatMap((r) => r.updates).map((u) => u.kind),
      ["upsert"],
    );
  });
});

Deno.test("DSH incomplete scans, unreadable logs and invalid config abort reconciliation", async () => {
  await fixture(async (home, file) => {
    const connector = new DshConnector();
    connector.lastState = (await poll(connector)).at(-1)!.state as DshState;
    const originalState = JSON.stringify(connector.lastState);
    const originalReadDir = Deno.readDir;
    const originalReadFile = Deno.readFile;
    try {
      Deno.readDir = () => {
        throw new Deno.errors.PermissionDenied(
          "simulated unreadable directory",
        );
      };
      await expectFailure(() => poll(connector));
      Deno.readDir = originalReadDir;
      await Deno.writeTextFile(`${home}/gety-connector.json`, "{");
      await expectFailure(() => poll(connector));
      await Deno.remove(`${home}/gety-connector.json`);
      await Deno.utime(file, new Date(), new Date(Date.now() + 10000));
      Deno.readFile = () =>
        Promise.reject(
          new Deno.errors.PermissionDenied("simulated unreadable log"),
        );
      await expectFailure(() => poll(connector));
      assertEquals(JSON.stringify(connector.lastState), originalState);
    } finally {
      Deno.readDir = originalReadDir;
      Deno.readFile = originalReadFile;
    }
  });
});

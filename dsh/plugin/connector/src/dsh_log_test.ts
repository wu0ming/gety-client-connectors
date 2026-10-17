import { assertEquals, assertStringIncludes } from "./test_assert.ts";

import {
  blocksToText,
  parseEvents,
  renderSession,
  titleFromPrompt,
} from "./dsh_log.ts";
import {
  isWorkspaceSelected,
  workspaceDirName,
  workspaceForDir,
} from "./dsh_home.ts";
import { fileNeedsParse, initialState } from "./index.ts";

const events = parseEvents([
  JSON.stringify({
    type: "session",
    version: 4,
    id: "session-1234abcd-0000-4000-8000-000000000000",
    createdAt: 1700000000000,
    cwd: "C:\\work\\demo",
  }),
  JSON.stringify({
    type: "model/selection",
    time: 1700000000100,
    data: { provider: "deepseek-account", model: "deepseek-flash" },
  }),
  JSON.stringify({
    type: "user/message",
    time: 1700000000200,
    data: {
      source: { kind: "user" },
      content: [{ type: "text", text: "How do I index sessions?" }],
    },
  }),
  JSON.stringify({
    type: "user/message",
    time: 1700000000300,
    data: {
      source: { kind: "runtime-context" },
      content: [{ type: "text", text: "Current working directory: ..." }],
    },
  }),
  JSON.stringify({
    type: "assistant/message",
    time: 1700000000400,
    data: {
      message: {
        role: "assistant",
        content: [
          { type: "reasoning", text: "private reasoning" },
          { type: "text", text: "Use the connector." },
        ],
      },
    },
  }),
  JSON.stringify({
    type: "tool/call",
    time: 1700000000500,
    data: { name: "pwsh", arguments: '{"description":"List files"}' },
  }),
  JSON.stringify({
    type: "tool/result",
    time: 1700000000600,
    data: {
      message: { content: [{ type: "text", text: "secret tool output" }] },
    },
  }),
  JSON.stringify({
    type: "session/title",
    time: 1700000000700,
    data: { title: "Session indexing" },
  }),
].join("\n"));

Deno.test("renderSession keeps conversation, drops injected context and tool output", () => {
  const session = renderSession(
    events,
    "C:\\sessions\\--work--\\session-1234abcd-0000-4000-8000-000000000000\\session.v4.jsonl.zstd",
    {
      includeToolCalls: false,
      workspace: {
        id: "ws-1",
        title: "Demo",
        path: "C:\\work\\demo",
        sessionIds: [],
      },
    },
  );
  if (session === null) throw new Error("expected a session");
  assertEquals(session.title, "Session indexing");
  assertEquals(session.messageCount, 2);
  assertEquals(session.workspaceTitle, "Demo");
  assertEquals(session.model, "deepseek-account/deepseek-flash");
  assertEquals(session.createdAt, "2023-11-14T22:13:20.000Z");
  assertEquals(session.updatedAt, "2023-11-14T22:13:20.700Z");
  assertStringIncludes(session.markdown, "Use the connector.");
  assertStringIncludes(session.markdown, "How do I index sessions?");
  assertEquals(session.markdown.includes("private reasoning"), false);
  assertEquals(session.markdown.includes("secret tool output"), false);
});

Deno.test("renderSession includes tool summaries only when enabled", () => {
  const path =
    "C:\\sessions\\--work--\\session-1234abcd-0000-4000-8000-000000000000\\session.v4.jsonl.zstd";
  const without = renderSession(events, path, { includeToolCalls: false });
  const withTools = renderSession(events, path, { includeToolCalls: true });
  assertEquals(without?.markdown.includes("List files") ?? false, false);
  assertEquals(withTools?.markdown.includes("List files") ?? false, true);
});

Deno.test("blocksToText joins text blocks and ignores images", () => {
  assertEquals(
    blocksToText([{ type: "text", text: "a" }, { type: "image" }, {
      type: "text",
      text: "b",
    }]),
    "a\n\nb",
  );
  assertEquals(blocksToText("  hi  "), "hi");
});

Deno.test("titleFromPrompt truncates long prompts", () => {
  const title = titleFromPrompt("word ".repeat(100));
  assertEquals(title?.endsWith("…") ?? false, true);
  assertEquals((title?.length ?? 0) <= 120, true);
});

Deno.test("workspace directory encoding and selection", () => {
  assertEquals(
    workspaceDirName(
      "C:\\Users\\me\\Documents\\deepseek-harness\\default-workspace",
    ),
    "--C-Users-me-Documents-deepseek-harness-default-workspace--",
  );
  const workspace = {
    id: "ws-1",
    title: "Demo",
    path: "C:\\work\\demo",
    sessionIds: [],
  };
  assertEquals(
    workspaceForDir([workspace], workspaceDirName(workspace.path))?.id,
    "ws-1",
  );
  assertEquals(
    isWorkspaceSelected({ version: 1, workspaces: null }, workspace, "x"),
    true,
  );
  assertEquals(
    isWorkspaceSelected({ version: 1, workspaces: ["ws-1"] }, workspace, "x"),
    true,
  );
  assertEquals(
    isWorkspaceSelected({ version: 1, workspaces: ["other"] }, workspace, "x"),
    false,
  );
  assertEquals(
    isWorkspaceSelected({ version: 1, workspaces: ["*"] }, workspace, "x"),
    true,
  );
});

Deno.test("state resets when rendering options change", () => {
  const first = initialState(undefined, false, true);
  assertEquals(first.schema_version, 1);
  const changed = initialState(first, true, true);
  assertEquals(changed.files, {});
  const unchanged = initialState(first, false, true);
  assertEquals(unchanged, first);
  assertEquals(
    fileNeedsParse({
      path: "p",
      stateKey: "k",
      workspaceDir: "w",
      sessionId: "s",
      mtimeMs: 1,
      size: 2,
    }, {
      mtime_ms: 1,
      size: 2,
      indexed: true,
    }),
    false,
  );
  assertEquals(
    fileNeedsParse({
      path: "p",
      stateKey: "k",
      workspaceDir: "w",
      sessionId: "s",
      mtimeMs: 1,
      size: 2,
    }, {
      mtime_ms: 1,
      size: 2,
      indexed: false,
    }),
    true,
  );
});

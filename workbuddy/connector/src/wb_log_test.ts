import { assertEquals, assertStringIncludes } from "./test_assert.ts";
import {
  extractUserQuery,
  hashText,
  mergeRounds,
  parseTrace,
  renderSession,
  sessionTitle,
  titleFromText,
  type WbSession,
  type WbTrace,
} from "./wb_log.ts";
import { initialState } from "./index.ts";

const session: WbSession = {
  id: "11111111-2222-4333-8444-555555555555",
  cwd: "C:\\work\\demo",
  title: "Fix the login flow",
  customTitle: "",
  status: "completed",
  createdAt: 1700000000000,
  updatedAt: 1700000100000,
  lastActivityAt: 1700000100000,
  isPlayground: false,
  mode: "craft",
  sourceMode: "working",
  model: "hy3",
  groupTitle: "",
  isAutomation: false,
  transport: "local",
};

function traceWith(userText: string, outputText: string): string {
  return JSON.stringify({
    trace: {
      traceId: "trace_test",
      sessionId: session.id,
      startedAt: "2026-10-17T10:00:00.000Z",
      endedAt: "2026-10-17T10:01:00.000Z",
      modelInfo: { models: ["hy3"] },
    },
    spans: [
      {
        name: "generation",
        startedAt: "2026-10-17T10:00:00.000Z",
        toolInput: JSON.stringify([
          { role: "system", content: "system prompt" },
          { role: "user", content: userText },
          { role: "assistant", content: "Let me check." },
        ]),
        toolOutput: JSON.stringify([{
          choices: [{ message: { role: "assistant", content: outputText } }],
        }]),
      },
    ],
  });
}

Deno.test("extractUserQuery keeps the query and drops injected context", () => {
  const text = [
    '<system-reminder data-role="user-context">',
    "<user_info>Workspace Folder: C:/work/demo</user_info>",
    "</system-reminder>",
    "<user_query>How do I index sessions?</user_query>",
  ].join("\n");
  assertEquals(extractUserQuery(text), "How do I index sessions?");
  assertEquals(
    extractUserQuery("<system-reminder>x</system-reminder>  plain query"),
    "plain query",
  );
  assertEquals(extractUserQuery("."), "");
});

Deno.test("parseTrace recovers user and assistant rounds", () => {
  const parsed = parseTrace(
    traceWith(
      "<user_info>Workspace Folder: C:/work/demo</user_info><user_query>Fix login</user_query>",
      "Done, fixed.",
    ),
    "C:\\traces\\1\\trace_test.json",
  );
  if (parsed === null) throw new Error("expected a trace");
  assertEquals(parsed.sessionId, session.id);
  assertEquals(parsed.workspace, "C:/work/demo");
  assertEquals(parsed.rounds.map((round) => round.role), [
    "user",
    "assistant",
    "assistant",
  ]);
  assertEquals(parsed.rounds[0]?.text, "Fix login");
  assertEquals(parsed.rounds[1]?.text, "Let me check.");
  assertEquals(parsed.rounds[2]?.text, "Done, fixed.");
  assertEquals(parsed.title, "Fix login");
});

Deno.test("parseTrace skips automation prompts and control payloads", () => {
  const parsed = parseTrace(
    traceWith(
      "<user_query>.\nYou MUST follow these steps in order: 1. Read memory.md</user_query>",
      '{"isNewTopic": true, "title": "internal"}',
    ),
    "C:\\traces\\1\\trace_test.json",
  );
  if (parsed === null) throw new Error("expected a trace");
  assertEquals(parsed.rounds.map((round) => round.role), ["assistant"]);
  assertEquals(parsed.rounds[0]?.text, "Let me check.");
});

Deno.test("mergeRounds deduplicates and keeps order", () => {
  const first: WbTrace = {
    traceId: "a",
    sessionId: null,
    startedAt: "2026-10-17T10:00:00.000Z",
    endedAt: "",
    workspace: "",
    model: "",
    title: "",
    rounds: [{ role: "user", text: "one" }, { role: "assistant", text: "two" }],
    toolCalls: [],
  };
  const second: WbTrace = {
    ...first,
    traceId: "b",
    startedAt: "2026-10-17T10:05:00.000Z",
    rounds: [{ role: "user", text: "one" }, {
      role: "assistant",
      text: "three",
    }],
  };
  assertEquals(mergeRounds([first, second]), [
    { role: "user", text: "one" },
    { role: "assistant", text: "two" },
    { role: "assistant", text: "three" },
  ]);
});

Deno.test("renderSession renders a metadata-only document when no trace exists", () => {
  const rendered = renderSession(
    session,
    [],
    { includeToolCalls: false },
    "C:\\sessions\\demo",
  );
  assertEquals(rendered.title, "Fix the login flow");
  assertStringIncludes(rendered.markdown, "no local agent trace");
  assertStringIncludes(rendered.markdown, "Session ID");
  assertEquals(rendered.metadata.traces, 0);
});

Deno.test("renderSession renders conversation rounds and tool calls", () => {
  const trace: WbTrace = {
    traceId: "a",
    sessionId: session.id,
    startedAt: "2026-10-17T10:00:00.000Z",
    endedAt: "2026-10-17T10:01:00.000Z",
    workspace: session.cwd,
    model: "hy3",
    title: "Fix login",
    rounds: [{ role: "user", text: "Fix login" }, {
      role: "assistant",
      text: "Done.",
    }],
    toolCalls: [{ name: "Bash", detail: "npm test" }],
  };
  const rendered = renderSession(
    session,
    [trace],
    { includeToolCalls: true },
    "C:\\sessions\\demo",
  );
  assertStringIncludes(rendered.markdown, "### User");
  assertStringIncludes(rendered.markdown, "### WorkBuddy");
  assertStringIncludes(rendered.markdown, "npm test");
});

Deno.test("titles and hashes are deterministic", () => {
  assertEquals(titleFromText("short title"), "short title");
  assertEquals((titleFromText("x".repeat(200)) ?? "").endsWith("…"), true);
  assertEquals(
    sessionTitle({ ...session, title: "", customTitle: "" }, [{
      role: "user",
      text: "Question",
    }]),
    "Question",
  );
  assertEquals(hashText("same"), hashText("same"));
  assertEquals(hashText("same") === hashText("different"), false);
});

Deno.test("state retains tracked docs when rendering options change", () => {
  const initial = initialState(undefined, false, true);
  assertEquals(initial.docs, {});
  const tracked = { ...initial, docs: { "wb-session-old": "hash" } };
  const changed = initialState(tracked, true, true);
  assertEquals(changed.docs, tracked.docs);
  assertEquals(initialState(initial, false, true), initial);
});

// src/index.ts
import { Connector } from "@gety-ai/connector-sdk";

// src/opencode_db.ts
import { del, upsert } from "@gety-ai/connector-sdk";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
var SESSION_DOC_TYPE = "opencode:session";
var MAX_CONTENT_CHARS = 9e5;
function openOpencodeDb(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  return {
    listSessionRefs() {
      const rows = db.prepare(
        `select id, title, directory, agent, model, time_created, time_updated,
						time_archived, tokens_input, tokens_output, cost
					from session_v2`
      ).all();
      return rows.map((row) => sessionRefFromRow(row));
    },
    listSessionMessages(sessionId) {
      const rows = db.prepare(
        `select type, seq, data from session_message
					where session_id = ? order by seq, time_created`
      ).all(sessionId);
      return rows.map((row) => ({
        type: String(row.type),
        seq: Number(row.seq),
        data: parseJsonObject(row.data) ?? {}
      }));
    },
    close() {
      db.close();
    }
  };
}
async function openOpencodeDbSnapshot(opencodeDir) {
  const dbPath = join(opencodeDir, "opencode.db");
  const tempDir = await Deno.makeTempDir({ prefix: "gety-opencode-" });
  const snapshotPath = join(tempDir, "opencode.db");
  try {
    copyFileSync(dbPath, snapshotPath);
    try {
      copyFileSync(`${dbPath}-wal`, `${snapshotPath}-wal`);
    } catch {
    }
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  let access;
  try {
    access = openOpencodeDb(snapshotPath);
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  return {
    access,
    cleanup() {
      try {
        access.close();
      } catch {
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
}
function resolveOpencodeDir(configuredDir, env = Deno.env.toObject(), os = Deno.build.os) {
  const explicit = configuredDir?.trim();
  if (explicit) {
    return explicit;
  }
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) {
    return join(xdgDataHome, "opencode");
  }
  const profile = env.USERPROFILE?.trim() || env.HOME?.trim();
  if (profile) {
    return join(profile, ".local", "share", "opencode");
  }
  if (os === "windows") {
    return join("C:", "Users", ".local", "share", "opencode");
  }
  return join(".local", "share", "opencode");
}
function sessionRefFromRow(row) {
  const updatedMs = epochMs(row.time_updated) ?? 0;
  const archivedMs = epochMs(row.time_archived) ?? void 0;
  const model = parseJsonObject(row.model);
  return {
    id: String(row.id),
    title: typeof row.title === "string" && row.title.trim() !== "" ? row.title.trim() : "Untitled session",
    directory: stringOrUndefined(row.directory),
    agent: stringOrUndefined(row.agent),
    modelId: model == null ? void 0 : stringOrUndefined(model.id),
    modelProvider: model == null ? void 0 : stringOrUndefined(model.providerID),
    createdMs: epochMs(row.time_created) ?? void 0,
    updatedMs,
    archivedMs,
    tokensInput: numberOrUndefined(row.tokens_input),
    tokensOutput: numberOrUndefined(row.tokens_output),
    cost: numberOrUndefined(row.cost)
  };
}
function isIndexableSession(session, options) {
  if (!options.includeArchivedSessions && session.ref.archivedMs != null) {
    return false;
  }
  return session.userMessageCount > 0;
}
function buildSessionUpdate(session) {
  return upsert({
    id: sessionDocId(session.ref.id),
    title: sessionTitle(session),
    content: session.content,
    content_format: "markdown",
    doc_updated_at: rfc3339(session.ref.updatedMs),
    doc_type: SESSION_DOC_TYPE,
    metadata: {
      source: "opencode",
      session_id: session.ref.id,
      directory: session.ref.directory,
      agent: session.ref.agent,
      model: session.ref.modelId,
      model_provider: session.ref.modelProvider,
      created_at: session.ref.createdMs == null ? void 0 : rfc3339(session.ref.createdMs),
      archived: session.ref.archivedMs == null ? false : true,
      tokens_input: session.ref.tokensInput,
      tokens_output: session.ref.tokensOutput,
      cost: session.ref.cost,
      message_count: session.messageCount,
      user_message_count: session.userMessageCount,
      assistant_message_count: session.assistantMessageCount,
      tool_call_count: session.toolCallCount,
      content_truncated: session.contentTruncated
    }
  });
}
function buildSessionDelete(sessionId) {
  return del(sessionDocId(sessionId));
}
function sessionDocId(sessionId) {
  return `opencode:session:${sessionId}`;
}
function parseSession(ref, messages, options) {
  const rounds = [];
  let currentRound = null;
  let messageCount = 0;
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let toolCallCount = 0;
  let firstUserText;
  for (const message of messages) {
    if (message.type === "user") {
      const text = cleanText(message.data.text);
      if (text == null) {
        continue;
      }
      currentRound = { userMessages: [], assistantMessages: [], toolCalls: [] };
      rounds.push(currentRound);
      currentRound.userMessages.push(text);
      firstUserText ??= text;
      messageCount += 1;
      userMessageCount += 1;
      continue;
    }
    if (message.type !== "assistant") {
      continue;
    }
    const round = currentRound ?? {
      userMessages: [],
      assistantMessages: [],
      toolCalls: []
    };
    if (currentRound == null) {
      currentRound = round;
      rounds.push(round);
    }
    const contentItems = Array.isArray(message.data.content) ? message.data.content : [];
    const assistantTexts = [];
    for (const item of contentItems) {
      if (!isRecord(item)) {
        continue;
      }
      if (item.type === "text") {
        const text = cleanText(item.text);
        if (text != null) {
          assistantTexts.push(text);
        }
        continue;
      }
      if (item.type === "tool" && options.includeToolCalls) {
        const summary = summarizeToolCall(item);
        if (summary != null) {
          round.toolCalls.push(summary);
          toolCallCount += 1;
        }
      }
    }
    if (assistantTexts.length > 0) {
      round.assistantMessages.push(assistantTexts.join("\n\n"));
      assistantMessageCount += 1;
    }
  }
  messageCount = userMessageCount + assistantMessageCount;
  const contentResult = renderSessionContent(ref, rounds);
  return {
    ref,
    content: contentResult.content,
    contentTruncated: contentResult.truncated,
    messageCount,
    userMessageCount,
    assistantMessageCount,
    toolCallCount,
    firstUserText
  };
}
function renderSessionContent(ref, rounds) {
  const lines = [];
  const metaLines = renderSessionMeta(ref);
  if (metaLines.length > 0) {
    lines.push("## Session", "", ...metaLines, "");
  }
  for (const round of rounds) {
    if (round.userMessages.length > 0) {
      lines.push("## User", "", round.userMessages.join("\n\n"), "");
    }
    if (round.assistantMessages.length > 0) {
      lines.push("## OpenCode", "", round.assistantMessages.join("\n\n"), "");
    }
    if (round.toolCalls.length > 0) {
      lines.push(
        "## Tool Calls",
        "",
        ...round.toolCalls.map((toolCall) => `- ${toolCall}`),
        ""
      );
    }
  }
  let content = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  let truncated = false;
  if (content.length > MAX_CONTENT_CHARS) {
    content = content.slice(0, MAX_CONTENT_CHARS).trimEnd();
    truncated = true;
  }
  return { content, truncated };
}
function renderSessionMeta(ref) {
  const lines = [];
  if (ref.directory != null) {
    lines.push(`- Directory: \`${ref.directory}\``);
  }
  if (ref.modelId != null) {
    const provider = ref.modelProvider == null ? "" : ` (${ref.modelProvider})`;
    lines.push(`- Model: \`${ref.modelId}\`${provider}`);
  }
  if (ref.agent != null) {
    lines.push(`- Agent: ${ref.agent}`);
  }
  if (ref.createdMs != null) {
    lines.push(`- Created: ${rfc3339(ref.createdMs)}`);
  }
  return lines;
}
function sessionTitle(session) {
  const title = session.ref.title;
  if (title && !/^new session\b/i.test(title)) {
    return title;
  }
  const first = session.firstUserText;
  if (first != null) {
    const paragraph = first.split(/\n\s*\n/)[0]?.trim();
    if (paragraph) {
      return oneLine(paragraph).slice(0, 120);
    }
  }
  return title || "Untitled session";
}
function summarizeToolCall(item) {
  const name = stringOrUndefined(item.name)?.trim();
  if (!name) {
    return null;
  }
  const state = isRecord(item.state) ? item.state : {};
  const input = isRecord(state.input) ? state.input : {};
  const command = stringOrUndefined(input.command) ?? stringOrUndefined(input.cmd);
  if (command != null) {
    return `${name}: ${oneLine(command).slice(0, 200)}`;
  }
  const filePath = stringOrUndefined(input.file_path) ?? stringOrUndefined(input.filePath);
  if (filePath != null) {
    return `${name}: ${filePath}`;
  }
  return name;
}
function rfc3339(epochMs2) {
  return new Date(epochMs2).toISOString();
}
function epochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return void 0;
}
function stringOrUndefined(value) {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  return void 0;
}
function numberOrUndefined(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return void 0;
}
function parseJsonObject(value) {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function cleanText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.replace(/\r\n/g, "\n").trim();
  return cleaned === "" ? null : cleaned;
}
function oneLine(value) {
  return value.replace(/\s+/g, " ").trim();
}

// src/index.ts
var STATE_SCHEMA_VERSION = 1;
var OpencodeConnector = class extends Connector {
  async *poll() {
    const includeToolCalls = this.config.include_tool_calls ?? false;
    const includeArchivedSessions = this.config.include_archived_sessions ?? true;
    const fingerprint = configFingerprint(includeToolCalls);
    const state = initialState(
      this.lastState,
      includeToolCalls,
      includeArchivedSessions,
      fingerprint
    );
    const previousSessions = state.sessions ?? {};
    const previousIndexed = new Set(
      state.indexed_sessions ?? indexedSessionIds(previousSessions)
    );
    const options = { includeArchivedSessions };
    const parseOptions = { includeToolCalls };
    const { access, cleanup } = await openDatabase(this.config);
    const currentSessions = {};
    const currentIndexed = /* @__PURE__ */ new Set();
    try {
      const refs = access.listSessionRefs();
      for (const ref of refs) {
        this.signal.throwIfAborted();
        const previous = previousSessions[ref.id];
        const needsIndex = previous == null || previous.updated_ms !== ref.updatedMs || previous.archived !== (ref.archivedMs != null);
        if (!needsIndex) {
          currentSessions[ref.id] = previous;
          if (previous.indexed) {
            currentIndexed.add(ref.id);
          }
          continue;
        }
        const session = parseSession(
          ref,
          access.listSessionMessages(ref.id),
          parseOptions
        );
        if (isIndexableSession(session, options)) {
          currentSessions[ref.id] = {
            updated_ms: ref.updatedMs,
            archived: ref.archivedMs != null,
            indexed: true
          };
          currentIndexed.add(ref.id);
          yield { updates: [buildSessionUpdate(session)] };
          continue;
        }
        currentSessions[ref.id] = {
          updated_ms: ref.updatedMs,
          archived: ref.archivedMs != null,
          indexed: false
        };
      }
    } finally {
      cleanup();
    }
    for (const sessionId of previousIndexed) {
      if (!currentIndexed.has(sessionId)) {
        this.signal.throwIfAborted();
        yield { updates: [buildSessionDelete(sessionId)] };
      }
    }
    yield {
      updates: [],
      state: nextStateAfterReconcile(
        currentSessions,
        includeToolCalls,
        includeArchivedSessions,
        fingerprint
      )
    };
  }
};
async function openDatabase(config) {
  const dir = resolveOpencodeDir(config.opencode_dir);
  return await openOpencodeDbSnapshot(dir);
}
function initialState(state, includeToolCalls, includeArchivedSessions, fingerprint) {
  if (state?.schema_version !== STATE_SCHEMA_VERSION || state.include_tool_calls !== includeToolCalls || state.include_archived_sessions !== includeArchivedSessions || state.config_fingerprint !== fingerprint) {
    return nextBaseState(
      {
        indexed_sessions: state?.indexed_sessions ?? indexedSessionIds(state?.sessions ?? {})
      },
      includeToolCalls,
      includeArchivedSessions,
      fingerprint
    );
  }
  return state;
}
function nextStateAfterReconcile(sessions, includeToolCalls, includeArchivedSessions, fingerprint) {
  return nextBaseState(
    {
      sessions,
      indexed_sessions: indexedSessionIds(sessions)
    },
    includeToolCalls,
    includeArchivedSessions,
    fingerprint
  );
}
function nextBaseState(state, includeToolCalls, includeArchivedSessions, fingerprint) {
  return {
    ...state,
    schema_version: STATE_SCHEMA_VERSION,
    config_fingerprint: fingerprint,
    include_tool_calls: includeToolCalls,
    include_archived_sessions: includeArchivedSessions,
    sessions: state.sessions ?? {},
    indexed_sessions: [...new Set(state.indexed_sessions ?? [])].sort()
  };
}
function indexedSessionIds(sessions) {
  return Object.keys(sessions).sort();
}
function configFingerprint(includeToolCalls) {
  return `v1:${includeToolCalls ? "tool" : "notool"}`;
}
export {
  OpencodeConnector as default,
  initialState,
  nextStateAfterReconcile
};
//# sourceMappingURL=main.js.map

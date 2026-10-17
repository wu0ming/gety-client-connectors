// src/index.ts
import { Connector, del, upsert } from "@gety-ai/connector-sdk";

// src/wb_log.ts
var MAX_CONTENT_CHARS = 2e6;
var MAX_TITLE_CHARS = 120;
var MAX_TOOL_CALLS = 100;
function parseTrace(raw, filePath) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const trace = isRecord(data.trace) ? data.trace : {};
  const spans = Array.isArray(data.spans) ? data.spans : [];
  const generations = spans.filter((span) => isRecord(span) && span.name === "generation").sort((left, right) => String(left.startedAt ?? "").localeCompare(String(right.startedAt ?? "")));
  if (generations.length === 0) return null;
  const generation = generations[generations.length - 1];
  const messages = asMessages(parseMaybeJson(generation.toolInput));
  const rounds = [];
  const seen = /* @__PURE__ */ new Set();
  let workspace = "";
  for (const message of messages) {
    const role = typeof message.role === "string" ? message.role : "";
    const content = contentText(message.content);
    if (role === "user") {
      if (workspace === "") {
        const match = /Workspace Folder:\s*([^\n<]+)/i.exec(content);
        if (match !== null) workspace = match[1]?.trim() ?? "";
      }
      const query = extractUserQuery(content);
      if (query !== "") pushRound(rounds, seen, "user", query);
    } else if (role === "assistant") {
      const text2 = normalize(content);
      if (text2 !== "" && !isControlPayload(text2)) {
        pushRound(rounds, seen, "assistant", text2);
      }
    }
  }
  const toolCalls = [];
  collectToolCalls(parseMaybeJson(generation.toolOutput), toolCalls);
  const outputText = assistantOutputText(parseMaybeJson(generation.toolOutput));
  if (outputText !== "" && !isControlPayload(outputText)) {
    pushRound(rounds, seen, "assistant", outputText);
  }
  if (rounds.length === 0) return null;
  const firstUser = rounds.find((round) => round.role === "user")?.text ?? "";
  const modelInfo = isRecord(trace.modelInfo) ? trace.modelInfo : {};
  const models = Array.isArray(modelInfo.models) ? modelInfo.models.filter((entry) => typeof entry === "string") : [];
  return {
    traceId: typeof trace.traceId === "string" && trace.traceId !== "" ? trace.traceId : baseName(filePath),
    sessionId: typeof trace.sessionId === "string" && trace.sessionId !== "" ? trace.sessionId : null,
    startedAt: isoOrEmpty(trace.startedAt),
    endedAt: isoOrEmpty(trace.endedAt),
    workspace,
    model: models.join(", "),
    title: titleFromText(firstUser) ?? `Trace ${shortId(String(trace.traceId ?? filePath))}`,
    rounds,
    toolCalls: dedupeToolCalls(toolCalls).slice(0, MAX_TOOL_CALLS)
  };
}
function renderSession(session, traces, options, sessionDir) {
  const sorted = [
    ...traces
  ].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const rounds = mergeRounds(sorted);
  const title = sessionTitle(session, rounds);
  const createdAt = toIso(session.createdAt);
  const updatedAt = toIso(session.updatedAt || session.lastActivityAt || session.createdAt);
  const lines = [
    `# ${title}`,
    "",
    `> Workspace: \`${session.cwd || "unknown"}\` \xB7 Model: \`${session.model || "unknown"}\` \xB7 Mode: \`${session.mode || session.sourceMode || "unknown"}\` \xB7 Status: \`${session.status || "unknown"}\` \xB7 Created: ${createdAt} \xB7 Updated: ${updatedAt} \xB7 Messages: ${rounds.length}`,
    "",
    "## Session",
    "",
    `- Session ID: \`${session.id}\``,
    `- Transport: \`${session.transport || "local"}\``,
    `- Playground: ${session.isPlayground ? "yes" : "no"}`,
    `- Automation: ${session.isAutomation ? "yes" : "no"}`,
    `- Local traces: ${sorted.length}`
  ];
  if (session.groupTitle !== "") lines.push(`- Group: ${session.groupTitle}`);
  lines.push("");
  if (rounds.length === 0) {
    lines.push("_WorkBuddy keeps full conversation text in its cloud service. This desktop copy has no local agent trace for this session, so only its local index entry is searchable._", "");
  } else {
    for (const [index, round] of rounds.entries()) {
      if (index > 0) lines.push("---", "");
      lines.push(`### ${round.role === "user" ? "User" : "WorkBuddy"}`, "", round.text, "");
    }
    if (options.includeToolCalls) {
      const calls = dedupeToolCalls(sorted.flatMap((trace) => trace.toolCalls));
      if (calls.length > 0) {
        lines.push("### Tool calls", "", ...calls.map((call) => `- \`${call.name}\`${call.detail === "" ? "" : ` \u2014 ${call.detail}`}`), "");
      }
    }
  }
  const markdown = capContent(lines.join("\n"));
  const target = sessionDir || session.cwd;
  return {
    title,
    markdown,
    url: fileUrl(target),
    metadata: {
      url: fileUrl(target),
      workspace: session.cwd,
      model: session.model,
      status: session.status,
      mode: session.mode || session.sourceMode,
      transport: session.transport,
      created_at: createdAt,
      updated_at: updatedAt,
      messages: rounds.length,
      traces: sorted.length,
      playground: session.isPlayground ? "yes" : "no"
    }
  };
}
function renderTrace(trace, filePath, options) {
  const lines = [
    `# ${trace.title}`,
    "",
    `> Workspace: \`${trace.workspace || "unknown"}\` \xB7 Model: \`${trace.model || "unknown"}\` \xB7 Trace: \`${trace.traceId}\` \xB7 Started: ${trace.startedAt || "unknown"}`,
    ""
  ];
  for (const [index, round] of trace.rounds.entries()) {
    if (index > 0) lines.push("---", "");
    lines.push(`### ${round.role === "user" ? "User" : "WorkBuddy"}`, "", round.text, "");
  }
  if (options.includeToolCalls && trace.toolCalls.length > 0) {
    lines.push("### Tool calls", "", ...trace.toolCalls.map((call) => `- \`${call.name}\`${call.detail === "" ? "" : ` \u2014 ${call.detail}`}`), "");
  }
  return {
    title: trace.title,
    markdown: capContent(lines.join("\n")),
    url: fileUrl(filePath),
    metadata: {
      url: fileUrl(filePath),
      workspace: trace.workspace,
      model: trace.model,
      trace_id: trace.traceId,
      started_at: trace.startedAt || toIso(Date.now()),
      messages: trace.rounds.length
    }
  };
}
function mergeRounds(traces) {
  const rounds = [];
  const seen = /* @__PURE__ */ new Set();
  for (const trace of traces) {
    for (const round of trace.rounds) {
      const key = `${round.role}\0${round.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rounds.push(round);
    }
  }
  return rounds;
}
function sessionTitle(session, rounds) {
  const preferred = session.customTitle.trim() || session.title.trim();
  if (preferred !== "" && preferred !== "New session started") return preferred;
  const firstUser = rounds.find((round) => round.role === "user")?.text ?? "";
  return titleFromText(firstUser) ?? `WorkBuddy session ${shortId(session.id)}`;
}
function extractUserQuery(text2) {
  const query = /<user_query>([\s\S]*?)<\/user_query>/i.exec(text2);
  if (query !== null) {
    const value = normalize(query[1] ?? "");
    return isAutomationPrompt(value) ? "" : value;
  }
  let stripped = text2.replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, " ").replace(/<user_info>[\s\S]*?<\/user_info>/gi, " ").replace(/<identity_context>[\s\S]*?<\/identity_context>/gi, " ").replace(/<[^>]+>/g, " ");
  stripped = normalize(stripped);
  if (stripped.length > 2e3) stripped = stripped.slice(-2e3).trim();
  return isAutomationPrompt(stripped) ? "" : stripped;
}
function isAutomationPrompt(text2) {
  const lower = text2.toLowerCase();
  if (lower.includes("automation_system_reminder")) return true;
  if (lower.includes("you must follow these steps in order")) return true;
  return text2.trim() === ".";
}
function isControlPayload(text2) {
  const trimmed = text2.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}") || trimmed.length > 500) return false;
  return trimmed.includes('"isNewTopic"') || trimmed.includes('"title"');
}
function titleFromText(text2) {
  const normalized = normalize(text2).replace(/\s+/g, " ");
  if (normalized === "") return null;
  return normalized.length > MAX_TITLE_CHARS ? `${normalized.slice(0, MAX_TITLE_CHARS - 1)}\u2026` : normalized;
}
function hashText(text2) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let index = 0; index < text2.length; index += 1) {
    hash ^= BigInt(text2.charCodeAt(index));
    hash = hash * prime & mask;
  }
  return hash.toString(16);
}
function capContent(markdown) {
  const trimmed = `${markdown.replace(/\n{3,}/g, "\n\n").trimEnd()}
`;
  if (trimmed.length <= MAX_CONTENT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_CONTENT_CHARS)}

_[WorkBuddy content truncated by the connector.]_
`;
}
function assistantOutputText(output) {
  const pieces = [];
  for (const item of Array.isArray(output) ? output : [
    output
  ]) {
    if (!isRecord(item)) continue;
    const choices = Array.isArray(item.choices) ? item.choices : [];
    for (const choice of choices) {
      if (!isRecord(choice) || !isRecord(choice.message)) continue;
      const text2 = normalize(contentText(choice.message.content));
      if (text2 !== "") pieces.push(text2);
    }
  }
  return pieces.join("\n\n").trim();
}
function collectToolCalls(output, target) {
  for (const item of Array.isArray(output) ? output : [
    output
  ]) {
    if (!isRecord(item)) continue;
    const choices = Array.isArray(item.choices) ? item.choices : [];
    for (const choice of choices) {
      if (!isRecord(choice) || !isRecord(choice.message)) continue;
      const calls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
      for (const call of calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        const name = typeof call.function.name === "string" ? call.function.name : "tool";
        const args = typeof call.function.arguments === "string" ? call.function.arguments : "";
        target.push({
          name,
          detail: toolDetail(args)
        });
      }
    }
  }
}
function toolDetail(args) {
  try {
    const parsed = JSON.parse(args);
    if (isRecord(parsed)) {
      const description = typeof parsed.description === "string" ? parsed.description : "";
      const command = typeof parsed.command === "string" ? parsed.command : "";
      const filePath = typeof parsed.file_path === "string" ? parsed.file_path : "";
      const detail = description || command || filePath;
      return normalize(detail).slice(0, 180);
    }
  } catch {
  }
  return normalize(args).slice(0, 180);
}
function dedupeToolCalls(calls) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const call of calls) {
    const key = `${call.name}\0${call.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(call);
  }
  return result;
}
function pushRound(rounds, seen, role, text2) {
  const normalized = normalize(text2);
  if (normalized === "") return;
  const key = `${role}\0${normalized}`;
  if (seen.has(key)) return;
  seen.add(key);
  rounds.push({
    role,
    text: normalized
  });
}
function asMessages(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => isRecord(entry));
}
function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const pieces = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (typeof part.text === "string") pieces.push(part.text);
  }
  return pieces.join("\n");
}
function normalize(text2) {
  return String(text2).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function isoOrEmpty(value) {
  if (typeof value !== "string" || value === "") return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
function toIso(ms) {
  const value = Number(ms);
  return new Date(Number.isFinite(value) && value > 0 ? value : Date.now()).toISOString();
}
function fileUrl(path) {
  const normalized = path.replace(/\\/g, "/");
  const withSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(withSlash)}`;
}
function shortId(id) {
  return id.replace(/[^A-Za-z0-9]/g, "").slice(-8) || "unknown";
}
function baseName(path) {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.length === 0 ? path : segments[segments.length - 1] ?? path;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/wb_home.ts
import { DatabaseSync } from "node:sqlite";
function resolveWorkBuddyHome() {
  const explicit = Deno.env.get("WORKBUDDY_HOME");
  if (explicit !== void 0 && explicit.trim() !== "") return explicit.trim();
  const userProfile = Deno.env.get("USERPROFILE");
  if (userProfile !== void 0 && userProfile.trim() !== "") {
    return `${userProfile.trim()}\\.workbuddy`;
  }
  const home = Deno.env.get("HOME");
  if (home !== void 0 && home.trim() !== "") {
    return `${home.trim()}/.workbuddy`;
  }
  return ".workbuddy";
}
function databasePath(workbuddyHome) {
  return `${workbuddyHome}/workbuddy.db`;
}
function traceRoot(workbuddyHome) {
  return `${workbuddyHome}/traces`;
}
function sessionDirectory(workbuddyHome, sessionId) {
  return `${workbuddyHome}/workspace/sessions/${sessionId}`;
}
function cachePath() {
  const localAppData = Deno.env.get("LOCALAPPDATA");
  if (localAppData !== void 0 && localAppData.trim() !== "") {
    return `${localAppData.trim()}\\gety-workbuddy-connector\\cache-v1.json`;
  }
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  return `${home}/.cache/gety-workbuddy-connector/cache-v1.json`;
}
function readSessions(workbuddyHome) {
  let db;
  try {
    db = new DatabaseSync(databasePath(workbuddyHome), {
      readOnly: true
    });
  } catch {
    return null;
  }
  try {
    const rows = db.prepare(`select id, cwd, title, custom_title, status, created_at, updated_at,
                last_activity_at, deleted_at, is_playground, mode, source_mode, model,
                group_title, is_background_automation, transport
         from sessions`).all();
    const sessions = [];
    const deletedSessionIds = /* @__PURE__ */ new Set();
    for (const row of rows) {
      const id = text(row.id);
      if (id === "") continue;
      if (row.deleted_at !== null && number(row.deleted_at) !== -1) {
        deletedSessionIds.add(id);
        continue;
      }
      sessions.push({
        id,
        cwd: text(row.cwd),
        title: text(row.title),
        customTitle: text(row.custom_title),
        status: text(row.status),
        createdAt: number(row.created_at),
        updatedAt: number(row.updated_at),
        lastActivityAt: number(row.last_activity_at),
        isPlayground: number(row.is_playground) === 1,
        mode: text(row.mode),
        sourceMode: text(row.source_mode),
        model: text(row.model),
        groupTitle: text(row.group_title),
        isAutomation: number(row.is_background_automation) === 1,
        transport: text(row.transport)
      });
    }
    return {
      sessions,
      deletedSessionIds
    };
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
    }
  }
}
async function listTraceFiles(workbuddyHome) {
  const root = traceRoot(workbuddyHome);
  const files = [];
  let buckets;
  try {
    buckets = [];
    for await (const entry of Deno.readDir(root)) {
      if (entry.isDirectory) buckets.push(entry);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return files;
    throw error;
  }
  for (const bucket of buckets) {
    let entries;
    try {
      entries = [];
      for await (const entry of Deno.readDir(`${root}/${bucket.name}`)) {
        entries.push(entry);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const path = `${root}/${bucket.name}/${entry.name}`;
      let stat;
      try {
        stat = await Deno.stat(path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      files.push({
        path,
        mtimeMs: stat.mtime?.getTime() ?? 0,
        size: stat.size
      });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}
async function readCache(path) {
  try {
    const raw = JSON.parse(await Deno.readTextFile(path));
    if (!isRecord2(raw) || raw.version !== 1 || !isRecord2(raw.traces)) {
      throw new Error("invalid cache");
    }
    return {
      version: 1,
      traces: raw.traces
    };
  } catch {
    return {
      version: 1,
      traces: {}
    };
  }
}
async function writeCache(path, cache) {
  try {
    const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (slash > 0) await Deno.mkdir(path.slice(0, slash), {
      recursive: true
    });
    await Deno.writeTextFile(path, JSON.stringify(cache));
  } catch {
  }
}
function text(value) {
  return typeof value === "string" ? value : "";
}
function number(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/index.ts
var STATE_SCHEMA_VERSION = 1;
var WorkBuddyConnector = class extends Connector {
  async *poll() {
    const includeToolCalls = this.config.include_tool_calls ?? false;
    const includeMetadataOnly = this.config.include_metadata_only_sessions ?? true;
    const optionsChanged = this.lastState?.schema_version !== STATE_SCHEMA_VERSION || this.lastState.include_tool_calls !== includeToolCalls || this.lastState.include_metadata_only_sessions !== includeMetadataOnly;
    const state = initialState(this.lastState, includeToolCalls, includeMetadataOnly);
    const home = resolveWorkBuddyHome();
    const sessionIndex = readSessions(home);
    if (sessionIndex === null) {
      console.error("workbuddy connector: session database is not readable; skipping this poll");
      yield {
        updates: []
      };
      return;
    }
    let files;
    try {
      files = await listTraceFiles(home);
    } catch {
      console.error("workbuddy connector: trace directory is not readable; skipping this poll");
      yield {
        updates: []
      };
      return;
    }
    const cache = await readCache(cachePath());
    let cacheDirty = false;
    let parsedCount = 0;
    const traces = [];
    const tracePaths = /* @__PURE__ */ new Map();
    for (const file of files) {
      this.signal.throwIfAborted();
      const cached = cache.traces[file.path];
      if (cached !== void 0 && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
        const trace2 = toTrace(cached);
        traces.push(trace2);
        tracePaths.set(trace2.traceId, file.path);
        continue;
      }
      let text2;
      try {
        text2 = await Deno.readTextFile(file.path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        console.error("workbuddy connector: trace file is not readable; skipping this poll");
        yield {
          updates: []
        };
        return;
      }
      const trace = parseTrace(text2, file.path) ?? emptyTrace(file.path);
      cache.traces[file.path] = {
        ...trace,
        path: file.path,
        mtimeMs: file.mtimeMs,
        size: file.size
      };
      cacheDirty = true;
      parsedCount += 1;
      if (parsedCount % 100 === 0) {
        console.info(`workbuddy connector: parsed ${parsedCount} trace files`);
      }
      traces.push(trace);
      tracePaths.set(trace.traceId, file.path);
    }
    const present = new Set(files.map((file) => file.path));
    for (const key of Object.keys(cache.traces)) {
      if (!present.has(key)) {
        delete cache.traces[key];
        cacheDirty = true;
      }
    }
    if (cacheDirty) await writeCache(cachePath(), cache);
    const sessionIds = new Set(sessionIndex.sessions.map((session) => session.id));
    const bySession = /* @__PURE__ */ new Map();
    const orphan = [];
    for (const trace of traces) {
      if (trace.rounds.length === 0) continue;
      if (trace.sessionId !== null && sessionIds.has(trace.sessionId)) {
        const list = bySession.get(trace.sessionId) ?? [];
        list.push(trace);
        bySession.set(trace.sessionId, list);
      } else if (trace.sessionId !== null && sessionIndex.deletedSessionIds.has(trace.sessionId)) {
        continue;
      } else {
        orphan.push(trace);
      }
    }
    const currentDocs = {};
    let upserts = 0;
    for (const session of sessionIndex.sessions) {
      const sessionTraces = bySession.get(session.id) ?? [];
      if (sessionTraces.length === 0 && !includeMetadataOnly) continue;
      const docId = `wb-session-${session.id}`;
      const rendered = renderSession(session, sessionTraces, {
        includeToolCalls
      }, sessionDirectory(home, session.id));
      const hash = hashText(`${rendered.title}
${rendered.markdown}
${JSON.stringify(rendered.metadata)}`);
      currentDocs[docId] = hash;
      if (!optionsChanged && state.docs?.[docId] === hash) continue;
      yield {
        updates: [
          upsert({
            id: docId,
            title: rendered.title,
            content: rendered.markdown,
            content_format: "markdown",
            doc_type: "workbuddy:session",
            doc_updated_at: sessionUpdatedAt(session, sessionTraces),
            original_file_size: rendered.markdown.length,
            metadata: rendered.metadata
          })
        ]
      };
      upserts += 1;
      if (upserts % 200 === 0) {
        console.info(`workbuddy connector: emitted ${upserts} session documents`);
      }
    }
    for (const trace of orphan) {
      if (!trace.rounds.some((round) => round.role === "user")) continue;
      const docId = `wb-trace-${trace.traceId}`;
      const path = tracePaths.get(trace.traceId) ?? "";
      const rendered = renderTrace(trace, path, {
        includeToolCalls
      });
      const hash = hashText(`${rendered.title}
${rendered.markdown}
${JSON.stringify(rendered.metadata)}`);
      currentDocs[docId] = hash;
      if (!optionsChanged && state.docs?.[docId] === hash) continue;
      yield {
        updates: [
          upsert({
            id: docId,
            title: rendered.title,
            content: rendered.markdown,
            content_format: "markdown",
            doc_type: "workbuddy:trace",
            doc_updated_at: trace.endedAt || trace.startedAt || (/* @__PURE__ */ new Date()).toISOString(),
            original_file_size: rendered.markdown.length,
            metadata: rendered.metadata
          })
        ]
      };
      upserts += 1;
    }
    for (const docId of Object.keys(state.docs ?? {})) {
      if (!(docId in currentDocs)) {
        yield {
          updates: [
            del(docId)
          ]
        };
      }
    }
    yield {
      updates: [],
      state: {
        schema_version: STATE_SCHEMA_VERSION,
        include_tool_calls: includeToolCalls,
        include_metadata_only_sessions: includeMetadataOnly,
        docs: sortRecord(currentDocs)
      }
    };
  }
};
function initialState(state, includeToolCalls, includeMetadataOnly) {
  if (state?.schema_version !== STATE_SCHEMA_VERSION || state.include_tool_calls !== includeToolCalls || state.include_metadata_only_sessions !== includeMetadataOnly) {
    if (state === null || state === void 0) {
      return {
        schema_version: STATE_SCHEMA_VERSION,
        include_tool_calls: includeToolCalls,
        include_metadata_only_sessions: includeMetadataOnly,
        docs: {}
      };
    }
    return {
      ...state,
      schema_version: STATE_SCHEMA_VERSION,
      include_tool_calls: includeToolCalls,
      include_metadata_only_sessions: includeMetadataOnly,
      docs: state.docs ?? {}
    };
  }
  return state;
}
function sessionUpdatedAt(session, traces) {
  const candidates = [
    session.updatedAt,
    session.lastActivityAt,
    session.createdAt,
    ...traces.map((trace) => Date.parse(trace.endedAt || trace.startedAt)).filter((value) => Number.isFinite(value))
  ].filter((value) => typeof value === "number" && value > 0);
  const latest = candidates.length === 0 ? Date.now() : Math.max(...candidates);
  return new Date(latest).toISOString();
}
function toTrace(cached) {
  return {
    traceId: cached.traceId,
    sessionId: cached.sessionId,
    startedAt: cached.startedAt,
    endedAt: cached.endedAt,
    workspace: cached.workspace,
    model: cached.model,
    title: cached.title,
    rounds: cached.rounds,
    toolCalls: cached.toolCalls
  };
}
function emptyTrace(path) {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return {
    traceId: segments.length === 0 ? path : segments[segments.length - 1] ?? path,
    sessionId: null,
    startedAt: "",
    endedAt: "",
    workspace: "",
    model: "",
    title: "",
    rounds: [],
    toolCalls: []
  };
}
function sortRecord(record) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}
export {
  capContent,
  WorkBuddyConnector as default,
  initialState,
  sessionUpdatedAt
};

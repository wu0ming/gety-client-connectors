/**
 * WorkBuddy session/trace parsing and markdown rendering.
 *
 * WorkBuddy's desktop client keeps a local SQLite session index and optional
 * local agent trace JSON files. Full conversation text lives in WorkBuddy's
 * cloud service, so this connector indexes:
 *   - every local session index entry (title, workspace, model, status), and
 *   - conversation rounds recovered from local agent traces where present.
 */

export interface WbSession {
  id: string;
  cwd: string;
  title: string;
  customTitle: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  isPlayground: boolean;
  mode: string;
  sourceMode: string;
  model: string;
  groupTitle: string;
  isAutomation: boolean;
  transport: string;
}

export interface WbRound {
  role: "user" | "assistant";
  text: string;
}

export interface WbToolCall {
  name: string;
  detail: string;
}

export interface WbTrace {
  traceId: string;
  sessionId: string | null;
  startedAt: string;
  endedAt: string;
  workspace: string;
  model: string;
  title: string;
  rounds: WbRound[];
  toolCalls: WbToolCall[];
}

export interface RenderOptions {
  includeToolCalls: boolean;
}

export interface RenderResult {
  title: string;
  markdown: string;
  url: string;
  metadata: Record<string, string | number>;
}

const MAX_CONTENT_CHARS = 2_000_000;
const MAX_TITLE_CHARS = 120;
const MAX_TOOL_CALLS = 100;

/** Parse one trace JSON file into conversation rounds; returns null when it has no usable text. */
export function parseTrace(raw: string, filePath: string): WbTrace | null {
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const trace = isRecord(data.trace) ? data.trace : {};
  const spans = Array.isArray(data.spans) ? data.spans : [];
  const generations = spans
    .filter((span) => isRecord(span) && span.name === "generation")
    .sort((left, right) =>
      String(left.startedAt ?? "").localeCompare(String(right.startedAt ?? ""))
    );
  if (generations.length === 0) return null;
  const generation = generations[generations.length - 1] as Record<
    string,
    unknown
  >;
  const messages = asMessages(parseMaybeJson(generation.toolInput));
  const rounds: WbRound[] = [];
  const seen = new Set<string>();
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
      const text = normalize(content);
      if (text !== "" && !isControlPayload(text)) {
        pushRound(rounds, seen, "assistant", text);
      }
    }
  }

  const toolCalls: WbToolCall[] = [];
  collectToolCalls(parseMaybeJson(generation.toolOutput), toolCalls);
  const outputText = assistantOutputText(parseMaybeJson(generation.toolOutput));
  if (outputText !== "" && !isControlPayload(outputText)) {
    pushRound(rounds, seen, "assistant", outputText);
  }

  if (rounds.length === 0) return null;
  const firstUser = rounds.find((round) => round.role === "user")?.text ?? "";
  const modelInfo = isRecord(trace.modelInfo) ? trace.modelInfo : {};
  const models = Array.isArray(modelInfo.models)
    ? modelInfo.models.filter((entry): entry is string =>
      typeof entry === "string"
    )
    : [];
  return {
    traceId: typeof trace.traceId === "string" && trace.traceId !== ""
      ? trace.traceId
      : baseName(filePath),
    sessionId: typeof trace.sessionId === "string" && trace.sessionId !== ""
      ? trace.sessionId
      : null,
    startedAt: isoOrEmpty(trace.startedAt),
    endedAt: isoOrEmpty(trace.endedAt),
    workspace,
    model: models.join(", "),
    title: titleFromText(firstUser) ??
      `Trace ${shortId(String(trace.traceId ?? filePath))}`,
    rounds,
    toolCalls: dedupeToolCalls(toolCalls).slice(0, MAX_TOOL_CALLS),
  };
}

/** Build one document for a WorkBuddy session, optionally enriched by local traces. */
export function renderSession(
  session: WbSession,
  traces: WbTrace[],
  options: RenderOptions,
  sessionDir: string,
): RenderResult {
  const sorted = [...traces].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt)
  );
  const rounds = mergeRounds(sorted);
  const title = sessionTitle(session, rounds);
  const createdAt = toIso(session.createdAt);
  const updatedAt = toIso(
    session.updatedAt || session.lastActivityAt || session.createdAt,
  );
  const lines = [
    `# ${title}`,
    "",
    `> Workspace: \`${session.cwd || "unknown"}\` · Model: \`${
      session.model || "unknown"
    }\` · Mode: \`${
      session.mode || session.sourceMode || "unknown"
    }\` · Status: \`${
      session.status || "unknown"
    }\` · Created: ${createdAt} · Updated: ${updatedAt} · Messages: ${rounds.length}`,
    "",
    "## Session",
    "",
    `- Session ID: \`${session.id}\``,
    `- Transport: \`${session.transport || "local"}\``,
    `- Playground: ${session.isPlayground ? "yes" : "no"}`,
    `- Automation: ${session.isAutomation ? "yes" : "no"}`,
    `- Local traces: ${sorted.length}`,
  ];
  if (session.groupTitle !== "") lines.push(`- Group: ${session.groupTitle}`);
  lines.push("");

  if (rounds.length === 0) {
    lines.push(
      "_WorkBuddy keeps full conversation text in its cloud service. This desktop copy has no local agent trace for this session, so only its local index entry is searchable._",
      "",
    );
  } else {
    for (const [index, round] of rounds.entries()) {
      if (index > 0) lines.push("---", "");
      lines.push(
        `### ${round.role === "user" ? "User" : "WorkBuddy"}`,
        "",
        round.text,
        "",
      );
    }
    if (options.includeToolCalls) {
      const calls = dedupeToolCalls(sorted.flatMap((trace) => trace.toolCalls));
      if (calls.length > 0) {
        lines.push(
          "### Tool calls",
          "",
          ...calls.map((call) =>
            `- \`${call.name}\`${call.detail === "" ? "" : ` — ${call.detail}`}`
          ),
          "",
        );
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
      playground: session.isPlayground ? "yes" : "no",
    },
  };
}

/** Build one document for a trace that has no matching session index entry. */
export function renderTrace(
  trace: WbTrace,
  filePath: string,
  options: RenderOptions,
): RenderResult {
  const lines = [
    `# ${trace.title}`,
    "",
    `> Workspace: \`${trace.workspace || "unknown"}\` · Model: \`${
      trace.model || "unknown"
    }\` · Trace: \`${trace.traceId}\` · Started: ${
      trace.startedAt || "unknown"
    }`,
    "",
  ];
  for (const [index, round] of trace.rounds.entries()) {
    if (index > 0) lines.push("---", "");
    lines.push(
      `### ${round.role === "user" ? "User" : "WorkBuddy"}`,
      "",
      round.text,
      "",
    );
  }
  if (options.includeToolCalls && trace.toolCalls.length > 0) {
    lines.push(
      "### Tool calls",
      "",
      ...trace.toolCalls.map((call) =>
        `- \`${call.name}\`${call.detail === "" ? "" : ` — ${call.detail}`}`
      ),
      "",
    );
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
      messages: trace.rounds.length,
    },
  };
}

export function mergeRounds(traces: WbTrace[]): WbRound[] {
  const rounds: WbRound[] = [];
  const seen = new Set<string>();
  for (const trace of traces) {
    for (const round of trace.rounds) {
      const key = `${round.role}\u0000${round.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rounds.push(round);
    }
  }
  return rounds;
}

export function sessionTitle(session: WbSession, rounds: WbRound[]): string {
  const preferred = session.customTitle.trim() || session.title.trim();
  if (preferred !== "" && preferred !== "New session started") return preferred;
  const firstUser = rounds.find((round) => round.role === "user")?.text ?? "";
  return titleFromText(firstUser) ?? `WorkBuddy session ${shortId(session.id)}`;
}

export function extractUserQuery(text: string): string {
  const query = /<user_query>([\s\S]*?)<\/user_query>/i.exec(text);
  if (query !== null) {
    const value = normalize(query[1] ?? "");
    return isAutomationPrompt(value) ? "" : value;
  }
  let stripped = text
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, " ")
    .replace(/<user_info>[\s\S]*?<\/user_info>/gi, " ")
    .replace(/<identity_context>[\s\S]*?<\/identity_context>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  stripped = normalize(stripped);
  if (stripped.length > 2000) stripped = stripped.slice(-2000).trim();
  return isAutomationPrompt(stripped) ? "" : stripped;
}

function isAutomationPrompt(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes("automation_system_reminder")) return true;
  if (lower.includes("you must follow these steps in order")) return true;
  return text.trim() === ".";
}

function isControlPayload(text: string): boolean {
  const trimmed = text.trim();
  if (
    !trimmed.startsWith("{") || !trimmed.endsWith("}") || trimmed.length > 500
  ) return false;
  return trimmed.includes('"isNewTopic"') || trimmed.includes('"title"');
}

export function titleFromText(text: string): string | null {
  const normalized = normalize(text).replace(/\s+/g, " ");
  if (normalized === "") return null;
  return normalized.length > MAX_TITLE_CHARS
    ? `${normalized.slice(0, MAX_TITLE_CHARS - 1)}…`
    : normalized;
}

export function hashText(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16);
}

export function capContent(markdown: string): string {
  const trimmed = `${markdown.replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
  if (trimmed.length <= MAX_CONTENT_CHARS) return trimmed;
  return `${
    trimmed.slice(0, MAX_CONTENT_CHARS)
  }\n\n_[WorkBuddy content truncated by the connector.]_\n`;
}

export function assistantOutputText(output: unknown): string {
  const pieces: string[] = [];
  for (const item of Array.isArray(output) ? output : [output]) {
    if (!isRecord(item)) continue;
    const choices = Array.isArray(item.choices) ? item.choices : [];
    for (const choice of choices) {
      if (!isRecord(choice) || !isRecord(choice.message)) continue;
      const text = normalize(contentText(choice.message.content));
      if (text !== "") pieces.push(text);
    }
  }
  return pieces.join("\n\n").trim();
}

export function collectToolCalls(output: unknown, target: WbToolCall[]): void {
  for (const item of Array.isArray(output) ? output : [output]) {
    if (!isRecord(item)) continue;
    const choices = Array.isArray(item.choices) ? item.choices : [];
    for (const choice of choices) {
      if (!isRecord(choice) || !isRecord(choice.message)) continue;
      const calls = Array.isArray(choice.message.tool_calls)
        ? choice.message.tool_calls
        : [];
      for (const call of calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        const name = typeof call.function.name === "string"
          ? call.function.name
          : "tool";
        const args = typeof call.function.arguments === "string"
          ? call.function.arguments
          : "";
        target.push({ name, detail: toolDetail(args) });
      }
    }
  }
}

function toolDetail(args: string): string {
  try {
    const parsed = JSON.parse(args) as unknown;
    if (isRecord(parsed)) {
      const description = typeof parsed.description === "string"
        ? parsed.description
        : "";
      const command = typeof parsed.command === "string" ? parsed.command : "";
      const filePath = typeof parsed.file_path === "string"
        ? parsed.file_path
        : "";
      const detail = description || command || filePath;
      return normalize(detail).slice(0, 180);
    }
  } catch {
    // keep the raw argument prefix
  }
  return normalize(args).slice(0, 180);
}

function dedupeToolCalls(calls: WbToolCall[]): WbToolCall[] {
  const seen = new Set<string>();
  const result: WbToolCall[] = [];
  for (const call of calls) {
    const key = `${call.name}\u0000${call.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(call);
  }
  return result;
}

function pushRound(
  rounds: WbRound[],
  seen: Set<string>,
  role: WbRound["role"],
  text: string,
): void {
  const normalized = normalize(text);
  if (normalized === "") return;
  const key = `${role}\u0000${normalized}`;
  if (seen.has(key)) return;
  seen.add(key);
  rounds.push({ role, text: normalized });
}

function asMessages(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> =>
    isRecord(entry)
  );
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const pieces: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (typeof part.text === "string") pieces.push(part.text);
  }
  return pieces.join("\n");
}

function normalize(text: string): string {
  return String(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isoOrEmpty(value: unknown): string {
  if (typeof value !== "string" || value === "") return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function toIso(ms: number): string {
  const value = Number(ms);
  return new Date(Number.isFinite(value) && value > 0 ? value : Date.now())
    .toISOString();
}

function fileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const withSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(withSlash)}`;
}

function shortId(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, "").slice(-8) || "unknown";
}

function baseName(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.length === 0 ? path : segments[segments.length - 1] ?? path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

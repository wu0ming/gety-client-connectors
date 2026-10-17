/**
 * DeepSeek Harness session log parsing and markdown rendering.
 *
 * DSH stores one session per `session.v4.jsonl.zstd` file. The file is a
 * concatenation of independent zstd frames, one per appended event, so it must
 * be decompressed frame by frame (`fzstd` does this) rather than as one stream.
 */

import { Decompress } from "./vendor/fzstd.js";

export interface DshLogEvent {
  type: string;
  seq?: number;
  time?: number;
  data?: Record<string, unknown>;
  id?: string;
  cwd?: string;
  createdAt?: number;
  delegationDepth?: number;
}

export interface DshWorkspace {
  id: string;
  title: string;
  path: string;
  sessionIds: string[];
}

export interface DshSession {
  id: string;
  filePath: string;
  workspaceId: string | null;
  workspaceTitle: string;
  workspacePath: string;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  messageCount: number;
  delegationDepth: number;
  toolCallCount: number;
  markdown: string;
  contentBytes: number;
}

export interface ParseOptions {
  includeToolCalls: boolean;
  workspace?: DshWorkspace | null;
  now?: number;
}

const MAX_CONTENT_CHARS = 2_000_000;
const MAX_TITLE_CHARS = 120;

/** Decompress every complete zstd frame in the file, keeping frames decoded before a corrupt tail. */
export function decodeSessionBytes(bytes: Uint8Array): string {
  const parts: Uint8Array[] = [];
  let total = 0;
  const stream = new Decompress((chunk: Uint8Array) => {
    parts.push(chunk.slice());
    total += chunk.byteLength;
  });
  try {
    stream.push(bytes, true);
  } catch {
    // A poll can catch DSH between appending a frame and the next one. The
    // frames already produced remain valid, and the file is retried on the
    // next poll because its size/mtime change again.
  }
  if (parts.length === 0) return "";
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export function parseEvents(text: string): DshLogEvent[] {
  const events: DshLogEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (isRecord(value) && typeof value.type === "string") {
        events.push(value as unknown as DshLogEvent);
      }
    } catch {
      // Skip a line truncated by a concurrent append.
    }
  }
  return events;
}

export function isIndexableSession(
  session: DshSession | null,
): session is DshSession {
  return session !== null && session.messageCount > 0;
}

/** Render one session, or return null when it carries no conversation text. */
export function renderSession(
  events: DshLogEvent[],
  filePath: string,
  options: ParseOptions,
): DshSession | null {
  const header = events.find((event) => event.type === "session");
  if (header === undefined) return null;
  const id = typeof header.id === "string" && header.id !== ""
    ? header.id
    : sessionIdFromPath(filePath);
  const cwd = typeof header.cwd === "string" ? header.cwd : "";

  let title = "";
  let titleFromEvent = false;
  const rounds: string[] = [];
  let firstPrompt = "";
  let messageCount = 0;
  let toolCallCount = 0;
  let model = "";
  const createdMs = typeof header.createdAt === "number" ? header.createdAt : 0;
  let updatedMs = createdMs;
  const toolLines: string[] = [];

  for (const event of events) {
    if (typeof event.time === "number") {
      updatedMs = Math.max(updatedMs, event.time);
    }
    const eventData = isRecord(event.data) ? event.data : {};
    switch (event.type) {
      case "session/title": {
        const next = typeof eventData.title === "string"
          ? eventData.title.trim()
          : "";
        if (next !== "") {
          title = next;
          titleFromEvent = true;
        }
        break;
      }
      case "model/selection": {
        const provider = typeof eventData.provider === "string"
          ? eventData.provider
          : "";
        const name = typeof eventData.model === "string" ? eventData.model : "";
        if (name !== "") model = provider === "" ? name : `${provider}/${name}`;
        break;
      }
      case "request/header": {
        if (model !== "") break;
        const requestHeader = isRecord(eventData.header)
          ? eventData.header
          : {};
        const config = isRecord(requestHeader.config)
          ? requestHeader.config
          : {};
        const provider = typeof config.provider === "string"
          ? config.provider
          : "";
        const name = typeof config.model === "string" ? config.model : "";
        if (name !== "") model = provider === "" ? name : `${provider}/${name}`;
        break;
      }
      case "user/message": {
        const source = isRecord(eventData.source) ? eventData.source : {};
        // Runtime context, skill catalogs, and time snapshots are injected as
        // user-role messages but are not part of the conversation.
        if (source.kind !== "user" && source.kind !== "command") break;
        const text = blocksToText(eventData.content);
        if (text === "") break;
        if (firstPrompt === "") firstPrompt = text;
        messageCount += 1;
        rounds.push(`### User\n\n${text}`);
        break;
      }
      case "assistant/message": {
        const message = isRecord(eventData.message) ? eventData.message : {};
        const text = blocksToText(message.content);
        if (text === "") break;
        messageCount += 1;
        rounds.push(`### DSH\n\n${text}`);
        break;
      }
      case "tool/call": {
        toolCallCount += 1;
        if (options.includeToolCalls) {
          toolLines.push(toolSummary(eventData));
        }
        break;
      }
      default:
        break;
    }
  }

  if (messageCount === 0) return null;
  if (!titleFromEvent || title === "") {
    title = titleFromPrompt(firstPrompt) ?? `Session ${shortId(id)}`;
  }

  const workspacePath = options.workspace?.path ?? cwd;
  const workspaceTitle = options.workspace?.title ?? baseName(workspacePath) ??
    "Unknown workspace";
  const createdAt = toIso(createdMs);
  const updatedAt = toIso(updatedMs);
  const lines = [
    `# ${title}`,
    "",
    `> Workspace: \`${workspacePath}\` · Model: \`${
      model || "unknown"
    }\` · Created: ${createdAt} · Messages: ${messageCount}`,
    "",
  ];
  if (toolCallCount > 0 && toolLines.length > 0) {
    lines.push(
      "### Tool calls",
      "",
      ...toolLines.slice(0, 200).map((line) => `- ${line}`),
      "",
    );
  }
  for (const [index, round] of rounds.entries()) {
    if (index > 0) lines.push("---", "");
    lines.push(round, "");
  }
  let markdown = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  if (markdown.length > MAX_CONTENT_CHARS) {
    markdown = markdown.slice(0, MAX_CONTENT_CHARS) +
      "\n\n_[Session content truncated by the DeepSeek Harness connector.]_\n";
  }

  return {
    id,
    filePath,
    workspaceId: options.workspace?.id ?? null,
    workspaceTitle,
    workspacePath,
    title,
    url: fileUrl(filePath),
    createdAt,
    updatedAt,
    model,
    messageCount,
    delegationDepth: typeof header.delegationDepth === "number"
      ? header.delegationDepth
      : 0,
    toolCallCount,
    markdown,
    contentBytes: markdown.length,
  };
}

/** Flatten the text blocks of one DSH message; images and other blocks are ignored. */
export function blocksToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const pieces: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      const text = block.text.trim();
      if (text !== "") pieces.push(text);
    }
  }
  return pieces.join("\n\n").trim();
}

export function titleFromPrompt(prompt: string): string | null {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized === "") return null;
  return normalized.length > MAX_TITLE_CHARS
    ? `${normalized.slice(0, MAX_TITLE_CHARS - 1)}…`
    : normalized;
}

export function sessionIdFromPath(filePath: string): string {
  const segments = filePath.split(/[\\/]/).filter(Boolean);
  const dir = segments.length >= 2 ? segments[segments.length - 2] ?? "" : "";
  return dir.startsWith("session-") ? dir : baseName(filePath) ?? filePath;
}

function toolSummary(data: Record<string, unknown>): string {
  const name = typeof data.name === "string" ? data.name : "tool";
  const args = typeof data.arguments === "string" ? data.arguments : "";
  let detail = "";
  if (args !== "") {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (isRecord(parsed)) {
        const description = typeof parsed.description === "string"
          ? parsed.description
          : "";
        const command = typeof parsed.command === "string"
          ? parsed.command
          : "";
        detail = description || command;
      }
    } catch {
      detail = args;
    }
  }
  detail = detail.replace(/\s+/g, " ").trim();
  if (detail.length > 180) detail = `${detail.slice(0, 179)}…`;
  return `\`${name}\`${detail === "" ? "" : ` — ${detail}`}`;
}

function fileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const withSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(withSlash)}`;
}

function baseName(path: string): string | null {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.length === 0 ? null : segments[segments.length - 1] ?? null;
}

function shortId(id: string): string {
  const match = /([0-9a-f]{8})[0-9a-f-]*$/i.exec(id);
  return match?.[1] ?? id.slice(0, 8);
}

function toIso(ms: number): string {
  const value = ms > 0 ? ms : Date.now();
  return new Date(value).toISOString();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

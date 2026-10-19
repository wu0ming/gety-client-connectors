// src/index.ts
import { join as join2 } from "node:path";
import { Connector } from "@gety-ai/connector-sdk";

// src/trae_memory.ts
import { del, upsert } from "@gety-ai/connector-sdk";
import { join } from "node:path";
var MAX_CONTENT_CHARS = 6e5;
var SESSION_RE = /^session_memory_(.+)\.jsonl$/;
var DATE_RE = /^\d{8}$/;
function classifyRelPath(relPath) {
  const parts = relPath.split("/");
  if (parts.length === 3 && parts[0] === "projects") {
    if (parts[2] === "project_memory.md") {
      return { kind: "project_memory", project: parts[1] };
    }
    return null;
  }
  if (parts.length === 4 && parts[0] === "projects" && DATE_RE.test(parts[2])) {
    const sessionMatch = SESSION_RE.exec(parts[3]);
    if (sessionMatch) {
      return { kind: "session", project: parts[1], date: parts[2] };
    }
    if (parts[3] === "topics.md") {
      return { kind: "topics", project: parts[1], date: parts[2] };
    }
  }
  if (parts.length === 1 && parts[0] === "user_profile.md") {
    return { kind: "user_profile" };
  }
  return null;
}
async function listMemoryFiles(rootDir, options) {
  const files = [];
  const rootStat = await Deno.stat(rootDir).catch(() => null);
  if (rootStat == null || !rootStat.isDirectory) {
    return files;
  }
  if (options.includeUserProfile) {
    const profile = join(rootDir, "user_profile.md");
    const stat = await Deno.stat(profile).catch(() => null);
    if (stat?.isFile) {
      files.push({
        relPath: "user_profile.md",
        kind: "user_profile",
        mtimeMs: stat.mtime?.getTime() ?? 0,
        size: stat.size
      });
    }
  }
  const projectsDir = join(rootDir, "projects");
  for await (const project of safeReadDir(projectsDir)) {
    if (!project.isDirectory) continue;
    if (options.includeProjectMemory) {
      const pm = join(projectsDir, project.name, "project_memory.md");
      const stat = await Deno.stat(pm).catch(() => null);
      if (stat?.isFile) {
        files.push({
          relPath: `projects/${project.name}/project_memory.md`,
          kind: "project_memory",
          mtimeMs: stat.mtime?.getTime() ?? 0,
          size: stat.size
        });
      }
    }
    for await (const dateDir of safeReadDir(join(projectsDir, project.name))) {
      if (!dateDir.isDirectory || !DATE_RE.test(dateDir.name)) continue;
      const datePath = join(projectsDir, project.name, dateDir.name);
      for await (const file of safeReadDir(datePath)) {
        if (!file.isFile) continue;
        const parsed = classifyRelPath(
          `projects/${project.name}/${dateDir.name}/${file.name}`
        );
        if (parsed == null) continue;
        const stat = await Deno.stat(join(datePath, file.name)).catch(
          () => null
        );
        if (stat == null || !stat.isFile) continue;
        files.push({
          relPath: `projects/${project.name}/${dateDir.name}/${file.name}`,
          kind: parsed.kind,
          mtimeMs: stat.mtime?.getTime() ?? 0,
          size: stat.size
        });
      }
    }
  }
  return files;
}
function buildMemoryDoc(file, rawText) {
  switch (file.kind) {
    case "session": {
      const sessionId = sessionIdFromFilename(file.relPath) ?? "unknown";
      const project = projectFromRelPath(file.relPath);
      const date = dateFromRelPath(file.relPath);
      const entries = parseSessionJsonl(rawText);
      const rendered = renderSessionContent(entries);
      return {
        relPath: file.relPath,
        kind: "session",
        docId: sessionIdDocId(sessionId),
        docType: "trae:session",
        title: sessionTitle(sessionId, entries),
        content: rendered.content,
        contentTruncated: rendered.truncated,
        updatedAtMs: latestCreatedAtMs(entries) ?? file.mtimeMs,
        metadata: {
          source: "trae",
          session_id: sessionId,
          project,
          date,
          entries: entries.length,
          last_summary_time: entries.at(-1)?.summaryTime
        }
      };
    }
    case "topics": {
      const project = projectFromRelPath(file.relPath);
      const date = dateFromRelPath(file.relPath);
      const entries = parseTopics(rawText);
      const rendered = renderTopicsContent(entries);
      return {
        relPath: file.relPath,
        kind: "topics",
        docId: topicsDocId(project, date),
        docType: "trae:topics",
        title: `Trae topics ${date ?? ""}`.trim(),
        content: rendered.content,
        contentTruncated: rendered.truncated,
        updatedAtMs: file.mtimeMs,
        metadata: {
          source: "trae",
          project,
          date,
          entries: entries.length
        }
      };
    }
    case "project_memory": {
      const project = projectFromRelPath(file.relPath);
      const capped = applyCap(cleanMarkdown(rawText));
      return {
        relPath: file.relPath,
        kind: "project_memory",
        docId: memoryDocId(project),
        docType: "trae:memory",
        title: markdownTitle(capped.content) ?? `Trae project memory ${project}`,
        content: capped.content,
        contentTruncated: capped.truncated,
        updatedAtMs: file.mtimeMs,
        metadata: {
          source: "trae",
          project
        }
      };
    }
    case "user_profile": {
      const capped = applyCap(cleanMarkdown(rawText));
      return {
        relPath: file.relPath,
        kind: "user_profile",
        docId: "trae:profile:user",
        docType: "trae:profile",
        title: markdownTitle(capped.content) ?? "Trae user profile",
        content: capped.content,
        contentTruncated: capped.truncated,
        updatedAtMs: file.mtimeMs,
        metadata: {
          source: "trae"
        }
      };
    }
  }
}
function sessionIdDocId(sessionId) {
  return `trae:session:${sessionId}`;
}
function topicsDocId(project, date) {
  return `trae:topics:${project}:${date ?? "unknown"}`;
}
function memoryDocId(project) {
  return `trae:memory:${project}`;
}
function sessionIdFromFilename(relPath) {
  const name = relPath.split("/").at(-1) ?? "";
  const match = SESSION_RE.exec(name);
  return match ? match[1] : null;
}
function projectFromRelPath(relPath) {
  const parts = relPath.split("/");
  return parts[0] === "projects" && parts.length > 1 ? parts[1] : "";
}
function dateFromRelPath(relPath) {
  const parts = relPath.split("/");
  return parts.length >= 3 && DATE_RE.test(parts[2]) ? parts[2] : void 0;
}
function parseSessionJsonl(rawText) {
  const entries = [];
  for (const line of rawText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed;
    const intent = typeof record.intent === "string" ? record.intent.trim() : "";
    const actions = stringArray(record.actions);
    const outcome = typeof record.outcome === "string" ? record.outcome.trim() : "";
    const learned = stringArray(record.learned);
    if (intent === "" && actions.length === 0 && outcome === "" && learned.length === 0) {
      continue;
    }
    const summaryTime = typeof record.message_summary_time === "string" ? record.message_summary_time : void 0;
    const meta = record.compact_summary_meta;
    const createdAtMs = meta !== null && typeof meta === "object" && typeof meta.created_at_ms === "number" ? meta.created_at_ms : void 0;
    entries.push({
      intent,
      actions,
      outcome,
      learned,
      summaryTime,
      createdAtMs
    });
  }
  return entries;
}
function latestCreatedAtMs(entries) {
  let latest;
  for (const entry of entries) {
    if (entry.createdAtMs != null && (latest == null || entry.createdAtMs > latest)) {
      latest = entry.createdAtMs;
    }
  }
  return latest;
}
function sessionTitle(sessionId, entries) {
  for (const entry of entries) {
    if (entry.intent !== "") {
      return oneLine(entry.intent).slice(0, 120);
    }
  }
  return `Trae session ${sessionId.slice(0, 12)}`;
}
function renderSessionContent(entries) {
  const lines = [];
  for (const entry of entries) {
    if (entry.summaryTime != null) {
      lines.push(`## ${entry.summaryTime}`);
    } else {
      lines.push("## Summary");
    }
    if (entry.intent !== "") {
      lines.push("", `**\u610F\u56FE**: ${entry.intent}`);
    }
    if (entry.actions.length > 0) {
      lines.push("", "**\u52A8\u4F5C**:", ...entry.actions.map((a) => `- ${a}`));
    }
    if (entry.outcome !== "") {
      lines.push("", `**\u7ED3\u679C**: ${entry.outcome}`);
    }
    if (entry.learned.length > 0) {
      lines.push("", "**\u7ECF\u9A8C**:", ...entry.learned.map((l) => `- ${l}`));
    }
    lines.push("");
  }
  const content = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return applyCap(content);
}
function parseTopics(rawText) {
  const entries = [];
  const headerRe = /^\[session_id:\s*([^\]|]+?)\s*\|\s*topic_summary_time:\s*([^\]]+?)\s*\]/;
  for (const line of rawText.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed.trim() === "") continue;
    const match = headerRe.exec(trimmed);
    if (match) {
      entries.push({
        sessionId: match[1],
        summaryTime: match[2],
        text: trimmed.slice(match[0].length).trim()
      });
      continue;
    }
    const previous = entries.at(-1);
    if (previous != null) {
      previous.text = `${previous.text}
${trimmed.trim()}`.trim();
    }
  }
  return entries;
}
function renderTopicsContent(entries) {
  const lines = [];
  for (const entry of entries) {
    lines.push(`## ${entry.summaryTime}`, "", entry.text, "");
  }
  const content = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return applyCap(content);
}
function cleanMarkdown(rawText) {
  return rawText.replace(/\r\n/g, "\n").replace(/\0/g, "").trim();
}
function markdownTitle(markdown) {
  const match = /^#\s+(.+)$/m.exec(markdown);
  if (match) {
    return oneLine(match[1]).slice(0, 120);
  }
  return void 0;
}
function docUpdateFor(doc) {
  return upsert({
    id: doc.docId,
    title: doc.title,
    content: doc.content,
    content_format: "markdown",
    doc_updated_at: new Date(doc.updatedAtMs).toISOString(),
    doc_type: doc.docType,
    metadata: doc.metadata
  });
}
function docDeleteForPath(relPath) {
  return del(deleteIdForPath(relPath));
}
function resolveMemoryDir(configuredDir, env = Deno.env.toObject()) {
  const explicit = configuredDir?.trim();
  if (explicit) {
    return explicit;
  }
  const profile = env.USERPROFILE?.trim() || env.HOME?.trim();
  if (profile) {
    return join(profile, ".trae-cn", "memory");
  }
  return join(".trae-cn", "memory");
}
function deleteIdForPath(relPath) {
  const parsed = classifyRelPath(relPath);
  const project = projectFromRelPath(relPath);
  const date = dateFromRelPath(relPath);
  switch (parsed?.kind) {
    case "session":
      return sessionIdDocId(sessionIdFromFilename(relPath) ?? "unknown");
    case "topics":
      return topicsDocId(project, date);
    case "project_memory":
      return memoryDocId(project);
    case "user_profile":
      return "trae:profile:user";
    default:
      return `trae:unknown:${relPath}`;
  }
}
function applyCap(content) {
  if (content.length <= MAX_CONTENT_CHARS) {
    return { content, truncated: false };
  }
  return {
    content: content.slice(0, MAX_CONTENT_CHARS).trimEnd(),
    truncated: true
  };
}
async function* safeReadDir(path) {
  try {
    for await (const entry of Deno.readDir(path)) {
      yield entry;
    }
  } catch {
  }
}
function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item) => typeof item === "string" && item.trim() !== ""
  ).map((item) => item.trim());
}
function oneLine(value) {
  return value.replace(/\s+/g, " ").trim();
}

// src/index.ts
var STATE_SCHEMA_VERSION = 1;
var TraeMemoryConnector = class extends Connector {
  async *poll() {
    const includeProjectMemory = this.config.include_project_memory ?? true;
    const includeUserProfile = this.config.include_user_profile ?? false;
    const fingerprint = configFingerprint(
      includeProjectMemory,
      includeUserProfile
    );
    const state = initialState(
      this.lastState,
      includeProjectMemory,
      includeUserProfile,
      fingerprint
    );
    const previousFiles = state.files ?? {};
    const previousIndexed = new Set(
      state.indexed_paths ?? indexedPaths(previousFiles)
    );
    const rootDir = resolveMemoryDir(this.config.memory_dir);
    const options = {
      includeProjectMemory,
      includeUserProfile
    };
    const files = await listMemoryFiles(rootDir, options);
    const currentIndexed = /* @__PURE__ */ new Set();
    const currentFiles = {};
    for (const file of files) {
      this.signal.throwIfAborted();
      const previous = previousFiles[file.relPath];
      const unchanged = previous != null && previous.mtime_ms === file.mtimeMs && previous.size === file.size && previous.kind === file.kind && previous.indexed;
      if (unchanged) {
        currentFiles[file.relPath] = previous;
        currentIndexed.add(file.relPath);
        continue;
      }
      let rawText;
      try {
        rawText = await Deno.readTextFile(join2(rootDir, file.relPath));
      } catch {
        continue;
      }
      const doc = buildMemoryDoc(file, rawText);
      currentFiles[file.relPath] = {
        mtime_ms: file.mtimeMs,
        size: file.size,
        kind: file.kind,
        indexed: true
      };
      currentIndexed.add(file.relPath);
      yield { updates: [docUpdateFor(doc)] };
    }
    for (const relPath of previousIndexed) {
      if (!currentIndexed.has(relPath)) {
        this.signal.throwIfAborted();
        yield { updates: [docDeleteForPath(relPath)] };
      }
    }
    yield {
      updates: [],
      state: nextStateAfterReconcile(
        currentFiles,
        includeProjectMemory,
        includeUserProfile,
        fingerprint
      )
    };
  }
};
function initialState(state, includeProjectMemory, includeUserProfile, fingerprint) {
  if (state?.schema_version !== STATE_SCHEMA_VERSION || state.include_project_memory !== includeProjectMemory || state.include_user_profile !== includeUserProfile || state.config_fingerprint !== fingerprint) {
    return nextBaseState(
      {
        indexed_paths: state?.indexed_paths ?? indexedPaths(state?.files ?? {})
      },
      includeProjectMemory,
      includeUserProfile,
      fingerprint
    );
  }
  return state;
}
function nextStateAfterReconcile(files, includeProjectMemory, includeUserProfile, fingerprint) {
  return nextBaseState(
    { files, indexed_paths: indexedPaths(files) },
    includeProjectMemory,
    includeUserProfile,
    fingerprint
  );
}
function nextBaseState(state, includeProjectMemory, includeUserProfile, fingerprint) {
  return {
    ...state,
    schema_version: STATE_SCHEMA_VERSION,
    config_fingerprint: fingerprint,
    include_project_memory: includeProjectMemory,
    include_user_profile: includeUserProfile,
    files: state.files ?? {},
    indexed_paths: [...new Set(state.indexed_paths ?? [])].sort()
  };
}
function indexedPaths(files) {
  return Object.keys(files).sort();
}
function configFingerprint(includeProjectMemory, includeUserProfile) {
  return `v1:pm=${includeProjectMemory ? 1 : 0}:up=${includeUserProfile ? 1 : 0}`;
}
export {
  TraeMemoryConnector as default,
  initialState,
  nextStateAfterReconcile
};
//# sourceMappingURL=main.js.map

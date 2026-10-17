/**
 * WorkBuddy home discovery, SQLite session index, trace enumeration, and the
 * local parse cache.
 */

import { DatabaseSync } from "node:sqlite";

import type { WbSession, WbTrace } from "./wb_log.ts";

export interface TraceFile {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface CachedTrace extends WbTrace {
  mtimeMs: number;
  size: number;
  path: string;
}

export interface TraceCache {
  version: number;
  traces: Record<string, CachedTrace>;
}

export interface SessionIndex {
  sessions: WbSession[];
  deletedSessionIds: Set<string>;
}

export function resolveWorkBuddyHome(): string {
  const explicit = Deno.env.get("WORKBUDDY_HOME");
  if (explicit !== undefined && explicit.trim() !== "") return explicit.trim();
  const userProfile = Deno.env.get("USERPROFILE");
  if (userProfile !== undefined && userProfile.trim() !== "") {
    return `${userProfile.trim()}\\.workbuddy`;
  }
  const home = Deno.env.get("HOME");
  if (home !== undefined && home.trim() !== "") {
    return `${home.trim()}/.workbuddy`;
  }
  return ".workbuddy";
}

export function databasePath(workbuddyHome: string): string {
  return `${workbuddyHome}/workbuddy.db`;
}

export function traceRoot(workbuddyHome: string): string {
  return `${workbuddyHome}/traces`;
}

export function sessionDirectory(
  workbuddyHome: string,
  sessionId: string,
): string {
  return `${workbuddyHome}/workspace/sessions/${sessionId}`;
}

export function cachePath(): string {
  const localAppData = Deno.env.get("LOCALAPPDATA");
  if (localAppData !== undefined && localAppData.trim() !== "") {
    return `${localAppData.trim()}\\gety-workbuddy-connector\\cache-v1.json`;
  }
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  return `${home}/.cache/gety-workbuddy-connector/cache-v1.json`;
}

export function readSessions(workbuddyHome: string): SessionIndex | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(databasePath(workbuddyHome), { readOnly: true });
  } catch {
    return null;
  }
  try {
    const rows = db
      .prepare(
        `select id, cwd, title, custom_title, status, created_at, updated_at,
                last_activity_at, deleted_at, is_playground, mode, source_mode, model,
                group_title, is_background_automation, transport
         from sessions`,
      )
      .all() as Record<string, unknown>[];
    const sessions: WbSession[] = [];
    const deletedSessionIds = new Set<string>();
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
        transport: text(row.transport),
      });
    }
    return { sessions, deletedSessionIds };
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // ignore close errors
    }
  }
}

export async function listTraceFiles(
  workbuddyHome: string,
): Promise<TraceFile[]> {
  const root = traceRoot(workbuddyHome);
  const files: TraceFile[] = [];
  let buckets: Deno.DirEntry[];
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
    let entries: Deno.DirEntry[];
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
      let stat: Deno.FileInfo;
      try {
        stat = await Deno.stat(path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      files.push({
        path,
        mtimeMs: stat.mtime?.getTime() ?? 0,
        size: stat.size,
      });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

export async function readCache(path: string): Promise<TraceCache> {
  try {
    const raw = JSON.parse(await Deno.readTextFile(path)) as unknown;
    if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.traces)) {
      throw new Error("invalid cache");
    }
    return { version: 1, traces: raw.traces as Record<string, CachedTrace> };
  } catch {
    return { version: 1, traces: {} };
  }
}

export async function writeCache(
  path: string,
  cache: TraceCache,
): Promise<void> {
  try {
    const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (slash > 0) await Deno.mkdir(path.slice(0, slash), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(cache));
  } catch {
    // A read-only cache location only costs a reparse on the next poll.
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * DSH home discovery, workspace registry, session file enumeration, and the
 * shared-workspace selection written by the DSH plugin.
 */

import type { DshWorkspace } from "./dsh_log.ts";

export type { DshWorkspace };

export interface ShareConfig {
  version: number;
  /** null means every workspace, including ones created later. */
  workspaces: string[] | null;
  updatedAt?: string;
}

export interface SessionFile {
  path: string;
  stateKey: string;
  workspaceDir: string;
  sessionId: string;
  mtimeMs: number;
  size: number;
}

export function resolveDshHome(): string {
  const explicit = Deno.env.get("DSH_HOME");
  if (explicit !== undefined && explicit.trim() !== "") return explicit.trim();
  const userProfile = Deno.env.get("USERPROFILE");
  if (userProfile !== undefined && userProfile.trim() !== "") {
    return `${userProfile.trim()}\\.dsh`;
  }
  const home = Deno.env.get("HOME");
  if (home !== undefined && home.trim() !== "") return `${home.trim()}/.dsh`;
  return ".dsh";
}

export async function readWorkspaces(dshHome: string): Promise<DshWorkspace[]> {
  const path = `${dshHome}/storages/workspace.json`;
  let raw: unknown;
  try {
    raw = JSON.parse(await Deno.readTextFile(path)) as unknown;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  if (
    !isRecord(raw) || !isRecord(raw.tables) || !isRecord(raw.tables.workspaces)
  ) throw new Error("Invalid DSH workspace registry");
  const workspaces: DshWorkspace[] = [];
  for (const [id, value] of Object.entries(raw.tables.workspaces)) {
    if (!isRecord(value) || typeof value.path !== "string") continue;
    const sessionIds = Array.isArray(value.sessionIds)
      ? value.sessionIds.filter((entry): entry is string =>
        typeof entry === "string"
      )
      : [];
    workspaces.push({
      id,
      title: typeof value.title === "string" && value.title !== ""
        ? value.title
        : baseName(value.path) ?? id,
      path: value.path,
      sessionIds,
    });
  }
  workspaces.sort((left, right) => left.title.localeCompare(right.title));
  return workspaces;
}

export async function readShareConfig(dshHome: string): Promise<ShareConfig> {
  const path = `${dshHome}/gety-connector.json`;
  try {
    const raw = JSON.parse(await Deno.readTextFile(path)) as unknown;
    if (
      !isRecord(raw) ||
      !(raw.workspaces === null ||
        (Array.isArray(raw.workspaces) &&
          raw.workspaces.every((entry) => typeof entry === "string")))
    ) throw new Error("Invalid DSH workspace sharing configuration");
    const workspaces = raw.workspaces as string[] | null;
    return {
      version: typeof raw.version === "number" ? raw.version : 1,
      workspaces,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return defaultShareConfig();
    throw error;
  }
}

export function defaultShareConfig(): ShareConfig {
  return { version: 1, workspaces: null };
}

/** The encoded directory DSH uses under `sessions/` for one workspace path. */
export function workspaceDirName(workspacePath: string): string {
  const encoded = workspacePath.replace(/[^A-Za-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
  return `--${encoded}--`;
}

export function workspaceForDir(
  workspaces: DshWorkspace[],
  dirName: string,
): DshWorkspace | null {
  const target = dirName.toLowerCase();
  for (const workspace of workspaces) {
    if (workspaceDirName(workspace.path).toLowerCase() === target) {
      return workspace;
    }
  }
  return null;
}

export function workspaceForPath(
  workspaces: DshWorkspace[],
  path: string,
): DshWorkspace | null {
  const normalize = (value: string) =>
    value.replace(/\//g, "\\").replace(/\\+$/g, "").toLowerCase();
  const target = normalize(path);
  for (const workspace of workspaces) {
    if (normalize(workspace.path) === target) return workspace;
  }
  return null;
}

export function isWorkspaceSelected(
  config: ShareConfig,
  workspace: DshWorkspace | null,
  dirName: string,
): boolean {
  if (config.workspaces === null) return true;
  const selected = new Set(
    config.workspaces.map((entry) => entry.trim().toLowerCase()).filter(
      Boolean,
    ),
  );
  if (selected.has("*")) return true;
  if (workspace !== null) {
    if (selected.has(workspace.id.toLowerCase())) return true;
    if (selected.has(workspace.path.replace(/\//g, "\\").toLowerCase())) {
      return true;
    }
    if (selected.has(workspaceDirName(workspace.path).toLowerCase())) {
      return true;
    }
  }
  return selected.has(dirName.toLowerCase());
}

export async function listSessionFiles(
  dshHome: string,
): Promise<SessionFile[]> {
  const root = `${dshHome}/sessions`;
  const files: SessionFile[] = [];
  const workspaceDirs: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (entry.isDirectory) workspaceDirs.push(entry);
  }
  for (const workspaceDir of workspaceDirs) {
    const workspacePath = `${root}/${workspaceDir.name}`;
    let sessionDirs: Deno.DirEntry[];
    try {
      sessionDirs = [];
      for await (const entry of Deno.readDir(workspacePath)) {
        if (entry.isDirectory) sessionDirs.push(entry);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    for (const sessionDir of sessionDirs) {
      const dirPath = `${workspacePath}/${sessionDir.name}`;
      let entries: Deno.DirEntry[];
      try {
        entries = [];
        for await (const entry of Deno.readDir(dirPath)) entries.push(entry);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile) continue;
        if (!/^session\.v\d+\.jsonl(?:\.zstd)?$/i.test(entry.name)) continue;
        const path = `${dirPath}/${entry.name}`;
        let stat: Deno.FileInfo;
        try {
          stat = await Deno.stat(path);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }
        if (!stat.isFile) continue;
        files.push({
          path,
          stateKey: `${workspaceDir.name}/${sessionDir.name}/${entry.name}`,
          workspaceDir: workspaceDir.name,
          sessionId: sessionDir.name,
          mtimeMs: stat.mtime?.getTime() ?? 0,
          size: stat.size,
        });
      }
    }
  }
  files.sort((left, right) => left.stateKey.localeCompare(right.stateKey));
  return files;
}

function baseName(path: string): string | null {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.length === 0 ? null : segments[segments.length - 1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * GetY custom connector: index DeepSeek Harness session logs as searchable
 * markdown documents.
 *
 * The connector never indexes tool outputs. Each session becomes one
 * `dsh:session` document; workspace sharing is controlled by
 * `~/.dsh/gety-connector.json`, written by the DSH GetY plugin. A missing or
 * `null` `workspaces` value means every workspace.
 */

import {
  Connector,
  del,
  type PollResult,
  upsert,
} from "@gety-ai/connector-sdk";
import type { ManifestConfig } from "./gen/manifest.d.ts";
import {
  decodeSessionBytes,
  type DshSession,
  isIndexableSession,
  parseEvents,
  renderSession,
} from "./dsh_log.ts";
import {
  type DshWorkspace,
  isWorkspaceSelected,
  listSessionFiles,
  readShareConfig,
  readWorkspaces,
  resolveDshHome,
  type SessionFile,
  type ShareConfig,
  workspaceForDir,
  workspaceForPath,
} from "./dsh_home.ts";

export interface DshFileState {
  session_id?: string;
  workspace_id?: string | null;
  mtime_ms: number;
  size: number;
  indexed: boolean;
}

export interface DshState {
  schema_version?: number;
  include_tool_calls?: boolean;
  include_subagents?: boolean;
  files?: Record<string, DshFileState>;
  indexed_sessions?: string[];
}

const STATE_SCHEMA_VERSION = 1;

export default class DshConnector extends Connector<ManifestConfig, DshState> {
  async *poll(): AsyncGenerator<PollResult, void, unknown> {
    const includeToolCalls = this.config.include_tool_calls ?? false;
    const includeSubagents = this.config.include_subagents ?? true;
    const state = initialState(
      this.lastState,
      includeToolCalls,
      includeSubagents,
    );
    const previousFiles = state.files ?? {};
    const previousIndexed = new Set(
      state.indexed_sessions ?? indexedSessionIds(previousFiles),
    );
    const dshHome = resolveDshHome();
    const shareConfig = await readShareConfig(dshHome);
    const workspaces = await readWorkspaces(dshHome);
    const files = await listSessionFiles(dshHome);
    const currentFiles: Record<string, DshFileState> = {};
    const currentIndexed = new Set<string>();

    for (const file of files) {
      this.signal.throwIfAborted();
      const previous = previousFiles[file.stateKey];
      const workspace = workspaceForDir(workspaces, file.workspaceDir) ??
        workspaceForSessionId(
          workspaces,
          previous?.session_id ?? file.sessionId,
        );
      const allowed = isWorkspaceSelected(
        shareConfig,
        workspace,
        file.workspaceDir,
      );

      if (
        previous !== undefined && !fileNeedsParse(file, previous) && allowed
      ) {
        currentFiles[file.stateKey] = previous;
        if (previous.indexed && previous.session_id !== undefined) {
          currentIndexed.add(previous.session_id);
        }
        continue;
      }

      if (!allowed) {
        currentFiles[file.stateKey] = {
          ...(previous ?? {}),
          workspace_id: workspace?.id ?? previous?.workspace_id ?? null,
          mtime_ms: file.mtimeMs,
          size: file.size,
          indexed: false,
        };
        continue;
      }

      const session = await this.parseFile(
        file,
        workspaces,
        workspace,
        includeToolCalls,
      );
      if (
        session === null || !isIndexableSession(session) ||
        (!includeSubagents && session.delegationDepth > 0)
      ) {
        currentFiles[file.stateKey] = {
          workspace_id: workspace?.id ?? null,
          mtime_ms: file.mtimeMs,
          size: file.size,
          indexed: false,
        };
        continue;
      }

      currentFiles[file.stateKey] = {
        session_id: session.id,
        workspace_id: session.workspaceId,
        mtime_ms: file.mtimeMs,
        size: file.size,
        indexed: true,
      };
      currentIndexed.add(session.id);
      yield { updates: [buildSessionUpdate(session, file.size)] };
    }

    for (const sessionId of previousIndexed) {
      if (!currentIndexed.has(sessionId)) {
        yield { updates: [del(sessionId)] };
      }
    }

    yield {
      updates: [],
      state: nextState(currentFiles, includeToolCalls, includeSubagents),
    };
  }

  private async parseFile(
    file: SessionFile,
    workspaces: DshWorkspace[],
    workspace: DshWorkspace | null,
    includeToolCalls: boolean,
  ): Promise<DshSession | null> {
    const text = decodeSessionBytes(await Deno.readFile(file.path));
    if (text.trim() === "") return null;
    const events = parseEvents(text);
    const header = events.find((event) => event.type === "session");
    const cwd = header?.cwd ?? "";
    const resolved = workspace ??
      (cwd === "" ? null : workspaceForPath(workspaces, cwd));
    return renderSession(events, file.path, {
      includeToolCalls,
      workspace: resolved,
    });
  }
}

export function initialState(
  state: DshState | null | undefined,
  includeToolCalls: boolean,
  includeSubagents: boolean,
): DshState {
  if (
    state?.schema_version !== STATE_SCHEMA_VERSION ||
    state.include_tool_calls !== includeToolCalls ||
    state.include_subagents !== includeSubagents
  ) {
    return {
      schema_version: STATE_SCHEMA_VERSION,
      include_tool_calls: includeToolCalls,
      include_subagents: includeSubagents,
      files: {},
      indexed_sessions: state?.indexed_sessions ??
        indexedSessionIds(state?.files ?? {}),
    };
  }
  return state;
}

export function fileNeedsParse(
  file: SessionFile,
  previous: DshFileState,
): boolean {
  return !previous.indexed ||
    previous.mtime_ms !== file.mtimeMs ||
    previous.size !== file.size;
}

export function buildSessionUpdate(session: DshSession, fileSize: number) {
  return upsert({
    id: session.id,
    title: session.title,
    content: session.markdown,
    content_format: "markdown",
    doc_type: "dsh:session",
    doc_updated_at: session.updatedAt,
    original_file_size: fileSize,
    metadata: {
      url: session.url,
      workspace: session.workspacePath,
      workspace_title: session.workspaceTitle,
      workspace_id: session.workspaceId ?? "",
      model: session.model,
      created_at: session.createdAt,
      messages: session.messageCount,
      tool_calls: session.toolCallCount,
    },
  });
}

function workspaceForSessionId(
  workspaces: DshWorkspace[],
  sessionId: string | undefined,
): DshWorkspace | null {
  if (sessionId === undefined) return null;
  for (const workspace of workspaces) {
    if (workspace.sessionIds.includes(sessionId)) return workspace;
  }
  return null;
}

function nextState(
  files: Record<string, DshFileState>,
  includeToolCalls: boolean,
  includeSubagents: boolean,
): DshState {
  const sortedFiles = Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    schema_version: STATE_SCHEMA_VERSION,
    include_tool_calls: includeToolCalls,
    include_subagents: includeSubagents,
    files: sortedFiles,
    indexed_sessions: indexedSessionIds(sortedFiles),
  };
}

function indexedSessionIds(files: Record<string, DshFileState>): string[] {
  const ids: string[] = [];
  for (const file of Object.values(files)) {
    if (file.indexed && file.session_id !== undefined) {
      ids.push(file.session_id);
    }
  }
  return [...new Set(ids)].sort();
}

export type { ShareConfig };

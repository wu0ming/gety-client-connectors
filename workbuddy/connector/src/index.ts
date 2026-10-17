/**
 * GetY custom connector: index local WorkBuddy session metadata and agent
 * traces as searchable markdown documents.
 *
 * WorkBuddy keeps its full conversation text in its cloud service. This
 * connector indexes the local session index (`workbuddy.db`) for every session
 * and recovers conversation rounds from local agent traces when WorkBuddy
 * wrote them. Tool outputs and reasoning are never indexed.
 */

import {
  Connector,
  del,
  type PollResult,
  upsert,
} from "@gety-ai/connector-sdk";
import type { ManifestConfig } from "./gen/manifest.d.ts";
import {
  capContent,
  hashText,
  parseTrace,
  renderSession,
  renderTrace,
  type WbSession,
  type WbTrace,
} from "./wb_log.ts";
import {
  type CachedTrace,
  cachePath,
  listTraceFiles,
  readCache,
  readSessions,
  resolveWorkBuddyHome,
  sessionDirectory,
  type TraceCache,
  type TraceFile,
  writeCache,
} from "./wb_home.ts";

export interface WbState {
  schema_version?: number;
  include_tool_calls?: boolean;
  include_metadata_only_sessions?: boolean;
  docs?: Record<string, string>;
}

const STATE_SCHEMA_VERSION = 1;

export default class WorkBuddyConnector
  extends Connector<ManifestConfig, WbState> {
  async *poll(): AsyncGenerator<PollResult, void, unknown> {
    const includeToolCalls = this.config.include_tool_calls ?? false;
    const includeMetadataOnly = this.config.include_metadata_only_sessions ??
      true;
    const optionsChanged = this.lastState?.schema_version !==
        STATE_SCHEMA_VERSION ||
      this.lastState.include_tool_calls !== includeToolCalls ||
      this.lastState.include_metadata_only_sessions !== includeMetadataOnly;
    const state = initialState(
      this.lastState,
      includeToolCalls,
      includeMetadataOnly,
    );
    const home = resolveWorkBuddyHome();
    const sessionIndex = readSessions(home);
    if (sessionIndex === null) {
      // Never delete documents because WorkBuddy's database could not be read
      // (for example while the app is upgrading its schema).
      console.error(
        "workbuddy connector: session database is not readable; skipping this poll",
      );
      yield { updates: [] };
      return;
    }

    let files: TraceFile[];
    try {
      files = await listTraceFiles(home);
    } catch {
      console.error(
        "workbuddy connector: trace directory is not readable; skipping this poll",
      );
      yield { updates: [] };
      return;
    }
    const cache = await readCache(cachePath());
    let cacheDirty = false;
    let parsedCount = 0;
    const traces: WbTrace[] = [];
    const tracePaths = new Map<string, string>();

    for (const file of files) {
      this.signal.throwIfAborted();
      const cached = cache.traces[file.path];
      if (
        cached !== undefined && cached.mtimeMs === file.mtimeMs &&
        cached.size === file.size
      ) {
        const trace = toTrace(cached);
        traces.push(trace);
        tracePaths.set(trace.traceId, file.path);
        continue;
      }
      let text: string;
      try {
        text = await Deno.readTextFile(file.path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        console.error(
          "workbuddy connector: trace file is not readable; skipping this poll",
        );
        yield { updates: [] };
        return;
      }
      const trace = parseTrace(text, file.path) ?? emptyTrace(file.path);
      cache.traces[file.path] = {
        ...trace,
        path: file.path,
        mtimeMs: file.mtimeMs,
        size: file.size,
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

    const sessionIds = new Set(
      sessionIndex.sessions.map((session) => session.id),
    );
    const bySession = new Map<string, WbTrace[]>();
    const orphan: WbTrace[] = [];
    for (const trace of traces) {
      if (trace.rounds.length === 0) continue;
      if (trace.sessionId !== null && sessionIds.has(trace.sessionId)) {
        const list = bySession.get(trace.sessionId) ?? [];
        list.push(trace);
        bySession.set(trace.sessionId, list);
      } else if (
        trace.sessionId !== null &&
        sessionIndex.deletedSessionIds.has(trace.sessionId)
      ) {
        continue;
      } else {
        orphan.push(trace);
      }
    }

    const currentDocs: Record<string, string> = {};
    let upserts = 0;

    for (const session of sessionIndex.sessions) {
      const sessionTraces = bySession.get(session.id) ?? [];
      if (sessionTraces.length === 0 && !includeMetadataOnly) continue;
      const docId = `wb-session-${session.id}`;
      const rendered = renderSession(
        session,
        sessionTraces,
        { includeToolCalls },
        sessionDirectory(home, session.id),
      );
      const hash = hashText(
        `${rendered.title}\n${rendered.markdown}\n${
          JSON.stringify(rendered.metadata)
        }`,
      );
      currentDocs[docId] = hash;
      if (!optionsChanged && state.docs?.[docId] === hash) continue;
      yield {
        updates: [upsert({
          id: docId,
          title: rendered.title,
          content: rendered.markdown,
          content_format: "markdown",
          doc_type: "workbuddy:session",
          doc_updated_at: sessionUpdatedAt(session, sessionTraces),
          original_file_size: rendered.markdown.length,
          metadata: rendered.metadata,
        })],
      };
      upserts += 1;
      if (upserts % 200 === 0) {
        console.info(
          `workbuddy connector: emitted ${upserts} session documents`,
        );
      }
    }

    for (const trace of orphan) {
      if (!trace.rounds.some((round) => round.role === "user")) continue;
      const docId = `wb-trace-${trace.traceId}`;
      const path = tracePaths.get(trace.traceId) ?? "";
      const rendered = renderTrace(trace, path, { includeToolCalls });
      const hash = hashText(
        `${rendered.title}\n${rendered.markdown}\n${
          JSON.stringify(rendered.metadata)
        }`,
      );
      currentDocs[docId] = hash;
      if (!optionsChanged && state.docs?.[docId] === hash) continue;
      yield {
        updates: [upsert({
          id: docId,
          title: rendered.title,
          content: rendered.markdown,
          content_format: "markdown",
          doc_type: "workbuddy:trace",
          doc_updated_at: trace.endedAt || trace.startedAt ||
            new Date().toISOString(),
          original_file_size: rendered.markdown.length,
          metadata: rendered.metadata,
        })],
      };
      upserts += 1;
    }

    for (const docId of Object.keys(state.docs ?? {})) {
      if (!(docId in currentDocs)) {
        yield { updates: [del(docId)] };
      }
    }

    yield {
      updates: [],
      state: {
        schema_version: STATE_SCHEMA_VERSION,
        include_tool_calls: includeToolCalls,
        include_metadata_only_sessions: includeMetadataOnly,
        docs: sortRecord(currentDocs),
      },
    };
  }
}

export function initialState(
  state: WbState | null | undefined,
  includeToolCalls: boolean,
  includeMetadataOnly: boolean,
): WbState {
  if (
    state?.schema_version !== STATE_SCHEMA_VERSION ||
    state.include_tool_calls !== includeToolCalls ||
    state.include_metadata_only_sessions !== includeMetadataOnly
  ) {
    if (state === null || state === undefined) {
      return {
        schema_version: STATE_SCHEMA_VERSION,
        include_tool_calls: includeToolCalls,
        include_metadata_only_sessions: includeMetadataOnly,
        docs: {},
      };
    }
    return {
      ...state,
      schema_version: STATE_SCHEMA_VERSION,
      include_tool_calls: includeToolCalls,
      include_metadata_only_sessions: includeMetadataOnly,
      docs: state.docs ?? {},
    };
  }
  return state;
}

export function sessionUpdatedAt(
  session: WbSession,
  traces: WbTrace[],
): string {
  const candidates = [
    session.updatedAt,
    session.lastActivityAt,
    session.createdAt,
    ...traces.map((trace) => Date.parse(trace.endedAt || trace.startedAt))
      .filter((value) => Number.isFinite(value)),
  ].filter((value) => typeof value === "number" && value > 0) as number[];
  const latest = candidates.length === 0 ? Date.now() : Math.max(...candidates);
  return new Date(latest).toISOString();
}

function toTrace(cached: CachedTrace): WbTrace {
  return {
    traceId: cached.traceId,
    sessionId: cached.sessionId,
    startedAt: cached.startedAt,
    endedAt: cached.endedAt,
    workspace: cached.workspace,
    model: cached.model,
    title: cached.title,
    rounds: cached.rounds,
    toolCalls: cached.toolCalls,
  };
}

function emptyTrace(path: string): WbTrace {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return {
    traceId: segments.length === 0
      ? path
      : segments[segments.length - 1] ?? path,
    sessionId: null,
    startedAt: "",
    endedAt: "",
    workspace: "",
    model: "",
    title: "",
    rounds: [],
    toolCalls: [],
  };
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

// Keep Tree-shaking-friendly exports for the local test runner.
export type { TraceCache, TraceFile };
export { capContent };

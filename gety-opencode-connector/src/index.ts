import { Connector, type PollResult } from '@gety-ai/connector-sdk';
import type { ManifestConfig } from './gen/manifest.d.ts';
import {
	buildSessionDelete,
	buildSessionUpdate,
	type DbAccess,
	isIndexableSession,
	type ListSessionsOptions,
	openOpencodeDbSnapshot,
	parseSession,
	type ParseSessionOptions,
	resolveOpencodeDir,
} from './opencode_db.ts';

export interface OpenCodeSessionState {
	updated_ms: number;
	archived: boolean;
	indexed: boolean;
}

export interface OpenCodeState {
	schema_version?: number;
	config_fingerprint?: string;
	include_tool_calls?: boolean;
	include_archived_sessions?: boolean;
	sessions?: Record<string, OpenCodeSessionState>;
	indexed_sessions?: string[];
}

const STATE_SCHEMA_VERSION = 1;

export default class OpencodeConnector extends Connector<
	ManifestConfig,
	OpenCodeState
> {
	async *poll(): AsyncGenerator<PollResult, void, unknown> {
		const includeToolCalls = this.config.include_tool_calls ?? false;
		const includeArchivedSessions = this.config.include_archived_sessions ??
			true;
		const fingerprint = configFingerprint(includeToolCalls);

		const state = initialState(
			this.lastState,
			includeToolCalls,
			includeArchivedSessions,
			fingerprint,
		);
		const previousSessions = state.sessions ?? {};
		const previousIndexed = new Set(
			state.indexed_sessions ?? indexedSessionIds(previousSessions),
		);

		const options: ListSessionsOptions = { includeArchivedSessions };
		const parseOptions: ParseSessionOptions = { includeToolCalls };
		const { access, cleanup } = await openDatabase(this.config);
		const currentSessions: Record<string, OpenCodeSessionState> = {};
		const currentIndexed = new Set<string>();

		try {
			const refs = access.listSessionRefs();
			for (const ref of refs) {
				this.signal.throwIfAborted();
				const previous = previousSessions[ref.id];
				const needsIndex = previous == null ||
					previous.updated_ms !== ref.updatedMs ||
					previous.archived !== (ref.archivedMs != null);

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
					parseOptions,
				);
				if (isIndexableSession(session, options)) {
					currentSessions[ref.id] = {
						updated_ms: ref.updatedMs,
						archived: ref.archivedMs != null,
						indexed: true,
					};
					currentIndexed.add(ref.id);
					yield { updates: [buildSessionUpdate(session)] };
					continue;
				}

				currentSessions[ref.id] = {
					updated_ms: ref.updatedMs,
					archived: ref.archivedMs != null,
					indexed: false,
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
				fingerprint,
			),
		};
	}
}

async function openDatabase(
	config: ManifestConfig,
): Promise<{ access: DbAccess; cleanup(): void }> {
	const dir = resolveOpencodeDir(config.opencode_dir);
	return await openOpencodeDbSnapshot(dir);
}

export function initialState(
	state: OpenCodeState | null | undefined,
	includeToolCalls: boolean,
	includeArchivedSessions: boolean,
	fingerprint: string,
): OpenCodeState {
	if (
		state?.schema_version !== STATE_SCHEMA_VERSION ||
		state.include_tool_calls !== includeToolCalls ||
		state.include_archived_sessions !== includeArchivedSessions ||
		state.config_fingerprint !== fingerprint
	) {
		return nextBaseState(
			{
				indexed_sessions: state?.indexed_sessions ??
					indexedSessionIds(state?.sessions ?? {}),
			},
			includeToolCalls,
			includeArchivedSessions,
			fingerprint,
		);
	}
	return state;
}

export function nextStateAfterReconcile(
	sessions: Record<string, OpenCodeSessionState>,
	includeToolCalls: boolean,
	includeArchivedSessions: boolean,
	fingerprint: string,
): OpenCodeState {
	return nextBaseState(
		{
			sessions: sessions,
			indexed_sessions: indexedSessionIds(sessions),
		},
		includeToolCalls,
		includeArchivedSessions,
		fingerprint,
	);
}

function nextBaseState(
	state: OpenCodeState,
	includeToolCalls: boolean,
	includeArchivedSessions: boolean,
	fingerprint: string,
): OpenCodeState {
	return {
		...state,
		schema_version: STATE_SCHEMA_VERSION,
		config_fingerprint: fingerprint,
		include_tool_calls: includeToolCalls,
		include_archived_sessions: includeArchivedSessions,
		sessions: state.sessions ?? {},
		indexed_sessions: [...new Set(state.indexed_sessions ?? [])].sort(),
	};
}

function indexedSessionIds(
	sessions: Record<string, OpenCodeSessionState>,
): string[] {
	return Object.keys(sessions).sort();
}

function configFingerprint(includeToolCalls: boolean): string {
	// OpenCode moved sessions between storage layouts across versions; bumping
	// this constant forces a full re-index when the parser changes.
	return `v1:${includeToolCalls ? 'tool' : 'notool'}`;
}

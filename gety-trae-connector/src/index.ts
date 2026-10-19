import { join } from 'node:path';
import { Connector, type PollResult } from '@gety-ai/connector-sdk';
import type { ManifestConfig } from './gen/manifest.d.ts';
import {
	buildMemoryDoc,
	docDeleteForPath,
	docUpdateFor,
	type ListFilesOptions,
	listMemoryFiles,
	type MemorySourceFile,
	resolveMemoryDir,
} from './trae_memory.ts';

export interface TraeFileState {
	mtime_ms: number;
	size: number;
	kind: MemorySourceFile['kind'];
	indexed: boolean;
}

export interface TraeState {
	schema_version?: number;
	config_fingerprint?: string;
	include_project_memory?: boolean;
	include_user_profile?: boolean;
	files?: Record<string, TraeFileState>;
	indexed_paths?: string[];
}

const STATE_SCHEMA_VERSION = 1;

export default class TraeMemoryConnector extends Connector<
	ManifestConfig,
	TraeState
> {
	async *poll(): AsyncGenerator<PollResult, void, unknown> {
		const includeProjectMemory = this.config.include_project_memory ?? true;
		const includeUserProfile = this.config.include_user_profile ?? false;
		const fingerprint = configFingerprint(
			includeProjectMemory,
			includeUserProfile,
		);

		const state = initialState(
			this.lastState,
			includeProjectMemory,
			includeUserProfile,
			fingerprint,
		);
		const previousFiles = state.files ?? {};
		const previousIndexed = new Set(
			state.indexed_paths ?? indexedPaths(previousFiles),
		);

		const rootDir = resolveMemoryDir(this.config.memory_dir);
		const options: ListFilesOptions = {
			includeProjectMemory,
			includeUserProfile,
		};
		const files = await listMemoryFiles(rootDir, options);

		const currentIndexed = new Set<string>();
		const currentFiles: Record<string, TraeFileState> = {};

		for (const file of files) {
			this.signal.throwIfAborted();
			const previous = previousFiles[file.relPath];
			const unchanged = previous != null &&
				previous.mtime_ms === file.mtimeMs &&
				previous.size === file.size &&
				previous.kind === file.kind &&
				previous.indexed;

			if (unchanged) {
				currentFiles[file.relPath] = previous;
				currentIndexed.add(file.relPath);
				continue;
			}

			let rawText: string;
			try {
				rawText = await Deno.readTextFile(join(rootDir, file.relPath));
			} catch {
				continue;
			}
			const doc = buildMemoryDoc(file, rawText);
			currentFiles[file.relPath] = {
				mtime_ms: file.mtimeMs,
				size: file.size,
				kind: file.kind,
				indexed: true,
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
				fingerprint,
			),
		};
	}
}

export function initialState(
	state: TraeState | null | undefined,
	includeProjectMemory: boolean,
	includeUserProfile: boolean,
	fingerprint: string,
): TraeState {
	if (
		state?.schema_version !== STATE_SCHEMA_VERSION ||
		state.include_project_memory !== includeProjectMemory ||
		state.include_user_profile !== includeUserProfile ||
		state.config_fingerprint !== fingerprint
	) {
		return nextBaseState(
			{
				indexed_paths: state?.indexed_paths ??
					indexedPaths(state?.files ?? {}),
			},
			includeProjectMemory,
			includeUserProfile,
			fingerprint,
		);
	}
	return state;
}

export function nextStateAfterReconcile(
	files: Record<string, TraeFileState>,
	includeProjectMemory: boolean,
	includeUserProfile: boolean,
	fingerprint: string,
): TraeState {
	return nextBaseState(
		{ files, indexed_paths: indexedPaths(files) },
		includeProjectMemory,
		includeUserProfile,
		fingerprint,
	);
}

function nextBaseState(
	state: TraeState,
	includeProjectMemory: boolean,
	includeUserProfile: boolean,
	fingerprint: string,
): TraeState {
	return {
		...state,
		schema_version: STATE_SCHEMA_VERSION,
		config_fingerprint: fingerprint,
		include_project_memory: includeProjectMemory,
		include_user_profile: includeUserProfile,
		files: state.files ?? {},
		indexed_paths: [...new Set(state.indexed_paths ?? [])].sort(),
	};
}

function indexedPaths(files: Record<string, TraeFileState>): string[] {
	return Object.keys(files).sort();
}

function configFingerprint(
	includeProjectMemory: boolean,
	includeUserProfile: boolean,
): string {
	return `v1:pm=${includeProjectMemory ? 1 : 0}:up=${
		includeUserProfile ? 1 : 0
	}`;
}

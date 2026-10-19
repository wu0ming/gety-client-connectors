import { del, type DocUpdate, upsert } from '@gety-ai/connector-sdk';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface OpenCodeSessionRef {
	id: string;
	title: string;
	directory?: string;
	agent?: string;
	modelId?: string;
	modelProvider?: string;
	createdMs?: number;
	updatedMs: number;
	archivedMs?: number;
	tokensInput?: number;
	tokensOutput?: number;
	cost?: number;
}

export interface OpenCodeMessage {
	type: string;
	seq: number;
	data: Record<string, unknown>;
}

export interface OpenCodeSession {
	ref: OpenCodeSessionRef;
	content: string;
	contentTruncated: boolean;
	messageCount: number;
	userMessageCount: number;
	assistantMessageCount: number;
	toolCallCount: number;
	firstUserText?: string;
}

export interface ListSessionsOptions {
	includeArchivedSessions: boolean;
}

export interface ParseSessionOptions {
	includeToolCalls: boolean;
}

export interface DbAccess {
	listSessionRefs(): OpenCodeSessionRef[];
	listSessionMessages(sessionId: string): OpenCodeMessage[];
	close(): void;
}

const SESSION_DOC_TYPE = 'opencode:session';
const MAX_CONTENT_CHARS = 900_000;

export function openOpencodeDb(dbPath: string): DbAccess {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	return {
		listSessionRefs(): OpenCodeSessionRef[] {
			const rows = db
				.prepare(
					`select id, title, directory, agent, model, time_created, time_updated,
						time_archived, tokens_input, tokens_output, cost
					from session_v2`,
				)
				.all() as Record<string, unknown>[];
			return rows.map((row) => sessionRefFromRow(row));
		},
		listSessionMessages(sessionId: string): OpenCodeMessage[] {
			const rows = db
				.prepare(
					`select type, seq, data from session_message
					where session_id = ? order by seq, time_created`,
				)
				.all(sessionId) as Record<string, unknown>[];
			return rows.map((row) => ({
				type: String(row.type),
				seq: Number(row.seq),
				data: parseJsonObject(row.data) ?? {},
			}));
		},
		close(): void {
			db.close();
		},
	};
}

/**
 * Copy opencode.db (+ WAL sidecars) into a fresh temp directory and open it
 * read-only. This avoids WAL/shm lock conflicts with a running OpenCode
 * process and gives readers a consistent snapshot.
 */
export async function openOpencodeDbSnapshot(
	opencodeDir: string,
): Promise<{ access: DbAccess; cleanup(): void }> {
	const dbPath = join(opencodeDir, 'opencode.db');
	const tempDir = await Deno.makeTempDir({ prefix: 'gety-opencode-' });
	const snapshotPath = join(tempDir, 'opencode.db');
	try {
		copyFileSync(dbPath, snapshotPath);
		try {
			copyFileSync(`${dbPath}-wal`, `${snapshotPath}-wal`);
		} catch {
			// WAL sidecar is optional.
		}
	} catch (error) {
		rmSync(tempDir, { recursive: true, force: true });
		throw error;
	}

	let access: DbAccess;
	try {
		access = openOpencodeDb(snapshotPath);
	} catch (error) {
		rmSync(tempDir, { recursive: true, force: true });
		throw error;
	}

	return {
		access,
		cleanup(): void {
			try {
				access.close();
			} catch {
				// Ignore close errors during cleanup.
			}
			rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

export function resolveOpencodeDir(
	configuredDir: string | undefined,
	env: Record<string, string | undefined> = Deno.env.toObject(),
	os: typeof Deno.build.os = Deno.build.os,
): string {
	const explicit = configuredDir?.trim();
	if (explicit) {
		return explicit;
	}

	const xdgDataHome = env.XDG_DATA_HOME?.trim();
	if (xdgDataHome) {
		return join(xdgDataHome, 'opencode');
	}

	const profile = env.USERPROFILE?.trim() || env.HOME?.trim();
	if (profile) {
		return join(profile, '.local', 'share', 'opencode');
	}

	if (os === 'windows') {
		return join('C:', 'Users', '.local', 'share', 'opencode');
	}
	return join('.local', 'share', 'opencode');
}

export function sessionRefFromRow(
	row: Record<string, unknown>,
): OpenCodeSessionRef {
	const updatedMs = epochMs(row.time_updated) ?? 0;
	const archivedMs = epochMs(row.time_archived) ?? undefined;
	const model = parseJsonObject(row.model);
	return {
		id: String(row.id),
		title: typeof row.title === 'string' && row.title.trim() !== ''
			? row.title.trim()
			: 'Untitled session',
		directory: stringOrUndefined(row.directory),
		agent: stringOrUndefined(row.agent),
		modelId: model == null ? undefined : stringOrUndefined(model.id),
		modelProvider: model == null
			? undefined
			: stringOrUndefined(model.providerID),
		createdMs: epochMs(row.time_created) ?? undefined,
		updatedMs,
		archivedMs,
		tokensInput: numberOrUndefined(row.tokens_input),
		tokensOutput: numberOrUndefined(row.tokens_output),
		cost: numberOrUndefined(row.cost),
	};
}

export function isIndexableSession(
	session: OpenCodeSession,
	options: ListSessionsOptions,
): boolean {
	if (
		!options.includeArchivedSessions && session.ref.archivedMs != null
	) {
		return false;
	}
	return session.userMessageCount > 0;
}

export function buildSessionUpdate(session: OpenCodeSession): DocUpdate {
	return upsert({
		id: sessionDocId(session.ref.id),
		title: sessionTitle(session),
		content: session.content,
		content_format: 'markdown',
		doc_updated_at: rfc3339(session.ref.updatedMs),
		doc_type: SESSION_DOC_TYPE,
		metadata: {
			source: 'opencode',
			session_id: session.ref.id,
			directory: session.ref.directory,
			agent: session.ref.agent,
			model: session.ref.modelId,
			model_provider: session.ref.modelProvider,
			created_at: session.ref.createdMs == null
				? undefined
				: rfc3339(session.ref.createdMs),
			archived: session.ref.archivedMs == null ? false : true,
			tokens_input: session.ref.tokensInput,
			tokens_output: session.ref.tokensOutput,
			cost: session.ref.cost,
			message_count: session.messageCount,
			user_message_count: session.userMessageCount,
			assistant_message_count: session.assistantMessageCount,
			tool_call_count: session.toolCallCount,
			content_truncated: session.contentTruncated,
		},
	});
}

export function buildSessionDelete(sessionId: string): DocUpdate {
	return del(sessionDocId(sessionId));
}

export function sessionDocId(sessionId: string): string {
	return `opencode:session:${sessionId}`;
}

export function parseSession(
	ref: OpenCodeSessionRef,
	messages: OpenCodeMessage[],
	options: ParseSessionOptions,
): OpenCodeSession {
	const rounds: RenderRound[] = [];
	let currentRound: RenderRound | null = null;
	let messageCount = 0;
	let userMessageCount = 0;
	let assistantMessageCount = 0;
	let toolCallCount = 0;
	let firstUserText: string | undefined;

	for (const message of messages) {
		if (message.type === 'user') {
			const text = cleanText(message.data.text);
			if (text == null) {
				continue;
			}
			currentRound = { userMessages: [], assistantMessages: [], toolCalls: [] };
			rounds.push(currentRound);
			currentRound.userMessages.push(text);
			firstUserText ??= text;
			messageCount += 1;
			userMessageCount += 1;
			continue;
		}

		if (message.type !== 'assistant') {
			continue;
		}

		const round: RenderRound = currentRound ?? {
			userMessages: [],
			assistantMessages: [],
			toolCalls: [],
		};
		if (currentRound == null) {
			currentRound = round;
			rounds.push(round);
		}

		const contentItems = Array.isArray(message.data.content)
			? message.data.content
			: [];
		const assistantTexts: string[] = [];
		for (const item of contentItems) {
			if (!isRecord(item)) {
				continue;
			}
			if (item.type === 'text') {
				const text = cleanText(item.text);
				if (text != null) {
					assistantTexts.push(text);
				}
				continue;
			}
			if (item.type === 'tool' && options.includeToolCalls) {
				const summary = summarizeToolCall(item);
				if (summary != null) {
					round.toolCalls.push(summary);
					toolCallCount += 1;
				}
			}
		}

		if (assistantTexts.length > 0) {
			round.assistantMessages.push(assistantTexts.join('\n\n'));
			assistantMessageCount += 1;
		}
	}

	messageCount = userMessageCount + assistantMessageCount;
	const contentResult = renderSessionContent(ref, rounds);
	return {
		ref,
		content: contentResult.content,
		contentTruncated: contentResult.truncated,
		messageCount,
		userMessageCount,
		assistantMessageCount,
		toolCallCount,
		firstUserText,
	};
}

interface RenderRound {
	userMessages: string[];
	assistantMessages: string[];
	toolCalls: string[];
}

function renderSessionContent(
	ref: OpenCodeSessionRef,
	rounds: readonly RenderRound[],
): { content: string; truncated: boolean } {
	const lines: string[] = [];

	const metaLines = renderSessionMeta(ref);
	if (metaLines.length > 0) {
		lines.push('## Session', '', ...metaLines, '');
	}

	for (const round of rounds) {
		if (round.userMessages.length > 0) {
			lines.push('## User', '', round.userMessages.join('\n\n'), '');
		}
		if (round.assistantMessages.length > 0) {
			lines.push('## OpenCode', '', round.assistantMessages.join('\n\n'), '');
		}
		if (round.toolCalls.length > 0) {
			lines.push(
				'## Tool Calls',
				'',
				...round.toolCalls.map((toolCall) => `- ${toolCall}`),
				'',
			);
		}
	}

	let content = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
	let truncated = false;
	if (content.length > MAX_CONTENT_CHARS) {
		content = content.slice(0, MAX_CONTENT_CHARS).trimEnd();
		truncated = true;
	}
	return { content, truncated };
}

function renderSessionMeta(ref: OpenCodeSessionRef): string[] {
	const lines: string[] = [];
	if (ref.directory != null) {
		lines.push(`- Directory: \`${ref.directory}\``);
	}
	if (ref.modelId != null) {
		const provider = ref.modelProvider == null ? '' : ` (${ref.modelProvider})`;
		lines.push(`- Model: \`${ref.modelId}\`${provider}`);
	}
	if (ref.agent != null) {
		lines.push(`- Agent: ${ref.agent}`);
	}
	if (ref.createdMs != null) {
		lines.push(`- Created: ${rfc3339(ref.createdMs)}`);
	}
	return lines;
}

export function sessionTitle(session: OpenCodeSession): string {
	const title = session.ref.title;
	if (title && !/^new session\b/i.test(title)) {
		return title;
	}
	const first = session.firstUserText;
	if (first != null) {
		const paragraph = first.split(/\n\s*\n/)[0]?.trim();
		if (paragraph) {
			return oneLine(paragraph).slice(0, 120);
		}
	}
	return title || 'Untitled session';
}

function summarizeToolCall(item: Record<string, unknown>): string | null {
	const name = stringOrUndefined(item.name)?.trim();
	if (!name) {
		return null;
	}
	const state = isRecord(item.state) ? item.state : {};
	const input = isRecord(state.input) ? state.input : {};
	const command = stringOrUndefined(input.command) ??
		stringOrUndefined(input.cmd);
	if (command != null) {
		return `${name}: ${oneLine(command).slice(0, 200)}`;
	}
	const filePath = stringOrUndefined(input.file_path) ??
		stringOrUndefined(input.filePath);
	if (filePath != null) {
		return `${name}: ${filePath}`;
	}
	return name;
}

function rfc3339(epochMs: number): string {
	return new Date(epochMs).toISOString();
}

function epochMs(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string') {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
	if (typeof value === 'string' && value.trim() !== '') {
		return value;
	}
	return undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	return undefined;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
	if (isRecord(value)) {
		return value;
	}
	if (typeof value !== 'string' || value.trim() === '') {
		return null;
	}
	try {
		const parsed = JSON.parse(value);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}
	const cleaned = value.replace(/\r\n/g, '\n').trim();
	return cleaned === '' ? null : cleaned;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

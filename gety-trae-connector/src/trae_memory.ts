import { del, type DocUpdate, upsert } from '@gety-ai/connector-sdk';
import { join } from 'node:path';

export interface MemorySourceFile {
	relPath: string;
	kind: MemoryFileKind;
	mtimeMs: number;
	size: number;
}

export type MemoryFileKind =
	| 'session'
	| 'topics'
	| 'project_memory'
	| 'user_profile';

export interface MemoryDoc {
	relPath: string;
	kind: MemoryFileKind;
	docId: string;
	docType: string;
	title: string;
	content: string;
	contentTruncated: boolean;
	updatedAtMs: number;
	metadata: Record<string, string | number | boolean | undefined>;
}

export interface SessionEntry {
	intent: string;
	actions: string[];
	outcome: string;
	learned: string[];
	summaryTime?: string;
	createdAtMs?: number;
}

export interface TopicEntry {
	sessionId: string;
	summaryTime: string;
	text: string;
}

export interface ListFilesOptions {
	includeProjectMemory: boolean;
	includeUserProfile: boolean;
}

export interface ParsedOptions {
	kind: MemoryFileKind;
	project?: string;
	date?: string;
}

const MAX_CONTENT_CHARS = 600_000;
const SESSION_RE = /^session_memory_(.+)\.jsonl$/;
const DATE_RE = /^\d{8}$/;

/** Relative path → (kind, project, date) classification. */
export function classifyRelPath(
	relPath: string,
): ParsedOptions | null {
	const parts = relPath.split('/');
	if (parts.length === 3 && parts[0] === 'projects') {
		if (parts[2] === 'project_memory.md') {
			return { kind: 'project_memory', project: parts[1] };
		}
		return null;
	}
	if (parts.length === 4 && parts[0] === 'projects' && DATE_RE.test(parts[2])) {
		const sessionMatch = SESSION_RE.exec(parts[3]);
		if (sessionMatch) {
			return { kind: 'session', project: parts[1], date: parts[2] };
		}
		if (parts[3] === 'topics.md') {
			return { kind: 'topics', project: parts[1], date: parts[2] };
		}
	}
	if (parts.length === 1 && parts[0] === 'user_profile.md') {
		return { kind: 'user_profile' };
	}
	return null;
}

/** Walk the memory folder and list indexable files with stat info. */
export async function listMemoryFiles(
	rootDir: string,
	options: ListFilesOptions,
): Promise<MemorySourceFile[]> {
	const files: MemorySourceFile[] = [];
	const rootStat = await Deno.stat(rootDir).catch(() => null);
	if (rootStat == null || !rootStat.isDirectory) {
		return files;
	}

	if (options.includeUserProfile) {
		const profile = join(rootDir, 'user_profile.md');
		const stat = await Deno.stat(profile).catch(() => null);
		if (stat?.isFile) {
			files.push({
				relPath: 'user_profile.md',
				kind: 'user_profile',
				mtimeMs: stat.mtime?.getTime() ?? 0,
				size: stat.size,
			});
		}
	}

	const projectsDir = join(rootDir, 'projects');
	for await (const project of safeReadDir(projectsDir)) {
		if (!project.isDirectory) continue;

		if (options.includeProjectMemory) {
			const pm = join(projectsDir, project.name, 'project_memory.md');
			const stat = await Deno.stat(pm).catch(() => null);
			if (stat?.isFile) {
				files.push({
					relPath: `projects/${project.name}/project_memory.md`,
					kind: 'project_memory',
					mtimeMs: stat.mtime?.getTime() ?? 0,
					size: stat.size,
				});
			}
		}

		for await (const dateDir of safeReadDir(join(projectsDir, project.name))) {
			if (!dateDir.isDirectory || !DATE_RE.test(dateDir.name)) continue;
			const datePath = join(projectsDir, project.name, dateDir.name);
			for await (const file of safeReadDir(datePath)) {
				if (!file.isFile) continue;
				const parsed = classifyRelPath(
					`projects/${project.name}/${dateDir.name}/${file.name}`,
				);
				if (parsed == null) continue;
				const stat = await Deno.stat(join(datePath, file.name)).catch(() =>
					null
				);
				if (stat == null || !stat.isFile) continue;
				files.push({
					relPath: `projects/${project.name}/${dateDir.name}/${file.name}`,
					kind: parsed.kind,
					mtimeMs: stat.mtime?.getTime() ?? 0,
					size: stat.size,
				});
			}
		}
	}
	return files;
}

/** Convert one source file's raw text into a MemoryDoc. */
export function buildMemoryDoc(
	file: MemorySourceFile,
	rawText: string,
): MemoryDoc {
	switch (file.kind) {
		case 'session': {
			const sessionId = sessionIdFromFilename(file.relPath) ?? 'unknown';
			const project = projectFromRelPath(file.relPath);
			const date = dateFromRelPath(file.relPath);
			const entries = parseSessionJsonl(rawText);
			const rendered = renderSessionContent(entries);
			return {
				relPath: file.relPath,
				kind: 'session',
				docId: sessionIdDocId(sessionId),
				docType: 'trae:session',
				title: sessionTitle(sessionId, entries),
				content: rendered.content,
				contentTruncated: rendered.truncated,
				updatedAtMs: latestCreatedAtMs(entries) ?? file.mtimeMs,
				metadata: {
					source: 'trae',
					session_id: sessionId,
					project,
					date,
					entries: entries.length,
					last_summary_time: entries.at(-1)?.summaryTime,
				},
			};
		}
		case 'topics': {
			const project = projectFromRelPath(file.relPath);
			const date = dateFromRelPath(file.relPath);
			const entries = parseTopics(rawText);
			const rendered = renderTopicsContent(entries);
			return {
				relPath: file.relPath,
				kind: 'topics',
				docId: topicsDocId(project, date),
				docType: 'trae:topics',
				title: `Trae topics ${date ?? ''}`.trim(),
				content: rendered.content,
				contentTruncated: rendered.truncated,
				updatedAtMs: file.mtimeMs,
				metadata: {
					source: 'trae',
					project,
					date,
					entries: entries.length,
				},
			};
		}
		case 'project_memory': {
			const project = projectFromRelPath(file.relPath);
			const capped = applyCap(cleanMarkdown(rawText));
			return {
				relPath: file.relPath,
				kind: 'project_memory',
				docId: memoryDocId(project),
				docType: 'trae:memory',
				title: markdownTitle(capped.content) ??
					`Trae project memory ${project}`,
				content: capped.content,
				contentTruncated: capped.truncated,
				updatedAtMs: file.mtimeMs,
				metadata: {
					source: 'trae',
					project,
				},
			};
		}
		case 'user_profile': {
			const capped = applyCap(cleanMarkdown(rawText));
			return {
				relPath: file.relPath,
				kind: 'user_profile',
				docId: 'trae:profile:user',
				docType: 'trae:profile',
				title: markdownTitle(capped.content) ?? 'Trae user profile',
				content: capped.content,
				contentTruncated: capped.truncated,
				updatedAtMs: file.mtimeMs,
				metadata: {
					source: 'trae',
				},
			};
		}
	}
}

export function sessionIdDocId(sessionId: string): string {
	return `trae:session:${sessionId}`;
}

export function topicsDocId(project: string, date?: string): string {
	return `trae:topics:${project}:${date ?? 'unknown'}`;
}

export function memoryDocId(project: string): string {
	return `trae:memory:${project}`;
}

export function sessionIdFromFilename(relPath: string): string | null {
	const name = relPath.split('/').at(-1) ?? '';
	const match = SESSION_RE.exec(name);
	return match ? match[1] : null;
}

export function projectFromRelPath(relPath: string): string {
	const parts = relPath.split('/');
	return parts[0] === 'projects' && parts.length > 1 ? parts[1] : '';
}

export function dateFromRelPath(relPath: string): string | undefined {
	const parts = relPath.split('/');
	return parts.length >= 3 && DATE_RE.test(parts[2]) ? parts[2] : undefined;
}

export function parseSessionJsonl(rawText: string): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const line of rawText.split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '') continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (typeof parsed !== 'object' || parsed === null) continue;
		const record = parsed as Record<string, unknown>;
		const intent = typeof record.intent === 'string'
			? record.intent.trim()
			: '';
		const actions = stringArray(record.actions);
		const outcome = typeof record.outcome === 'string'
			? record.outcome.trim()
			: '';
		const learned = stringArray(record.learned);
		if (
			intent === '' && actions.length === 0 && outcome === '' &&
			learned.length === 0
		) {
			continue;
		}
		const summaryTime = typeof record.message_summary_time === 'string'
			? record.message_summary_time
			: undefined;
		const meta = record.compact_summary_meta;
		const createdAtMs = meta !== null && typeof meta === 'object' &&
				typeof (meta as Record<string, unknown>).created_at_ms === 'number'
			? (meta as Record<string, unknown>).created_at_ms as number
			: undefined;
		entries.push({
			intent,
			actions,
			outcome,
			learned,
			summaryTime,
			createdAtMs,
		});
	}
	return entries;
}

export function latestCreatedAtMs(
	entries: readonly SessionEntry[],
): number | undefined {
	let latest: number | undefined;
	for (const entry of entries) {
		if (
			entry.createdAtMs != null &&
			(latest == null || entry.createdAtMs > latest)
		) {
			latest = entry.createdAtMs;
		}
	}
	return latest;
}

export function sessionTitle(
	sessionId: string,
	entries: readonly SessionEntry[],
): string {
	for (const entry of entries) {
		if (entry.intent !== '') {
			return oneLine(entry.intent).slice(0, 120);
		}
	}
	return `Trae session ${sessionId.slice(0, 12)}`;
}

export function renderSessionContent(
	entries: readonly SessionEntry[],
): { content: string; truncated: boolean } {
	const lines: string[] = [];
	for (const entry of entries) {
		if (entry.summaryTime != null) {
			lines.push(`## ${entry.summaryTime}`);
		} else {
			lines.push('## Summary');
		}
		if (entry.intent !== '') {
			lines.push('', `**意图**: ${entry.intent}`);
		}
		if (entry.actions.length > 0) {
			lines.push('', '**动作**:', ...entry.actions.map((a) => `- ${a}`));
		}
		if (entry.outcome !== '') {
			lines.push('', `**结果**: ${entry.outcome}`);
		}
		if (entry.learned.length > 0) {
			lines.push('', '**经验**:', ...entry.learned.map((l) => `- ${l}`));
		}
		lines.push('');
	}
	const content = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
	return applyCap(content);
}

export function parseTopics(rawText: string): TopicEntry[] {
	const entries: TopicEntry[] = [];
	const headerRe =
		/^\[session_id:\s*([^\]|]+?)\s*\|\s*topic_summary_time:\s*([^\]]+?)\s*\]/;
	for (const line of rawText.split('\n')) {
		const trimmed = line.replace(/\r$/, '');
		if (trimmed.trim() === '') continue;
		const match = headerRe.exec(trimmed);
		if (match) {
			entries.push({
				sessionId: match[1],
				summaryTime: match[2],
				text: trimmed.slice(match[0].length).trim(),
			});
			continue;
		}
		const previous = entries.at(-1);
		if (previous != null) {
			previous.text = `${previous.text}\n${trimmed.trim()}`.trim();
		}
	}
	return entries;
}

export function renderTopicsContent(
	entries: readonly TopicEntry[],
): { content: string; truncated: boolean } {
	const lines: string[] = [];
	for (const entry of entries) {
		lines.push(`## ${entry.summaryTime}`, '', entry.text, '');
	}
	const content = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
	return applyCap(content);
}

export function cleanMarkdown(rawText: string): string {
	return rawText.replace(/\r\n/g, '\n').replace(/\0/g, '').trim();
}

export function markdownTitle(markdown: string): string | undefined {
	const match = /^#\s+(.+)$/m.exec(markdown);
	if (match) {
		return oneLine(match[1]).slice(0, 120);
	}
	return undefined;
}

export function docUpdateFor(doc: MemoryDoc): DocUpdate {
	return upsert({
		id: doc.docId,
		title: doc.title,
		content: doc.content,
		content_format: 'markdown',
		doc_updated_at: new Date(doc.updatedAtMs).toISOString(),
		doc_type: doc.docType,
		metadata: doc.metadata,
	});
}

export function docDeleteFor(docId: string): DocUpdate {
	return del(docId);
}

export function docDeleteForPath(relPath: string): DocUpdate {
	return del(deleteIdForPath(relPath));
}

export function resolveMemoryDir(
	configuredDir: string | undefined,
	env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
	const explicit = configuredDir?.trim();
	if (explicit) {
		return explicit;
	}
	const profile = env.USERPROFILE?.trim() || env.HOME?.trim();
	if (profile) {
		return join(profile, '.trae-cn', 'memory');
	}
	return join('.trae-cn', 'memory');
}

export function deleteIdForPath(relPath: string): string {
	const parsed = classifyRelPath(relPath);
	const project = projectFromRelPath(relPath);
	const date = dateFromRelPath(relPath);
	switch (parsed?.kind) {
		case 'session':
			return sessionIdDocId(sessionIdFromFilename(relPath) ?? 'unknown');
		case 'topics':
			return topicsDocId(project, date);
		case 'project_memory':
			return memoryDocId(project);
		case 'user_profile':
			return 'trae:profile:user';
		default:
			return `trae:unknown:${relPath}`;
	}
}

function applyCap(content: string): { content: string; truncated: boolean } {
	if (content.length <= MAX_CONTENT_CHARS) {
		return { content, truncated: false };
	}
	return {
		content: content.slice(0, MAX_CONTENT_CHARS).trimEnd(),
		truncated: true,
	};
}

async function* safeReadDir(
	path: string,
): AsyncGenerator<Deno.DirEntry, void, unknown> {
	try {
		for await (const entry of Deno.readDir(path)) {
			yield entry;
		}
	} catch {
		// Missing or unreadable directories contribute nothing.
	}
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string =>
			typeof item === 'string' && item.trim() !== ''
		)
		.map((item) => item.trim());
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

export { MAX_CONTENT_CHARS };

import { join } from 'node:path';
import assert from 'node:assert/strict';
import {
	buildMemoryDoc,
	classifyRelPath,
	docUpdateFor,
	markdownTitle,
	memoryDocId,
	type MemorySourceFile,
	parseSessionJsonl,
	parseTopics,
	renderSessionContent,
	resolveMemoryDir,
	sessionIdDocId,
	sessionIdFromFilename,
	sessionTitle,
	topicsDocId,
} from './trae_memory.ts';
import {
	initialState,
	nextStateAfterReconcile,
	type TraeFileState,
	type TraeState,
} from './index.ts';

function sourceFile(
	relPath: string,
	kind: MemorySourceFile['kind'],
	mtimeMs = 1790000000000,
): MemorySourceFile {
	return { relPath, kind, mtimeMs, size: 100 };
}

Deno.test('classifyRelPath recognizes all memory layouts', () => {
	assert.deepEqual(
		classifyRelPath('projects/p1/20260904/session_memory_abc.jsonl'),
		{
			kind: 'session',
			project: 'p1',
			date: '20260904',
		},
	);
	assert.deepEqual(classifyRelPath('projects/p1/20260904/topics.md'), {
		kind: 'topics',
		project: 'p1',
		date: '20260904',
	});
	assert.deepEqual(classifyRelPath('projects/p1/project_memory.md'), {
		kind: 'project_memory',
		project: 'p1',
	});
	assert.deepEqual(classifyRelPath('user_profile.md'), {
		kind: 'user_profile',
	});
	assert.equal(classifyRelPath('projects/p1/notadate/notes.md'), null);
	assert.equal(classifyRelPath('projects/p1/20260904/other.txt'), null);
	assert.equal(classifyRelPath('stray.md'), null);
});

Deno.test('parseSessionJsonl extracts entries and skips malformed lines', () => {
	const raw = [
		JSON.stringify({
			intent: '优化技能包',
			actions: ['梳理规范', '更新文件'],
			outcome: '完成更新',
			learned: ['先确认再改'],
			message_summary_time: '2026-09-03 15:29:32',
			compact_summary_meta: { created_at_ms: 1788420572729 },
		}),
		'not json',
		JSON.stringify({ intent: '', actions: [], outcome: '', learned: [] }),
		JSON.stringify({ intent: '第二个任务' }),
	].join('\n');

	const entries = parseSessionJsonl(raw);
	assert.equal(entries.length, 2);
	assert.equal(entries[0].intent, '优化技能包');
	assert.deepEqual(entries[0].actions, ['梳理规范', '更新文件']);
	assert.equal(entries[0].createdAtMs, 1788420572729);
	assert.equal(entries[0].summaryTime, '2026-09-03 15:29:32');
	assert.equal(entries[1].actions.length, 0);
});

Deno.test('sessionTitle uses first intent with fallback', () => {
	const entries = parseSessionJsonl(
		JSON.stringify({ intent: '修复 EPR 报表导出\n换行会被压平' }),
	);
	assert.equal(
		sessionTitle('ses_x', entries),
		'修复 EPR 报表导出 换行会被压平',
	);
	assert.equal(
		sessionTitle('6a964554349a6b42a63d8cb4', []),
		'Trae session 6a964554349a',
	);
});

Deno.test('renderSessionContent renders intent, actions, outcome, learned', () => {
	const entries = parseSessionJsonl(
		JSON.stringify({
			intent: '查询任务',
			actions: ['步骤一'],
			outcome: '完成',
			learned: ['教训一'],
			message_summary_time: '2026-09-03 15:29:32',
		}),
	);
	const { content, truncated } = renderSessionContent(entries);
	assert.equal(truncated, false);
	assert.match(content, /## 2026-09-03 15:29:32/);
	assert.match(content, /\*\*意图\*\*: 查询任务/);
	assert.match(content, /- 步骤一/);
	assert.match(content, /\*\*结果\*\*: 完成/);
	assert.match(content, /- 教训一/);
});

Deno.test('parseTopics extracts bracket headers and continuation lines', () => {
	const raw = [
		'[session_id: ses_a | topic_summary_time: 2026-08-05 09:11:40]第一条话题。',
		'续行内容。',
		'',
		'[session_id: ses_b | topic_summary_time: 2026-08-05 10:09:34]第二条话题。',
	].join('\n');

	const entries = parseTopics(raw);
	assert.equal(entries.length, 2);
	assert.equal(entries[0].sessionId, 'ses_a');
	assert.equal(entries[0].text, '第一条话题。\n续行内容。');
	assert.equal(entries[1].sessionId, 'ses_b');
});

Deno.test('buildMemoryDoc session contract is stable', () => {
	const file = sourceFile(
		'projects/p1/20260904/session_memory_abc123.jsonl',
		'session',
	);
	const doc = buildMemoryDoc(
		file,
		JSON.stringify({
			intent: '目标任务',
			outcome: '完成',
			message_summary_time: '2026-09-04 10:00:00',
			compact_summary_meta: { created_at_ms: 1788420572729 },
		}),
	);

	assert.equal(doc.docId, 'trae:session:abc123');
	assert.equal(doc.docType, 'trae:session');
	assert.equal(doc.title, '目标任务');
	assert.equal(doc.updatedAtMs, 1788420572729);
	assert.equal(doc.metadata.project, 'p1');
	assert.equal(doc.metadata.date, '20260904');
	assert.equal(doc.metadata.entries, 1);
	assert.equal(doc.metadata.source, 'trae');

	const update = docUpdateFor(doc);
	assert.equal(update.kind, 'upsert');
	if (update.kind !== 'upsert') throw new Error('expected upsert');
	assert.equal(update.doc.id, 'trae:session:abc123');
	assert.equal(update.doc.doc_updated_at, '2026-09-03T07:29:32.729Z');
	assert.equal(update.doc.content_format, 'markdown');
});

Deno.test('buildMemoryDoc topics and memory docs derive ids from path', () => {
	const topics = buildMemoryDoc(
		sourceFile('projects/p1/20260805/topics.md', 'topics'),
		'[session_id: s | topic_summary_time: t]text',
	);
	assert.equal(topics.docId, topicsDocId('p1', '20260805'));
	assert.equal(topics.docType, 'trae:topics');
	assert.equal(topics.title, 'Trae topics 20260805');

	const pm = buildMemoryDoc(
		sourceFile('projects/p1/project_memory.md', 'project_memory'),
		'# 项目记忆\n内容',
	);
	assert.equal(pm.docId, memoryDocId('p1'));
	assert.equal(pm.docType, 'trae:memory');
	assert.equal(pm.title, '项目记忆');

	const up = buildMemoryDoc(
		sourceFile('user_profile.md', 'user_profile'),
		'正文无标题',
	);
	assert.equal(up.docId, 'trae:profile:user');
	assert.equal(up.title, 'Trae user profile');
});

Deno.test('markdownTitle finds first heading', () => {
	assert.equal(markdownTitle('intro\n\n# 标题\n'), '标题');
	assert.equal(markdownTitle('no heading'), undefined);
});

Deno.test('initialState forces full reindex on schema or config change', () => {
	const previous: TraeState = {
		schema_version: 1,
		config_fingerprint: 'v1:pm=1:up=0',
		include_project_memory: true,
		include_user_profile: false,
		files: {
			'projects/p1/20260904/topics.md': {
				mtime_ms: 1,
				size: 2,
				kind: 'topics',
				indexed: true,
			},
		},
		indexed_paths: ['projects/p1/20260904/topics.md'],
	};

	const same = initialState(previous, true, false, 'v1:pm=1:up=0');
	assert.equal(same, previous);

	const changed = initialState(previous, true, true, 'v1:pm=1:up=1');
	assert.notEqual(changed, previous);
	assert.deepEqual(changed.indexed_paths, ['projects/p1/20260904/topics.md']);
	assert.deepEqual(changed.files, {});
});

Deno.test('nextStateAfterReconcile stores sorted indexed paths', () => {
	const files: Record<string, TraeFileState> = {
		b: { mtime_ms: 1, size: 1, kind: 'topics', indexed: true },
		a: { mtime_ms: 2, size: 2, kind: 'session', indexed: true },
	};
	const state = nextStateAfterReconcile(files, true, false, 'v1:pm=1:up=0');
	assert.deepEqual(state.indexed_paths, ['a', 'b']);
});

Deno.test('resolveMemoryDir honors config and profile fallback', () => {
	assert.equal(resolveMemoryDir('D:/mem', {}), 'D:/mem');
	assert.equal(
		resolveMemoryDir(undefined, { USERPROFILE: 'C:/Users/demo' }),
		join('C:/Users/demo', '.trae-cn', 'memory'),
	);
	assert.equal(
		resolveMemoryDir(undefined, { HOME: '/home/demo' }),
		join('/home/demo', '.trae-cn', 'memory'),
	);
});

Deno.test('sessionIdFromFilename extracts the session id', () => {
	assert.equal(
		sessionIdFromFilename(
			'projects/p/20260904/session_memory_6a964554349a.jsonl',
		),
		'6a964554349a',
	);
	assert.equal(sessionIdFromFilename('projects/p/20260904/topics.md'), null);
});

Deno.test('sessionIdDocId is prefixed and stable', () => {
	assert.equal(sessionIdDocId('abc'), 'trae:session:abc');
});

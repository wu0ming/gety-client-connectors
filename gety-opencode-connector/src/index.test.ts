import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
	initialState,
	nextStateAfterReconcile,
	type OpenCodeSessionState,
	type OpenCodeState,
} from './index.ts';
import {
	buildSessionDelete,
	buildSessionUpdate,
	isIndexableSession,
	type OpenCodeMessage,
	type OpenCodeSessionRef,
	parseSession,
	resolveOpencodeDir,
	sessionDocId,
	sessionRefFromRow,
	sessionTitle,
} from './opencode_db.ts';

function testRef(
	overrides: Partial<OpenCodeSessionRef> = {},
): OpenCodeSessionRef {
	return {
		id: 'ses_test',
		title: 'New session - 2026-07-30T03:04:49.094Z',
		directory: 'C:/work/demo',
		agent: 'build',
		modelId: 'qwen3.7-plus',
		modelProvider: 'bailian',
		createdMs: 1785380689094,
		updatedMs: 1785380871782,
		archivedMs: undefined,
		tokensInput: 12,
		tokensOutput: 80,
		cost: 0.5,
		...overrides,
	};
}

function userMessage(text: string, seq: number): OpenCodeMessage {
	return {
		type: 'user',
		seq,
		data: { time: { created: 1785380689127 }, text, files: [], agents: [] },
	};
}

function assistantMessage(
	content: Record<string, unknown>[],
	seq: number,
): OpenCodeMessage {
	return {
		type: 'assistant',
		seq,
		data: {
			time: { created: 1785380689305 },
			agent: 'build',
			model: { providerID: 'bailian', modelID: 'qwen3.7-plus' },
			content,
		},
	};
}

Deno.test('parseSession renders user and assistant rounds as markdown', () => {
	const ref = testRef();
	const messages: OpenCodeMessage[] = [
		userMessage('帮我看看这个报错', 1),
		assistantMessage([
			{ type: 'step-start' },
			{
				type: 'text',
				text: '这是类型错误，修复方式如下。',
			},
		], 2),
		userMessage('修好了吗', 3),
		assistantMessage([
			{ type: 'text', text: '修好了，测试通过。' },
		], 4),
	];

	const session = parseSession(ref, messages, { includeToolCalls: false });

	assert.equal(session.userMessageCount, 2);
	assert.equal(session.assistantMessageCount, 2);
	assert.equal(session.messageCount, 4);
	assert.equal(session.firstUserText, '帮我看看这个报错');
	assert.match(session.content, /## User/);
	assert.match(session.content, /## OpenCode/);
	assert.match(session.content, /帮我看看这个报错/);
	assert.match(session.content, /修好了，测试通过。/);
	assert.match(session.content, /## Session/);
	assert.match(session.content, /C:\/work\/demo/);
	assert.match(session.content, /qwen3\.7-plus/);
	assert.doesNotMatch(session.content, /## Tool Calls/);
});

Deno.test('parseSession summarizes tool calls only when enabled', () => {
	const ref = testRef();
	const messages: OpenCodeMessage[] = [
		userMessage('list files', 1),
		assistantMessage([
			{
				type: 'tool',
				id: 'call_1',
				name: 'shell',
				executed: true,
				state: {
					status: 'completed',
					input: { command: 'ls -la\nnode_modules' },
					output: 'huge output',
				},
			},
			{ type: 'text', text: 'done' },
		], 2),
	];

	const withoutTools = parseSession(ref, messages, { includeToolCalls: false });
	assert.equal(withoutTools.toolCallCount, 0);
	assert.doesNotMatch(withoutTools.content, /## Tool Calls/);
	assert.doesNotMatch(withoutTools.content, /ls -la/);

	const withTools = parseSession(ref, messages, { includeToolCalls: true });
	assert.equal(withTools.toolCallCount, 1);
	assert.match(withTools.content, /## Tool Calls/);
	assert.match(withTools.content, /shell: ls -la node_modules/);
	assert.doesNotMatch(withTools.content, /huge output/);
});

Deno.test('parseSession skips system, synthetic and idle messages', () => {
	const ref = testRef();
	const messages: OpenCodeMessage[] = [
		userMessage('hello', 1),
		assistantMessage([{ type: 'text', text: 'hi' }], 2),
		{ type: 'system', seq: 3, data: { text: 'instructions changed' } },
		{ type: 'synthetic', seq: 4, data: { text: '<shell id="sh_1">' } },
		{ type: 'idle', seq: 5, data: { outcome: 'succeeded' } },
	];

	const session = parseSession(ref, messages, { includeToolCalls: false });
	assert.equal(session.userMessageCount, 1);
	assert.equal(session.assistantMessageCount, 1);
	assert.doesNotMatch(session.content, /instructions changed/);
	assert.doesNotMatch(session.content, /<shell/);
});

Deno.test('sessionTitle falls back to first user prompt for default titles', () => {
	const ref = testRef();
	const session = parseSession(
		ref,
		[userMessage('查找所有未处理的 EPR return\n\n更多内容', 1)],
		{ includeToolCalls: false },
	);
	assert.equal(sessionTitle(session), '查找所有未处理的 EPR return');

	const named = parseSession(testRef({ title: '测试连接' }), [], {
		includeToolCalls: false,
	});
	assert.equal(sessionTitle(named), '测试连接');

	const empty = parseSession(testRef(), [], { includeToolCalls: false });
	assert.equal(sessionTitle(empty), 'New session - 2026-07-30T03:04:49.094Z');
});

Deno.test('isIndexableSession respects archived option and user message requirement', () => {
	const withUser = parseSession(testRef(), [userMessage('hi', 1)], {
		includeToolCalls: false,
	});
	const withoutUser = parseSession(testRef(), [], { includeToolCalls: false });
	const archived = parseSession(
		testRef({ archivedMs: 1790000000000 }),
		[userMessage('hi', 1)],
		{ includeToolCalls: false },
	);

	assert.equal(
		isIndexableSession(withUser, { includeArchivedSessions: true }),
		true,
	);
	assert.equal(
		isIndexableSession(withoutUser, { includeArchivedSessions: true }),
		false,
	);
	assert.equal(
		isIndexableSession(archived, { includeArchivedSessions: true }),
		true,
	);
	assert.equal(
		isIndexableSession(archived, { includeArchivedSessions: false }),
		false,
	);
});

Deno.test('buildSessionUpdate emits stable doc contract', () => {
	const session = parseSession(
		testRef(),
		[userMessage('hi', 1), assistantMessage([{ type: 'text', text: 'ok' }], 2)],
		{ includeToolCalls: false },
	);
	const update = buildSessionUpdate(session);

	assert.equal(update.kind, 'upsert');
	if (update.kind !== 'upsert') throw new Error('expected upsert');
	assert.equal(update.doc.id, 'opencode:session:ses_test');
	assert.equal(update.doc.doc_type, 'opencode:session');
	assert.equal(update.doc.content_format, 'markdown');
	assert.equal(update.doc.doc_updated_at, '2026-07-30T03:07:51.782Z');
	assert.equal(sessionDocId('ses_x'), 'opencode:session:ses_x');

	const metadata = update.doc.metadata as Record<string, unknown>;
	assert.equal(metadata.source, 'opencode');
	assert.equal(metadata.session_id, 'ses_test');
	assert.equal(metadata.created_at, '2026-07-30T03:04:49.094Z');
	assert.equal(metadata.archived, false);
	assert.equal(metadata.model, 'qwen3.7-plus');
});

Deno.test('buildSessionDelete removes by stable doc id', () => {
	const update = buildSessionDelete('ses_gone');
	assert.deepEqual(update, { kind: 'delete', id: 'opencode:session:ses_gone' });
});

Deno.test('sessionRefFromRow parses model JSON and timestamps', () => {
	const ref = sessionRefFromRow({
		id: 'ses_row',
		title: '  my session  ',
		directory: 'C:/x',
		agent: 'build',
		model: '{"id":"gpt-5.3-chat-latest","providerID":"openai"}',
		time_created: 1785380689094,
		time_updated: 1785380871782,
		time_archived: null,
		tokens_input: 10,
		tokens_output: 20,
		cost: 0.25,
	});

	assert.equal(ref.id, 'ses_row');
	assert.equal(ref.title, 'my session');
	assert.equal(ref.modelId, 'gpt-5.3-chat-latest');
	assert.equal(ref.modelProvider, 'openai');
	assert.equal(ref.createdMs, 1785380689094);
	assert.equal(ref.archivedMs, undefined);
});

Deno.test('initialState forces full reindex on schema or config change', () => {
	const previous: OpenCodeState = {
		schema_version: 1,
		config_fingerprint: 'v1:notool',
		include_tool_calls: false,
		include_archived_sessions: true,
		sessions: { ses_a: { updated_ms: 1, archived: false, indexed: true } },
		indexed_sessions: ['ses_a'],
	};

	const same = initialState(previous, false, true, 'v1:notool');
	assert.equal(same, previous);

	const toolChanged = initialState(previous, true, true, 'v1:notool');
	assert.notEqual(toolChanged, previous);
	assert.deepEqual(toolChanged.indexed_sessions, ['ses_a']);
	assert.deepEqual(toolChanged.sessions, {});
});

Deno.test('nextStateAfterReconcile stores current session ids sorted', () => {
	const sessions: Record<string, OpenCodeSessionState> = {
		ses_b: { updated_ms: 2, archived: false, indexed: true },
		ses_a: { updated_ms: 1, archived: false, indexed: true },
	};
	const state = nextStateAfterReconcile(sessions, false, true, 'v1:notool');
	assert.deepEqual(state.indexed_sessions, ['ses_a', 'ses_b']);
	assert.equal(state.sessions?.ses_a.updated_ms, 1);
});

Deno.test('resolveOpencodeDir honors config, XDG_DATA_HOME and profile', () => {
	assert.equal(
		resolveOpencodeDir('D:/custom/opencode', {}),
		'D:/custom/opencode',
	);

	// Expectations use join() so the test is separator-agnostic.
	assert.equal(
		resolveOpencodeDir(undefined, { XDG_DATA_HOME: '/xdg' }),
		join('/xdg', 'opencode'),
	);
	assert.equal(
		resolveOpencodeDir(undefined, { USERPROFILE: 'C:/Users/demo' }),
		join('C:/Users/demo', '.local', 'share', 'opencode'),
	);
	assert.equal(
		resolveOpencodeDir(undefined, { HOME: '/home/demo' }),
		join('/home/demo', '.local', 'share', 'opencode'),
	);
});

/**
 * DSH GetY connector host plugin.
 *
 * Exposes the connector state and controls to the Plugins page over three
 * same-origin routes, and drives the GetY CLI (`gety connector ...`) so
 * "connect" really installs, enables, and polls the custom connector.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const inject = ['connection'];

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const CONNECTOR_MANIFEST_ID = 'dsh_sessions';
const GETY_CLI_TIMEOUT_MS = 120_000;

export function apply(ctx) {
	const runtime = createRuntime();

	ctx.connection.fetch.register({
		path: '/api/gety/state',
		methods: ['GET'],
		requestBody: 'buffered',
		fetch: async () => json(await collectState(runtime, false)),
	});

	ctx.connection.fetch.register({
		path: '/api/gety/connect',
		methods: ['POST'],
		requestBody: 'buffered',
		fetch: async () => {
			try {
				return json(await connect(runtime));
			} catch (error) {
				return json({ ok: false, error: message(error) }, 500);
			}
		},
	});

	ctx.connection.fetch.register({
		path: '/api/gety/workspaces',
		methods: ['POST'],
		requestBody: 'buffered',
		fetch: async (request) => {
			try {
				const body = await readBody(request);
				return json(await saveWorkspaces(runtime, body));
			} catch (error) {
				return json({ ok: false, error: message(error) }, 400);
			}
		},
	});

	ctx.connection.fetch.register({
		path: '/api/gety/sync',
		methods: ['POST'],
		requestBody: 'buffered',
		fetch: async () => {
			try {
				return json(await syncNow(runtime));
			} catch (error) {
				return json({ ok: false, error: message(error) }, 500);
			}
		},
	});
}

function createRuntime() {
	const dshHome = resolveDshHome();
	return {
		dshHome,
		configPath: join(dshHome, 'gety-connector.json'),
		installDir: join(dshHome, 'gety-connector', 'connector'),
		packageConnectorDir: join(PACKAGE_DIR, 'connector'),
		statusCache: { at: 0, value: null },
	};
}

function resolveDshHome() {
	const explicit = process.env.DSH_HOME;
	if (typeof explicit === 'string' && explicit.trim() !== '') return resolve(explicit.trim());
	return join(homedir(), '.dsh');
}

function resolveGetyExe() {
	const explicit = process.env.GETY_EXE;
	if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
	const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
	const candidates = [
		join(localAppData, 'Gety', 'Gety.exe'),
		join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Gety', 'Gety.exe'),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return candidates[0];
}

async function collectState(runtime, force) {
	const workspaces = readWorkspaces(runtime.dshHome);
	const share = readShareConfig(runtime.configPath);
	const gety = await getyStatus(runtime, force);
	const selected = new Set(share.workspaces ?? []);
	const allSelected = share.workspaces === null;
	const connector = gety.connector;

	return {
		ok: true,
		dshHome: runtime.dshHome,
		configPath: runtime.configPath,
		installDir: runtime.installDir,
		workspaces: workspaces.map((workspace) => ({
			id: workspace.id,
			title: workspace.title,
			path: workspace.path,
			sessionCount: workspace.sessionIds.length,
			selected: allSelected || selected.has(workspace.id),
		})),
		allSelected,
		gety: {
			exe: gety.exe,
			installed: gety.exe !== null,
			running: gety.running,
			version: gety.version,
			error: gety.error,
			connector: connector === null
				? null
				: {
					id: connector.id,
					name: connector.name,
					version: connector.version,
					enabled: connector.enabled,
					state: connector.status?.state ?? 'unknown',
					docCount: connector.searchable_doc_count ?? 0,
					lastUpdate: connector.last_update_time ?? null,
					sourcePath: connector.source_path ?? null,
				},
		},
		mcpConfigured: mcpConfigured(runtime.dshHome),
	};
}

async function connect(runtime) {
	const exe = resolveGetyExe();
	if (!existsSync(exe)) {
		throw new Error(`找不到 GetY（${exe}）。请先安装并启动 GetY。`);
	}
	ensureDefaultConfig(runtime);
	syncConnectorSource(runtime);

	await runGety(exe, ['connector', 'list', '--json', '--kind', 'all'], 30_000);
	let connector = await findConnector(runtime, exe);
	if (connector === null) {
		const result = await runGety(exe, ['connector', 'install', runtime.installDir, '--json'], GETY_CLI_TIMEOUT_MS);
		const parsed = parseJson(result.stdout);
		if (parsed !== null && typeof parsed.id === 'string') {
			connector = await findConnector(runtime, exe);
		}
		connector = connector ?? await findConnector(runtime, exe);
	} else {
		await runGety(exe, ['connector', 'configure', connector.id, '--json'], GETY_CLI_TIMEOUT_MS).catch(() => undefined);
	}
	if (connector === null) {
		throw new Error('GetY 未返回 DeepSeek Harness 连接器，请打开 GetY → 设置 → 连接器 检查安装结果。');
	}
	await runGety(exe, ['connector', 'enable', connector.id, '--json'], 30_000).catch(() => undefined);
	await runGety(exe, ['connector', 'restart', connector.id, '--json'], 30_000).catch(() => undefined);
	await runGety(exe, ['connector', 'poll', connector.id, '--json'], 30_000).catch(() => undefined);
	return collectState(runtime, true);
}

async function saveWorkspaces(runtime, body) {
	const workspaces = readWorkspaces(runtime.dshHome);
	const requested = body.workspaces;
	let next;
	if (requested === null) {
		next = null;
	} else if (Array.isArray(requested)) {
		const known = new Set(workspaces.map((workspace) => workspace.id));
		if (!requested.every((entry) => typeof entry === 'string')) throw new Error('工作区 ID 必须是字符串');
		const ids = requested
			.map((entry) => entry.trim())
			.filter((entry) => entry !== '');
		for (const id of ids) {
			if (!known.has(id)) throw new Error(`未知工作区：${id}`);
		}
		next = [...new Set(ids)];
	} else {
		throw new Error('workspaces 必须是字符串数组或 null');
	}
	writeShareConfig(runtime.configPath, next);
	await pollIfInstalled(runtime);
	return collectState(runtime, true);
}

async function syncNow(runtime) {
	const exe = resolveGetyExe();
	if (!existsSync(exe)) throw new Error('找不到 GetY，请先启动 GetY。');
	const connector = await findConnector(runtime, exe);
	if (connector === null) throw new Error('连接器尚未安装，请先点击“连接 GetY”。');
	await runGety(exe, ['connector', 'poll', connector.id, '--json'], 30_000);
	return collectState(runtime, true);
}

async function pollIfInstalled(runtime) {
	const exe = resolveGetyExe();
	if (!existsSync(exe)) return;
	const connector = await findConnector(runtime, exe).catch(() => null);
	if (connector === null) return;
	await runGety(exe, ['connector', 'poll', connector.id, '--json'], 30_000).catch(() => undefined);
}

async function getyStatus(runtime, force) {
	const exe = resolveGetyExe();
	const exeExists = existsSync(exe);
	if (!force && Date.now() - runtime.statusCache.at < 5_000 && runtime.statusCache.value !== null) {
		return runtime.statusCache.value;
	}
	if (!exeExists) {
		const value = { exe: null, running: false, version: null, error: '未找到 GetY', connector: null };
		runtime.statusCache = { at: Date.now(), value };
		return value;
	}
	let running = false;
	let version = null;
	let error = null;
	try {
		const result = await runGety(exe, ['--version'], 10_000);
		version = result.stdout.trim().split(/\r?\n/)[0] || null;
	} catch {
		version = null;
	}
	let connector = null;
	try {
		connector = await findConnector(runtime, exe);
		running = true;
	} catch (cause) {
		error = message(cause);
	}
	const value = { exe, running, version, error, connector };
	runtime.statusCache = { at: Date.now(), value };
	return value;
}

async function findConnector(runtime, exe) {
	const result = await runGety(exe, ['connector', 'list', '--json', '--kind', 'all'], 30_000);
	const list = parseJson(result.stdout);
	if (!Array.isArray(list)) throw new Error('GetY 返回的连接器列表不是 JSON 数组');
	const match = list.find((entry) => entry?.type_key === CONNECTOR_MANIFEST_ID) ?? null;
	if (match === null) return null;
	try {
		const detail = await runGety(exe, ['connector', 'show', match.id, '--json'], 30_000);
		const shown = parseJson(detail.stdout);
		return shown !== null ? { ...match, ...shown } : match;
	} catch {
		return match;
	}
}

function runGety(exe, args, timeout) {
	return new Promise((resolvePromise, rejectPromise) => {
		execFile(
			exe,
			args,
			{ windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
			(error, stdout, stderr) => {
				if (error !== null) {
					const detail = [stderr, stdout].map((value) => value?.trim()).filter(Boolean).join('\n');
					rejectPromise(new Error(detail || error.message));
					return;
				}
				resolvePromise({ stdout, stderr });
			},
		);
	});
}

function parseJson(text) {
	if (typeof text !== 'string') return null;
	const trimmed = text.trim();
	if (trimmed === '') return null;
	try {
		return JSON.parse(trimmed);
	} catch {
		// The CLI can prepend diagnostics; parse the first JSON document.
		const starts = [trimmed.indexOf('['), trimmed.indexOf('{')].filter((index) => index >= 0).sort((a, b) => a - b);
		for (const start of starts) {
			for (let end = trimmed.length; end > start; end -= 1) {
				const candidate = trimmed.slice(start, end);
				try {
					return JSON.parse(candidate);
				} catch {
					// keep shrinking
				}
			}
		}
		return null;
	}
}

function readWorkspaces(dshHome) {
	const path = join(dshHome, 'storages', 'workspace.json');
	let raw;
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return [];
	}
	const table = raw?.tables?.workspaces;
	if (table === null || typeof table !== 'object') return [];
	const workspaces = [];
	for (const [id, value] of Object.entries(table)) {
		if (value === null || typeof value !== 'object' || typeof value.path !== 'string') continue;
		const sessionIds = Array.isArray(value.sessionIds)
			? value.sessionIds.filter((entry) => typeof entry === 'string')
			: [];
		workspaces.push({
			id,
			path: value.path,
			title: typeof value.title === 'string' && value.title !== '' ? value.title : baseName(value.path),
			sessionIds,
		});
	}
	workspaces.sort((left, right) => left.title.localeCompare(right.title));
	return workspaces;
}

function readShareConfig(configPath) {
	try {
		const raw = JSON.parse(readFileSync(configPath, 'utf8'));
		if (raw === null || typeof raw !== 'object' || !(raw.workspaces === null ||
			(Array.isArray(raw.workspaces) && raw.workspaces.every((entry) => typeof entry === 'string')))) {
			throw new Error('工作区分享配置无效，请检查 gety-connector.json。');
		}
		return {
			workspaces: Array.isArray(raw.workspaces)
				? raw.workspaces.filter((entry) => typeof entry === 'string')
				: null,
			updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
		};
	} catch (error) {
		if (error?.code === 'ENOENT') return { workspaces: null, updatedAt: null };
		throw error;
	}
}

function writeShareConfig(configPath, workspaces) {
	mkdirSync(dirname(configPath), { recursive: true });
	const temporaryPath = `${configPath}.${process.pid}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify({
			version: 1,
			workspaces,
			updatedAt: new Date().toISOString(),
		}, null, 2)}\n`, 'utf8');
		renameSync(temporaryPath, configPath);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

function ensureDefaultConfig(runtime) {
	if (existsSync(runtime.configPath)) return;
	writeShareConfig(runtime.configPath, null);
}

function syncConnectorSource(runtime) {
	const source = runtime.packageConnectorDir;
	if (!existsSync(join(source, 'manifest.json')) || !existsSync(join(source, 'dist', 'main.js'))) {
		throw new Error(`插件内置连接器不完整：${source}`);
	}
	const destination = runtime.installDir;
	if (destination !== runtime.dshHome && !destination.startsWith(`${runtime.dshHome}${sep}`)) {
		throw new Error(`拒绝写入非 DSH 目录：${destination}`);
	}
	const sourceVersion = readConnectorVersion(source);
	const destinationVersion = readConnectorVersion(destination);
	const sourceHash = connectorFingerprint(source);
	const destinationHash = connectorFingerprint(destination);
	if (
		destinationVersion === sourceVersion &&
		destinationHash !== null &&
		destinationHash === sourceHash &&
		existsSync(join(destination, 'dist', 'main.js'))
	) return;
	mkdirSync(dirname(destination), { recursive: true });
	if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
	cpSync(source, destination, { recursive: true });
}

function connectorFingerprint(directory) {
	try {
		const hash = createHash('sha256');
		hash.update(readFileSync(join(directory, 'manifest.json')));
		hash.update(readFileSync(join(directory, 'dist', 'main.js')));
		return hash.digest('hex');
	} catch {
		return null;
	}
}

function readConnectorVersion(directory) {
	try {
		const raw = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
		return typeof raw.version === 'string' ? raw.version : null;
	} catch {
		return null;
	}
}

function mcpConfigured(dshHome) {
	const candidates = [
		join(dshHome, 'cordis.patch.yml'),
		join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'),
	];
	for (const path of candidates) {
		try {
			const text = readFileSync(path, 'utf8');
			if (text.includes('serverName: gety') || text.includes('serverName: "gety"')) return true;
		} catch {
			// absent patch file
		}
	}
	return false;
}

async function readBody(request) {
	const value = await request.json();
	if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求必须是 JSON 对象');
	return value;
}

function json(value, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
		},
	});
}

function message(error) {
	return error instanceof Error ? error.message : String(error);
}

function baseName(path) {
	const segments = path.split(/[\\/]/).filter(Boolean);
	return segments.length === 0 ? path : segments[segments.length - 1];
}

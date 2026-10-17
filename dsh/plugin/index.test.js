import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from './index.js';

test('workspace API rejects malformed requests and preserves the saved selection', async () => {
	const home = mkdtempSync(join(tmpdir(), 'dsh-gety-test-'));
	const previousHome = process.env.DSH_HOME;
	const previousGety = process.env.GETY_EXE;
	process.env.DSH_HOME = home;
	process.env.GETY_EXE = join(home, 'missing-gety.exe');
	try {
		mkdirSync(join(home, 'storages'));
		writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: {} } }));
		const path = join(home, 'gety-connector.json');
		writeFileSync(path, JSON.stringify({ version: 1, workspaces: [] }));
		const routes = new Map();
		apply({ connection: { fetch: { register(route) { routes.set(route.path, route.fetch); } } } });
		const save = routes.get('/api/gety/workspaces');
		for (const body of ['{', '{}', '[]', '{"workspaces":[42]}']) {
			const response = await save(new Request('http://localhost/api/gety/workspaces', { method: 'POST', body }));
			assert.equal(response.status, 400);
			assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).workspaces, []);
		}
		const response = await save(new Request('http://localhost/api/gety/workspaces', { method: 'POST', body: '{"workspaces":null}' }));
		assert.equal(response.status, 200, await response.text());
		assert.equal(JSON.parse(readFileSync(path, 'utf8')).workspaces, null);
		assert.equal(readdirSync(home).some((name) => name.endsWith('.tmp')), false);
		writeFileSync(path, '{');
		await assert.rejects(routes.get('/api/gety/state')());
	} finally {
		if (previousHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previousHome;
		if (previousGety === undefined) delete process.env.GETY_EXE;
		else process.env.GETY_EXE = previousGety;
		rmSync(home, { recursive: true, force: true });
	}
});

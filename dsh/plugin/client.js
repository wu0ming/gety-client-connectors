window.__ModuleLoader__.load({
	id: '@local/dsh-gety-connector',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		let React = require('react');

		const NS = 'gety.connector';

		const en = {
			title: 'GetY connector',
			description: 'Search your DeepSeek Harness sessions from GetY, and choose which workspaces GetY may index.',
			summary: 'Shares DSH session history with GetY.',
			status: 'Connection',
			gety: 'GetY',
			getyRunning: 'Running',
			getyStopped: 'Not reachable',
			getyMissing: 'Not installed',
			mcp: 'GetY tools in DSH',
			mcpOn: 'Connected',
			mcpOff: 'Not configured',
			connector: 'Session connector',
			connectorOn: 'Installed',
			connectorOff: 'Not installed',
			documents: 'Indexed sessions',
			lastSync: 'Last update',
			connect: 'Connect GetY',
			connecting: 'Connecting…',
			sync: 'Sync now',
			syncing: 'Syncing…',
			refresh: 'Refresh',
			workspaces: 'Shared workspaces',
			workspacesHint: 'Choose which DSH workspaces GetY may index. All workspaces are selected by default.',
			all: 'All workspaces',
			sessions: 'sessions',
			save: 'Save selection',
			saving: 'Saving…',
			saved: 'Selection saved. GetY will refresh the index shortly.',
			connected: 'GetY is connected.',
			loadFailed: 'Could not read the GetY state.',
			actionFailed: 'The action failed.',
			empty: 'No workspaces yet. Start a session in DSH first.',
			unknown: 'Unknown',
		};

		const zh = {
			title: 'GetY 连接器',
			description: '让 GetY 搜索 DeepSeek Harness 的会话历史，并选择要分享的工作区。',
			summary: '把 DSH 会话历史分享给 GetY。',
			status: '连接状态',
			gety: 'GetY',
			getyRunning: '运行中',
			getyStopped: '未连接',
			getyMissing: '未安装',
			mcp: 'DSH 中的 GetY 工具',
			mcpOn: '已连接',
			mcpOff: '未配置',
			connector: '会话连接器',
			connectorOn: '已安装',
			connectorOff: '未安装',
			documents: '已索引会话',
			lastSync: '最近更新',
			connect: '连接 GetY',
			connecting: '连接中…',
			sync: '立即同步',
			syncing: '同步中…',
			refresh: '刷新',
			workspaces: '分享工作区',
			workspacesHint: '选择允许 GetY 索引的 DSH 工作区。默认全选。',
			all: '全部工作区',
			sessions: '个会话',
			save: '保存选择',
			saving: '保存中…',
			saved: '已保存，GetY 会很快刷新索引。',
			connected: 'GetY 已连接。',
			loadFailed: '读取 GetY 状态失败。',
			actionFailed: '操作失败。',
			empty: '还没有工作区。请先在 DSH 中开始一个会话。',
			unknown: '未知',
		};

		const inject = ['slots', 'locale'];

		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'gety-connector: dictionaries');
			ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
				name: 'plugins.bundle.config',
				key: '@local/dsh-gety-connector',
				locale: NS,
				inject: () => ({ t }),
			}, GetYConfig)), 'gety-connector: config page');
		}

		function GetYConfig(props) {
			const t = props.t ?? ((key) => key);
			if (props.view === 'summary') return t('summary');

			const [state, setState] = React.useState(null);
			const [loading, setLoading] = React.useState(true);
			const [busy, setBusy] = React.useState('');
			const [error, setError] = React.useState(null);
			const [notice, setNotice] = React.useState(null);
			const [allSelected, setAllSelected] = React.useState(true);
			const [selected, setSelected] = React.useState(() => new Set());

			const applyState = React.useCallback((next) => {
				setState(next);
				if (next === null || !Array.isArray(next.workspaces)) return;
				setAllSelected(next.allSelected !== false);
				setSelected(new Set(next.workspaces.filter((workspace) => workspace.selected).map((workspace) => workspace.id)));
			}, []);

			const load = React.useCallback(async () => {
				setLoading(true);
				setError(null);
				try {
					const response = await fetch('/api/gety/state', { credentials: 'same-origin', cache: 'no-store' });
					const data = await response.json();
					if (!response.ok || data.ok === false) throw new Error(data.error || t('loadFailed'));
					applyState(data);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setLoading(false);
				}
			}, [applyState, t]);

			React.useEffect(() => {
				load();
			}, [load]);

			const run = React.useCallback(async (name, path) => {
				setBusy(name);
				setError(null);
				setNotice(null);
				try {
					const response = await fetch(path, {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({}),
					});
					const data = await response.json();
					if (!response.ok || data.ok === false) throw new Error(data.error || t('actionFailed'));
					applyState(data);
					return true;
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
					return false;
				} finally {
					setBusy('');
				}
			}, [applyState, t]);

			const connect = React.useCallback(async () => {
				const ok = await run('connect', '/api/gety/connect');
				if (ok) setNotice(t('connected'));
			}, [run, t]);

			const sync = React.useCallback(async () => {
				await run('sync', '/api/gety/sync');
			}, [run]);

			const save = React.useCallback(async () => {
				setBusy('save');
				setError(null);
				setNotice(null);
				try {
					const response = await fetch('/api/gety/workspaces', {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ workspaces: allSelected ? null : [...selected] }),
					});
					const data = await response.json();
					if (!response.ok || data.ok === false) throw new Error(data.error || t('actionFailed'));
					applyState(data);
					setNotice(t('saved'));
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setBusy('');
				}
			}, [allSelected, applyState, selected, t]);

			if (loading && state === null) {
				return React.createElement('p', { style: muted() }, t('status'));
			}
			if (state === null) {
				return React.createElement('p', { style: { ...muted(), color: '#dc2626' } }, error || t('loadFailed'));
			}

			const gety = state.gety ?? {};
			const connector = gety.connector ?? null;
			const workspaces = Array.isArray(state.workspaces) ? state.workspaces : [];
			const activeWorkspaces = allSelected ? workspaces.length : selected.size;

			return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px', color: 'var(--dsh-text-primary, #111827)' } },
				React.createElement('section', { style: panel() },
					React.createElement('h3', { style: heading() }, t('title')),
					React.createElement('p', { style: muted() }, t('description')),
					React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' } },
						statusRow(t('gety'), gety.installed === false ? t('getyMissing') : gety.running ? t('getyRunning') : t('getyStopped'), gety.installed === false ? 'gray' : gety.running ? 'green' : 'red'),
						statusRow(t('mcp'), state.mcpConfigured ? t('mcpOn') : t('mcpOff'), state.mcpConfigured ? 'green' : 'gray'),
						statusRow(t('connector'), connector ? t('connectorOn') : t('connectorOff'), connector ? 'green' : 'gray'),
						statusRow(t('documents'), connector ? String(connector.docCount ?? 0) : '0', connector ? 'green' : 'gray'),
						connector && connector.lastUpdate ? statusRow(t('lastSync'), formatTime(connector.lastUpdate), 'green') : null,
					),
					gety.error ? React.createElement('p', { style: { ...muted(), color: '#d97706', whiteSpace: 'pre-wrap' } }, gety.error) : null,
					React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '6px' } },
						button(t('connect'), connect, busy === 'connect', t('connecting'), true),
						button(t('sync'), sync, busy === 'sync', t('syncing'), false, !connector),
						button(t('refresh'), load, false, '', false, false),
					),
				),
				React.createElement('section', { style: panel() },
					React.createElement('h3', { style: heading() }, t('workspaces')),
					React.createElement('p', { style: muted() }, t('workspacesHint')),
					React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, margin: '4px 0' } },
						React.createElement('input', {
							type: 'checkbox',
							checked: allSelected,
							onChange: (event) => {
								const next = event.target.checked;
								setAllSelected(next);
								setSelected(next ? new Set(workspaces.map((workspace) => workspace.id)) : new Set());
							},
						}),
						t('all'),
						React.createElement('span', { style: { ...muted(), fontWeight: 400 } }, `(${activeWorkspaces}/${workspaces.length})`),
					),
					workspaces.length === 0 ? React.createElement('p', { style: muted() }, t('empty')) : null,
					React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
						workspaces.map((workspace) => React.createElement('label', {
							key: workspace.id,
							style: { display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '7px 8px', borderRadius: '8px', background: 'var(--dsh-surface-raised, rgba(127,127,127,0.06))' },
						},
							React.createElement('input', {
								type: 'checkbox',
								style: { marginTop: '2px' },
								checked: allSelected || selected.has(workspace.id),
								onChange: (event) => {
									const next = new Set(selected);
									if (event.target.checked) next.add(workspace.id);
									else next.delete(workspace.id);
									setSelected(next);
									setAllSelected(false);
								},
							}),
							React.createElement('span', { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
								React.createElement('span', { style: { fontWeight: 600 } }, workspace.title || workspace.id),
								React.createElement('code', { style: { fontSize: '12px', opacity: 0.72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, workspace.path),
								React.createElement('span', { style: { ...muted(), fontSize: '12px' } }, `${workspace.sessionCount} ${t('sessions')}`),
							),
						)),
					),
					React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' } },
						button(t('save'), save, busy === 'save', t('saving'), true),
					),
				),
				error ? React.createElement('p', { style: { color: '#dc2626', whiteSpace: 'pre-wrap' } }, error) : null,
				notice ? React.createElement('p', { style: { color: '#15803d' } }, notice) : null,
			);
		}

		function statusRow(label, value, tone) {
			const colors = { green: '#16a34a', red: '#dc2626', gray: '#9ca3af' };
			return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' } },
				React.createElement('span', { style: { ...muted(), fontSize: '13px' } }, label),
				React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 600 } },
					React.createElement('span', { style: { width: '7px', height: '7px', borderRadius: '50%', background: colors[tone] || colors.gray } }),
					value,
				),
			);
		}

		function button(label, onClick, busy, busyLabel, primary, disabled) {
			return React.createElement('button', {
				type: 'button',
				onClick,
				disabled: busy || disabled === true,
				style: {
					border: primary ? '1px solid transparent' : '1px solid var(--dsh-border, rgba(0,0,0,0.14))',
					background: primary ? 'var(--dsh-accent, #2563eb)' : 'transparent',
					color: primary ? '#ffffff' : 'inherit',
					borderRadius: '8px',
					padding: '7px 13px',
					fontSize: '13px',
					fontWeight: 600,
					cursor: busy || disabled === true ? 'default' : 'pointer',
					opacity: busy || disabled === true ? 0.55 : 1,
				},
			}, busy ? busyLabel : label);
		}

		function panel() {
			return {
				border: '1px solid var(--dsh-border, rgba(0,0,0,0.12))',
				borderRadius: '12px',
				padding: '16px',
				background: 'var(--dsh-surface, transparent)',
			};
		}

		function heading() {
			return { margin: '0 0 4px', fontSize: '15px', fontWeight: 700 };
		}

		function muted() {
			return { margin: 0, color: 'var(--dsh-text-secondary, #6b7280)', fontSize: '13px', lineHeight: 1.5 };
		}

		function formatTime(value) {
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return String(value);
			return date.toLocaleString();
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});

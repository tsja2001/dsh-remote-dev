/**
 * dsh-remote-ssh browser half — packaged web-client module contract.
 *
 * A profile bundle's client.js arrives as a CLASSIC script fetched by the
 * web shell: it must register itself through
 * window.__ModuleLoader__.load({ id: <package name>, factory }) instead of
 * using ESM exports — an export statement is a SyntaxError in a classic
 * script and aborts the whole page's plugin boot. The factory runs once at
 * materialization, receives the synchronous require (shell seed words:
 * 'react', 'react/jsx-runtime', 'react-dom', ...) and returns the cordis
 * client plugin module ({ name, inject, apply }); CSS side effects belong
 * inside the factory closure so the module system can claim the style tag.
 *
 * UI: a Remote Connections settings section talking to the Host half
 * (index.js) through the /dsh-remote/api/* HTTP bridge, with the
 * dynamic-plugin host RPC bridge used when that runtime provides it.
 * Styling rides the shell's --dsw-alias-* design tokens so both color
 * schemes render correctly; copy is bilingual (zh/en) and follows the
 * shell locale when the service is present.
 *
 * @module @tsja/dsh-remote-ssh/client
 */

window.__ModuleLoader__.load({
	id: '@tsja/dsh-remote-ssh',
	factory: (require) => {
		const React = require('react')
		const { useState, useEffect, useRef, useCallback } = React
		const useSES = React.useSyncExternalStore
		const h = React.createElement

		/* i18n — flat dictionaries; active language in a subscribable store */

		const DICT = {
			zh: {
				nav: '远程连接', title: 'SSH 远程连接',
				intro: '配置通过 SSH 访问的远程设备（密码或密钥认证），连接后即可在会话中用 remote_exec / remote_read / remote_write / remote_list 工具操作远端。',
				name: '名称', namePh: '留空自动使用 user@host',
				host: '主机 / IP', hostPh: '192.168.1.10 或 example.com',
				port: '端口', user: '用户名', auth: '认证方式',
				authPassword: '密码认证', authKey: '密钥认证',
				password: '密码', passwordKeepPh: '留空保持原密码',
				keyPath: '密钥路径', keyPathPh: '~/.ssh/id_ed25519',
				passphrase: '密钥口令', passphrasePh: '无口令可留空', passphraseKeepPh: '留空保持原口令',
				bindPath: '绑定目录（可选）', bindPathPh: '/srv/app', browse: '浏览…',
				test: '测试连接', testing: '测试中…',
				save: '添加连接', saveEdit: '保存修改', saving: '保存中…', cancel: '取消', refresh: '刷新', edit: '编辑',
				connect: '连接', connecting: '连接中…', disconnect: '断开',
				del: '删除', confirmDelete: '确认删除？',
				connected: '已连接', disconnected: '未连接', dropped: '已断开',
				fingerprint: '主机指纹', resetFp: '重置指纹', lastError: '最近错误',
				emptyTitle: '还没有远程连接',
				emptyDesc: '添加一台设备的 SSH 连接信息（IP/端口/账户 + 密码或密钥），连接后即可在会话中操作远端文件与命令。',
				emptyCta: '添加第一个连接',
				cmdTitle: '命令测试', cmdPh: 'echo hello', cmdRun: '执行', exit: '退出码',
				pickTitle: '选择远程目录', pickSelect: '选择此目录', pickCancel: '取消',
				pickUp: '上一级', pickHome: '主目录', pickLoading: '读取目录…', pickEmpty: '（空目录）',
				errRequired: '此项必填', errPort: '端口需为 1–65535',
				errNeedPassword: '密码认证需要填写密码', errNeedKey: '密钥认证需要密钥路径',
				errForm: '请先修正表单中标红的字段',
				toastSaved: '已保存 {name}', toastDeleted: '已删除 {name}',
				toastConnected: '{name} 已连接', toastDisconnected: '{name} 已断开',
				toastTestOk: '{name} 测试通过', toastTestFail: '{name} 测试未通过',
				toastFpReset: '已重置主机指纹，下次连接将重新记录',
				storage: '凭据存储', storageCredentials: 'DSH 凭据库', storageFile: '本地文件 (0600)',
				probeOk: '连接成功', probeLatency: '延迟',
				authPasswordBadge: '密码', authKeyBadge: '密钥',
				noBridge: '当前运行环境没有可用的 RPC 桥——请以插件方式安装后重试。',
				profilesAt: '配置文件：~/.dsh/remote/profiles.json',
				dir: '目录', remoteRef: '会话内引用', copied: '已复制',
				wflowRemoteChip: '选择远程机器上的目录…', wflowBack: '← 本机目录',
				wflowMachines: '远程机器', wflowNoProfiles: '还没有配置远程连接——到 设置 → 远程连接 添加一台设备。',
				wflowConnecting: '正在连接 {name}…', wflowChoose: '选择此目录',
				wflowBound: '已绑定远程工作目录：{ref}',
				wflowHint: '远程目录将成为会话的远程开发上下文：remote_* 工具的相对路径与 remote_exec 的默认目录都会指向它。',
				wflowLocalFallback: '当前组合没有提供本机目录浏览对话框。可以直接输入本机目录的绝对路径：',
				wflowOpenPath: '打开', wflowErrPath: '请输入以 / 开头的绝对路径',
				wflowBoundDir: '已绑定', wflowPickOne: '选择左侧的机器开始浏览',
			},
			en: {
				nav: 'Remote Connections', title: 'SSH Remote Connections',
				intro: 'Configure devices reachable over SSH (password or key auth). Once connected, the remote_exec / remote_read / remote_write / remote_list tools operate on the remote machine in your sessions.',
				name: 'Name', namePh: 'defaults to user@host',
				host: 'Host / IP', hostPh: '192.168.1.10 or example.com',
				port: 'Port', user: 'Username', auth: 'Authentication',
				authPassword: 'Password', authKey: 'Private key',
				password: 'Password', passwordKeepPh: 'blank keeps the stored password',
				keyPath: 'Key path', keyPathPh: '~/.ssh/id_ed25519',
				passphrase: 'Passphrase', passphrasePh: 'leave blank if none', passphraseKeepPh: 'blank keeps the stored passphrase',
				bindPath: 'Bound directory (optional)', bindPathPh: '/srv/app', browse: 'Browse…',
				test: 'Test connection', testing: 'Testing…',
				save: 'Add connection', saveEdit: 'Save changes', saving: 'Saving…', cancel: 'Cancel', refresh: 'Refresh', edit: 'Edit',
				connect: 'Connect', connecting: 'Connecting…', disconnect: 'Disconnect',
				del: 'Delete', confirmDelete: 'Confirm delete?',
				connected: 'connected', disconnected: 'disconnected', dropped: 'dropped',
				fingerprint: 'Host fingerprint', resetFp: 'Reset fingerprint', lastError: 'Last error',
				emptyTitle: 'No remote connections yet',
				emptyDesc: 'Add a device (IP/port/account + password or key) to operate its files and commands from your sessions.',
				emptyCta: 'Add your first connection',
				cmdTitle: 'Command test', cmdPh: 'echo hello', cmdRun: 'Run', exit: 'exit code',
				pickTitle: 'Choose a remote directory', pickSelect: 'Choose this directory', pickCancel: 'Cancel',
				pickUp: 'Up one level', pickHome: 'Home', pickLoading: 'Reading directory…', pickEmpty: '(empty directory)',
				errRequired: 'Required', errPort: 'Port must be 1–65535',
				errNeedPassword: 'Password auth needs a password', errNeedKey: 'Key auth needs a key path',
				errForm: 'Fix the highlighted fields first',
				toastSaved: 'Saved {name}', toastDeleted: 'Deleted {name}',
				toastConnected: '{name} connected', toastDisconnected: '{name} disconnected',
				toastTestOk: '{name} passed the connection test', toastTestFail: '{name} failed the connection test',
				toastFpReset: 'Host fingerprint reset; the next connect records it again',
				storage: 'Secret storage', storageCredentials: 'DSH credential store', storageFile: 'Local file (0600)',
				probeOk: 'Connection succeeded', probeLatency: 'latency',
				authPasswordBadge: 'password', authKeyBadge: 'key',
				noBridge: 'No RPC bridge available in this runtime — install as a plugin and retry.',
				profilesAt: 'Config file: ~/.dsh/remote/profiles.json',
				dir: 'dir', remoteRef: 'Session reference', copied: 'Copied',
				wflowRemoteChip: 'Pick a directory on a remote machine…', wflowBack: '← Local directory',
				wflowMachines: 'Remote machines', wflowNoProfiles: 'No remote connections yet — add one under Settings → Remote Connections.',
				wflowConnecting: 'Connecting to {name}…', wflowChoose: 'Choose this directory',
				wflowBound: 'Bound remote working directory: {ref}',
				wflowHint: 'The remote directory becomes the session remote working context: relative paths of the remote_* tools and remote_exec default to it.',
				wflowLocalFallback: 'This composition provides no local directory dialog. Enter an absolute local directory path instead:',
				wflowOpenPath: 'Open', wflowErrPath: 'Enter an absolute path starting with /',
				wflowBoundDir: 'bound', wflowPickOne: 'Pick a machine on the left to start browsing',
			},
		}

		const langStore = (() => {
			let lang = String(navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
			const listeners = new Set()
			return {
				get: () => lang,
				set(next) {
					if (next === lang) return
					lang = next
					for (const fn of listeners) fn()
				},
				subscribe(fn) {
					listeners.add(fn)
					return () => listeners.delete(fn)
				},
			}
		})()

		function tr(lang, key, vars) {
			let s = DICT[lang] && DICT[lang][key] != null ? DICT[lang][key] : (DICT.zh[key] != null ? DICT.zh[key] : key)
			if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]))
			return s
		}

		function useLang() {
			if (useSES) return useSES(langStore.subscribe, langStore.get)
			const [v, setV] = useState(langStore.get())
			useEffect(() => langStore.subscribe(() => setV(langStore.get())), [])
			return v
		}

		/* Styles — shell design tokens only, both color schemes */

		const CSS = [
'\n.dsh-remote-page { display: flex; flex-direction: column; gap: 16px; padding: 4px 2px; font-size: 13px;',
'  color: var(--dsw-alias-label-primary); }',
'\n.dsh-remote-page h2 { margin: 0 0 2px; font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary); }',
'\n.dsh-remote-intro { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); max-width: 72ch; }',
'\n.dsh-remote-storage { display: inline-flex; align-items: center; gap: 6px; font-size: 11px;',
'  color: var(--dsw-alias-label-caption); }',
'\n.dsh-remote-storage .dot { width: 6px; height: 6px; border-radius: 999px; background: var(--dsw-alias-state-success-primary); }',

'\n.dsh-remote-form { display: flex; flex-direction: column; gap: 10px; padding: 14px;',
'  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; }',
'\n.dsh-remote-form-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }',
'\n.dsh-remote-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px 12px; }',
'\n.dsh-remote-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }',
'\n.dsh-remote-field > label { font-size: 12px; color: var(--dsw-alias-label-secondary); }',
'\n.dsh-remote-input, .dsh-remote-select { padding: 6px 10px; border-radius: 8px; width: 100%; box-sizing: border-box;',
'  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);',
'  color: var(--dsw-alias-label-primary); font-size: 13px; }',
'\n.dsh-remote-input:focus, .dsh-remote-select:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }',
'\n.dsh-remote-field.invalid .dsh-remote-input { border-color: var(--dsw-alias-state-error-primary); }',
'\n.dsh-remote-field-error { font-size: 11px; color: var(--dsw-alias-state-error-primary); }',
'\n.dsh-remote-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
'\n.dsh-remote-pw { position: relative; display: flex; }',
'\n.dsh-remote-pw .dsh-remote-input { padding-right: 32px; }',
'\n.dsh-remote-eye { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); border: 0; background: none;',
'  cursor: pointer; font-size: 13px; line-height: 1; padding: 4px 6px; border-radius: 6px; color: var(--dsw-alias-label-secondary); }',
'\n.dsh-remote-eye:hover { background: var(--dsw-alias-interactive-bg-hover); }',
'\n.dsh-remote-seg { display: inline-flex; gap: 4px; padding: 3px; border-radius: 9px; width: fit-content;',
'  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); }',
'\n.dsh-remote-seg button { border: 0; background: none; padding: 5px 14px; border-radius: 6px; cursor: pointer;',
'  font-size: 12px; color: var(--dsw-alias-label-secondary); }',
'\n.dsh-remote-seg button[aria-pressed="true"] { background: var(--dsw-alias-state-business-primary);',
'  color: var(--dsw-alias-label-primary-inverted, #fff); }',
'\n.dsh-remote-bindrow { display: flex; gap: 6px; align-items: flex-end; }',
'\n.dsh-remote-bindrow .dsh-remote-field { flex: 1; }',

'\n.dsh-remote-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }',
'\n.dsh-remote-btn { padding: 6px 14px; border-radius: 8px; cursor: pointer; font-size: 12px;',
'  border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); }',
'\n.dsh-remote-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }',
'\n.dsh-remote-btn:disabled { opacity: 0.45; cursor: default; }',
'\n.dsh-remote-btn.primary { background: var(--dsw-alias-state-business-primary); border-color: transparent;',
'  color: var(--dsw-alias-label-primary-inverted, #fff); }',
'\n.dsh-remote-btn.primary:hover:not(:disabled) { opacity: 0.9; }',
'\n.dsh-remote-btn.danger-armed { border-color: var(--dsw-alias-state-error-primary);',
'  color: var(--dsw-alias-state-error-primary); }',
'\n.dsh-remote-btn.small { padding: 4px 10px; font-size: 11px; border-radius: 7px; }',

'\n.dsh-remote-probe { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 8px;',
'  font-size: 12px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }',
'\n.dsh-remote-probe.ok { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent); }',
'\n.dsh-remote-probe.fail { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); }',
'\n.dsh-remote-probe .fp { font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all;',
'  color: var(--dsw-alias-label-secondary); }',

'\n.dsh-remote-cards { display: flex; flex-direction: column; gap: 8px; }',
'\n.dsh-remote-card { display: flex; gap: 12px; justify-content: space-between; align-items: center; padding: 12px 14px;',
'  border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); flex-wrap: wrap; }',
'\n.dsh-remote-card:hover { background: var(--dsw-alias-interactive-bg-hover); }',
'\n.dsh-remote-card-main { display: flex; flex-direction: column; gap: 3px; min-width: 220px; flex: 1; }',
'\n.dsh-remote-card-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-weight: 600; }',
'\n.dsh-remote-dot { width: 8px; height: 8px; border-radius: 999px; flex: none; }',
'\n.dsh-remote-dot.st-connected { background: var(--dsw-alias-state-success-primary); }',
'\n.dsh-remote-dot.st-warn { background: var(--dsw-alias-state-warn-primary); }',
'\n.dsh-remote-dot.st-off { background: var(--dsw-alias-label-caption); }',
'\n.dsh-remote-badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; font-weight: 400;',
'  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }',
'\n.dsh-remote-badge.status-on { color: var(--dsw-alias-state-success-primary);',
'  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent); }',
'\n.dsh-remote-badge.status-warn { color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary));',
'  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent); }',
'\n.dsh-remote-card-sub { font-size: 12px; color: var(--dsw-alias-label-tertiary); word-break: break-all; }',
'\n.dsh-remote-card-err { font-size: 12px; color: var(--dsw-alias-state-error-primary); }',
'\n.dsh-remote-fp { font-family: ui-monospace, monospace; font-size: 11px; color: var(--dsw-alias-label-caption); }',
'\n.dsh-remote-card-actions { display: flex; gap: 6px; flex-wrap: wrap; }',

'\n.dsh-remote-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 36px 16px;',
'  border: 1px dashed var(--dsw-alias-border-l2); border-radius: 12px; color: var(--dsh-alias-label-tertiary); }',
'\n.dsh-remote-empty .big { font-size: 28px; }',
'\n.dsh-remote-empty b { color: var(--dsw-alias-label-secondary); }',

'\n.dsh-remote-cmd { display: flex; flex-direction: column; gap: 8px; padding: 14px;',
'  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; }',
'\n.dsh-remote-cmd-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }',
'\n.dsh-remote-cmd-row input { flex: 1; min-width: 200px; }',
'\n.dsh-remote-out { font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all;',
'  background: var(--dsw-alias-markdown-code-block); border-radius: 8px; padding: 10px; max-height: 260px; overflow: auto; }',
'\n.dsh-remote-out .stderr { color: var(--dsw-alias-state-error-primary); }',
'\n.dsh-remote-exit { font-size: 11px; padding: 1px 8px; border-radius: 999px; align-self: flex-start;',
'  background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }',
'\n.dsh-remote-exit.nonzero { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent);',
'  color: var(--dsw-alias-state-error-primary); }',

'\n.dsh-remote-modal-backdrop { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center;',
'  justify-content: center; background: color-mix(in srgb, var(--dsw-alias-bg-base) 62%, transparent);',
'  backdrop-filter: blur(2px); }',
'\n.dsh-remote-modal { display: flex; flex-direction: column; width: min(620px, calc(100vw - 48px));',
'  max-height: min(560px, calc(100vh - 64px)); border-radius: 14px; overflow: hidden; outline: none;',
'  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);',
'  box-shadow: 0 18px 48px rgba(0,0,0,.28); }',
'\n.dsh-remote-modal-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; font-weight: 600;',
'  border-bottom: 1px solid var(--dsw-alias-border-l2); }',
'\n.dsh-remote-modal-head .grow { flex: 1; }',
'\n.dsh-remote-crumbs { display: flex; align-items: center; gap: 2px; padding: 8px 16px; font-size: 12px; flex-wrap: wrap;',
'  color: var(--dsw-alias-label-secondary); border-bottom: 1px solid var(--dsw-alias-border-l2); }',
'\n.dsh-remote-crumbs .crumb { cursor: pointer; padding: 2px 6px; border-radius: 6px; font-family: ui-monospace, monospace; }',
'\n.dsh-remote-crumbs .crumb:hover { background: var(--dsw-alias-interactive-bg-hover); }',
'\n.dsh-remote-crumbs .sep { color: var(--dsw-alias-label-caption); }',
'\n.dsh-remote-list { flex: 1; overflow: auto; padding: 6px 8px; }',
'\n.dsh-remote-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; cursor: pointer;',
'  font-size: 13px; }',
'\n.dsh-remote-item:hover { background: var(--dsw-alias-interactive-bg-hover); }',
'\n.dsh-remote-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
'\n.dsh-remote-item .meta { font-size: 11px; color: var(--dsw-alias-label-caption); font-family: ui-monospace, monospace; }',
'\n.dsh-remote-modal-foot { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 16px; flex-wrap: wrap;',
'  border-top: 1px solid var(--dsw-alias-border-l2); align-items: center; }',
'\n.dsh-remote-modal-foot .path { flex: 1; font-family: ui-monospace, monospace; font-size: 11px; min-width: 120px;',
'  color: var(--dsw-alias-label-tertiary); word-break: break-all; }',
'\n.dsh-remote-modal .hint { padding: 12px 16px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }',

'\n.dsh-remote-toasts { position: fixed; right: 18px; bottom: 18px; z-index: 1100; display: flex; flex-direction: column;',
'  gap: 8px; }',
'\n.dsh-remote-toast { padding: 9px 14px; border-radius: 10px; font-size: 12px; max-width: 380px; word-break: break-all;',
'  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-label-primary);',
'  border: 1px solid var(--dsw-alias-border-l2); box-shadow: 0 8px 24px rgba(0,0,0,.22); }',
'\n.dsh-remote-toast.ok { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 50%, transparent); }',
'\n.dsh-remote-toast.err { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 50%, transparent); }',

/* workspace directory flow (add-workspace picker) */
'.dsh-remote-wflow-chip { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 1300; }',
'.dsh-remote-wflow-chip button { display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px; border-radius: 999px;',
'  cursor: pointer; font-size: 12px; border: 1px solid var(--dsw-alias-border-l2);',
'  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); box-shadow: 0 6px 18px rgba(0,0,0,.18); }',
'.dsh-remote-wflow-chip button:hover { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-state-business-primary); }',
'.dsh-remote-modal.wflow { width: min(780px, calc(100vw - 40px)); }',
'.dsh-remote-wflow-body { display: flex; min-height: 0; flex: 1; border-bottom: 1px solid var(--dsw-alias-border-l2); }',
'.dsh-remote-wflow-machines { width: 224px; flex: none; overflow: auto; padding: 8px; border-right: 1px solid var(--dsw-alias-border-l2);',
'  display: flex; flex-direction: column; gap: 4px; }',
'.dsh-remote-wflow-machines .head { font-size: 11px; color: var(--dsw-alias-label-caption); padding: 2px 6px 6px; }',
'.dsh-remote-machine { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 10px; cursor: pointer;',
'  border: 1px solid transparent; }',
'.dsh-remote-machine:hover { background: var(--dsw-alias-interactive-bg-hover); }',
'.dsh-remote-machine.sel { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-state-business-primary); }',
'.dsh-remote-machine .row { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; }',
'.dsh-remote-machine .row .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
'.dsh-remote-machine .sub { font-size: 11px; color: var(--dsw-alias-label-tertiary); font-family: ui-monospace, monospace;',
'  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
'.dsh-remote-machine .bd { font-size: 10px; padding: 0 6px; border-radius: 999px; align-self: flex-start; margin-top: 2px;',
'  color: var(--dsw-alias-state-business-primary); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent); }',
'.dsh-remote-wflow-dirs { flex: 1; display: flex; flex-direction: column; min-width: 0; }',
'.dsh-remote-wflow-dirs .dsh-remote-list { flex: 1; }',
'.dsh-remote-item.disabled { opacity: 0.45; cursor: default; }',
'.dsh-remote-item.disabled:hover { background: none; }',
'.dsh-remote-wflow-foot-hint { flex: 1; min-width: 160px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-caption); }',
'@media (max-width: 640px) { .dsh-remote-wflow-body { flex-direction: column; }',
'  .dsh-remote-wflow-machines { width: auto; max-height: 132px; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }',
'  .dsh-remote-modal.wflow { width: calc(100vw - 24px); } }',
		].join('')

		// CSS side effect at materialization: the client module system claims
		// untagged style tags emitted while the factory runs.
		const styleEl = document.createElement('style')
		styleEl.textContent = CSS
		document.head.append(styleEl)

		/* Bridge + small helpers */

		async function httpCall(method, args) {
			const name = method === 'remote.list' ? 'profiles' : String(method).replace(/^remote\./, '')
			const res = await fetch('/dsh-remote/api/' + name, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(args || {}),
			})
			const data = await res.json().catch(() => ({}))
			if (!res.ok || data.ok === false) {
				const err = new Error(data.error || 'HTTP ' + res.status)
				if (data.classified) err.classified = data.classified
				throw err
			}
			return data
		}

		const cx = (...parts) => parts.filter(Boolean).join(' ')

		function errText(err, lang) {
			const c = err && err.classified
			if (c) return (lang === 'en' ? c.en || c.zh : c.zh || c.en) || ''
			return String((err && err.message) || err)
		}

		function fmtSize(n) {
			if (n == null) return ''
			if (n < 1024) return n + ' B'
			if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
			if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
			return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB'
		}

		function fmtMtime(sec) {
			if (!sec) return ''
			const d = new Date(sec * 1000)
			const pad = (x) => String(x).padStart(2, '0')
			return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
		}

		/* Toasts */

		let toastSeq = 0
		function ToastStack({ items }) {
			return h('div', { className: 'dsh-remote-toasts' },
				items.map((t) => h('div', { key: t.id, className: cx('dsh-remote-toast', t.kind) }, t.text)))
		}

		function useToasts() {
			const [items, setItems] = useState([])
			const push = useCallback((kind, text) => {
				const id = ++toastSeq
				setItems((a) => [...a.slice(-3), { id, kind, text }])
				setTimeout(() => setItems((a) => a.filter((x) => x.id !== id)), 4200)
			}, [])
			return { items, push }
		}

		/* Form primitives */

		function TextField({ idPrefix, label, value, onChange, placeholder, invalid, error, mono, type }) {
			const id = idPrefix + '-' + label
			return h('div', { className: cx('dsh-remote-field', invalid && 'invalid') },
				h('label', { htmlFor: id }, label),
				h('input', {
					id, className: cx('dsh-remote-input', mono && 'dsh-remote-mono'), type: type || 'text',
					value, placeholder, autoComplete: 'off', spellCheck: false,
					onChange: (e) => onChange(e.target.value),
				}),
				invalid && error ? h('div', { className: 'dsh-remote-field-error' }, error) : null,
			)
		}

		function PasswordField({ idPrefix, label, value, onChange, placeholder, invalid, error }) {
			const [show, setShow] = useState(false)
			const id = idPrefix + '-pw-' + label
			return h('div', { className: cx('dsh-remote-field', invalid && 'invalid') },
				h('label', { htmlFor: id }, label),
				h('div', { className: 'dsh-remote-pw' },
					h('input', {
					id, className: 'dsh-remote-input', type: show ? 'text' : 'password', value, placeholder,
						autoComplete: 'new-password', onChange: (e) => onChange(e.target.value),
					}),
					h('button', {
						type: 'button', className: 'dsh-remote-eye', 'aria-label': show ? 'hide password' : 'show password',
						onClick: () => setShow((s) => !s),
					}, show ? '🙈' : '👁'),
				),
				invalid && error ? h('div', { className: 'dsh-remote-field-error' }, error) : null,
			)
		}

		function AuthSegmented({ value, onChange, lang }) {
			const opts = [
				{ value: 'password', label: tr(lang, 'authPassword') },
				{ value: 'key', label: tr(lang, 'authKey') },
			]
			return h('div', { className: 'dsh-remote-field' },
				h('label', null, tr(lang, 'auth')),
				h('div', { className: 'dsh-remote-seg', role: 'radiogroup', 'aria-label': tr(lang, 'auth') },
					opts.map((o) => h('button', {
					key: o.value, type: 'button', role: 'radio', 'aria-checked': value === o.value,
					'aria-pressed': value === o.value, onClick: () => onChange(o.value),
					}, o.label)),
				),
			)
		}

		/* Remote directory browser modal */

		function parentOf(path) {
			if (!path || path === '/') return null
			const trimmed = path.replace(/\/+$/, '')
			const idx = trimmed.lastIndexOf('/')
			return idx <= 0 ? '/' : trimmed.slice(0, idx)
		}

		function crumbsOf(path) {
			const parts = String(path || '/').split('/').filter(Boolean)
			const crumbs = [{ name: '/', path: '/' }]
			let acc = ''
			for (const p of parts) {
				acc += '/' + p
				crumbs.push({ name: p, path: acc })
			}
			return crumbs
		}

		function RemoteBrowserModal({ bridge, target, initialPath, makeRef, onClose, onPick, pushToast, lang }) {
			const [path, setPath] = useState(initialPath || '')
			const [entries, setEntries] = useState(null)
			const [error, setError] = useState('')
			const [loading, setLoading] = useState(true)
			const dialogRef = useRef(null)

			const load = useCallback((p) => {
				setLoading(true)
				setError('')
				bridge.call('remote.browse', Object.assign({}, target, { path: p || undefined }))
					.then((r) => {
						setPath(r.path)
						setEntries(r.entries || [])
					})
					.catch((e) => {
						setEntries([])
						setError(errText(e, lang))
					})
					.finally(() => setLoading(false))
			}, [target, lang])

			useEffect(() => { load(initialPath) }, [])
			useEffect(() => { dialogRef.current && dialogRef.current.focus() }, [])
			useEffect(() => () => { bridge.call('remote.browseClose', target).catch(() => {}) }, [])

			const enter = (entry) => {
				if (entry.type !== 'directory') return
				const next = path === '/' ? '/' + entry.name : path + '/' + entry.name
				load(next)
			}

			const onKeyDown = (e) => {
				if (e.key === 'Escape') {
					e.stopPropagation()
					onClose()
				} else if (e.key === 'Tab') {
					const focusables = dialogRef.current
						? dialogRef.current.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])')
						: []
					if (focusables.length === 0) return
					const first = focusables[0]
					const last = focusables[focusables.length - 1]
					if (e.shiftKey && document.activeElement === first) {
						e.preventDefault()
						last.focus()
					} else if (!e.shiftKey && document.activeElement === last) {
						e.preventDefault()
						first.focus()
					}
				}
			}

			const refString = makeRef ? makeRef(path) : null
			const copyRef = () => {
				if (!refString) return
				navigator.clipboard && navigator.clipboard.writeText(refString)
					.then(() => pushToast('ok', tr(lang, 'copied') + ': ' + refString))
					.catch(() => {})
			}

			return h('div', {
				className: 'dsh-remote-modal-backdrop',
				onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() },
			},
				h('div', {
					className: 'dsh-remote-modal', role: 'dialog', 'aria-modal': 'true', tabIndex: -1,
					'aria-label': tr(lang, 'pickTitle'), ref: dialogRef, onKeyDown,
				},
					h('div', { className: 'dsh-remote-modal-head' },
						h('span', null, '📁 ' + tr(lang, 'pickTitle')),
						h('span', { className: 'grow' }),
						h('button', { type: 'button', className: 'dsh-remote-btn small', onClick: () => load('.') }, tr(lang, 'pickHome')),
						h('button', {
							type: 'button', className: 'dsh-remote-btn small',
							onClick: () => { const up = parentOf(path); if (up != null) load(up) },
						}, '↑ ' + tr(lang, 'pickUp')),
					),
					h('div', { className: 'dsh-remote-crumbs' },
						crumbsOf(path).map((c, i, arr) => h('span', { key: c.path + i },
							h('span', { className: 'crumb', onClick: () => load(c.path) }, c.name),
							i < arr.length - 1 ? h('span', { className: 'sep' }, '›') : null,
						)),
					),
					error
						? h('div', { className: 'dsh-remote-card-err', style: { padding: '12px 16px' } }, error)
						: loading
							? h('div', { className: 'hint' }, '⏳ ' + tr(lang, 'pickLoading'))
							: h('div', { className: 'dsh-remote-list' },
								(entries && entries.length)
										? entries.map((e) => h('div', {
											key: e.name, className: 'dsh-remote-item', onClick: () => enter(e),
											role: 'button', tabIndex: 0,
											onKeyDown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); enter(e) } },
										},
										h('span', null, e.type === 'directory' ? '📁' : e.type === 'symlink' ? '🔗' : '📄'),
										h('span', { className: 'name' }, e.name),
										h('span', { className: 'meta' },
											e.type === 'directory' ? tr(lang, 'dir') : fmtSize(e.size),
											e.mtime ? ' · ' + fmtMtime(e.mtime) : ''),
										))
										: h('div', { className: 'hint' }, tr(lang, 'pickEmpty')),
								),
					h('div', { className: 'dsh-remote-modal-foot' },
						h('span', { className: 'path' }, path),
						refString ? h('button', { type: 'button', className: 'dsh-remote-btn small', onClick: copyRef,
							title: tr(lang, 'remoteRef') }, '⧉ ' + tr(lang, 'remoteRef')) : null,
						h('button', { type: 'button', className: 'dsh-remote-btn', onClick: onClose }, tr(lang, 'pickCancel')),
						h('button', {
						type: 'button', className: 'dsh-remote-btn primary', disabled: loading || !!error,
						onClick: () => onPick(path),
						}, tr(lang, 'pickSelect')),
					),
				),
			)
		}


		/* Workspace directory flow (the add-workspace picker) */

		/**
		 * Find another occupant of the directory-flow holes that exposes a
		 * listDirectory face (the shipped browse dialog). Our flow embeds it
		 * verbatim for the local tab so the pure-local experience keeps the
		 * exact upstream dialog; entries lacking the face (the native
		 * OS-chooser flow) fall back to a plain path input.
		 */
		function findLocalBrowseFlow(slots, ownComponent) {
			const holes = ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']
			for (const hole of holes) {
				let entries = []
				try { entries = slots.entries(hole) || [] } catch (e) { continue }
				for (const entry of entries) {
					if (!entry || entry.component === ownComponent) continue
					if (typeof entry.inject !== 'function') continue
					let face = null
					try { face = entry.inject() } catch (e) { continue }
					if (face && typeof face.listDirectory === 'function') {
						return { component: entry.component, face }
					}
				}
			}
			return null
		}

		/** The remote tab: machine list on the left, directory tree on the right. */
		function RemotePickerPane({ bridge, lang, onBack, onClose, onBound, pushToast }) {
			const [profiles, setProfiles] = useState(null)
			const [sel, setSel] = useState(null)
			const [path, setPath] = useState('')
			const [entries, setEntries] = useState(null)
			const [loading, setLoading] = useState(false)
			const [error, setError] = useState('')
			const [binding, setBinding] = useState(false)
			const dialogRef = useRef(null)

			useEffect(() => {
				bridge.call('remote.list')
					.then((list) => setProfiles(list || []))
					.catch((e) => { setProfiles([]); setError(errText(e, lang)) })
			}, [])
			useEffect(() => { dialogRef.current && dialogRef.current.focus() }, [])
			useEffect(() => () => {
				if (sel) bridge.call('remote.browseClose', { id: sel }).catch(() => {})
			}, [sel])

			const loadAt = (id, p) => {
				setLoading(true)
				setError('')
				bridge.call('remote.browse', { id: id, path: p || undefined })
					.then((r) => { setPath(r.path); setEntries(r.entries || []) })
					.catch((e) => { setEntries([]); setError(errText(e, lang)) })
					.finally(() => setLoading(false))
			}

			const openMachine = (p) => {
				if (binding) return
				setSel(p.id)
				setEntries(null)
				setPath('')
				loadAt(p.id, '')
			}

			const enter = (entry) => {
				if (entry.type !== 'directory' || !sel) return
				const next = path === '/' ? '/' + entry.name : path + '/' + entry.name
				loadAt(sel, next)
			}

			const confirmBind = () => {
				if (!sel || !path || binding) return
				setBinding(true)
				bridge.call('remote.bind', { id: sel, path: path })
					.then((r) => {
						const prof = r.profile || {}
						const ref = 'remote://' + prof.user + '@' + prof.host + ':' + prof.port + path
						pushToast('ok', tr(lang, 'wflowBound', { ref: ref }))
						setTimeout(onBound, 400)
					})
					.catch((e) => { pushToast('err', errText(e, lang)); setBinding(false) })
			}

			const onKeyDown = (e) => {
				if (e.key === 'Escape') { e.stopPropagation(); onClose() }
			}

			const selected = (profiles || []).find((x) => x.id === sel) || null
			const connecting = loading && !entries && selected

			return h('div', {
				className: 'dsh-remote-modal-backdrop',
				onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() },
			},
				h('div', {
					className: 'dsh-remote-modal wflow', role: 'dialog', 'aria-modal': 'true', tabIndex: -1,
					'aria-label': tr(lang, 'wflowMachines'), ref: dialogRef, onKeyDown,
				},
					h('div', { className: 'dsh-remote-modal-head' },
						h('span', null, '🌐 ' + tr(lang, 'wflowMachines')),
						h('span', { className: 'grow' }),
						h('button', { type: 'button', className: 'dsh-remote-btn small', onClick: onBack }, tr(lang, 'wflowBack')),
					),
					h('div', { className: 'dsh-remote-wflow-body' },
						h('div', { className: 'dsh-remote-wflow-machines' },
							h('div', { className: 'head' }, tr(lang, 'wflowMachines')),
							profiles == null
								? h('div', { className: 'hint' }, '⏳ …')
								: profiles.length === 0
									? h('div', { className: 'hint' }, tr(lang, 'wflowNoProfiles'))
									: profiles.map((p) => h('div', {
										key: p.id, className: cx('dsh-remote-machine', sel === p.id && 'sel'),
										role: 'button', tabIndex: 0,
										onClick: () => openMachine(p),
										onKeyDown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openMachine(p) } },
									},
										h('div', { className: 'row' },
											h('span', { className: cx('dsh-remote-dot', p.status === 'connected' ? 'st-connected' : p.lastError ? 'st-warn' : 'st-off') }),
											h('span', { className: 'nm' }, p.name),
										),
										h('div', { className: 'sub' }, p.user + '@' + p.host + ':' + p.port),
										p.bindPath ? h('span', { className: 'bd', title: p.bindPath }, '📂 ' + tr(lang, 'wflowBoundDir') + ' · ' + p.bindPath) : null,
									)),
						),
						h('div', { className: 'dsh-remote-wflow-dirs' },
							h('div', { className: 'dsh-remote-crumbs' },
								path
									? crumbsOf(path).map((c, i, arr) => h('span', { key: c.path + i },
										h('span', { className: 'crumb', onClick: () => loadAt(sel, c.path) }, c.name),
										i < arr.length - 1 ? h('span', { className: 'sep' }, '›') : null,
									))
									: h('span', { className: 'sep' }, tr(lang, 'wflowPickOne')),
							),
							error
								? h('div', { className: 'dsh-remote-card-err', style: { padding: '12px 16px' } }, error)
								: connecting
									? h('div', { className: 'hint' }, '⏳ ' + tr(lang, 'wflowConnecting', { name: selected ? selected.name : '' }))
									: loading
										? h('div', { className: 'hint' }, '⏳ ' + tr(lang, 'pickLoading'))
										: entries
											? h('div', { className: 'dsh-remote-list' },
												entries.length
													? entries.map((e) => h('div', {
														key: e.name,
														className: cx('dsh-remote-item', e.type !== 'directory' && 'disabled'),
														onClick: () => enter(e),
														role: e.type === 'directory' ? 'button' : undefined,
														tabIndex: e.type === 'directory' ? 0 : undefined,
														onKeyDown: (ev) => { if (e.type === 'directory' && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); enter(e) } },
													},
														h('span', null, e.type === 'directory' ? '📁' : e.type === 'symlink' ? '🔗' : '📄'),
														h('span', { className: 'name' }, e.name),
														h('span', { className: 'meta' },
															e.type === 'directory' ? tr(lang, 'dir') : fmtSize(e.size),
															e.mtime ? ' · ' + fmtMtime(e.mtime) : ''),
													))
													: h('div', { className: 'hint' }, tr(lang, 'pickEmpty')),
											)
											: h('div', { className: 'hint' }, tr(lang, 'wflowPickOne')),
						),
					),
					h('div', { className: 'dsh-remote-modal-foot' },
						h('span', { className: 'dsh-remote-wflow-foot-hint' }, tr(lang, 'wflowHint')),
						h('span', { className: 'path' }, path),
						h('button', { type: 'button', className: 'dsh-remote-btn', onClick: onClose }, tr(lang, 'pickCancel')),
						h('button', {
							type: 'button', className: 'dsh-remote-btn primary', disabled: !sel || !path || loading || !!error || binding,
							onClick: confirmBind,
						}, tr(lang, 'wflowChoose')),
					),
				),
			)
		}

		/**
		 * The directory-flow occupant: wins the add-workspace holes at a lower
		 * priority than the shipped picker and offers both worlds. The local
		 * tab embeds the shipped browse dialog untouched (plus a small chip to
		 * switch to remote); the remote tab lists the configured machines,
		 * connects on demand, browses remote directories, and binds the pick
		 * as the session remote working context (remote_* tools honor it).
		 */
		function WorkspaceDirectoryFlow(props) {
			const lang = useLang()
			const [tab, setTab] = useState('local')
			const [fallback, setFallback] = useState('')
			const [fallbackErr, setFallbackErr] = useState('')
			const toasts = useToasts()
			if (!props.open) return null

			const goRemote = () => { setFallbackErr(''); setTab('remote') }
			const ownerShare = {
				open: props.open,
				busy: props.busy,
				onPicked: props.onPicked,
				onCancel: props.onCancel,
				onError: props.onError,
			}

			if (tab === 'remote') {
				return h(React.Fragment, null,
					h(RemotePickerPane, {
						bridge: props.bridge, lang,
						onBack: () => setTab('local'),
						onClose: props.onCancel,
						onBound: props.onCancel,
						pushToast: toasts.push,
					}),
					h(ToastStack, { items: toasts.items }),
				)
			}

			const local = props.slots ? findLocalBrowseFlow(props.slots, props.dshRemoteFlow) : null
			if (local) {
				return h(React.Fragment, null,
					h(local.component, Object.assign({}, ownerShare, local.face)),
					h('div', { className: 'dsh-remote-wflow-chip' },
						h('button', { type: 'button', onClick: goRemote }, '🌐 ' + tr(lang, 'wflowRemoteChip')),
					),
					h(ToastStack, { items: toasts.items }),
				)
			}

			// No shipped browse dialog in this composition: a plain path input.
			const openFallback = () => {
				const v = fallback.trim()
				if (!v.startsWith('/') || v.length < 2) { setFallbackErr(tr(lang, 'wflowErrPath')); return }
				props.onPicked(v)
			}
			return h(React.Fragment, null,
				h('div', {
					className: 'dsh-remote-modal-backdrop',
					onMouseDown: (e) => { if (e.target === e.currentTarget) props.onCancel() },
				},
					h('div', {
						className: 'dsh-remote-modal', role: 'dialog', 'aria-modal': 'true', tabIndex: -1,
						'aria-label': tr(lang, 'wflowOpenPath'),
						onKeyDown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); props.onCancel() } },
					},
						h('div', { className: 'dsh-remote-modal-head' },
							h('span', null, '📁 ' + tr(lang, 'wflowOpenPath')),
							h('span', { className: 'grow' }),
						),
						h('div', { style: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' } },
							h('div', { className: 'hint' }, tr(lang, 'wflowLocalFallback')),
							h('input', {
								className: 'dsh-remote-input dsh-remote-mono', value: fallback, autoFocus: true,
								placeholder: '/home/user/project',
								onChange: (e) => { setFallback(e.target.value); setFallbackErr('') },
								onKeyDown: (e) => { if (e.key === 'Enter') openFallback() },
							}),
							fallbackErr ? h('div', { className: 'dsh-remote-field-error' }, fallbackErr) : null,
						),
						h('div', { className: 'dsh-remote-modal-foot' },
							h('button', { type: 'button', className: 'dsh-remote-btn', onClick: goRemote }, '🌐 ' + tr(lang, 'wflowMachines')),
							h('span', { className: 'path' }),
							h('button', { type: 'button', className: 'dsh-remote-btn', onClick: props.onCancel }, tr(lang, 'pickCancel')),
							h('button', { type: 'button', className: 'dsh-remote-btn primary', onClick: openFallback }, tr(lang, 'wflowOpenPath')),
						),
					),
				),
				h(ToastStack, { items: toasts.items }),
			)
		}

		/* Profile card */

		function ProfileCard({ p, busy, lang, onConnect, onDisconnect, onTest, onEdit, onDelete, onBrowse, onResetFp }) {
			const [confirming, setConfirming] = useState(false)
			useEffect(() => {
				if (!confirming) return
				const t = setTimeout(() => setConfirming(false), 3000)
				return () => clearTimeout(t)
			}, [confirming])

			const live = p.status === 'connected'
			const dot = live ? 'st-connected' : (p.lastError ? 'st-warn' : 'st-off')
			const statusLabel = live ? tr(lang, 'connected') : (p.lastError ? tr(lang, 'dropped') : tr(lang, 'disconnected'))
			const disabled = busy !== null

			return h('div', { className: 'dsh-remote-card' },
				h('div', { className: 'dsh-remote-card-main' },
					h('div', { className: 'dsh-remote-card-title' },
						h('span', { className: cx('dsh-remote-dot', dot), title: statusLabel }),
						h('span', null, p.name),
						h('span', { className: cx('dsh-remote-badge', live && 'status-on', !live && p.lastError && 'status-warn') },
							p.auth === 'key' ? '🔑 ' + tr(lang, 'authKeyBadge') : '＊ ' + tr(lang, 'authPasswordBadge')),
					p.platform ? h('span', { className: 'dsh-remote-badge' }, p.platform) : null,
					),
					h('div', { className: 'dsh-remote-card-sub dsh-remote-mono' }, p.user + '@' + p.host + ':' + p.port),
					p.bindPath ? h('div', { className: 'dsh-remote-card-sub' }, '📂 ' + p.bindPath) : null,
					p.hostFingerprint ? h('div', { className: 'dsh-remote-fp' }, tr(lang, 'fingerprint') + ': ' + p.hostFingerprint) : null,
					p.lastError ? h('div', { className: 'dsh-remote-card-err' },
						tr(lang, 'lastError') + ': ' + (lang === 'en' ? p.lastError.en : p.lastError.zh)) : null,
				),
				h('div', { className: 'dsh-remote-card-actions' },
					live
						? h('button', { className: 'dsh-remote-btn', disabled, onClick: () => onDisconnect(p) }, tr(lang, 'disconnect'))
						: h('button', { className: 'dsh-remote-btn primary', disabled, onClick: () => onConnect(p) }, tr(lang, 'connect')),
					h('button', { className: 'dsh-remote-btn small', disabled, onClick: () => onTest(p) }, '⚡ ' + tr(lang, 'test')),
					h('button', { className: 'dsh-remote-btn small', disabled, onClick: () => onBrowse(p) }, '📁 ' + tr(lang, 'browse')),
					h('button', { className: 'dsh-remote-btn small', disabled, onClick: () => onEdit(p) }, tr(lang, 'edit')),
					p.hostFingerprint ? h('button', {
						className: 'dsh-remote-btn small', disabled, title: tr(lang, 'resetFp'),
						onClick: () => onResetFp(p),
					}, '🔑✕') : null,
					h('button', {
						className: cx('dsh-remote-btn', 'small', confirming && 'danger-armed'), disabled,
						onClick: () => (confirming ? onDelete(p) : setConfirming(true)),
					}, confirming ? tr(lang, 'confirmDelete') : tr(lang, 'del')),
				),
			)
		}

		/* Page */

		const EMPTY_FORM = {
			id: '', name: '', host: '', port: 22, user: '', auth: 'password',
			password: '', key_path: '', passphrase: '', bind_path: '',
		}

		function validateForm(form, editing) {
			const errors = {}
			if (!form.host.trim()) errors.host = true
			const port = Number(form.port)
			if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = true
			if (!form.user.trim()) errors.user = true
			if (form.auth === 'password' && !form.password && !editing) errors.password = true
			if (form.auth === 'key' && !form.key_path.trim()) errors.key_path = true
			return errors
		}

		/** Build the settings-section component bound to one bridge. */
		function makePage(bridge) {
			return function RemoteConnectionsPage() {
				if (!bridge) {
					return h('div', { className: 'dsh-remote-intro' }, tr(langStore.get(), 'noBridge'))
				}
				const lang = useLang()
				const t = (key, vars) => tr(lang, key, vars)
				const [profiles, setProfiles] = useState([])
				const [form, setForm] = useState(EMPTY_FORM)
				const [errors, setErrors] = useState({})
				const [busy, setBusy] = useState(null)
				const [probe, setProbe] = useState(null)
				const [browser, setBrowser] = useState(null)
				const [cmd, setCmd] = useState('')
				const [cmdTarget, setCmdTarget] = useState('')
				const [out, setOut] = useState(null)
				const toasts = useToasts()
				const formRef = useRef(null)

				const editing = Boolean(form.id)

				const refresh = useCallback(() => {
					bridge.call('remote.list', {}).then(setProfiles).catch((e) => toasts.push('err', errText(e, lang)))
				}, [lang])
				useEffect(refresh, [refresh])

				const set = (field) => (value) => {
					setForm((f) => Object.assign({}, f, { [field]: value }))
					setErrors((e) => Object.assign({}, e, { [field]: false }))
				}

				const act = async (key, fn) => {
					setBusy(key)
					try {
						return await fn()
					} catch (e) {
						toasts.push('err', errText(e, lang))
						return null
					} finally {
						setBusy(null)
						refresh()
					}
				}

				const save = () => {
					const errs = validateForm(form, editing)
					setErrors(errs)
					if (Object.keys(errs).length) return toasts.push('err', t('errForm'))
					act('save', async () => {
						const r = await bridge.call('remote.save', { profile: Object.assign({}, form, { port: Number(form.port) }) })
						toasts.push('ok', t('toastSaved', { name: r.profile.name || r.profile.host }))
						setForm(EMPTY_FORM)
						setProbe(null)
						return r
					})
				}

				const runProbe = () => {
					const errs = validateForm(form, editing)
					if (editing) delete errs.password // blank = use stored secret
					setErrors(errs)
					if (errs.host || errs.port || errs.user || errs.key_path) return toasts.push('err', t('errForm'))
					act('probe', async () => {
						try {
							const r = await bridge.call('remote.probe', Object.assign({}, form, { port: Number(form.port) }))
							setProbe(r)
						} catch (e) {
							setProbe({ ok: false, message: errText(e, lang) })
							throw e
						}
					})
				}

				const onConnect = (p) => act('act:' + p.id, () =>
					bridge.call('remote.connect', { id: p.id }).then(() => toasts.push('ok', t('toastConnected', { name: p.name }))))
				const onDisconnect = (p) => act('act:' + p.id, () =>
					bridge.call('remote.disconnect', { id: p.id }).then(() => toasts.push('ok', t('toastDisconnected', { name: p.name }))))
				const onTest = (p) => act('act:' + p.id, async () => {
					const r = await bridge.call('remote.test', { id: p.id })
					toasts.push(r.ok ? 'ok' : 'err', t(r.ok ? 'toastTestOk' : 'toastTestFail', { name: p.name }))
					return r
				})
				const onDelete = (p) => act('act:' + p.id, () =>
					bridge.call('remote.delete', { id: p.id }).then(() => toasts.push('ok', t('toastDeleted', { name: p.name }))))
				const onResetFp = (p) => act('act:' + p.id, () =>
					bridge.call('remote.resetFingerprint', { id: p.id }).then(() => toasts.push('ok', t('toastFpReset'))))
				const onEdit = (p) => {
					setForm({
						id: p.id, name: p.name, host: p.host, port: p.port, user: p.user, auth: p.auth,
						password: '', key_path: p.keyPath || '', passphrase: '', bind_path: p.bindPath || '',
					})
					setProbe(null)
					setErrors({})
					formRef.current && formRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
				}
				const onBrowseCard = (p) => setBrowser({
					target: { id: p.id },
					initialPath: p.bindPath || undefined,
					makeRef: (path) => 'remote://' + p.user + '@' + p.host + path,
					onPick: null,
				})

				const openBindPicker = () => {
					const target = editing ? { id: form.id } : {
						profile: {
							host: form.host, port: Number(form.port) || 22, user: form.user, auth: form.auth,
							password: form.password, key_path: form.key_path, passphrase: form.passphrase,
						},
					}
					setBrowser({ target, initialPath: form.bind_path || undefined, makeRef: null, onPick: (path) => set('bind_path')(path) })
				}

				const runExec = () => {
					const target = cmdTarget || (profiles.find((p) => p.status === 'connected') || {}).id
					if (!target) return toasts.push('err', t('disconnected'))
					act('exec:' + target, async () => {
						const r = await bridge.call('remote.exec', { id: target, command: cmd, timeout_ms: 30000 })
						setOut(r)
						return r
					})
				}

				const storageMode = profiles.length ? profiles[0].secretStore : null
				const connected = profiles.filter((p) => p.status === 'connected')

				return h('div', { className: 'dsh-remote-page' },
					h('h2', null, t('title'), ' ',
						h('span', { className: 'dsh-remote-badge', title: 'client build' }, 'v0.3'),
					),
					h('p', { className: 'dsh-remote-intro' },
						t('intro'), ' ',
						storageMode ? h('span', { className: 'dsh-remote-storage' },
							h('span', { className: 'dot' }),
							t('storage') + ': ' + (storageMode === 'credentials' ? t('storageCredentials') : t('storageFile')),
						) : null,
					),

					/* form */
					h('div', { className: 'dsh-remote-form', ref: formRef },
						h('div', { className: 'dsh-remote-form-title' }, editing ? t('saveEdit') : t('save')),
						h('div', { className: 'dsh-remote-grid' },
							h(TextField, { idPrefix: 'drr', label: t('name'), value: form.name, onChange: set('name'), placeholder: t('namePh') }),
							h(TextField, { idPrefix: 'drr', label: t('host'), value: form.host, onChange: set('host'), placeholder: t('hostPh'), invalid: errors.host, error: t('errRequired') }),
							h(TextField, { idPrefix: 'drr', label: t('port'), value: form.port, onChange: set('port'), placeholder: '22', invalid: errors.port, error: t('errPort') }),
							h(TextField, { idPrefix: 'drr', label: t('user'), value: form.user, onChange: set('user'), placeholder: 'root', invalid: errors.user, error: t('errRequired') }),
						),
						h(AuthSegmented, { value: form.auth, onChange: set('auth'), lang }),
						h('div', { className: 'dsh-remote-grid' },
							form.auth === 'password'
								? h(PasswordField, {
										idPrefix: 'drr', label: t('password'), value: form.password, onChange: set('password'),
										placeholder: editing ? t('passwordKeepPh') : '',
										invalid: errors.password, error: t('errNeedPassword'),
									})
								: h('div', { className: 'dsh-remote-grid', style: { gridTemplateColumns: '1fr 1fr' } },
										h(TextField, {
											idPrefix: 'drr', label: t('keyPath'), value: form.key_path, onChange: set('key_path'),
											placeholder: t('keyPathPh'), mono: true, invalid: errors.key_path, error: t('errNeedKey'),
										}),
										h(PasswordField, {
											idPrefix: 'drr', label: t('passphrase'), value: form.passphrase, onChange: set('passphrase'),
											placeholder: editing ? t('passphraseKeepPh') : t('passphrasePh'),
										}),
									),
								h('div', { className: 'dsh-remote-bindrow' },
										h(TextField, {
											idPrefix: 'drr', label: t('bindPath'), value: form.bind_path, onChange: set('bind_path'),
											placeholder: t('bindPathPh'), mono: true,
										}),
										h('button', {
											type: 'button', className: 'dsh-remote-btn', onClick: openBindPicker, disabled: busy !== null,
										}, '📁 ' + t('browse')),
									),
								),
						h('div', { className: 'dsh-remote-actions' },
							h('button', {
								className: 'dsh-remote-btn primary', disabled: busy !== null, onClick: save,
							}, busy === 'save' ? t('saving') : (editing ? t('saveEdit') : t('save'))),
							h('button', {
								className: 'dsh-remote-btn', disabled: busy !== null, onClick: runProbe,
							}, busy === 'probe' ? t('testing') : '⚡ ' + t('test')),
							editing ? h('button', {
								className: 'dsh-remote-btn', disabled: busy !== null,
								onClick: () => { setForm(EMPTY_FORM); setErrors({}); setProbe(null) },
							}, t('cancel')) : null,
							h('button', { className: 'dsh-remote-btn', disabled: busy !== null, onClick: refresh }, '⟳ ' + t('refresh')),
						),
						probe ? h('div', { className: cx('dsh-remote-probe', probe.ok ? 'ok' : 'fail') },
							probe.ok
								? h('span', null, '✓ ' + t('probeOk') + ' · ' + (probe.platform || '?') + ' · ' + t('probeLatency') + ' ' + probe.latencyMs + 'ms')
								: h('span', null, '✕ ' + probe.message),
							probe.fingerprint ? h('span', { className: 'fp' }, t('fingerprint') + ': ' + probe.fingerprint) : null,
						) : null,
					),

					/* profiles */
					profiles.length === 0
						? h('div', { className: 'dsh-remote-empty' },
							h('span', { className: 'big' }, '🖥'),
							h('b', null, t('emptyTitle')),
							h('span', null, t('emptyDesc')),
							h('button', {
								className: 'dsh-remote-btn primary',
								onClick: () => formRef.current && formRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }),
							}, t('emptyCta')),
						)
						: h('div', { className: 'dsh-remote-cards' },
							profiles.map((p) => h(ProfileCard, {
								key: p.id, p, busy, lang,
								onConnect, onDisconnect, onTest, onEdit, onDelete, onBrowse: onBrowseCard, onResetFp,
							})),
							h('div', { className: 'dsh-remote-fp', style: { textAlign: 'center' } }, t('profilesAt')),
						),

					/* command test panel */
					profiles.length > 0 ? h('div', { className: 'dsh-remote-cmd' },
						h('div', { className: 'dsh-remote-form-title' }, t('cmdTitle')),
						h('div', { className: 'dsh-remote-cmd-row' },
							h('select', {
								className: 'dsh-remote-select', style: { width: 'auto', flex: 'none' },
								value: cmdTarget || ((connected[0] || profiles[0] || {}).id || ''),
								onChange: (e) => setCmdTarget(e.target.value),
							},
								profiles.map((p) => h('option', { key: p.id, value: p.id },
									p.name + (p.status === 'connected' ? ' ●' : ''))),
							),
							h('input', {
								className: 'dsh-remote-input dsh-remote-mono', placeholder: t('cmdPh'), value: cmd,
								onChange: (e) => setCmd(e.target.value),
								onKeyDown: (e) => { if (e.key === 'Enter') runExec() },
							}),
							h('button', {
								className: 'dsh-remote-btn primary', disabled: busy !== null || !cmd.trim(), onClick: runExec,
							}, t('cmdRun')),
						),
						out ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
							h('span', { className: cx('dsh-remote-exit', out.code !== 0 && 'nonzero') },
								t('exit') + '=' + out.code + (out.signal ? ' signal=' + out.signal : '')),
							h('div', { className: 'dsh-remote-out' },
								out.stdout || '',
								out.stderr ? h('span', { className: 'stderr' }, out.stderr) : null,
								(!out.stdout && !out.stderr) ? '(no output)' : null),
						) : null,
					) : null,

					/* overlays */
					browser ? h(RemoteBrowserModal, {
						bridge, lang, pushToast: toasts.push,
						target: browser.target,
						initialPath: browser.initialPath,
						makeRef: browser.makeRef,
						onClose: () => setBrowser(null),
						onPick: (path) => {
							browser.onPick && browser.onPick(path)
							setBrowser(null)
						},
					}) : null,
					h(ToastStack, { items: toasts.items }),
				)
			}
		}

		/* Module registration */

		return {
			/** Cordis plugin name (informational; the entry id is the package name). */
			name: 'remote-ssh-client',
			/** Required services (cordis fiber inject): the slot registry. */
			inject: ['slots'],
			apply: (ctx) => {
				// Follow the shell locale when the service is present; otherwise
				// keep the navigator-derived default (never blocks registration).
				try {
					const loc = ctx.locale
					if (loc && typeof loc.getLocale === 'function') {
						const adopt = () => {
							const active = loc.getLocale() && loc.getLocale().active
							langStore.set(active === 'en' ? 'en' : 'zh')
						}
						adopt()
						if (typeof loc.subscribe === 'function') {
							ctx.effect(() => loc.subscribe(adopt))
						}
					}
				} catch {
					/* locale service unavailable — navigator default stands */
				}

				// host is the dynamic-plugin RPC bridge when that runtime is
				// present; the packaged web client falls back to the HTTP API.
				const bridge = typeof host !== 'undefined' ? host : { call: httpCall }
				const Page = makePage(bridge)
				ctx.slots.inject('settings.section', () => ctx.slots.register(
					{
						name: 'settings.section',
						id: 'remote-connections',
						order: 30,
						label: () => tr(langStore.get(), 'nav'),
					},
					Page,
				))

				// Occupy both add-workspace directory-flow holes at a lower priority
				// than the shipped picker (a cell renders its lowest-priority live
				// entry): our flow embeds the shipped local dialog untouched and adds
				// the remote tab. Uninstalling the plugin restores the original.
				const flowFace = () => ({ bridge, slots: ctx.slots, dshRemoteFlow: WorkspaceDirectoryFlow })
				ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
					ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
						yield ctx.slots.register(
							{ name: 'conversation.hero.workspace.directoryFlow', priority: -50, inject: flowFace },
							WorkspaceDirectoryFlow,
						)
						yield ctx.slots.register(
							{ name: 'sidebar.workspaces.directoryFlow', priority: -50, inject: flowFace },
							WorkspaceDirectoryFlow,
						)
					}))
			},
		}
	},
})
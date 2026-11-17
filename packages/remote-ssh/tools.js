/**
 * dsh-remote-ssh model tools: remote_dev_connect / remote_dev_disconnect /
 * remote_dev_status / remote_dev_exec / remote_dev_read / remote_dev_write / remote_dev_list.
 * Registered on the `tools` service; the plugin also adds a systemPrompt
 * section so the model knows the remote tool family exists.
 *
 * @module dsh-remote-dev/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

const STATUS_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		id: { type: 'string', required: true },
		name: { type: 'string', required: true },
		host: { type: 'string', required: true },
		port: { type: 'number', required: true },
		user: { type: 'string', required: true },
		auth: { type: 'string', required: true },
		keyPath: { type: 'string' },
		bindPath: { type: 'string', required: true },
		boundAt: { type: 'string' },
		hostFingerprint: { type: 'string' },
		status: { type: 'string', required: true },
		platform: { oneOf: [{ type: 'string' }, { type: 'null' }] },
		lastError: {
			oneOf: [{
				type: 'object',
				additionalProperties: false,
				properties: {
					code: { type: 'string', required: true },
					zh: { type: 'string', required: true },
					en: { type: 'string', required: true },
				},
			}, { type: 'null' }],
		},
		secretStore: { type: 'string' },
	},
}

/** Keep canonical values lossless JSON and never expose extra manager fields. */
function statusValue(status) {
	const value = {}
	for (const key of Object.keys(STATUS_SCHEMA.properties)) {
		if (status[key] !== undefined) value[key] = status[key]
	}
	if (value.lastError) {
		const { code, zh, en } = value.lastError
		value.lastError = { code, zh, en }
	}
	return value
}

function checkAbort(exec) {
	exec?.signal?.throwIfAborted()
}

export function applyRemoteTools(ctx, manager) {
	const tools = ctx.get('tools')
	if (tools === undefined) return // no tools registry in this context

	tools.register(defineTool({
		name: 'remote_dev_connect',
		description: 'Connect to a machine over SSH using a stored profile id, or ad-hoc host/user with password or private-key auth. Keeps the connection open for later remote_dev_* calls.',
		parameters: {
			profile: { type: 'string', description: 'Stored profile id (see remote_dev_status for the list).' },
			host: { type: 'string', description: 'Host or IP when not using a stored profile.' },
			port: { type: 'number', description: 'SSH port, default 22.' },
			user: { type: 'string', description: 'Login user when not using a stored profile.' },
			auth: { type: 'string', description: 'password | key, default password.' },
			password: { type: 'string', description: 'Password for password auth.' },
			key_path: { type: 'string', description: 'Private key path for key auth (~ supported).' },
			passphrase: { type: 'string', description: 'Passphrase for an encrypted private key.' },
		},
		output: {
			schema: STATUS_SCHEMA,
			render: (_args, value) => [{
				type: 'text',
				text: `connected: ${value.name} (${value.user}@${value.host}:${value.port}) platform=${value.platform ?? 'unknown'}`,
			}],
		},
		async execute(args, exec) {
			checkAbort(exec)
			const status = await manager.connectAdhoc(args, { signal: exec?.signal })
			checkAbort(exec)
			return statusValue(status)
		},
	}))

	tools.register(defineTool({
		name: 'remote_dev_disconnect',
		description: 'Close the SSH connection of one profile.',
		parameters: {
			profile: { type: 'string', required: true, description: 'Profile id to disconnect.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: { ok: { type: 'boolean', required: true } },
			},
			render: (args) => [{ type: 'text', text: `disconnected ${args.profile}` }],
		},
		async execute(args, exec) {
			checkAbort(exec)
			const result = await manager.disconnect(args.profile)
			checkAbort(exec)
			return result
		},
	}))

	tools.register(defineTool({
		name: 'remote_dev_status',
		description: 'List stored remote profiles with connection status, detected platform, and the last error when a connection dropped.',
		parameters: {},
		output: {
			schema: { type: 'array', items: STATUS_SCHEMA },
			render: (_args, value) => [{
				type: 'text',
				text: value.map((p) =>
					`${p.status}  ${p.name}  ${p.user}@${p.host}:${p.port} (${p.auth})${p.platform ? ` · ${p.platform}` : ''}${p.lastError ? ` · last error: ${p.lastError.code} (${p.lastError.en})` : ''}`,
				).join('\n') || '(no profiles)',
			}],
		},
		async execute(_args, exec) {
			checkAbort(exec)
			return manager.statusAll().map(statusValue)
		},
	}))

	tools.register(defineTool({
		name: 'remote_dev_exec',
		description: 'Run a command on the remote machine over an open SSH connection. Runs in the profile bound working directory when one is set. On Windows targets the command runs through the default shell (cmd.exe). Reconnects once with the stored credentials if the connection dropped.',
		parameters: {
			profile: { type: 'string', required: true, description: 'Profile id (must be connected first).' },
			command: { type: 'string', required: true, description: 'Command to run on the remote machine.' },
			timeout_ms: { type: 'number', description: 'Timeout in ms, default 30000, max 600000.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					exit_code: { oneOf: [{ type: 'number' }, { type: 'null' }] },
					signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
					platform: { oneOf: [{ type: 'string' }, { type: 'null' }] },
					stdout: { type: 'string', required: true },
					stderr: { type: 'string', required: true },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: `exit=${value.exit_code}${value.signal ? ` signal=${value.signal}` : ''}\n${value.stdout}${value.stderr}`,
			}],
		},
		async execute(args, exec) {
			checkAbort(exec)
			const conn = await manager.require(args.profile, { signal: exec?.signal })
			checkAbort(exec)
			// The profile's bound directory (picked in the workspace directory
			// flow) is the default working directory.
			const command = manager.withDefaultCwd(args.profile, args.command, conn.platform)
			const timeoutMs = Math.min(Math.max(args.timeout_ms || 30000, 1), 600000)
			const r = await conn.exec(command, { timeoutMs, signal: exec?.signal })
			checkAbort(exec)
			return {
				exit_code: r.code ?? null,
				signal: r.signal ?? null,
				platform: conn.platform ?? null,
				stdout: r.stdout,
				stderr: r.stderr,
			}
		},
	}))

	tools.register(defineTool({
		name: 'remote_dev_read',
		description: 'Read a UTF-8 text file from the remote machine over SFTP (requires an open connection). Relative paths resolve against the profile bound working directory.',
		parameters: {
			profile: { type: 'string', required: true, description: 'Profile id.' },
			path: { type: 'string', required: true, description: 'Remote file path; relative resolves against the bound directory.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: { content: { type: 'string', required: true } },
			},
			render: (_args, value) => [{ type: 'text', text: value.content }],
		},
		async execute(args, exec) {
			checkAbort(exec)
			const path = manager.resolveBound(args.profile, args.path)
			const conn = await manager.require(args.profile, { signal: exec?.signal })
			checkAbort(exec)
			const content = await conn.readFile(path, { signal: exec?.signal })
			checkAbort(exec)
			return { content }
		},
	}))

	tools.register(defineTool({
		name: 'remote_dev_write',
		description: 'Write a UTF-8 text file on the remote machine over SFTP (requires an open connection). Relative paths resolve against the profile bound working directory.',
		parameters: {
			profile: { type: 'string', required: true, description: 'Profile id.' },
			path: { type: 'string', required: true, description: 'Remote file path.' },
			content: { type: 'string', required: true, description: 'Full new file content.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					ok: { type: 'boolean', required: true },
					path: { type: 'string', required: true },
				},
			},
			render: (_args, value) => [{ type: 'text', text: `wrote ${value.path}` }],
		},
		async execute(args, exec) {
			checkAbort(exec)
			const path = manager.resolveBound(args.profile, args.path)
			const conn = await manager.require(args.profile, { signal: exec?.signal })
			checkAbort(exec)
			await conn.writeFile(path, args.content, { signal: exec?.signal })
			checkAbort(exec)
			return { ok: true, path }
		},
	}))

	tools.register(defineTool({
		name: 'remote_dev_list',
		description: 'List a directory on the remote machine over SFTP (requires an open connection); entries come back directories-first. Relative paths resolve against the profile bound working directory.',
		parameters: {
			profile: { type: 'string', required: true, description: 'Profile id.' },
			path: { type: 'string', required: true, description: 'Remote directory path; relative resolves against the bound directory.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					entries: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								name: { type: 'string', required: true },
								type: { type: 'string', required: true },
								size: { oneOf: [{ type: 'number' }, { type: 'null' }] },
								mtime: { oneOf: [{ type: 'number' }, { type: 'null' }] },
							},
						},
					},
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.entries.map((e) => `${e.type === 'directory' ? 'd' : e.type === 'symlink' ? 'l' : '-'}  ${e.size ?? ''}  ${e.name}`).join('\n') || '(empty)',
			}],
		},
		async execute(args, exec) {
			checkAbort(exec)
			const path = manager.resolveBound(args.profile, args.path)
			const conn = await manager.require(args.profile, { signal: exec?.signal })
			checkAbort(exec)
			const entries = await conn.listDir(path, { signal: exec?.signal })
			checkAbort(exec)
			return { entries: entries.map((entry) => ({
				name: entry.name,
				type: entry.type,
				size: entry.size ?? null,
				mtime: entry.mtime ?? null,
			})) }
		},
	}))

	registerRemotePromptSection(ctx, manager)
}

/**
 * The remote_dev_* tool guidance, plus the live remote working contexts the user
 * picked in the workspace directory flow. The section text is a provider so
 * every prompt assembly reflects the current bindings without re-registering.
 * Registration tolerates both orders: use the service synchronously when it
 * is already active, otherwise wait for it through ctx.inject (exactly once).
 */
function registerRemotePromptSection(ctx, manager) {
	let registered = false
	const sectionText = () => {
		const base = 'Use the remote_dev_* tools to work on a machine reachable over SSH: remote_dev_connect first (auth is password or key), then remote_dev_exec / remote_dev_read / remote_dev_write / remote_dev_list with the profile id. Remote paths are paths on the remote machine. On Windows targets, commands run through cmd.exe. When a session runs on a remote machine through a remote-workspace preset, its ordinary read/write/edit/glob/grep/bash tools already operate there directly — use those instead of the remote_dev_* tools inside such a session.'
		const bound = manager.boundContexts()
		if (bound.length === 0) return base
		const lines = bound.map((p) => {
			const where = 'remote://' + p.user + '@' + p.host + ':' + p.port + p.bindPath
			return '- ' + where + " (profile id '" + p.id + "', name '" + (p.name || p.user + '@' + p.host) + "')"
		})
		return base + '\n\nRemote working directories the user picked for this deployment (most recent first):\n' + lines.join('\n') +
			'\nFor each profile above: relative paths in remote_dev_read / remote_dev_write / remote_dev_list resolve against its bound directory, and remote_dev_exec runs there by default. Treat the most recent entry as the primary working directory unless the user says otherwise.'
	}
	const register = (sp) => {
		if (registered) return
		registered = true
		ctx.effect(() => sp.section({ name: 'tool:remote-dev', order: 100, text: sectionText }))
	}
	const sp = ctx.get('systemPrompt')
	if (sp !== undefined) register(sp)
	else ctx.inject(['systemPrompt'], (spCtx) => register(spCtx.systemPrompt))
}

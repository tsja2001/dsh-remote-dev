/**
 * dsh-remote-ssh model tools: remote_connect / remote_disconnect /
 * remote_status / remote_exec / remote_read / remote_write / remote_list.
 * Registered on the `tools` service; the plugin also adds a systemPrompt
 * section so the model knows the remote tool family exists.
 *
 * @module @tsja/dsh-remote-ssh/tools
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
		platform: { type: 'string' },
		lastError: {
			type: 'object',
			additionalProperties: false,
			properties: {
				code: { type: 'string', required: true },
				zh: { type: 'string', required: true },
				en: { type: 'string', required: true },
			},
		},
	},
}

export function applyRemoteTools(ctx, manager) {
	const tools = ctx.get('tools')
	if (tools === undefined) return // no tools registry in this context

	tools.register(defineTool({
		name: 'remote_connect',
		description: 'Connect to a machine over SSH using a stored profile id, or ad-hoc host/user with password or private-key auth. Keeps the connection open for later remote_* calls.',
		parameters: {
			profile: { type: 'string', description: 'Stored profile id (see remote_status for the list).' },
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
		async execute(args) {
			return manager.connectAdhoc(args)
		},
	}))

	tools.register(defineTool({
		name: 'remote_disconnect',
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
		async execute(args) {
			return manager.disconnect(args.profile)
		},
	}))

	tools.register(defineTool({
		name: 'remote_status',
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
		async execute() {
			return manager.statusAll()
		},
	}))

	tools.register(defineTool({
		name: 'remote_exec',
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
					exit_code: { type: 'number' },
					signal: { type: 'string' },
					platform: { type: 'string' },
					stdout: { type: 'string', required: true },
					stderr: { type: 'string', required: true },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: `exit=${value.exit_code}${value.signal ? ` signal=${value.signal}` : ''}\n${value.stdout}${value.stderr}`,
			}],
		},
		async execute(args) {
			const conn = await manager.require(args.profile)
			// The profile's bound directory (picked in the workspace directory
			// flow) is the default working directory.
			const command = manager.withDefaultCwd(args.profile, args.command, conn.platform)
			const r = await conn.exec(command, { timeoutMs: args.timeout_ms })
			return {
				exit_code: r.code,
				signal: r.signal,
				platform: conn.platform,
				stdout: r.stdout,
				stderr: r.stderr,
			}
		},
	}))

	tools.register(defineTool({
		name: 'remote_read',
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
		async execute(args) {
			const path = manager.resolveBound(args.profile, args.path)
			return { content: await (await manager.require(args.profile)).readFile(path) }
		},
	}))

	tools.register(defineTool({
		name: 'remote_write',
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
		async execute(args) {
			const path = manager.resolveBound(args.profile, args.path)
			await (await manager.require(args.profile)).writeFile(path, args.content)
			return { ok: true, path }
		},
	}))

	tools.register(defineTool({
		name: 'remote_list',
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
								size: { type: 'number' },
								mtime: { type: 'number' },
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
		async execute(args) {
			const path = manager.resolveBound(args.profile, args.path)
			return { entries: await (await manager.require(args.profile)).listDir(path) }
		},
	}))

	registerRemotePromptSection(ctx, manager)
}

/**
 * The remote_* tool guidance, plus the live remote working contexts the user
 * picked in the workspace directory flow. The section text is a provider so
 * every prompt assembly reflects the current bindings without re-registering.
 * Registration tolerates both orders: use the service synchronously when it
 * is already active, otherwise wait for it through ctx.inject (exactly once).
 */
function registerRemotePromptSection(ctx, manager) {
	let registered = false
	const sectionText = () => {
		const base = 'Use the remote_* tools to work on a machine reachable over SSH: remote_connect first (auth is password or key), then remote_exec / remote_read / remote_write / remote_list with the profile id. Remote paths are paths on the remote machine. On Windows targets, commands run through cmd.exe.'
		const bound = manager.boundContexts()
		if (bound.length === 0) return base
		const lines = bound.map((p) => {
			const where = 'remote://' + p.user + '@' + p.host + ':' + p.port + p.bindPath
			return '- ' + where + " (profile id '" + p.id + "', name '" + (p.name || p.user + '@' + p.host) + "')"
		})
		return base + '\n\nRemote working directories the user picked for this deployment (most recent first):\n' + lines.join('\n') +
			'\nFor each profile above: relative paths in remote_read / remote_write / remote_list resolve against its bound directory, and remote_exec runs there by default. Treat the most recent entry as the primary working directory unless the user says otherwise.'
	}
	const register = (sp) => {
		if (registered) return
		registered = true
		ctx.effect(() => sp.section({ name: 'tool:remote', order: 100, text: sectionText }))
	}
	const sp = ctx.get('systemPrompt')
	if (sp !== undefined) register(sp)
	else ctx.inject(['systemPrompt'], (spCtx) => register(spCtx.systemPrompt))
}

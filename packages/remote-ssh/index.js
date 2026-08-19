/**
 * dsh-remote-ssh plugin entry (Host half).
 *
 * Owns a RemoteManager (profile store + live connections + secret store),
 * exposes one shared RPC method table through both bridges the runtime
 * provides — the dynamic-plugin `harness.handle` surface and a JSON HTTP API
 * on `ctx.webServer` (`/dsh-remote/api/*`, same-origin only) — and registers
 * the remote_* model tools.
 *
 * @module dsh-remote-dev
 */

import { deleteProfile, loadProfiles, resetFingerprint, saveProfiles, upsertProfile } from './profiles.js'
import { RemoteConnection, classifyError } from './transport.js'
import { applyRemoteTools } from './tools.js'
import { RemoteWorkspaces, workspaceRpc } from './workspaces.js'
import { MANAGER_KEY } from './world-support.js'

/** Strip secrets from a stored profile before it crosses an RPC boundary. */
function publicProfile(p, displayName) {
	return {
		id: p.id,
		name: displayName ?? p.name ?? '',
		host: p.host,
		port: p.port,
		user: p.user,
		auth: p.auth,
		keyPath: p.keyPath || '',
		bindPath: p.bindPath || '',
		boundAt: p.boundAt || '',
		hostFingerprint: p.hostFingerprint || '',
	}
}

/** File-backed secret store: values live in profiles.json (0600, documented). */
function fileSecretStore() {
	return {
		mode: 'file',
		async get(profile, field) {
			return profile[field] || ''
		},
		async set() {},
		async unset() {},
	}
}

/** Credential-seam store: values live in DSH_REMOTE_* credential refs. */
function credentialSecretStore(credentials) {
	const ref = (id, field) =>
		`DSH_REMOTE_${String(id).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${field.toUpperCase()}`
	return {
		mode: 'credentials',
		async get(profile, field) {
			try {
				return (await credentials.resolve(ref(profile.id, field)))?.value || ''
			} catch {
				return ''
			}
		},
		async set(id, field, value) {
			await credentials.set(ref(id, field), value)
		},
		async unset(id, field) {
			try {
				await credentials.unset(ref(id, field))
			} catch {
				/* best effort */
			}
		},
	}
}

/** Profile store + live connection table shared by tools, RPC, and UI. */
export class RemoteManager {
	constructor() {
		/** profileId -> RemoteConnection (only live connections). */
		this.connections = new Map()
		/** profileId -> last classified error (survives connection removal). */
		this.lastErrors = new Map()
		/** profileId -> {count, windowStart} bounded auto-reconnect budget. */
		this.reconnects = new Map()
		/** Secret storage: 'file' or 'credentials' (upgraded when the service arrives). */
		this.secrets = fileSecretStore()
	}

	displayName(p) {
		return p.name || `${p.user || '?'}@${p.host || '?'}`
	}

	/**
	 * Upgrade to credential-backed secret storage and migrate file secrets
	 * once: every secret still sitting in profiles.json moves into a
	 * credential ref, then is blanked from the file.
	 */
	async adoptCredentials(credentials) {
		if (this.secrets.mode === 'credentials') return
		const store = credentialSecretStore(credentials)
		const profiles = loadProfiles()
		let dirty = false
		for (const p of profiles) {
			if (p.password) {
				try {
					await store.set(p.id, 'password', p.password)
					p.password = ''
					dirty = true
				} catch {
					/* keep file value if the seam rejects the write */
				}
			}
			if (p.passphrase) {
				try {
					await store.set(p.id, 'passphrase', p.passphrase)
					p.passphrase = ''
					dirty = true
				} catch {
					/* keep file value if the seam rejects the write */
				}
			}
		}
		this.secrets = store
		if (dirty) saveProfiles(profiles)
	}

	listProfiles() {
		return loadProfiles()
	}

	/** Save one profile; routes secrets into the active store. */
	async saveProfile(input) {
		if (this.secrets.mode === 'credentials') {
			const saved = upsertProfile({ ...input, password: '', passphrase: '' })
			if (input.password) await this.secrets.set(saved.id, 'password', input.password)
			if (input.auth === 'key' && input.passphrase) await this.secrets.set(saved.id, 'passphrase', input.passphrase)
			if (input.auth === 'password') await this.secrets.unset(saved.id, 'passphrase')
			if (input.auth === 'key') await this.secrets.unset(saved.id, 'password')
			const fresh = loadProfiles().find((p) => p.id === saved.id) || saved
			return publicProfile(fresh, this.displayName(fresh))
		}
		const saved = upsertProfile(input)
		return publicProfile(saved, this.displayName(saved))
	}

	async deleteProfile(id) {
		await this.disconnect(id)
		if (this.secrets.mode === 'credentials') {
			await this.secrets.unset(id, 'password')
			await this.secrets.unset(id, 'passphrase')
		}
		deleteProfile(id)
		return { ok: true }
	}

	/** Resolve a profile's secrets through the active store (per operation). */
	async resolveSecrets(profile) {
		return {
			...profile,
			password: await this.secrets.get(profile, 'password'),
			passphrase: await this.secrets.get(profile, 'passphrase'),
		}
	}

	/** Bounded auto-reconnect budget: max 3 attempts per 60s per profile. */
	canReconnect(id) {
		const now = Date.now()
		const r = this.reconnects.get(id)
		if (!r || now - r.windowStart > 60000) {
			this.reconnects.set(id, { count: 1, windowStart: now })
			return true
		}
		if (r.count >= 3) return false
		r.count += 1
		return true
	}

	/** Open one connection; wires lifecycle state into the manager tables. */
	async openConnection(profile) {
		const resolved = await this.resolveSecrets(profile)
		const conn = new RemoteConnection(resolved, {
			onState: (state, err) => {
				if (state === 'connected') {
					this.lastErrors.delete(profile.id)
				} else if (state === 'closed' && err) {
					this.lastErrors.set(profile.id, err)
					if (this.connections.get(profile.id) === conn) this.connections.delete(profile.id)
				}
			},
		})
		await conn.connect()
		this.connections.set(profile.id, conn)
		this.reconnects.delete(profile.id)
		// Host-key TOFU: pin the fingerprint observed on first connect.
		if (!profile.hostFingerprint && conn.fingerprint) {
			try {
				upsertProfile({ ...profile, hostFingerprint: conn.fingerprint })
			} catch {
				/* pinning is best-effort; verification still happens next time */
			}
		}
		return conn
	}

	/** Connect one stored profile by id. */
	async connect(id) {
		const profile = loadProfiles().find((p) => p.id === id)
		if (!profile) throw new Error(`profile not found: ${id}`)
		await this.disconnect(id)
		await this.openConnection(profile)
		const fresh = loadProfiles().find((p) => p.id === id) || profile
		return this.statusOf(fresh)
	}

	/**
	 * The live RemoteConnection for a stored profile, connecting on demand.
	 * Used by the preset world plugins (they need the transport object itself,
	 * not the status snapshot that connect() returns).
	 */
	async connection(id) {
		const profile = loadProfiles().find((p) => p.id === id)
		if (!profile) throw new Error(`profile not found: ${id}`)
		let conn = this.connections.get(id)
		if (!conn || conn.state !== 'connected') {
			await this.disconnect(id)
			await this.openConnection(profile)
			conn = this.connections.get(id)
		}
		return conn
	}

	/** Connect ad-hoc (tool path): stored profile or inline host/user/auth. */
	async connectAdhoc(args) {
		if (args.profile) return this.connect(args.profile)
		if (!args.host || !args.user) {
			throw new Error('remote_connect needs a stored profile id, or host+user for an ad-hoc connection')
		}
		const profile = {
			id: `adhoc-${args.host}-${args.user}`,
			name: `adhoc ${args.user}@${args.host}`,
			host: args.host,
			port: args.port || 22,
			user: args.user,
			auth: args.auth === 'key' ? 'key' : 'password',
			password: args.password || '',
			keyPath: args.key_path || '',
			passphrase: args.passphrase || '',
		}
		await this.disconnect(profile.id)
		await this.openConnection(profile)
		return this.statusOf(profile)
	}

	/**
	 * Get a live connection for profile id, self-healing at most once with the
	 * stored credentials when the previous connection dropped.
	 */
	async require(id) {
		const conn = this.connections.get(id)
		if (conn && conn.state === 'connected') return conn
		const profile = loadProfiles().find((p) => p.id === id)
		if (!profile) throw new Error(`profile not found: ${id}`)
		if (this.canReconnect(id)) {
			try {
				await this.connect(id)
				return this.connections.get(id)
			} catch (err) {
				const last = err.classified || this.lastErrors.get(id)
				throw new Error(
					`profile is not connected: ${id} — ${last ? `${last.code}: ${last.en}` : err.message}`,
				)
			}
		}
		const last = this.lastErrors.get(id)
		throw new Error(`profile is not connected: ${id} — ${last ? `${last.code}: ${last.en}` : 'run remote_connect first'}`)
	}

	/** Test connectivity without keeping the connection open. */
	async test(id) {
		const profile = loadProfiles().find((p) => p.id === id)
		if (!profile) throw new Error(`profile not found: ${id}`)
		const result = await this.probe({ id })
		return { ...result, id }
	}

	/**
	 * Probe a connection from raw form values (test-before-save): connects,
	 * echoes, captures platform/fingerprint/latency, then closes. Blank
	 * secrets fall back to the stored profile's when an id is given.
	 */
	async probe(input) {
		const stored = input.id ? loadProfiles().find((p) => p.id === input.id) : undefined
		const storedResolved = stored ? await this.resolveSecrets(stored) : null
		// The form posts its current values; anything blank falls back to the
		// stored profile so a test-before-save works while editing, and a bare
		// { id } probes exactly what is stored.
		const profile = {
			id: input.id || 'probe',
			name: input.name || storedResolved?.name || '',
			host: String(input.host ?? storedResolved?.host ?? '').trim(),
			port: input.port || storedResolved?.port || 22,
			user: String(input.user ?? storedResolved?.user ?? '').trim(),
			auth: (input.auth || storedResolved?.auth) === 'key' ? 'key' : 'password',
			password: input.password || '',
			keyPath: input.key_path || input.keyPath || '',
			passphrase: input.passphrase || '',
		}
		if (!profile.host || !profile.user) {
			const err = new Error('probe needs host and user')
			err.classified = { code: 'VALIDATION', zh: '请填写主机和用户名', en: 'Host and user are required', detail: '' }
			throw err
		}
		if (profile.auth === 'password' && !profile.password && storedResolved?.password) {
			profile.password = storedResolved.password
		}
		if (profile.auth === 'key') {
			if (!profile.keyPath && storedResolved?.keyPath) profile.keyPath = storedResolved.keyPath
			if (!profile.passphrase && storedResolved?.passphrase) profile.passphrase = storedResolved.passphrase
		}
		const startedAt = Date.now()
		const conn = new RemoteConnection(profile)
		try {
			await conn.connect()
			const r = await conn.exec('echo dsh-remote-ok', { timeoutMs: 10000 })
			return {
				ok: r.code === 0,
				platform: conn.platform,
				fingerprint: conn.fingerprint,
				latencyMs: Date.now() - startedAt,
				echo: String(r.stdout || '').trim(),
			}
		} finally {
			conn.close()
		}
	}

	async disconnect(id) {
		const conn = this.connections.get(id)
		if (conn) {
			conn.close()
			this.connections.delete(id)
		}
		return { ok: true }
	}

	/**
	 * List a remote directory for the browser picker; auto-connects (and
	 * marks the connection auto-opened so browseClose can retire it).
	 * Addressed either by a stored profile id or by inline form values
	 * (test-before-save browsing with unsaved credentials).
	 */
	async browse(args = {}) {
		const { path } = args
		let profile
		if (args.id) {
			profile = loadProfiles().find((p) => p.id === args.id)
			if (!profile) throw new Error(`profile not found: ${args.id}`)
		} else if (args.profile?.host && args.profile?.user) {
			const f = args.profile
			profile = {
				id: `form-${f.host}-${f.user}`,
				name: f.name || `${f.user}@${f.host}`,
				host: String(f.host).trim(),
				port: Number(f.port) || 22,
				user: String(f.user).trim(),
				auth: f.auth === 'key' ? 'key' : 'password',
				password: f.password || '',
				keyPath: f.key_path || f.keyPath || '',
				passphrase: f.passphrase || '',
			}
		} else {
			throw new Error('browse needs a stored id or host+user')
		}
		let conn = this.connections.get(profile.id)
		if (!conn || conn.state !== 'connected') {
			await this.disconnect(profile.id)
			await this.openConnection(profile)
			conn = this.connections.get(profile.id)
			conn.autoOpened = true
		}
		const abs = await conn.realpath(path || '.')
		const home = await conn.home()
		const entries = await conn.listDir(abs)
		return { path: abs, home, platform: conn.platform, entries }
	}

	/** Close a connection that was opened only for directory browsing. */
	async browseClose(id) {
		if (!id) return { ok: true }
		const conn = this.connections.get(id)
		if (conn?.autoOpened) await this.disconnect(id)
		return { ok: true }
	}

	/** Clear the pinned host fingerprint (explicit re-trust). */
	resetFingerprint(id) {
		resetFingerprint(id)
		return { ok: true }
	}

	/**
	 * Persist the remote working directory picked in the workspace directory
	 * flow. The binding is what makes a session develop on the remote: the
	 * system prompt advertises it and the remote_* tools resolve relative
	 * paths (and remote_exec's default cwd) against it.
	 */
	bind(id, path) {
		const profiles = loadProfiles()
		const p = profiles.find((x) => x.id === id)
		if (!p) throw new Error('profile not found: ' + id)
		p.bindPath = String(path || '').trim()
		p.boundAt = p.bindPath ? new Date().toISOString() : ''
		saveProfiles(profiles)
		return this.statusOf(p)
	}

	/**
	 * Resolve a possibly-relative remote path against the profile's bound
	 * directory. Absolute POSIX (/...), Windows drive (C:/...) and UNC
	 * (backslash-backslash...) paths pass through untouched; a profile
	 * without a binding passes the path through untouched as well.
	 */
	resolveBound(id, path) {
		const raw = String(path ?? '')
		if (!raw) return raw
		if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(raw)) return raw
		const p = loadProfiles().find((x) => x.id === id)
		const base = p?.bindPath
		if (!base) return raw
		const sep = /^[A-Za-z]:/.test(base) || base.includes('\\') ? '\\' : '/'
		return base.replace(/[\\/]+$/, '') + sep + raw
	}

	/**
	 * Prefix one shell command with a cd into the profile's bound directory
	 * (remote_exec's default working directory). Profiles without a binding
	 * run the command unchanged.
	 */
	withDefaultCwd(id, command, platform) {
		const p = loadProfiles().find((x) => x.id === id)
		if (!p?.bindPath) return command
		const dir = p.bindPath
		if (platform === 'win32') return 'cd /d "' + dir.replace(/"/g, '""') + '" && ' + command
		return "cd '" + dir.replace(/'/g, "'\\''") + "' && " + command
	}

	/** Profiles with a bound working directory, most recently bound first. */
	boundContexts() {
		return loadProfiles()
			.filter((p) => p.bindPath)
			.sort((a, b) => String(b.boundAt || '').localeCompare(String(a.boundAt || '')))
	}

	statusOf(profile, conn) {
		const live = conn || this.connections.get(profile.id)
		const status = live
			? live.state === 'connected'
				? 'connected'
				: live.state === 'connecting'
					? 'connecting'
					: 'disconnected'
			: 'disconnected'
		const last = live?.lastError || this.lastErrors.get(profile.id) || null
		return {
			id: profile.id,
			name: this.displayName(profile),
			host: profile.host,
			port: profile.port,
			user: profile.user,
			auth: profile.auth,
			keyPath: profile.keyPath || '',
			bindPath: profile.bindPath || '',
			boundAt: profile.boundAt || '',
			hostFingerprint: profile.hostFingerprint || '',
			status,
			platform: live?.platform || null,
			lastError: last ? { code: last.code, zh: last.zh, en: last.en } : null,
			secretStore: this.secrets.mode,
		}
	}

	statusAll() {
		return loadProfiles().map((p) => this.statusOf(p))
	}

	closeAll() {
		for (const conn of this.connections.values()) conn.close()
		this.connections.clear()
		this.lastErrors.clear()
	}
}

export const name = 'remote-ssh'

export const inject = ['tools']

/** Attach a classified error shape to anything thrown out of an RPC call. */
function withClassified(err) {
	if (!err.classified) err.classified = classifyError(err)
	return err
}

/**
 * The package-private RPC surface shared by the browser UI (client.js) and
 * any other consumer: method name -> handler(args) -> pure-JSON result.
 */
export function rpcTable(manager, workspaces) {
	return {
		...workspaces ? workspaceRpc(workspaces) : {},
		'remote.list': async () => manager.statusAll(),
		'remote.save': async (args) => {
			const profile = await manager.saveProfile(args?.profile || {})
			return { ok: true, profile, profiles: manager.statusAll() }
		},
		'remote.delete': async (args) => {
			await manager.deleteProfile(String(args?.id || ''))
			return { ok: true, profiles: manager.statusAll() }
		},
		'remote.connect': async (args) => manager.connect(String(args?.id || '')),
		'remote.disconnect': async (args) => {
			await manager.disconnect(String(args?.id || ''))
			return { ok: true }
		},
		'remote.test': async (args) => manager.test(String(args?.id || '')),
		'remote.probe': async (args) => manager.probe(args || {}),
		'remote.browse': async (args) => manager.browse(args),
		'remote.browseClose': async (args) => manager.browseClose(String(args?.id || '')),
		'remote.resetFingerprint': async (args) => manager.resetFingerprint(String(args?.id || '')),
		'remote.bind': async (args) => {
			const profile = manager.bind(String(args?.id || ''), String(args?.path || ''))
			return { ok: true, profile }
		},
		/**
		 * Back-compatible alias of `remote.workspace.create` (v0.4 authored the
		 * preset only; a remote workspace is now a real sidebar workspace).
		 */
		'remote.workspace': async (args) => {
			if (!workspaces) throw new Error('remote workspaces are unavailable in this composition')
			const record = await workspaces.create({
				profileId: String(args?.id || args?.profileId || ''),
				root: String(args?.path || args?.root || ''),
			})
			return { ok: true, workspace: record, anchor: record.anchor }
		},
		'remote.exec': async (args) => {
			const id = String(args?.id || '')
			const conn = await manager.require(id)
			const command = manager.withDefaultCwd(id, String(args?.command || ''), conn.platform)
			const r = await conn.exec(command, { timeoutMs: args?.timeout_ms })
			return { code: r.code, signal: r.signal, stdout: r.stdout, stderr: r.stderr, platform: conn.platform }
		},
	}
}

/**
 * Packaged-mode browser bridge: a small JSON HTTP API on `ctx.webServer`.
 * Same-origin only (CSRF guard: an Origin header must match the request
 * Host), request bodies capped at 1 MiB. Uses ctx.inject so routes register
 * once the webServer service is available and re-register on service reload.
 * @param ctx - plugin context.
 * @param manager - the shared RemoteManager.
 * @param workspaces - the RemoteWorkspaces service, when one is wired.
 */
export function applyHttpBridge(ctx, manager, workspaces) {
	ctx.inject(['webServer'], (serverCtx) => {
		const webServer = serverCtx.webServer
		const table = rpcTable(manager, workspaces)

		const MAX_BODY = 1024 * 1024

		function sameOrigin(req) {
			const origin = req.headers?.origin
			if (!origin) return true // same-origin fetch/curl without Origin
			try {
				return new URL(origin).host === req.headers.host
			} catch {
				return false
			}
		}

		function readJsonBody(req) {
			return new Promise((resolve, reject) => {
				const chunks = []
				let size = 0
				req.on('data', (c) => {
					size += c.length
					if (size > MAX_BODY) {
						reject(Object.assign(new Error('request body too large'), { statusCode: 413 }))
						req.destroy()
						return
					}
					chunks.push(c)
				})
				req.on('end', () => {
					try {
						resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
					} catch {
						reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }))
					}
				})
				req.on('error', reject)
			})
		}

		function sendJson(res, status, data) {
			res.writeHead(status, { 'content-type': 'application/json' })
			res.end(JSON.stringify(data))
		}

		function register(path, fn) {
			const route = {
				kind: 'exact',
				path,
				handler: async (req, res) => {
					try {
						if (!sameOrigin(req)) {
							return sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
						}
						const body = await readJsonBody(req)
						sendJson(res, 200, await fn(body))
					} catch (err) {
						const status = err?.statusCode || 500
						const classified = withClassified(err).classified
						sendJson(res, status, {
							ok: false,
							error: String(err?.message || err),
							classified: classified === undefined ? undefined : { code: classified.code, zh: classified.zh, en: classified.en },
						})
					}
				},
			}
			serverCtx.effect(() => webServer.register(route))
		}

		for (const [method, fn] of Object.entries(table)) {
			const name = method === 'remote.list' ? 'profiles' : method.replace(/^remote\./, '')
			register('/dsh-remote/api/' + name, fn)
		}
	})
}

export function apply(ctx) {
	const manager = new RemoteManager()

	// Publish the manager for the world plugins (remote-fs/remote-shell)
	// loaded by authored presets in THIS process; withdrawn on unload so a
	// reload gap surfaces as an actionable error instead of a stale manager.
	// Before any wiring below, because an already-available service makes
	// `ctx.inject` fire during that call.
	globalThis[MANAGER_KEY] = manager

	// Remote workspaces: sidebar rows whose sessions run on the remote machine.
	// Wiring is service-optional, so a headless or preset-less composition keeps
	// working with the standalone remote_* tools alone.
	const workspaces = new RemoteWorkspaces({ manager })
	workspaces.attach(ctx)
	const table = rpcTable(manager, workspaces)

	// Package-private RPC consumed by the browser UI (client.js). `harness` is
	// provided by the dynamic-plugin runtime; when this bundle runs as a
	// packaged plugin, applyHttpBridge below serves the same surface over HTTP.
	if (typeof harness !== 'undefined') {
		for (const [method, fn] of Object.entries(table)) {
			harness.handle(method, async (args) => fn(args))
		}
	}

	// Upgrade secret storage to the credential seam when the service is
	// present (standard dsh compositions); minimal compositions keep the file.
	ctx.inject(['credentials'], (credCtx) => {
		void manager.adoptCredentials(credCtx.credentials)
	})

	applyHttpBridge(ctx, manager, workspaces)
	applyRemoteTools(ctx, manager)

	// Close every connection when the plugin unloads.
	ctx.effect(() => () => {
		if (globalThis[MANAGER_KEY] === manager) delete globalThis[MANAGER_KEY]
		manager.closeAll()
	})
}

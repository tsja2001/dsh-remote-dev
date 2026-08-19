/**
 * Shared support for the remote world plugins (remote-fs / remote-shell).
 *
 * A preset composition loads those plugins in the HOST process, where the
 * plugin's RemoteManager already owns profiles, credentials, and live
 * connections. The manager publishes itself on a Symbol registry key at
 * apply() time; the world plugins acquire the connection for their baked
 * profile id through it, so one SSH connection is shared between the UI,
 * the remote_* tools, and a session's whole remote world.
 */

/** Registry key the host plugin stashes its manager under. */
export const MANAGER_KEY = Symbol.for('dsh-remote-ssh.manager')

/** Read the host manager, or fail with an actionable message. */
export function hostManager() {
	const manager = globalThis[MANAGER_KEY]
	if (!manager) {
		throw new Error(
			'remote-ssh world: the remote-ssh host plugin is not loaded in this process; '
				+ 'install/enable it in this profile before opening a remote session.',
		)
	}
	return manager
}

/** POSIX single-quote escape for shell fragments. */
export function posixQuote(value) {
	return "'" + String(value).replaceAll("'", "'\\''") + "'"
}

/** Windows cmd-safe double-quote escape. */
export function winQuote(value) {
	return '"' + String(value).replaceAll('"', '""') + '"'
}

/**
 * Build the per-world support object shared by remote-fs and remote-shell.
 *
 * @param {object} _ctx - the preset-row cordis context (unused for now).
 * @param {object} config - { profile, root } baked by the authoring RPC.
 */
export function worldSupport(_ctx, config = {}) {
	const profileId = String(config.profile || '')
	if (!profileId) throw new Error('remote-ssh world: config.profile is required')
	const root = String(config.root || '')
	let platformCache = null
	let acquiring = null
	const support = {
		get root() {
			return root
		},
		get platformCache() {
			return platformCache
		},
		/** Acquire the shared connection, auto-connecting when needed. */
		async acquire(reason) {
			if (!acquiring) {
				acquiring = hostManager()
				// manager.connection(id) returns the live RemoteConnection
				// (manager.connect() resolves to a status snapshot instead).
				.connection(profileId)
				.then(async (conn) => {
					platformCache = conn.platform || (await conn.detectPlatform())
					return conn
				})
				.finally(() => {
					// let a later call retry after a failure
					acquiring = null
				})
			}
			return acquiring
		},
		/** Best-effort platform without connecting (defaults posix). */
		async platformOf(conn) {
			if (!platformCache) platformCache = conn.platform || 'posix'
			return platformCache
		},
		isPosix() {
			return platformCache !== 'windows'
		},
	}
	return support
}

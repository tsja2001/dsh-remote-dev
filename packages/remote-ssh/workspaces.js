/**
 * Remote workspaces: a remote directory that behaves like a local one.
 *
 * The sidebar's "Add workspace" flow adopts a HOST directory — the registry
 * canonicalizes it through `fs.realpath` and groups sessions by their header
 * cwd — so a `remote://` path can never be a workspace record. What can is an
 * ANCHOR: an empty local directory this plugin owns, one per remote root,
 * whose only job is to be the stable identity the registry groups by.
 * Everything a session then does happens on the remote machine, because the
 * session composes the workspace's generated agent preset, whose `fs` and
 * `shell` are this plugin's SSH implementations.
 *
 *   sidebar row / session cwd   →  $DSH_HOME/remote-workspaces/<machine>/<dir>
 *   files, commands, {{cwd}}    →  <machine>:<remote root>  (over SSH)
 *
 * Three moving parts live here:
 *
 * 1. The record store (`$DSH_HOME/remote/workspaces.json`, 0600): the
 *    anchor ⇄ (profile, remote root, preset) mapping, which is the only
 *    durable statement that a workspace is remote.
 * 2. Workspace registration: the anchor directory is created and adopted
 *    through `ctx.workspaceRegistry`, then titled `dir [SSH: machine]`. The
 *    api-proxy pushes the new row to every connected browser by itself, so
 *    the sidebar updates without the client doing anything.
 * 3. Automatic composition: on `agent/created`, a session whose cwd is an
 *    anchor is recomposed onto that workspace's preset and the choice is
 *    appended to its log, so a later resume rebuilds the same remote world.
 *    `agent/pre-step` awaits an in-flight recomposition, so a prompt that
 *    arrives inside the (millisecond) window still runs remotely.
 *
 * @module dsh-remote-dev/workspaces
 */

import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'
import {
	ensureRemotePreset, listRemotePresets, presetIdFor, presetNeedsRefresh,
	REMOTE_PRESET_PREFIX, removeRemotePreset,
} from './presets.js'

/** The DSH home directory (presets and plugin state live under it). */
export function dshHome() {
	return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** Where the anchor directories live. */
export function anchorRoot(home = dshHome()) {
	return join(home, 'remote-workspaces')
}

/** The record file. */
export function recordsFile(home = dshHome()) {
	return join(home, 'remote', 'workspaces.json')
}

/** Filesystem-safe segment for a machine name or a remote path tail. */
function slug(value, fallback) {
	const clean = String(value || '')
		.replace(/[\\/]+$/, '')
		.split(/[\\/]/)
		.filter(Boolean)
		.at(-1) || ''
	const safe = clean.replace(/[^\w.@ +-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48)
	return safe || fallback
}

/** Stable record id for one (profile, remote root) pair. */
export function workspaceIdFor(profileId, root) {
	return createHash('sha256').update(String(profileId) + '\0' + String(root)).digest('hex').slice(0, 12)
}

/** Read the whole record list (an unreadable or malformed file reads empty). */
export function loadRecords(home = dshHome()) {
	try {
		const parsed = JSON.parse(readFileSync(recordsFile(home), 'utf8'))
		return Array.isArray(parsed) ? parsed.filter(record => record && typeof record === 'object') : []
	} catch {
		return []
	}
}

/** Write the whole record list with 0600 permissions. */
export function saveRecords(records, home = dshHome()) {
	const file = recordsFile(home)
	mkdirSync(join(file, '..'), { recursive: true })
	writeFileSync(file, JSON.stringify(records, null, 2))
	try {
		chmodSync(file, 0o600)
	} catch {
		/* non-posix filesystem */
	}
}

/**
 * The local directory that stands in for one remote root.
 *
 * Named after the machine and the remote directory rather than after a hash,
 * because it is what a person sees in a path tooltip and in `session.cwd`.
 * The record id disambiguates two remote roots whose last segment collides.
 */
export function anchorPathFor({ home = dshHome(), profileId, profileName, root }) {
	const machine = slug(profileName || profileId, 'machine')
	const tail = slug(root, 'root')
	return join(anchorRoot(home), machine, `${tail}-${workspaceIdFor(profileId, root).slice(0, 6)}`)
}

/** Display title of a remote workspace row (VS Code's `folder [SSH: host]`). */
export function titleFor({ root, label }) {
	const tail = String(root).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).at(-1) || root
	return `${tail} [SSH: ${label}]`
}

/**
 * Create the anchor directory and drop a marker explaining what it is.
 *
 * The marker is for a person who finds the directory on disk (and for this
 * plugin's own cleanup); nothing reads it at runtime, and no session tool
 * ever sees it — a remote session's filesystem is the remote machine.
 */
async function ensureAnchor(anchor, record) {
	mkdirSync(anchor, { recursive: true });
	await writeFile(
		join(anchor, '.dsh-remote-workspace.json'),
		JSON.stringify(
			{
				note: 'Anchor directory for a dsh-remote-ssh remote workspace. Sessions grouped '
					+ 'under it run their files and commands on the remote machine below. Safe to '
					+ 'delete once the workspace is removed.',
				profile: record.profileId,
				machine: record.label,
				remoteRoot: record.root,
				target: record.target,
				preset: record.presetId,
			},
			null,
			2,
		) + '\n',
		'utf8',
	)
	// The registry canonicalizes with realpath; store what it will store.
	return await realpath(anchor)
}

/** Guard: only ever delete inside our own anchor root. */
function insideAnchorRoot(anchor, home) {
	const base = resolvePath(anchorRoot(home)) + sep
	return resolvePath(anchor).startsWith(base)
}

/**
 * Remote-workspace service: the record store plus the harness wiring that
 * makes a record behave like a workspace.
 */
export class RemoteWorkspaces {
	/**
	 * @param {object} options
	 * @param {() => string} [options.home] - DSH home resolver (tests override it).
	 * @param {object} options.manager - the shared RemoteManager (profiles, connections).
	 */
	constructor(options = {}) {
		this.homeOf = options.home || dshHome
		this.manager = options.manager
		/** Cordis context of the host plugin, once applied. */
		this.ctx = null
		/** `agentPresets` service, while one is composed. */
		this.presets = null
		/** `workspaceRegistry` service, while one is composed. */
		this.registry = null
		/** sessionId -> in-flight recomposition (awaited before the first step). */
		this.pending = new Map()
	}

	get home() {
		return this.homeOf()
	}

	/** Every stored record. */
	list() {
		return loadRecords(this.home)
	}

	/** The record for one anchor directory, or undefined. */
	byAnchor(path) {
		if (!path) return undefined
		const wanted = resolvePath(String(path))
		return this.list().find(record => record.anchor && resolvePath(record.anchor) === wanted)
	}

	/** The record for one id, or undefined. */
	byId(id) {
		return this.list().find(record => record.id === String(id))
	}

	/** Log a warning through the host logger when there is one. */
	warn(message) {
		const logger = this.ctx?.logger
		if (logger?.warn) logger.warn(message)
	}

	/**
	 * The base composition every remote preset is derived from: the
	 * deployment's default preset, or the first healthy non-remote one when
	 * the default is missing, broken, or itself a remote workspace.
	 * @returns {Promise<{id: string, path: string, text: string} | null>}
	 */
	async resolveBase() {
		const presets = this.presets
		if (!presets) return null
		const usable = preset => preset && !preset.broken && !preset.id.startsWith(REMOTE_PRESET_PREFIX)
		let chosen = null
		try {
			const preferred = await presets.resolve()
			if (usable(preferred)) chosen = preferred
		} catch {
			/* an unknown or unreadable default falls through to the roster scan */
		}
		if (!chosen) {
			try {
				chosen = (await presets.list()).find(usable) || null
			} catch {
				chosen = null
			}
		}
		if (!chosen) return null
		try {
			return { id: chosen.id, path: chosen.path, text: await readFile(chosen.path, 'utf8') }
		} catch {
			return null
		}
	}

	/**
	 * Author (or refresh) the preset of one record.
	 * @param {object} record - the stored record.
	 * @param {object} [options] - { force } to rewrite even when the stamp matches.
	 */
	async refreshPreset(record, options = {}) {
		const base = await this.resolveBase()
		if (!options.force && !(await presetNeedsRefresh({ home: this.home, presetId: record.presetId, base }))) {
			return { presetId: record.presetId, wrote: false }
		}
		return await ensureRemotePreset({
			home: this.home,
			profileId: record.profileId,
			profileName: record.label,
			root: record.root,
			target: record.target,
			base,
		})
	}

	/**
	 * Create (or reuse) the remote workspace for one remote directory.
	 *
	 * Idempotent in every part: the same (profile, root) resolves to the same
	 * record id, anchor, preset id, and — because `workspaceRegistry.create`
	 * is itself idempotent per canonical path — the same workspace row.
	 *
	 * @param {object} options
	 * @param {string} options.profileId - remote profile id.
	 * @param {string} options.root - absolute remote directory.
	 * @returns {Promise<object>} the stored record, with `workspaceId` when a registry is composed.
	 */
	async create({ profileId, root }) {
		const id = String(profileId || '')
		const remoteRoot = String(root || '').trim()
		if (!id) throw new Error('remote workspace: a machine must be selected')
		if (!remoteRoot) throw new Error('remote workspace: a remote directory is required')
		const profile = this.manager.statusAll().find(entry => entry.id === id)
		if (!profile) throw new Error('remote workspace: unknown machine ' + id)
		const label = profile.name || id
		const target = `remote://${profile.user}@${profile.host}:${profile.port}${remoteRoot}`
		const home = this.home

		const record = {
			id: workspaceIdFor(id, remoteRoot),
			profileId: id,
			label,
			root: remoteRoot,
			target,
			presetId: presetIdFor(id, remoteRoot),
			anchor: anchorPathFor({ home, profileId: id, profileName: label, root: remoteRoot }),
			title: titleFor({ root: remoteRoot, label }),
			createdAt: new Date().toISOString(),
		}
		record.anchor = await ensureAnchor(record.anchor, record)

		const preset = await this.refreshPreset(record, { force: true })
		record.baseId = preset.baseId || ''
		record.notes = preset.notes || []
		// Without a roster the generated preset can never be mounted, so the
		// sessions of this workspace would silently run on the HOST. The row is
		// still created (the binding is real), and the flag lets the UI say so.
		record.composable = Boolean(this.presets)

		// The profile binding keeps the standalone remote_* tools pointed at
		// the same directory, so both worlds agree on "the" working directory.
		try {
			this.manager.bind(id, remoteRoot)
		} catch {
			/* binding is a convenience for the tools, never a create failure */
		}

		const registered = await this.register(record)
		if (registered) record.workspaceId = registered

		const records = loadRecords(home).filter(entry => entry.id !== record.id)
		records.unshift(record)
		saveRecords(records, home)
		return record
	}

	/**
	 * Adopt one record's anchor as a real workspace row and title it.
	 * @returns {Promise<string | undefined>} the workspace id, when a registry is composed.
	 */
	async register(record) {
		const registry = this.registry
		if (!registry) return undefined
		const workspace = await registry.create(record.anchor, record.title)
		if (workspace.title !== record.title && typeof workspace.setTitle === 'function') {
			// `create` never renames an existing row; a record whose machine was
			// renamed still gets its current title.
			await workspace.setTitle(record.title).catch(() => {})
		}
		return workspace.id
	}

	/**
	 * Remove one remote workspace: the sidebar row and this plugin's record.
	 *
	 * The generated preset is KEPT by default, and with it the anchor: every
	 * session ever created in this workspace records that preset id in its
	 * log, and resuming one composes it by id — deleting it would turn old
	 * conversations into sessions that cannot open. `deletePreset` is the
	 * explicit "I am done with this machine" cleanup. Session logs themselves
	 * are never touched either way.
	 * @param {object} options - { id, deletePreset }.
	 */
	async remove({ id, deletePreset = false }) {
		const record = this.byId(id)
		if (!record) return { ok: true, removed: false }
		const home = this.home
		if (this.registry && record.workspaceId) {
			try {
				await this.registry.delete(record.workspaceId)
			} catch (error) {
				this.warn(`remote-ssh: could not unregister workspace ${record.workspaceId}: ${String(error)}`)
			}
		}
		if (deletePreset) {
			await removeRemotePreset({ home, presetId: record.presetId }).catch(() => {})
			if (insideAnchorRoot(record.anchor, home)) {
				await rm(record.anchor, { recursive: true, force: true }).catch(() => {})
				// The per-machine directory is ours too; rmdir declines while
				// another workspace of the same machine still lives there.
				await rmdir(dirname(record.anchor)).catch(() => {})
			}
		}
		saveRecords(loadRecords(home).filter(entry => entry.id !== record.id), home)
		return { ok: true, removed: true, presetKept: !deletePreset }
	}

	/**
	 * Bring every stored record back in line with the host at startup: the
	 * anchor exists, the preset exists and matches the current base, and the
	 * workspace id points at the row that actually carries this anchor.
	 *
	 * Deliberately NOT a re-registration: deleting a workspace in the sidebar
	 * is an operator decision, and re-creating the row on the next boot would
	 * overrule it. A record whose row is gone keeps its preset (old sessions
	 * still resume into it) and is offered for re-adding in the remote picker.
	 */
	async reconcile() {
		const home = this.home
		const records = loadRecords(home)
		if (!records.length) return records
		const rows = this.registry ? this.registry.list() : []
		let dirty = false
		for (const record of records) {
			try {
				record.anchor = await ensureAnchor(record.anchor, record)
				const preset = await this.refreshPreset(record)
				if (preset.baseId !== undefined && preset.baseId !== record.baseId) {
					record.baseId = preset.baseId
					dirty = true
				}
				const row = rows.find(candidate => candidate.path === record.anchor)
				const workspaceId = row ? row.id : undefined
				if (workspaceId !== record.workspaceId) {
					record.workspaceId = workspaceId
					dirty = true
				}
			} catch (error) {
				this.warn(`remote-ssh: could not restore remote workspace "${record.title}": ${String(error)}`)
			}
		}
		if (dirty) saveRecords(records, home)
		return records
	}

	/**
	 * Compose one freshly created agent onto its remote workspace's preset.
	 *
	 * Returns undefined for every local session (the overwhelmingly common
	 * case) after one map lookup, so the hook costs nothing outside remote
	 * workspaces.
	 * @param {object} agent - the agent published by the registry.
	 * @returns {Promise<void> | undefined} the in-flight recomposition, when one started.
	 */
	composeFor(agent) {
		const presets = this.presets
		if (!presets) return undefined
		const cwd = agent?.session?.header?.cwd
		if (!cwd) return undefined
		const record = this.byAnchor(cwd)
		if (!record) return undefined
		let composed
		try {
			composed = presets.composedPreset(agent.ctx)
		} catch {
			return undefined
		}
		if (composed === record.presetId) return undefined
		const work = (async () => {
			await this.refreshPreset(record)
			await presets.recompose(agent.ctx, record.presetId)
			// Recorded only after the swap committed, exactly as the browser's
			// own preset switch does: the log is what a later resume reads, so
			// this session rebuilds the same remote world without this hook.
			agent.session.append('agent-preset/selected', { agentPreset: record.presetId })
		})().catch((error) => {
			this.warn(
				`remote-ssh: session "${agent.id}" could not compose remote workspace "${record.title}" `
				+ `(preset ${record.presetId}): ${String(error)}`,
			)
		})
		this.pending.set(agent.id, work)
		void work.finally(() => {
			if (this.pending.get(agent.id) === work) this.pending.delete(agent.id)
		})
		return work
	}

	/**
	 * Wire the service into the host composition.
	 *
	 * Both services are optional: a deployment without `workspaceRegistry`
	 * (headless, ACP) simply has no sidebar to register into, and one without
	 * `agentPresets` composes no presets at all — in both cases the plugin
	 * degrades to its standalone `remote_*` tools instead of failing.
	 * @param {object} ctx - the host plugin context.
	 */
	attach(ctx) {
		this.ctx = ctx

		ctx.inject(['workspaceRegistry'], (registryCtx) => {
			this.registry = registryCtx.workspaceRegistry
			// Restore rows a previous run created, then heal anything missing.
			void this.reconcile()
			registryCtx.effect(() => () => {
				if (this.registry === registryCtx.workspaceRegistry) this.registry = null
			})
		})

		ctx.inject(['agentPresets'], (presetCtx) => {
			this.presets = presetCtx.agentPresets
			presetCtx.effect(() => presetCtx.on('agent/created', ({ agent }) => {
				// Synchronous listener: a throw here would veto the session's
				// publication, so the whole swap runs on its own promise and
				// reports failures to the log instead.
				try {
					this.composeFor(agent)
				} catch (error) {
					this.warn(`remote-ssh: remote workspace hook failed: ${String(error)}`)
				}
			}))
			presetCtx.effect(() => () => {
				if (this.presets === presetCtx.agentPresets) this.presets = null
			})
		})

		// Close the (millisecond) window between publication and the swap: a
		// prompt sent the instant a session opens waits for its remote world
		// instead of running one step against the host composition.
		ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
			const work = this.pending.get(payload?.agent?.id)
			if (work) await work
			return next()
		}))

		ctx.effect(() => () => {
			this.pending.clear()
			this.ctx = null
		})
	}

	/**
	 * Records joined with what the host currently knows: whether the preset
	 * is still on disk and whether the workspace row still exists.
	 */
	async status() {
		const presets = new Set((await listRemotePresets({ home: this.home })).map(entry => entry.presetId))
		const rows = this.registry ? this.registry.list() : []
		return this.list().map(record => ({
			...record,
			presetPresent: presets.has(record.presetId),
			registered: rows.some(row => row.id === record.workspaceId || row.path === record.anchor),
		}))
	}
}

/** RPC methods this module contributes to the plugin's shared table. */
export function workspaceRpc(workspaces) {
	return {
		/**
		 * Create the remote workspace for a picked directory: anchor, preset,
		 * registry row. The browser then reports the anchor to the harness's
		 * own adopt flow, which is idempotent and opens a session in it.
		 */
		'remote.workspace.create': async (args) => {
			const record = await workspaces.create({
				profileId: String(args?.id || args?.profileId || ''),
				root: String(args?.path || args?.root || ''),
			})
			return { ok: true, workspace: record, anchor: record.anchor }
		},
		'remote.workspace.list': async () => ({ ok: true, workspaces: await workspaces.status() }),
		'remote.workspace.remove': async (args) => await workspaces.remove({
			id: String(args?.id || ''),
			deletePreset: Boolean(args?.deletePreset),
		}),
		'remote.workspace.refresh': async () => {
			const records = await workspaces.reconcile()
			return { ok: true, workspaces: records }
		},
	}
}

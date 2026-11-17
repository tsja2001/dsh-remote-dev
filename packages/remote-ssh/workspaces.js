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
 * 3. Runtime preset registration and composition: `agent/created` is a serial,
 *    awaited publication boundary in DSH 0.2.2. Its listener finishes binding
 *    and verifying the remote world before the loop can capture tools. A
 *    failure rejects publication; a remote session never falls back to local.
 *
 * @module dsh-remote-dev/workspaces
 */

import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { readFile, readdir, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'
import {
	ensureRemotePreset, listRemotePresets, presetIdFor, readPersistedBase, readRemotePresetDefinition,
	readSourceStamp, REALM_SERVICES, REMOTE_PRESET_ID, REMOTE_PRESET_PREFIX, removeRemotePreset,
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
	try {
		// Both sides must use the same identity (/var is /private/var on macOS).
		const base = realpathSync(anchorRoot(home)) + sep
		return realpathSync(anchor).startsWith(base)
	} catch {
		return false
	}
}

/** Recover legacy historical anchors from this plugin's own marker layout. */
async function historicalAnchors(home) {
	const found = new Map()
	const directories = async path => {
		try { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()) }
		catch (error) { if (error.code === 'ENOENT') return []; throw error }
	}
	for (const machine of await directories(anchorRoot(home))) {
		const machinePath = join(anchorRoot(home), machine.name)
		for (const entry of await directories(machinePath)) {
			const anchor = await realpath(join(machinePath, entry.name))
			try {
				const marker = JSON.parse(await readFile(join(anchor, '.dsh-remote-workspace.json'), 'utf8'))
				if (REMOTE_PRESET_ID.test(marker.preset) && marker.profile && marker.remoteRoot) {
					found.set(marker.preset, { anchor, profileId: marker.profile, root: marker.remoteRoot,
						label: marker.machine, target: marker.target })
				}
			} catch { /* An unrelated or invalid marker never supplies a binding. */ }
		}
	}
	return found
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
		/** One registry incarnation owns its own registrations and async disposers. */
		this.presetState = null
		/** sessionId -> the awaited publication transaction. */
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
		const record = this.list().find(record => record.anchor && resolvePath(record.anchor) === wanted)
		if (record) return record
		// Removing a sidebar workspace deliberately preserves its anchor and
		// preset. A new/resumed session there must still be recognized as remote.
		if (!insideAnchorRoot(wanted, this.home)) return undefined
		try {
			const marker = JSON.parse(readFileSync(join(wanted, '.dsh-remote-workspace.json'), 'utf8'))
			if (!REMOTE_PRESET_ID.test(marker.preset) || !marker.profile || !marker.remoteRoot) return { anchor: wanted, invalidBinding: true }
			return { anchor: wanted, presetId: marker.preset, profileId: marker.profile,
				root: marker.remoteRoot, label: marker.machine || marker.profile, target: marker.target }
		} catch {
			return { anchor: wanted, invalidBinding: true }
		}
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

	stateFor(presets = this.presets) {
		if (!presets) return null
		if (this.presetState?.presets === presets) return this.presetState
		this.presetState = { presets, active: true, registrations: new Map(), tasks: new Map(), ready: Promise.resolve() }
		return this.presetState
	}

	/**
	 * readDocument is the current runtime contract; roster rows carry no path
	 * or declaring base URL. Do not resolve relative names against this plugin.
	 * Reading the default document avoids resolve/list's diagnostic settlement
	 * inside a Host plugin's activation (which would wait for that same plugin).
	 */
	async resolveBase(state = this.stateFor(), preferredId) {
		const presets = state?.presets
		if (!presets) return null
		if (typeof presets.readDocument !== 'function' || typeof presets.register !== 'function') {
			throw new Error('remote workspaces require the DSH 0.2.2 preset readDocument/register API')
		}
		const id = preferredId || presets.defaultId
		if (!id || id.startsWith(REMOTE_PRESET_PREFIX)) {
			throw new Error('remote workspaces require a non-remote base preset')
		}
		const document = await presets.readDocument(id)
		if (typeof document?.content !== 'string') throw new Error(`preset "${id}" publishes no composition document`)
		return { id: document.agentPreset || id, text: document.content }
	}

	/** Serialize refresh/re-registration of an identity, including startup races. */
	async refreshPreset(record, options = {}) {
		if (record.presetId !== presetIdFor(record.profileId, record.root)) {
			throw new Error(`remote preset "${record.presetId}" does not match its persisted binding`)
		}
		const state = options.state || this.stateFor()
		const refresh = async () => {
			if (state && !state.active) throw new Error('remote preset registry is unloading')
			let base
			try {
				base = await this.resolveBase(state, options.baseId)
			} catch (error) {
				if (!options.persisted) throw error
				base = await readPersistedBase({ home: this.home, presetId: record.presetId, baseId: options.baseId })
			}
			const authored = await ensureRemotePreset({
				home: this.home, profileId: record.profileId, profileName: record.label,
				root: record.root, target: record.target, anchor: record.anchor, base,
			})
			if (!state) return authored
			const definition = await readRemotePresetDefinition({ home: this.home, presetId: record.presetId })
			const hash = createHash('sha256').update(JSON.stringify(definition)).digest('hex')
			const previous = state.registrations.get(record.presetId)
			if (previous?.hash === hash) return authored
			if (previous) {
				await previous.dispose()
				state.registrations.delete(record.presetId)
			}
			if (!state.active) throw new Error('remote preset registry is unloading')
			const dispose = await state.presets.register(definition)
			if (typeof dispose !== 'function') throw new Error('preset registration returned no disposer')
			if (!state.active) {
				await dispose()
				throw new Error('remote preset registry unloaded during registration')
			}
			state.registrations.set(record.presetId, { hash, dispose })
			return authored
		}
		if (!state) return refresh()
		const work = (state.tasks.get(record.presetId) || Promise.resolve()).catch(() => {}).then(refresh)
		state.tasks.set(record.presetId, work)
		const forget = () => { if (state.tasks.get(record.presetId) === work) state.tasks.delete(record.presetId) }
		void work.then(forget, forget)
		return work
	}

	/** Unregister every owned definition, retaining revisions leased by Agents. */
	async disposePresets(state = this.presetState) {
		if (!state) return
		state.active = false
		if (this.presetState === state) {
			this.presetState = null
			this.presets = null
		}
		await Promise.allSettled([...state.tasks.values()])
		const results = await Promise.allSettled([...state.registrations.values()].map(entry => entry.dispose()))
		state.registrations.clear()
		const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
		if (failures.length) throw new AggregateError(failures, 'remote preset teardown failed')
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
		await this.stateFor()?.ready
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
		// A missing registry leaves the standalone tools usable, but opening a
		// session under this anchor is rejected by the publication guard.
		record.composable = Boolean(this.stateFor()?.registrations.has(record.presetId))

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
			const state = this.stateFor()
			await state?.tasks.get(record.presetId)
			const registration = state?.registrations.get(record.presetId)
			if (registration) {
				await registration.dispose()
				state.registrations.delete(record.presetId)
			}
			await removeRemotePreset({ home, presetId: record.presetId })
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
	async reconcile(options = {}) {
		const home = this.home
		const records = loadRecords(home)
		const state = options.state || this.stateFor()
		const rows = this.registry ? this.registry.list() : []
		const restored = new Set()
		for (const record of records) {
			try {
				record.anchor = await ensureAnchor(record.anchor, record)
				const preset = await this.refreshPreset(record, { state })
				record.baseId = preset.baseId
				record.composable = Boolean(state?.registrations.has(record.presetId))
				restored.add(record.presetId)
				const row = rows.find(candidate => candidate.path === record.anchor)
				record.workspaceId = row?.id
			} catch (error) {
				record.composable = false
				this.warn(`remote-ssh: could not restore remote workspace "${record.title}": ${String(error)}`)
			}
		}
		if (records.length) saveRecords(records, home)
		// Historical sessions can name a preset even after its workspace record
		// was removed. The host no longer discovers these directories itself.
		const anchors = state ? await historicalAnchors(home) : new Map()
		if (state) for (const preset of await listRemotePresets({ home })) {
			if (restored.has(preset.presetId)) continue
			try {
				if (!preset.profile || !preset.root) throw new Error('persisted preset has no trustworthy profile/root stamp')
				const marker = anchors.get(preset.presetId)
				if (marker && (marker.profileId !== preset.profile || marker.root !== preset.root)) throw new Error('historical anchor does not match its preset stamp')
				await this.refreshPreset({ presetId: preset.presetId, profileId: preset.profile,
					root: preset.root, label: preset.name || marker?.label, target: preset.target || marker?.target,
					anchor: preset.anchor || marker?.anchor },
				{ state, baseId: preset.baseId || undefined, persisted: true })
			} catch (error) {
				this.warn(`remote-ssh: could not register historical preset "${preset.presetId}": ${String(error)}`)
			}
		}
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
		const record = this.byAnchor(agent?.session?.header?.cwd)
		const presets = this.presets
		const composed = presets?.composedPreset(agent.ctx)
		if (!record && !composed?.startsWith(REMOTE_PRESET_PREFIX)) return undefined
		if (this.pending.has(agent.id)) return this.pending.get(agent.id)
		const work = (async () => {
			if (record?.invalidBinding) throw new Error('remote workspace anchor has no valid persisted binding')
			const state = this.stateFor()
			if (!state) throw new Error('remote workspace cannot run: the agent preset registry is unavailable')
			await state.ready
			let binding = record
			if (!binding) {
				if (!REMOTE_PRESET_ID.test(composed)) throw new Error('invalid remote preset identity')
				const stamp = await readSourceStamp(join(this.home, '.agent-presets', composed))
				if (!stamp?.profileId || !stamp?.root) throw new Error(`remote preset "${composed}" has no persisted binding`)
				binding = { presetId: composed, profileId: stamp.profileId, root: stamp.root,
					label: stamp.profileName, target: stamp.target, anchor: stamp.anchor }
			}
			if (composed !== binding.presetId) {
				if (binding.id || !state.registrations.has(binding.presetId)) {
					await this.refreshPreset(binding, { state, persisted: !binding.id, baseId: binding.baseId })
				}
				await presets.recompose(agent.ctx, binding.presetId)
			}
			this.assertRemoteServices(agent, binding)
			if (composed !== binding.presetId) {
				agent.session.append('agent-preset/selected', { agentPreset: binding.presetId })
			}
		})()
		this.pending.set(agent.id, work)
		const forget = () => { if (this.pending.get(agent.id) === work) this.pending.delete(agent.id) }
		// Observe cleanup on both outcomes without converting the rejection into
		// success or leaving a rejected finally() promise behind.
		void work.then(forget, forget)
		return work
	}

	assertRemoteServices(agent, record) {
		const presets = this.presets
		if (!presets || presets.composedPreset(agent.ctx) !== record.presetId || typeof presets.serviceFor !== 'function') {
			throw new Error(`remote workspace cannot bind preset "${record.presetId}"`)
		}
		for (const name of REALM_SERVICES) {
			const service = presets.serviceFor(agent, name)
			if (!service || service.profileId !== record.profileId || service.root !== record.root) {
				throw new Error(`remote workspace preset "${record.presetId}" has no matching remote ${name} service`)
			}
		}
	}

	/** Guard later user preset switches/service loss before any model request. */
	async guardRemoteAgent(agent) {
		const record = this.byAnchor(agent?.session?.header?.cwd)
		const composed = this.presets?.composedPreset(agent.ctx)
		if (record) return this.assertRemoteServices(agent, record)
		if (!composed?.startsWith(REMOTE_PRESET_PREFIX)) return
		if (!REMOTE_PRESET_ID.test(composed)) throw new Error('invalid remote preset identity')
		const stamp = await readSourceStamp(join(this.home, '.agent-presets', composed))
		if (!stamp?.profileId || !stamp?.root) throw new Error(`remote preset "${composed}" has no persisted binding`)
		this.assertRemoteServices(agent, { presetId: composed, profileId: stamp.profileId, root: stamp.root })
	}

	/**
	 * Optional host services leave standalone tools available. Remote sessions
	 * themselves require a verified binding. The registry injection awaits
	 * startup registration so persisted ids are ready when the Host is ready.
	 */
	attach(ctx) {
		this.ctx = ctx
		// DSH 0.2.2 AgentRegistry.announce awaits this serial listener before
		// ReactLoopFactory releases queued work. pre-step runs AFTER tools.resolve
		// and prompt assembly and therefore cannot perform the composition swap.
		ctx.effect(() => ctx.on('agent/created', ({ agent }) => this.composeFor(agent)))
		ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
			await this.guardRemoteAgent(payload.agent)
			return next()
		}))
		ctx.inject(['workspaceRegistry'], (registryCtx) => {
			const registry = registryCtx.workspaceRegistry
			this.registry = registry
			registryCtx.effect(() => () => {
				if (this.registry === registry) this.registry = null
			})
		})
		const hasPresets = typeof ctx.get === 'function' ? ctx.get('agentPresets') !== undefined : Boolean(ctx.agentPresets)
		const presetFiber = ctx.inject(['agentPresets'], async (presetCtx) => {
			this.presets = presetCtx.agentPresets
			const state = this.stateFor()
			presetCtx.effect(() => () => this.disposePresets(state))
			state.ready = this.reconcile({ state })
			await state.ready
		})
		ctx.effect(() => () => {
			this.pending.clear()
			this.ctx = null
		})
		// Main apply awaits this when a registry is present. Awaiting a child
		// injection fiber is necessary: the parent's Fiber.await() alone does
		// not include that child's asynchronous startup work.
		return hasPresets && typeof presetFiber?.await === 'function'
			? presetFiber.await() : (this.presetState?.ready || Promise.resolve())
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

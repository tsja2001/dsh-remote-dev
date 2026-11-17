/** Offline tests against the DSH 0.2.2 readDocument/register contract. */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import {
	ensureRemotePreset, GENERATOR_VERSION, listRemotePresets, LOCAL_WORLD_ROWS, parseComposition,
	presetIdFor, presetNeedsRefresh, readRemotePresetDefinition, REALM_SERVICES, renderComposition,
	transformBaseComposition,
} from '../packages/remote-ssh/presets.js'
import {
	loadRecords, RemoteWorkspaces, saveRecords, titleFor, workspaceRpc,
} from '../packages/remote-ssh/workspaces.js'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-remote-ws-')))
let passed = 0
let failed = 0
async function test(name, run) {
	try {
		await run()
		passed++
		console.log('PASS', name)
	} catch (error) {
		failed++
		console.error('FAIL', name, error)
	}
}
const parse = text => load(text, { schema: entryListSchema })
const STANDARD = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a coding agent. Your working directory is {{cwd}}.
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
`
const COMPLEX = `- id: literal
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |
      isolate:
        fs: true
      - name: '@deepseek-ai/dsh-subprocess-local'
      name: './not-a-plugin.js'
    nested: {name: './also-not-a-plugin', isolate: {fs: true}}
    expression: !!js ctx.fs.root
    quoted: 'name: # literal value'
- id: providers
  name: cordis:group
  group: true
  isolate: { 'fs': true, "shell": true, subprocess: true, workingDirectory: true, planMode: true }
  config:
    - 'name': '@deepseek-ai/dsh-subprocess-local' # quoted row key and trailing comment
      disabled: !!js false
    - name: '@deepseek-ai/dsh-working-directory'
      config: { initial: !!js process.cwd() }
    - name: '@deepseek-ai/dsh-fs-local'
    - name: '@deepseek-ai/dsh-tool-fs-search'
- name: cordis:group
  group: true
  isolate:
    'fs': true
    subprocess: true
    workingDirectory: true
  config:
    - name: '@deepseek-ai/dsh-tool-todo'
`

class FakeRegistry {
	rows = []
	seq = 0
	async create(path, title) {
		assert.ok(existsSync(path))
		let row = this.rows.find(item => item.path === path)
		if (!row) {
			row = { id: `ws-${++this.seq}`, path, title, async setTitle(value) { this.title = value } }
			this.rows.push(row)
		}
		return row
	}
	list() { return [...this.rows] }
	async delete(id) { this.rows = this.rows.filter(row => row.id !== id) }
}

/** No path field and no disk discovery: only register() installs a preset. */
class FakePresets {
	defaultId = 'standard'
	documents = new Map([['standard', STANDARD]])
	definitions = new Map()
	bindings = new Map()
	registrations = []
	disposals = []
	recomposed = []
	failRecompose = null
	beforeRegister = null
	async readDocument(id) {
		const content = this.documents.get(id)
		if (content === undefined) throw new Error(`unknown preset ${id}`)
		return { agentPreset: id, content }
	}
	async register(definition) {
		assert.ok(!this.definitions.has(definition.id), 'duplicate runtime registration')
		const group = definition.plugins[0]
		assert.equal(group.name, 'cordis:group')
		assert.deepEqual(Object.keys(group.isolate), REALM_SERVICES)
		const remoteRows = group.config.slice(0, 4)
		assert.deepEqual(remoteRows.map(row => row.id), ['remote-fs', 'remote-shell', 'remote-subprocess', 'remote-context'])
		const config = remoteRows[0].config
		const generation = { definition, services: Object.fromEntries(REALM_SERVICES.map(name => [name,
			{ profileId: config.profile, root: config.root }])) }
		this.definitions.set(definition.id, generation)
		this.registrations.push(definition.id)
		await this.beforeRegister?.(definition)
		let disposed = false
		return async () => {
			if (disposed) return
			disposed = true
			this.disposals.push(definition.id)
			if (this.definitions.get(definition.id) === generation) this.definitions.delete(definition.id)
		}
	}
	async resolve(id = this.defaultId) {
		if (!this.documents.has(id) && !this.definitions.has(id)) throw new Error(`unknown preset ${id}`)
		return { id }
	}
	async list() { return [...this.documents.keys(), ...this.definitions.keys()].map(id => ({ id })) }
	composedPreset(ctx) { return this.bindings.get(ctx)?.definition.id }
	serviceFor(agent, name) { return this.bindings.get(agent.ctx)?.services[name] }
	async recompose(ctx, id) {
		if (this.failRecompose) throw this.failRecompose
		const generation = this.definitions.get(id)
		if (!generation) throw new Error(`preset ${id} is not registered`)
		this.bindings.set(ctx, generation)
		this.recomposed.push(id)
		return { id }
	}
}

const manager = {
	bound: [],
	statusAll: () => [
		{ id: 'p1', name: 'buildbox', user: 'dev', host: 'buildbox', port: 22 },
		{ id: 'p2', name: 'edge', user: 'ops', host: 'edge.example', port: 2222 },
	],
	bind(id, root) { this.bound.push([id, root]) },
}
function instance(home = HOME, presets = new FakePresets()) {
	const value = new RemoteWorkspaces({ manager, home: () => home })
	value.presets = presets
	value.registry = new FakeRegistry()
	return value
}
function agent(id, cwd) {
	const events = []
	return { id, ctx: {}, session: { header: { cwd }, append(type, data) { events.push({ type, data }) } }, events }
}
function context(services = {}) {
	const listeners = new Map()
	const disposers = []
	const tasks = []
	const warnings = []
	const ctx = {
		...services, listeners, warnings,
		logger: { warn(message) { warnings.push(message) } },
		effect(run) { const dispose = run(); if (dispose) disposers.push(dispose); return dispose },
		on(event, handler) {
			const handlers = listeners.get(event) || []
			handlers.push(handler); listeners.set(event, handlers)
			return () => listeners.set(event, handlers.filter(item => item !== handler))
		},
		inject(names, apply) { if (names.every(name => ctx[name])) tasks.push(Promise.resolve(apply(ctx))) },
		async ready() { await Promise.all(tasks) },
		async serial(event, payload) { for (const listener of listeners.get(event) || []) await listener(payload) },
		async step(subject, next) {
			let dispatch = next
			for (const listener of [...(listeners.get('agent/pre-step') || [])].reverse()) {
				const following = dispatch
				dispatch = () => listener({ agent: subject }, following)
			}
			return dispatch()
		},
		async dispose() { for (const dispose of disposers.reverse()) await dispose() },
	}
	return ctx
}

try {
	await test('host YAML schema preserves expressions, literal config and quoted/flow entries', async () => {
		const before = parse(COMPLEX)
		const result = await transformBaseComposition(COMPLEX)
		assert.equal(result.ok, true, result.reason)
		const after = parse(result.text)
		assert.deepEqual(after[0], before[0])
		assert.deepEqual(after[1].isolate, { planMode: true })
		assert.equal(after[2].isolate, undefined)
		assert.ok(after[1].config.slice(0, 3).every(row => row.disabled === true))
		assert.equal(after[1].config[3].disabled, undefined)
		assert.deepEqual(after[1].config[1].config.initial, { __jsExpr: 'process.cwd()' })
		assert.ok(LOCAL_WORLD_ROWS.has('@deepseek-ai/dsh-subprocess-local'))
		assert.ok(LOCAL_WORLD_ROWS.has('@deepseek-ai/dsh-working-directory'))
	})
	await test('relative declarations need a real source base; unsafe includes and malformed YAML refuse', async () => {
		const text = "- name: './local.js'\n"
		assert.equal((await transformBaseComposition(text)).ok, false)
		assert.equal((await transformBaseComposition(text, { baseDir: 'guess' })).ok, false)
		assert.equal(parse((await transformBaseComposition(text, { baseDir: '/actual/preset' })).text)[0].name, '/actual/preset/local.js')
		for (const input of ["- name: cordis:include\n  config: {path: /elsewhere.yml}", '---\n- name: x\n---\n- name: y', '- name: [broken', '- bad: shape']) {
			assert.equal((await transformBaseComposition(input)).ok, false, input)
		}
	})
	await test('renderer owns four services and bakes an explicit local anchor into every provider', async () => {
		const rewritten = await transformBaseComposition(COMPLEX)
		const [group] = await parseComposition(renderComposition({ profileId: 'p1', root: '/srv/app', anchor: '/local/anchor', baseText: rewritten.text }))
		assert.deepEqual(group.isolate, Object.fromEntries(REALM_SERVICES.map(name => [name, true])))
		assert.deepEqual(group.config.slice(0, 4).map(row => row.id), ['remote-fs', 'remote-shell', 'remote-subprocess', 'remote-context'])
		for (const row of group.config.slice(0, 4)) {
			assert.equal(row.config.anchor, '/local/anchor')
			assert.equal(row.config.profile, 'p1')
			assert.equal(row.config.root, '/srv/app')
			assert.ok(row.name.startsWith('/'))
		}
	})
	await test('authoring is idempotent, stamped, readable as a runtime definition, and drift-aware', async () => {
		const base = { id: 'standard', text: STANDARD }
		const options = { home: HOME, profileId: 'author', profileName: "build'box", root: '/srv/app', base }
		const first = await ensureRemotePreset(options)
		assert.equal(first.wrote, true)
		assert.equal((await ensureRemotePreset(options)).wrote, false)
		assert.equal(await presetNeedsRefresh({ home: HOME, presetId: first.presetId, base }), false)
		assert.equal(await presetNeedsRefresh({ home: HOME, presetId: first.presetId, base: { ...base, text: STANDARD + '\n# changed' } }), true)
		const definition = await readRemotePresetDefinition({ home: HOME, presetId: first.presetId })
		assert.equal(definition.id, first.presetId)
		assert.ok(definition.name.includes("build'box"))
		assert.deepEqual(definition.plugins[0].config[5].disabled, { __jsExpr: "process.platform === 'win32'" })
		const stamp = JSON.parse(await readFile(join(first.directory, 'source.json'), 'utf8'))
		assert.equal(stamp.generator, GENERATOR_VERSION)
		await rm(first.directory, { recursive: true, force: true })
	})

	const workspaces = instance()
	const presets = workspaces.presets
	let record
	await test('create registers parsed plugins through readDocument/register and adopts the anchor', async () => {
		record = await workspaces.create({ profileId: 'p1', root: '/srv/app' })
		assert.ok(existsSync(join(record.anchor, '.dsh-remote-workspace.json')))
		assert.equal(record.presetId, presetIdFor('p1', '/srv/app'))
		assert.equal(record.baseId, 'standard')
		assert.equal(record.composable, true)
		assert.ok(presets.definitions.has(record.presetId))
		assert.equal(workspaces.registry.rows[0].title, titleFor({ root: '/srv/app', label: 'buildbox' }))
		assert.ok(manager.bound.some(([id, root]) => id === 'p1' && root === '/srv/app'))
		const same = await workspaces.create({ profileId: 'p1', root: '/srv/app' })
		assert.equal(same.id, record.id)
		assert.equal(workspaces.registry.rows.length, 1)
		assert.equal(presets.registrations.length, 1)
		assert.equal(loadRecords(HOME).length, 1)
	})
	await test('invalid workspace input and unsafe runtime base leave no runnable remote preset', async () => {
		await assert.rejects(workspaces.create({ profileId: 'missing', root: '/x' }), /unknown machine/)
		await assert.rejects(workspaces.create({ profileId: 'p1', root: ' ' }), /directory is required/)
		presets.documents.set('standard', "- name: './relative-plugin.js'")
		await assert.rejects(workspaces.create({ profileId: 'p2', root: '/unsafe' }), /no published source base/)
		assert.ok(!presets.definitions.has(presetIdFor('p2', '/unsafe')))
		presets.documents.set('standard', STANDARD)
	})
	await test('composition finishes before the first tool capture and records the selected preset', async () => {
		const subject = agent('remote', record.anchor)
		const ctx = context({ agentPresets: presets, workspaceRegistry: workspaces.registry })
		const wired = new RemoteWorkspaces({ manager, home: () => HOME })
		// Release ownership before another plugin incarnation registers the same ids.
		await workspaces.disposePresets()
		wired.attach(ctx)
		await ctx.ready()
		await ctx.serial('agent/created', { agent: subject })
		const captured = REALM_SERVICES.map(name => presets.serviceFor(subject, name))
		assert.ok(captured.every(service => service.profileId === 'p1' && service.root === '/srv/app'))
		assert.deepEqual(subject.events.at(-1), { type: 'agent-preset/selected', data: { agentPreset: record.presetId } })
		let entered = false
		await ctx.step(subject, async () => { entered = true })
		assert.equal(entered, true)
		const count = presets.recomposed.length
		await ctx.serial('agent/created', { agent: subject })
		assert.equal(presets.recomposed.length, count)
		assert.equal(wired.pending.size, 0)
		await ctx.dispose()
		assert.equal(wired.presets, null)
		assert.equal(presets.definitions.size, 0)
	})
	// The original service now owns a fresh incarnation of the same registry.
	workspaces.presets = presets
	await workspaces.reconcile()
	await test('local sessions and sessions without cwd remain available', async () => {
		assert.equal(workspaces.composeFor(agent('local', join(HOME, 'local'))), undefined)
		assert.equal(workspaces.composeFor(agent('no-cwd')), undefined)
	})
	await test('recompose failure rejects publication and never advances to model capture', async () => {
		presets.failRecompose = new Error('remote mount failed')
		let captured = false
		await assert.rejects((async () => {
			await workspaces.composeFor(agent('broken', record.anchor))
			captured = true
		})(), /remote mount failed/)
		assert.equal(captured, false)
		assert.equal(workspaces.pending.size, 0)
		presets.failRecompose = null
	})
	await test('missing or mismatched remote service fails closed and logs no successful selection', async () => {
		for (const name of REALM_SERVICES) {
			const subject = agent('missing-' + name, record.anchor)
			const generation = presets.definitions.get(record.presetId)
			const saved = generation.services[name]
			delete generation.services[name]
			await assert.rejects(workspaces.composeFor(subject), new RegExp('remote ' + name))
			assert.equal(subject.events.length, 0)
			generation.services[name] = { profileId: 'another-host', root: '/srv/app' }
			await assert.rejects(workspaces.composeFor(agent('wrong-' + name, record.anchor)), new RegExp('remote ' + name))
			generation.services[name] = saved
		}
	})
	await test('preset service absence preserves local sessions but refuses remote anchors', async () => {
		const standalone = new RemoteWorkspaces({ manager, home: () => HOME })
		assert.equal(standalone.composeFor(agent('local-standalone', join(HOME, 'local'))), undefined)
		await assert.rejects(standalone.composeFor(agent('remote-standalone', record.anchor)), /registry is unavailable/)
	})
	await test('base refresh replaces registration once and retains an existing agent revision', async () => {
		const subject = agent('retained', record.anchor)
		await workspaces.composeFor(subject)
		const old = presets.bindings.get(subject.ctx)
		const disposals = presets.disposals.length
		presets.documents.set('standard', STANDARD + "- id: todo\n  name: '@deepseek-ai/dsh-tool-todo'\n")
		await Promise.all([workspaces.refreshPreset(record), workspaces.refreshPreset(record)])
		assert.equal(presets.disposals.length, disposals + 1)
		assert.notEqual(presets.definitions.get(record.presetId), old)
		assert.equal(presets.bindings.get(subject.ctx), old)
		assert.ok(presets.definitions.get(record.presetId).definition.plugins[0].config.some(row => row.id === 'todo'))
		await workspaces.guardRemoteAgent(subject)
	})
	await test('later local preset switch on a remote anchor is blocked before a model request', async () => {
		const subject = agent('switch', record.anchor)
		await workspaces.composeFor(subject)
		presets.bindings.delete(subject.ctx)
		await assert.rejects(workspaces.guardRemoteAgent(subject), /cannot bind preset/)
	})
	await test('reconcile restores anchor health without re-adding an operator-deleted sidebar row', async () => {
		await rm(record.anchor, { recursive: true, force: true })
		await workspaces.reconcile()
		assert.ok(existsSync(record.anchor))
		await workspaces.registry.delete(record.workspaceId)
		await workspaces.reconcile()
		assert.equal(workspaces.registry.rows.length, 0)
		assert.equal(loadRecords(HOME)[0].workspaceId, undefined)
		assert.ok(existsSync(join(HOME, '.agent-presets', record.presetId)))
		const status = await workspaceRpc(workspaces)['remote.workspace.list']()
		assert.equal(status.workspaces[0].registered, false)
	})
	await test('removal keeps historical preset and restart registers it without a workspace record', async () => {
		await workspaces.create({ profileId: 'p1', root: '/srv/app' })
		const result = await workspaces.remove({ id: record.id })
		assert.equal(result.presetKept, true)
		assert.equal(loadRecords(HOME).length, 0)
		assert.equal((await listRemotePresets({ home: HOME })).length, 1)
		await workspaces.disposePresets()
		const next = new FakePresets()
		const restarted = new RemoteWorkspaces({ manager, home: () => HOME })
		const ctx = context({ agentPresets: next, workspaceRegistry: new FakeRegistry() })
		restarted.attach(ctx)
		await ctx.ready()
		assert.ok(next.definitions.has(record.presetId))
		assert.equal(restarted.list().length, 0)
		assert.equal(restarted.registry.rows.length, 0)
		const historical = agent('historical', record.anchor)
		await ctx.serial('agent/created', { agent: historical })
		assert.equal(next.composedPreset(historical.ctx), record.presetId)
		const noAnchor = agent('historical-selected', join(HOME, 'elsewhere'))
		await next.recompose(noAnchor.ctx, record.presetId)
		await ctx.serial('agent/created', { agent: noAnchor })
		await ctx.dispose()
		assert.equal(next.definitions.size, 0)
		const reloadCtx = context({ agentPresets: next })
		restarted.attach(reloadCtx)
		await reloadCtx.ready()
		assert.ok(next.definitions.has(record.presetId))
		await reloadCtx.dispose()
	})
	await test('explicit purge unregisters the runtime definition and deletes the canonical macOS anchor', async () => {
		const fresh = instance()
		const purge = await fresh.create({ profileId: 'p1', root: '/srv/app' })
		const result = await fresh.remove({ id: purge.id, deletePreset: true })
		assert.equal(result.presetKept, false)
		assert.equal(fresh.presets.definitions.has(purge.presetId), false)
		assert.equal(existsSync(join(HOME, '.agent-presets', purge.presetId)), false)
		assert.equal(existsSync(purge.anchor), false)
		await fresh.disposePresets()
	})
	await test('unload during registration waits and disposes late registration instead of leaking it', async () => {
		const raceHome = join(HOME, 'race')
		await mkdir(raceHome)
		const race = instance(raceHome)
		let release
		let started
		const began = new Promise(resolve => { started = resolve })
		const barrier = new Promise(resolve => { release = resolve })
		race.presets.beforeRegister = async () => { started(); await barrier }
		const create = race.create({ profileId: 'p1', root: '/srv/race' })
		await began
		const state = race.presetState
		const dispose = race.disposePresets()
		release()
		await assert.rejects(create, /unloaded during registration/)
		await dispose
		assert.equal(state.registrations.size, 0)
		assert.equal(state.presets.definitions.size, 0)
	})
	await test('legacy historical preset upgrades when its base declaration was removed', async () => {
		const legacyHome = join(HOME, 'legacy')
		const legacy = instance(legacyHome)
		legacy.presets.defaultId = 'retired-base'
		legacy.presets.documents.set('retired-base', STANDARD + "- id: retained-feature\n  name: '@deepseek-ai/dsh-tool-todo'\n")
		const record = await legacy.create({ profileId: 'p1', root: '/srv/legacy' })
		const directory = join(legacyHome, '.agent-presets', record.presetId)
		const definition = await readRemotePresetDefinition({ home: legacyHome, presetId: record.presetId })
		const group = definition.plugins[0]
		delete group.isolate.subprocess
		delete group.isolate.workingDirectory
		group.config = group.config.filter(row => row.id !== 'remote-subprocess')
		for (const row of group.config.slice(0, 3)) delete row.config.anchor
		await writeFile(join(directory, 'agent.cordis.yml'), dump(definition.plugins, { schema: entryListSchema }))
		const stamp = JSON.parse(await readFile(join(directory, 'source.json'), 'utf8'))
		stamp.generator = 3
		delete stamp.anchor
		delete stamp.profileName
		delete stamp.target
		await writeFile(join(directory, 'source.json'), JSON.stringify(stamp))
		await legacy.remove({ id: record.id })
		await legacy.disposePresets()
		const restarted = instance(legacyHome)
		await restarted.reconcile()
		const restored = restarted.presets.definitions.get(record.presetId).definition
		assert.ok(restored.plugins[0].config.some(row => row.id === 'retained-feature'))
		assert.equal(restored.plugins[0].config[2].id, 'remote-subprocess')
		assert.equal(restored.plugins[0].config[2].config.anchor, record.anchor)
		await restarted.composeFor(agent('legacy-resume', record.anchor))
		await restarted.disposePresets()
	})
	await test('orphaned anchor with a missing marker cannot silently become local', async () => {
		const orphanHome = join(HOME, 'orphan')
		const anchor = join(orphanHome, 'remote-workspaces', 'machine', 'directory')
		await mkdir(anchor, { recursive: true })
		const orphan = instance(orphanHome)
		await assert.rejects(orphan.composeFor(agent('orphan', anchor)), /no valid persisted binding/)
	})
	await test('corrupt persisted binding is never registered or composed', async () => {
		const corrupt = instance(join(HOME, 'corrupt'))
		const record = { presetId: 'remote-ssh-mismatched-00000000', profileId: 'p1', root: '/srv/app' }
		await assert.rejects(corrupt.refreshPreset(record), /does not match/)
		assert.equal(corrupt.presets.registrations.length, 0)
	})
} finally {
	await rm(HOME, { recursive: true, force: true })
}
console.log(`\n${passed} passed, ${failed} failed, 0 skipped`)
process.exitCode = failed ? 1 : 0

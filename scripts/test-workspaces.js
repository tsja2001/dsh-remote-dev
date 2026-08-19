/**
 * Remote-workspace validation: preset derivation, the record store, workspace
 * registration, and the automatic composition hook.
 *
 * No SSH server and no harness process are needed — the harness services this
 * plugin talks to (`workspaceRegistry`, `agentPresets`, the cordis context)
 * are stood in for by doubles that mirror their published contracts.
 *
 * YAML validity of the generated compositions is checked with js-yaml when one
 * can be found (the harness ships it); set DSH_TEST_JS_YAML to a js-yaml ESM
 * entry to pin it. Without one, those checks report as SKIP.
 *
 * Usage: node scripts/test-workspaces.js
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
	ensureRemotePreset, fallbackBaseComposition, listRemotePresets, presetIdFor,
	presetNeedsRefresh, renderComposition, transformBaseComposition,
} from '../packages/remote-ssh/presets.js'
import {
	loadRecords, RemoteWorkspaces, saveRecords, titleFor, workspaceRpc,
} from '../packages/remote-ssh/workspaces.js'

let pass = 0
let fail = 0
let skip = 0
function ok(label, cond, extra) {
	if (cond) {
		pass += 1
		console.log('PASS', label)
	} else {
		fail += 1
		console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra, null, 2).slice(0, 800))
	}
}
function skipped(label, why) {
	skip += 1
	console.log('SKIP', label, '-', why)
}

const HOME = mkdtempSync(join(tmpdir(), 'dsh-remote-ws-'))
process.env.DSH_HOME = HOME
const here = dirname(fileURLToPath(import.meta.url))

/* ── YAML loader (optional) ─────────────────────────────────────────────── */

async function loadYaml() {
	const candidates = [
		process.env.DSH_TEST_JS_YAML,
		'js-yaml',
		'/home/t/projects/deepseek-harness/node_modules/js-yaml/dist/js-yaml.mjs',
		join(here, '../node_modules/js-yaml/dist/js-yaml.mjs'),
	].filter(Boolean)
	for (const candidate of candidates) {
		try {
			const mod = await import(candidate)
			const yaml = mod.default || mod
			if (typeof yaml.load === 'function') return yaml
		} catch {
			/* try the next candidate */
		}
	}
	return null
}
const yaml = await loadYaml()
/** The loader's dialect: `!!js` scalars are expression nodes, not errors. */
const schema = yaml
	? yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
		kind: 'scalar',
		resolve: data => typeof data === 'string',
		construct: data => ({ __jsExpr: data }),
	}))
	: null
const parse = text => yaml.load(text, { schema })

/* ── fixtures ───────────────────────────────────────────────────────────── */

const STANDARD = [
	'# a shipped-looking base',
	'- id: persona',
	"  name: '@deepseek-ai/dsh-persona'",
	'  config:',
	'    text: >-',
	'      You are a coding agent. Your working directory is {{cwd}}.',
	'- id: tool-bash',
	"  name: '@deepseek-ai/dsh-tool-bash'",
	"  disabled: !!js process.platform === 'win32'",
	'- id: tool-fs',
	"  name: '@deepseek-ai/dsh-tool-fs'",
	'- id: planning',
	'  name: cordis:group',
	'  group: true',
	'  isolate:',
	'    planMode: true',
	'  config:',
	'    - id: plan-mode',
	"      name: '@deepseek-ai/dsh-plan-mode'",
	'      config:',
	'        section: |',
	'          Stay in plan mode.',
	'',
].join('\n')

const MINIMAL = [
	'- id: persona',
	"  name: '@deepseek-ai/dsh-persona'",
	'- id: persistent-shell',
	'  name: cordis:group',
	'  group: true',
	'  isolate:',
	'    terminals: true',
	'  config:',
	'    - id: pty',
	"      name: '@deepseek-ai/dsh-terminal'",
	'    - id: terminal-bash',
	"      name: '@deepseek-ai/dsh-terminal-bash'",
	'    - id: persistent-bash',
	"      name: '@deepseek-ai/dsh-tool-bash-persistent'",
	'      config:',
	'        timeoutMs: 300000',
	'- id: filesystem',
	'  name: cordis:group',
	'  group: true',
	'  isolate:',
	'    fs: true',
	'  config:',
	'    - id: fs-local',
	"      name: '@deepseek-ai/dsh-fs-local'",
	'      config:',
	'        cwd: !!js process.cwd()',
	'    - id: str-replace-editor',
	"      name: '@deepseek-ai/dsh-tool-str-replace-editor'",
	"- name: '@deepseek-ai/dsh-bash-local'",
	'  disabled: false',
	'  config:',
	'    shell: bash',
	'- id: local-row',
	"  name: './local-plugin.js'",
	'- id: flow-isolate',
	'  name: cordis:group',
	'  group: true',
	'  isolate: { fs: true, workflowEngine: true }',
	'  config:',
	'    - id: inner',
	"      name: '@deepseek-ai/dsh-tool-workflow'",
	'',
].join('\n')

/* ── 1. base transformation ─────────────────────────────────────────────── */

const keptStandard = transformBaseComposition(STANDARD, { baseDir: '/base' })
ok('standard base needs no rewriting', keptStandard.ok && keptStandard.text === STANDARD, keptStandard.notes)

const rewritten = transformBaseComposition(MINIMAL, { baseDir: '/base/preset' })
ok('minimal base transforms', rewritten.ok === true, rewritten.reason)
const lines = rewritten.text.split('\n')
ok('fs isolate key removed', !/^\s*fs:\s*true\s*$/m.test(rewritten.text), rewritten.text)
// The `filesystem` group isolated fs alone, so its whole realm header goes;
// the `terminals` block and the inline flow realm are the two that remain.
ok('emptied isolate header removed', rewritten.text.split('isolate:').length - 1 === 2, rewritten.text)
ok('unrelated isolate realm kept', /^\s*terminals:\s*true\s*$/m.test(rewritten.text))
ok(
	'inline isolate keeps its other realms',
	/isolate: \{ workflowEngine: true \}/.test(rewritten.text),
	rewritten.text,
)
for (const local of ['dsh-fs-local', 'dsh-terminal-bash', 'dsh-tool-bash-persistent']) {
	const index = lines.findIndex(line => line.includes(local))
	ok(`${local} disabled`, index >= 0 && lines[index + 2]?.trim() === 'disabled: true', lines.slice(index, index + 3))
}
ok('consumer of the isolated fs kept', rewritten.text.includes('dsh-tool-str-replace-editor'))
// `- name:` puts the row's keys two columns right of the dash; the rewrite has
// to disable it there and drop the row's own `disabled: false`.
const inlineName = lines.findIndex(line => line.includes('dsh-bash-local'))
ok('a `- name:` row is disabled at the right column',
	lines[inlineName + 1]?.trim().startsWith('# dsh-remote-ssh')
	&& lines[inlineName + 2] === '  disabled: true'
	&& lines[inlineName + 3] === '  config:',
	lines.slice(inlineName, inlineName + 5))
ok('terminals registry row kept enabled', /name: '@deepseek-ai\/dsh-terminal'\n(?!.*disabled)/.test(rewritten.text + '\n'))
ok(
	'relative row absolutized',
	rewritten.text.includes("name: '/base/preset/local-plugin.js'"),
	rewritten.text,
)
ok('config of a disabled row survives', rewritten.text.includes('__CFG__') === false && rewritten.text.includes('timeoutMs: 300000'))

ok('tabs refuse the shift', transformBaseComposition('- id: x\n\tname: y\n').ok === false)
ok('multi-document refuses the shift', transformBaseComposition('---\n- id: x\n').ok === false)

/* ── 2. rendered composition ────────────────────────────────────────────── */

const composition = renderComposition({
	profileId: 'p1',
	root: '/srv/app',
	label: 'buildbox',
	target: 'remote://dev@buildbox:22/srv/app',
	baseText: rewritten.text,
	baseId: 'minimal',
	notes: rewritten.notes,
})

if (!yaml) {
	skipped('composition parses as an entry list', 'js-yaml not found')
	skipped('composition structure', 'js-yaml not found')
} else {
	let rows = null
	try {
		rows = parse(composition)
	} catch (error) {
		ok('composition parses as an entry list', false, String(error))
	}
	if (rows) {
		ok('composition parses as an entry list', Array.isArray(rows) && rows.length === 1)
		const group = rows[0]
		ok('one isolate group', group.name === 'cordis:group' && group.group === true)
		ok('realm owns fs and shell', group.isolate?.fs === true && group.isolate?.shell === true, group.isolate)
		const ids = group.config.map(row => row.id)
		ok('world rows come first', ids.slice(0, 3).join() === 'remote-fs,remote-shell,remote-context', ids)
		ok('base rows are nested inside the realm', ids.includes('persona') && ids.includes('filesystem'), ids)
		const worldRow = group.config[0]
		ok('world row is baked with the binding', worldRow.config.profile === 'p1' && worldRow.config.root === '/srv/app')
		ok('world row points at this package', worldRow.name.endsWith('remote-fs.js') && worldRow.name.startsWith('/'))
		const filesystem = group.config.find(row => row.id === 'filesystem')
		ok('nested group no longer isolates fs', filesystem.isolate === undefined, filesystem.isolate)
		ok('local fs provider disabled', filesystem.config.find(row => row.id === 'fs-local').disabled === true)
		ok('js expressions survive', filesystem.config[0].config.cwd.__jsExpr === 'process.cwd()')
		const flow = group.config.find(row => row.id === 'flow-isolate')
		ok('inline isolate keeps other realms', flow.isolate?.workflowEngine === true && flow.isolate?.fs === undefined)
	}

	const fallback = renderComposition({ profileId: 'p1', root: '/srv/app', baseText: fallbackBaseComposition() })
	let fallbackRows = null
	try {
		fallbackRows = parse(fallback)
	} catch (error) {
		ok('built-in base parses', false, String(error))
	}
	if (fallbackRows) {
		ok('built-in base parses', fallbackRows[0].config.some(row => row.id === 'tool-fs'))
	}

	// The real shipped presets, when this checkout sits beside a harness.
	const harnessPresets = process.env.DSH_TEST_PRESET_ROOT
		|| '/home/t/projects/deepseek-harness/apps/cli/config/agent-presets'
	for (const name of ['standard', 'minimal', 'code']) {
		const file = join(harnessPresets, name, 'agent.cordis.yml')
		if (!existsSync(file)) {
			skipped(`shipped preset "${name}" round-trips`, 'harness checkout not found')
			continue
		}
		const text = readFileSync(file, 'utf8')
		const shifted = transformBaseComposition(text, { baseDir: dirname(file) })
		if (!shifted.ok) {
			ok(`shipped preset "${name}" round-trips`, false, shifted.reason)
			continue
		}
		let parsed = null
		let generated = null
		try {
			generated = renderComposition({
				profileId: 'p1', root: '/srv/app', label: 'box', baseText: shifted.text, baseId: name,
			})
			parsed = parse(generated)
		} catch (error) {
			ok(`shipped preset "${name}" round-trips`, false, String(error))
			continue
		}
		const original = parse(text)
		const nested = parsed[0].config.slice(3)
		ok(
			`shipped preset "${name}" round-trips`,
			nested.length === original.length && nested.every((row, index) => row.id === original[index].id),
			{ nested: nested.map(r => r.id), original: original.map(r => r.id) },
		)
	}
}

/* ── 3. preset authoring ────────────────────────────────────────────────── */

const base = { id: 'standard', path: '/base/standard/agent.cordis.yml', text: STANDARD }
const authored = await ensureRemotePreset({
	home: HOME, profileId: 'p1', profileName: 'buildbox', root: '/srv/app',
	target: 'remote://dev@buildbox:22/srv/app', base,
})
ok('preset id is derived from profile+root', authored.presetId === presetIdFor('p1', '/srv/app'))
ok('preset was written', authored.wrote === true && existsSync(join(authored.directory, 'agent.cordis.yml')))
ok('metadata names the machine', readFileSync(join(authored.directory, 'preset.yml'), 'utf8').includes('[SSH: buildbox]'))
const again = await ensureRemotePreset({
	home: HOME, profileId: 'p1', profileName: 'buildbox', root: '/srv/app',
	target: 'remote://dev@buildbox:22/srv/app', base,
})
ok('re-authoring is a no-op', again.wrote === false)
ok('fresh preset is not stale', (await presetNeedsRefresh({ home: HOME, presetId: authored.presetId, base })) === false)
ok(
	'a changed base makes it stale',
	(await presetNeedsRefresh({ home: HOME, presetId: authored.presetId, base: { ...base, text: STANDARD + '\n# edit\n' } })) === true,
)
ok('listing reports the binding', (await listRemotePresets({ home: HOME })).some(
	entry => entry.presetId === authored.presetId && entry.profile === 'p1' && entry.root === '/srv/app',
))

/* ── 3b. the harness's own roster health check ──────────────────────────── */

// The strongest available check without a running host: hand the generated
// files to the real `discoverPresets` and require that the roster reports no
// `broken` reason — it parses with the loader's own YAML dialect and applies
// the same row-shape validation a mount begins with.
const harnessLib = process.env.DSH_TEST_HARNESS_LIB
	|| '/home/t/projects/deepseek-harness/packages/preset/agent-presets/lib/index.js'
const presetRoot = process.env.DSH_TEST_PRESET_ROOT
	|| '/home/t/projects/deepseek-harness/apps/cli/config/agent-presets'
let discoverPresets = null
try {
	({ discoverPresets } = await import(harnessLib))
} catch {
	discoverPresets = null
}
if (!discoverPresets) {
	skipped('the harness roster accepts the generated presets', 'harness build not found')
} else {
	const rosterHome = mkdtempSync(join(tmpdir(), 'dsh-remote-roster-'))
	const wanted = []
	for (const name of ['standard', 'minimal', 'code']) {
		const file = join(presetRoot, name, 'agent.cordis.yml')
		if (!existsSync(file)) continue
		const authored = await ensureRemotePreset({
			home: rosterHome, profileId: 'p1', profileName: 'buildbox', root: '/srv/app/' + name,
			target: 'remote://dev@buildbox:22/srv/app/' + name,
			base: { id: name, path: file, text: readFileSync(file, 'utf8') },
		})
		wanted.push(authored.presetId)
	}
	if (!wanted.length) {
		skipped('the harness roster accepts the generated presets', 'shipped presets not found')
	} else {
		const roster = await discoverPresets([{ path: join(rosterHome, '.agent-presets'), trust: 'user' }])
		const mine = roster.filter(entry => wanted.includes(entry.id))
		ok('the harness roster accepts the generated presets',
			mine.length === wanted.length && mine.every(entry => entry.broken === undefined),
			mine.map(entry => ({ id: entry.id, broken: entry.broken })))
		ok('the roster shows the workspace name', mine.every(entry => / \[SSH: buildbox\]$/.test(entry.name || '')),
			mine.map(entry => entry.name))
	}
	await rm(rosterHome, { recursive: true, force: true })
}

/* ── 4. doubles for the harness services ────────────────────────────────── */

class FakeWorkspace {
	constructor(id, path, title) {
		this.id = id
		this.path = path
		this.title = title
	}

	async setTitle(title) {
		this.title = title
	}
}

class FakeRegistry {
	constructor() {
		this.rows = []
		this.seq = 0
	}

	async create(path, title) {
		if (!existsSync(path)) throw new Error(`ENOENT: ${path}`)
		const existing = this.rows.find(row => row.path === path)
		if (existing) return existing
		this.seq += 1
		const row = new FakeWorkspace(`ws-${this.seq}`, path, title || path.split('/').at(-1))
		this.rows.push(row)
		return row
	}

	list() {
		return [...this.rows]
	}

	async delete(id) {
		const before = this.rows.length
		this.rows = this.rows.filter(row => row.id !== id)
		return this.rows.length !== before
	}
}

class FakePresets {
	constructor(presets, defaultId) {
		this.presets = presets
		this.defaultId = defaultId
		this.composed = new Map()
		this.recomposed = []
	}

	async list() {
		return this.presets
	}

	async resolve(id) {
		const wanted = id || this.defaultId
		const found = this.presets.find(preset => preset.id === wanted)
		if (!found) throw new Error(`unknown preset ${wanted}`)
		return found
	}

	composedPreset(agentCtx) {
		return this.composed.get(agentCtx)
	}

	async recompose(agentCtx, id) {
		if (!existsSync(join(HOME, '.agent-presets', id, 'agent.cordis.yml'))) {
			throw new Error(`preset "${id}" has no composition on disk`)
		}
		this.composed.set(agentCtx, id)
		this.recomposed.push(id)
		return { id }
	}
}

const manager = {
	bound: [],
	statusAll: () => [
		{ id: 'p1', name: 'buildbox', host: 'buildbox', port: 22, user: 'dev' },
		{ id: 'p2', name: 'edge', host: 'edge.example', port: 2222, user: 'ops' },
	],
	bind(id, path) {
		this.bound.push([id, path])
	},
}

const basePresetDir = join(HOME, 'shipped', 'standard')
await mkdir(basePresetDir, { recursive: true })
await writeFile(join(basePresetDir, 'agent.cordis.yml'), STANDARD, 'utf8')
const presets = new FakePresets(
	[{ id: 'standard', path: join(basePresetDir, 'agent.cordis.yml') }],
	'standard',
)

const workspaces = new RemoteWorkspaces({ manager })
workspaces.registry = new FakeRegistry()
workspaces.presets = presets

/* ── 5. creating a remote workspace ─────────────────────────────────────── */

const record = await workspaces.create({ profileId: 'p1', root: '/srv/app' })
ok('anchor is created', existsSync(record.anchor))
ok('anchor carries a marker', existsSync(join(record.anchor, '.dsh-remote-workspace.json')))
ok('anchor lives under the plugin home', record.anchor.startsWith(join(HOME, 'remote-workspaces')), record.anchor)
ok('anchor is named after machine and directory', record.anchor.includes('buildbox') && record.anchor.includes('app-'))
ok('record is persisted', loadRecords(HOME).some(entry => entry.id === record.id))
ok('workspace row is registered', record.workspaceId === 'ws-1')
ok('row is titled like VS Code', workspaces.registry.rows[0].title === titleFor({ root: '/srv/app', label: 'buildbox' }))
ok('preset was derived from the base', record.baseId === 'standard')
ok('remote_* tools follow the same directory', manager.bound.some(([id, path]) => id === 'p1' && path === '/srv/app'))

const same = await workspaces.create({ profileId: 'p1', root: '/srv/app' })
ok('creating twice is idempotent', same.id === record.id && workspaces.registry.rows.length === 1)
ok('record list holds one row per binding', loadRecords(HOME).filter(entry => entry.id === record.id).length === 1)

const second = await workspaces.create({ profileId: 'p2', root: '/srv/app' })
ok('same directory on another machine is a second workspace', second.anchor !== record.anchor && second.workspaceId === 'ws-2')

ok('unknown machine refuses', await workspaces.create({ profileId: 'nope', root: '/x' }).then(() => false, () => true))
ok('missing directory refuses', await workspaces.create({ profileId: 'p1', root: '  ' }).then(() => false, () => true))

/* ── 6. automatic composition ───────────────────────────────────────────── */

function fakeAgent(id, cwd) {
	const events = []
	return {
		id,
		ctx: { agent: id },
		session: { header: { cwd }, append: (type, data) => events.push({ type, data }) },
		events,
	}
}

const remoteAgent = fakeAgent('s1', record.anchor)
await workspaces.composeFor(remoteAgent)
ok('remote session is recomposed', presets.recomposed.at(-1) === record.presetId, presets.recomposed)
ok('the choice is recorded in the log', remoteAgent.events.at(-1)?.type === 'agent-preset/selected'
	&& remoteAgent.events.at(-1)?.data.agentPreset === record.presetId, remoteAgent.events)

const localAgent = fakeAgent('s2', join(HOME, 'somewhere-local'))
ok('local session is untouched', workspaces.composeFor(localAgent) === undefined)

const resumed = fakeAgent('s3', record.anchor)
presets.composed.set(resumed.ctx, record.presetId)
ok('an already-composed session is left alone', workspaces.composeFor(resumed) === undefined)

const noCwd = fakeAgent('s4', undefined)
ok('a session without cwd is ignored', workspaces.composeFor(noCwd) === undefined)

// A failing recomposition must never escape into the agent lifecycle.
const brokenRecord = { ...record, presetId: 'remote-ssh-missing-00000000', title: 'broken' }
const warnings = []
workspaces.ctx = { logger: { warn: message => warnings.push(message) } }
const brokenAgent = fakeAgent('s5', record.anchor)
const savedRecords = loadRecords(HOME)
saveRecords([brokenRecord], HOME)
await workspaces.composeFor(brokenAgent)
ok('a broken preset degrades to a warning', warnings.length === 1 && warnings[0].includes('remote-ssh-missing'), warnings)
saveRecords(savedRecords, HOME)

/* ── 7. attach wiring ───────────────────────────────────────────────────── */

const disposers = []
const listeners = new Map()
const fakeCtx = {
	logger: { warn: message => warnings.push(message) },
	inject(names, apply) {
		const child = { ...fakeCtx, workspaceRegistry: workspaces.registry, agentPresets: presets }
		child.effect = fakeCtx.effect
		child.on = fakeCtx.on
		if (names.every(name => child[name] !== undefined)) apply(child)
	},
	effect(run) {
		const dispose = run()
		disposers.push(dispose)
		return dispose
	},
	on(event, handler) {
		listeners.set(event, handler)
		return () => listeners.delete(event)
	},
}
const wired = new RemoteWorkspaces({ manager })
wired.attach(fakeCtx)
ok('attach picks up the registry', wired.registry === workspaces.registry)
ok('attach picks up the preset roster', wired.presets === presets)
ok('attach listens for new agents', listeners.has('agent/created'))
ok('attach guards the first step', listeners.has('agent/pre-step'))

const created = fakeAgent('s6', record.anchor)
listeners.get('agent/created')({ agent: created })
let stepped = false
await listeners.get('agent/pre-step')({ agent: created }, async () => {
	stepped = true
	return { kind: 'proceed' }
})
ok('pre-step waits for the swap, then proceeds', stepped && presets.composedPreset(created.ctx) === record.presetId)

/* ── 8. reconcile and removal ───────────────────────────────────────────── */

const rpc = workspaceRpc(workspaces)
const listed = await rpc['remote.workspace.list']()
ok('rpc lists workspaces with health', listed.workspaces.length === 2
	&& listed.workspaces.every(entry => entry.presetPresent === true && entry.registered === true), listed)

await rm(record.anchor, { recursive: true, force: true })
await workspaces.reconcile()
ok('a deleted anchor is recreated', existsSync(record.anchor))
ok('reconcile keeps the workspace id', loadRecords(HOME).find(entry => entry.id === record.id).workspaceId === record.workspaceId)

// Deleting the row in the sidebar is an operator decision: the next boot must
// not put it back, and old sessions must still find their preset.
await workspaces.registry.delete(record.workspaceId)
await workspaces.reconcile()
ok('a row deleted in the sidebar stays deleted', !workspaces.registry.rows.some(row => row.path === record.anchor))
ok('the record forgets its removed row', loadRecords(HOME).find(entry => entry.id === record.id).workspaceId === undefined)
ok('its preset survives for old sessions', existsSync(join(HOME, '.agent-presets', record.presetId)))
ok('list reports it as unregistered', (await rpc['remote.workspace.list']()).workspaces
	.find(entry => entry.id === record.id).registered === false)

// Re-adding the same binding restores the row without duplicating anything.
const readded = await workspaces.create({ profileId: 'p1', root: '/srv/app' })
ok('re-adding restores the row', readded.workspaceId !== undefined && loadRecords(HOME).length === 2)

const removal = await rpc['remote.workspace.remove']({ id: record.id })
ok('rpc removes the record', removal.removed === true && !loadRecords(HOME).some(entry => entry.id === record.id))
ok('the workspace row is gone', !workspaces.registry.rows.some(row => row.path === record.anchor))
ok('the preset is kept by default', removal.presetKept === true && existsSync(join(HOME, '.agent-presets', record.presetId)))
ok('removing twice is a no-op', (await rpc['remote.workspace.remove']({ id: record.id })).removed === false)

const purge = await workspaces.create({ profileId: 'p1', root: '/srv/app' })
const purged = await rpc['remote.workspace.remove']({ id: purge.id, deletePreset: true })
ok('an explicit purge deletes the preset', purged.presetKept === false
	&& !existsSync(join(HOME, '.agent-presets', purge.presetId)))
ok('an explicit purge deletes the anchor', !existsSync(purge.anchor))

/* ── 9. base drift regenerates ──────────────────────────────────────────── */

const drift = loadRecords(HOME).find(entry => entry.profileId === 'p2')
const beforeText = await readFile(join(HOME, '.agent-presets', drift.presetId, 'agent.cordis.yml'), 'utf8')
await writeFile(join(basePresetDir, 'agent.cordis.yml'), STANDARD + '\n- id: tool-todo\n  name: \'@deepseek-ai/dsh-tool-todo\'\n', 'utf8')
await workspaces.refreshPreset(drift)
const afterText = await readFile(join(HOME, '.agent-presets', drift.presetId, 'agent.cordis.yml'), 'utf8')
ok('an edited base preset regenerates the remote one', afterText !== beforeText && afterText.includes('tool-todo'))

/* ── done ───────────────────────────────────────────────────────────────── */

await rm(HOME, { recursive: true, force: true })
console.log(`\n${String(pass)} passed, ${String(fail)} failed, ${String(skip)} skipped`)
process.exit(fail === 0 ? 0 : 1)

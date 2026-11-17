/**
 * Remote workspace presets for the declarative DSH preset registry.
 *
 * Files under .agent-presets are this plugin's durable assets, not a roster
 * watched by the host. workspaces.js registers their parsed definitions at
 * runtime and owns the registration disposers.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REMOTE_PRESET_PREFIX = 'remote-ssh-'
export const GENERATOR_VERSION = 4
export const REMOTE_PRESET_ID = /^remote-ssh-[a-z0-9-]+$/

/** Verified host providers, plus legacy world/PTY rows older bases may contain. */
export const LOCAL_WORLD_ROWS = new Set([
	'@deepseek-ai/dsh-fs-local',
	'@deepseek-ai/dsh-fs-sandbox',
	'@deepseek-ai/dsh-fs-e2b',
	'@deepseek-ai/dsh-bash-local',
	'@deepseek-ai/dsh-bash-sandbox',
	'@deepseek-ai/dsh-pwsh-local',
	'@deepseek-ai/dsh-pwsh-sandbox',
	'@deepseek-ai/dsh-subprocess-local',
	'@deepseek-ai/dsh-working-directory',
	'@deepseek-ai/dsh-terminal-bash',
	'@deepseek-ai/dsh-tool-bash-persistent',
	'@deepseek-ai/dsh-tool-terminal',
])

export const REALM_SERVICES = ['fs', 'shell', 'subprocess', 'workingDirectory']

/** Lazy host peer: importing the standalone remote_* tools needs no YAML host. */
let yamlRuntime
async function yamlCodec() {
	if (!yamlRuntime) {
		yamlRuntime = Promise.all([import('js-yaml'), import('@deepseek-ai/cordis-plugin-include')])
			.then(([yaml, { entryListSchema }]) => {
				if (!entryListSchema) throw new Error('the host does not export entryListSchema')
				return { load: yaml.load, dump: yaml.dump, schema: entryListSchema }
			})
			.catch(error => {
				yamlRuntime = undefined
				throw new Error('remote workspace presets require js-yaml and @deepseek-ai/cordis-plugin-include 1.1.0', { cause: error })
			})
	}
	return yamlRuntime
}

/** Parse with exactly the host dialect; !!js stays data until Cordis loads it. */
export async function parseComposition(text) {
	const codec = await yamlCodec()
	const rows = codec.load(text, { schema: codec.schema })
	validateRows(rows)
	return rows
}

function isGroupRow(row) {
	return row.group === true || row.name === 'cordis:group' || row.name === '@deepseek-ai/cordis-plugin-group'
}

function validateRows(rows, ancestors = new Set()) {
	if (!Array.isArray(rows)) throw new Error('preset composition must be a list of plugin rows')
	if (ancestors.has(rows)) throw new Error('cyclic preset groups are not supported')
	const nested = new Set(ancestors).add(rows)
	for (const row of rows) {
		if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.name !== 'string' || !row.name) {
			throw new Error('preset composition contains a row without a plugin name')
		}
		if (row.group === true) validateRows(row.config, nested)
	}
}

export function presetIdFor(profileId, root) {
	const digest = createHash('sha256').update(String(profileId) + '\0' + String(root)).digest('hex').slice(0, 8)
	const clean = String(profileId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'profile'
	return REMOTE_PRESET_PREFIX + clean + '-' + digest
}

function yamlString(value) {
	// JSON quoting is valid YAML and preserves embedded newlines/backslashes.
	return JSON.stringify(String(value))
}

function comment(value) {
	return String(value).replace(/[\r\n]/g, ' ')
}

function packageDir() {
	return fileURLToPath(new URL('.', import.meta.url))
}

/**
 * Rewrite plugin entries, never arbitrary config maps or block-scalar lines.
 * Aliases, quoted keys, flow maps, multiline scalars and !!js expressions keep
 * their YAML values through the host schema. No expressions are evaluated here.
 *
 * readDocument() intentionally publishes no declaring base URL. Consequently a
 * relative plugin in such a document cannot be transplanted safely. An explicit
 * absolute baseDir is accepted only for callers that really own a source file.
 * Includes can hide untransformed local providers and are refused as well.
 */
export async function transformBaseComposition(text, options = {}) {
	const notes = []
	try {
		const rows = await parseComposition(text)
		const walk = entries => entries.map(original => {
			const row = { ...original }
			if (row.name === 'cordis:include' || row.name === '@deepseek-ai/cordis-plugin-include') {
				throw new Error('included compositions must be expanded by their owner before deriving a remote preset')
			}
			if (row.name.startsWith('.')) {
				if (!options.baseDir || !isAbsolute(options.baseDir)) {
					throw new Error(`relative plugin "${row.name}" has no published source base URL`)
				}
				notes.push(`resolved ${row.name} against its explicit source directory`)
				row.name = resolvePath(options.baseDir, row.name)
			}
			if (LOCAL_WORLD_ROWS.has(row.name)) {
				row.disabled = true
				notes.push(`disabled \`${row.name}\` (local world provider)`)
			}
			if (row.isolate != null) {
				if (typeof row.isolate !== 'object' || Array.isArray(row.isolate) || '__jsExpr' in row.isolate) {
					throw new Error(`cannot inspect isolation of plugin "${row.name}"`)
				}
				row.isolate = { ...row.isolate }
				for (const service of REALM_SERVICES) {
					if (!(service in row.isolate)) continue
					delete row.isolate[service]
					notes.push(`removed \`${service}\` from a nested isolate realm`)
				}
				if (!Object.keys(row.isolate).length) delete row.isolate
			}
			if (row.group === true) row.config = walk(row.config)
			return row
		})
		const plugins = walk(rows)
		const codec = await yamlCodec()
		return { ok: true, plugins, text: codec.dump(plugins, { schema: codec.schema, noRefs: true, lineWidth: -1 }), notes }
	} catch (error) {
		return { ok: false, text, notes, reason: error.message }
	}
}

function shift(text, spaces = 4) {
	const pad = ' '.repeat(spaces)
	return text.split('\n').map(line => /^\s*$/.test(line) ? '' : pad + line).join('\n').replace(/\n+$/, '')
}

/** Small safe base for deployments with no declared default composition. */
export function fallbackBaseComposition() {
	return [
		'- id: persona',
		"  name: '@deepseek-ai/dsh-persona'",
		'  config:',
		'    text: >-',
		'      You are a coding agent powered by the {{model}} model.',
		'- id: agent-instructions',
		"  name: '@deepseek-ai/dsh-agent-instructions'",
		'  config:',
		'    maxBytes: 65536',
		'- id: tool-bash',
		"  name: '@deepseek-ai/dsh-tool-bash'",
		'- id: tool-fs',
		"  name: '@deepseek-ai/dsh-tool-fs'",
		'- id: tool-fs-search',
		"  name: '@deepseek-ai/dsh-tool-fs-search'",
		'  config:',
		'    sampleOverCapGlobResults: false',
		'- id: tool-jobs',
		"  name: '@deepseek-ai/dsh-tool-jobs'",
		'- id: tool-todo',
		"  name: '@deepseek-ai/dsh-tool-todo'",
		'  config:',
		'    allowParallelInProgress: true',
		'- id: tool-ask-user',
		"  name: '@deepseek-ai/dsh-tool-ask-user'",
		'',
	].join('\n')
}

/** Render one isolated realm, with all world providers preceding consumers. */
export function renderComposition(options) {
	const here = packageDir()
	const world = (id, file) => [
		'    - id: ' + id,
		'      name: ' + yamlString(join(here, file)),
		'      config:',
		'        profile: ' + yamlString(options.profileId),
		'        root: ' + yamlString(options.root),
		...options.anchor ? ['        anchor: ' + yamlString(options.anchor)] : [],
		...options.label ? ['        label: ' + yamlString(options.label)] : [],
		...options.target ? ['        target: ' + yamlString(options.target)] : [],
	]
	return [
		'# Generated by dsh-remote-dev — do not edit by hand.',
		'# Base preset: ' + comment(options.baseId || '(built-in)'),
		...(options.notes || []).map(note => '# ' + comment(note)),
		'- id: remote-world',
		'  name: cordis:group',
		'  group: true',
		'  isolate:',
		...REALM_SERVICES.map(service => '    ' + service + ': true'),
		'  config:',
		...world('remote-fs', 'remote-fs.js'),
		...world('remote-shell', 'remote-shell.js'),
		...world('remote-subprocess', 'remote-subprocess.js'),
		...world('remote-context', 'remote-context.js'),
		shift(options.baseText),
		'',
	].join('\n')
}

function metadataFor({ profileId, profileName, root, target }) {
	const label = profileName || profileId
	const tail = root.split(/[\\/]/).filter(Boolean).at(-1) || root
	return {
		name: tail + ' [SSH: ' + label + ']',
		description: 'Remote workspace ' + (target || root) + '. Files and commands run on ' + label + ' over SSH.',
		order: 100,
	}
}

export function sourceStamp(base) {
	return {
		generator: GENERATOR_VERSION,
		baseId: base?.id || '',
		basePath: base?.path || '',
		baseHash: createHash('sha256').update(base?.text || '').digest('hex').slice(0, 16),
	}
}

export async function readSourceStamp(directory) {
	try {
		return JSON.parse(await readFile(join(directory, 'source.json'), 'utf8'))
	} catch {
		return null
	}
}

/** Author durable files; registering their definition is a separate lifetime. */
export async function ensureRemotePreset(options) {
	const { home, profileId, profileName, root, target, anchor } = options
	if (!home || !isAbsolute(home)) throw new Error('ensureRemotePreset: an absolute home is required')
	if (!profileId) throw new Error('ensureRemotePreset: profileId is required')
	if (!root) throw new Error('ensureRemotePreset: root is required')
	const presetId = presetIdFor(profileId, root)
	const directory = join(home, '.agent-presets', presetId)
	const base = options.base || null
	let baseText = base ? base.text : fallbackBaseComposition()
	let notes = []
	if (base) {
		const transformed = await transformBaseComposition(baseText, { baseDir: base.baseDir })
		if (!transformed.ok) throw new Error(`remote preset base "${base.id}" cannot be reused: ${transformed.reason}`)
		baseText = transformed.plugins.length ? transformed.text : ''
		notes = transformed.notes
	} else {
		notes = ['no base preset was available; using the built-in row set']
	}
	const composition = renderComposition({ profileId, root, anchor, label: profileName || profileId, target, baseText, baseId: base?.id, notes })
	const metadata = metadataFor(options)
	const codec = await yamlCodec()
	const metadataText = codec.dump(metadata, { schema: codec.schema, lineWidth: -1 })
	const stamp = { ...sourceStamp(base), profileId, profileName: profileName || profileId, root, target, anchor }
	await mkdir(directory, { recursive: true })
	const previous = await readFile(join(directory, 'agent.cordis.yml'), 'utf8').catch(() => null)
	if (previous !== composition) await writeFile(join(directory, 'agent.cordis.yml'), composition, 'utf8')
	await writeFile(join(directory, 'preset.yml'), metadataText, 'utf8')
	await writeFile(join(directory, 'source.json'), JSON.stringify(stamp, null, 2) + '\n', 'utf8')
	return { presetId, directory, wrote: previous !== composition, baseId: base?.id || '', notes }
}

export async function presetNeedsRefresh({ home, presetId, base }) {
	if (!home || !REMOTE_PRESET_ID.test(presetId)) return true
	const directory = join(home, '.agent-presets', presetId)
	const stamp = await readSourceStamp(directory)
	if (!stamp) return true
	const wanted = sourceStamp(base)
	return stamp.generator !== wanted.generator || stamp.baseId !== wanted.baseId
		|| stamp.baseHash !== wanted.baseHash || stamp.basePath !== wanted.basePath
}

export async function removeRemotePreset({ home, presetId }) {
	if (!home || !isAbsolute(home)) throw new Error('removeRemotePreset: an absolute home is required')
	if (!REMOTE_PRESET_ID.test(presetId)) throw new Error('removeRemotePreset: refusing to delete a preset not authored here: ' + presetId)
	await rm(join(home, '.agent-presets', presetId), { recursive: true, force: true })
	return true
}

/** Include historical presets whose sidebar workspace record was removed. */
export async function listRemotePresets({ home }) {
	if (!home) throw new Error('listRemotePresets: home is required')
	const base = join(home, '.agent-presets')
	let names
	try {
		names = (await readdir(base)).filter(name => REMOTE_PRESET_ID.test(name))
	} catch (error) {
		if (error.code === 'ENOENT') return []
		throw error
	}
	const out = []
	for (const presetId of names.sort()) {
		const directory = join(base, presetId)
		const stamp = await readSourceStamp(directory)
		const composition = await readFile(join(directory, 'agent.cordis.yml'), 'utf8').catch(() => null)
		if (!composition) continue
		// Old stamped assets retain their binding even after the workspace was
		// removed. Never infer an unknown binding from arbitrary YAML lines.
		out.push({
			presetId, profile: stamp?.profileId || '', root: stamp?.root || '',
			name: stamp?.profileName || '', target: stamp?.target, anchor: stamp?.anchor,
			baseId: stamp?.baseId || '', generator: stamp?.generator,
		})
	}
	return out
}

export async function readRemotePreset({ home, presetId }) {
	if (!home || !REMOTE_PRESET_ID.test(presetId)) return undefined
	try {
		return { presetId, composition: await readFile(join(home, '.agent-presets', presetId, 'agent.cordis.yml'), 'utf8') }
	} catch (error) {
		if (error.code === 'ENOENT') return undefined
		throw error
	}
}

/**
 * Recover the already-derived base when a historical preset's original
 * declaration was removed. This also upgrades old three-provider generated
 * assets without reusing their obsolete world rows or guessing any base URL.
 */
export async function readPersistedBase({ home, presetId, baseId }) {
	const definition = await readRemotePresetDefinition({ home, presetId })
	const group = definition.plugins[0]
	if (definition.plugins.length !== 1 || group.id !== 'remote-world' || group.group !== true) {
		throw new Error(`persisted remote preset "${presetId}" has no generated world group`)
	}
	const worldFiles = new Map([
		['remote-fs', 'remote-fs.js'], ['remote-shell', 'remote-shell.js'],
		['remote-subprocess', 'remote-subprocess.js'], ['remote-context', 'remote-context.js'],
	])
	const plugins = group.config.filter(row => {
		if (!worldFiles.has(row.id)) return true
		if (basename(row.name) !== worldFiles.get(row.id)) throw new Error(`persisted remote world row "${row.id}" has an unexpected provider`)
		return false
	})
	const codec = await yamlCodec()
	return { id: baseId || 'persisted-remote-base', text: codec.dump(plugins, { schema: codec.schema, noRefs: true, lineWidth: -1 }) }
}

/** Parsed definition accepted by AgentPresetRegistry.register(), not a path. */
export async function readRemotePresetDefinition({ home, presetId }) {
	const stored = await readRemotePreset({ home, presetId })
	if (!stored) throw new Error(`remote preset "${presetId}" has no composition on disk`)
	const codec = await yamlCodec()
	const metadata = codec.load(await readFile(join(home, '.agent-presets', presetId, 'preset.yml'), 'utf8'), { schema: codec.schema })
	return { id: presetId, name: metadata?.name, description: metadata?.description, order: metadata?.order,
		plugins: await parseComposition(stored.composition) }
}

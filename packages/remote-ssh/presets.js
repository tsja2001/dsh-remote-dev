/**
 * Agent-preset authoring for remote workspaces.
 *
 * A remote workspace IS an agent preset: a composition whose `fs` and
 * `shell` services are this plugin's SSH implementations, published inside
 * one `isolate` realm so every tool row in the same realm resolves the
 * REMOTE world instead of the host one. Sessions that name the preset read,
 * write, glob, grep and run commands on the remote machine — with the same
 * tools, the same schemas and the same cards as a local session.
 *
 * The composition is DERIVED from a base preset (the deployment default),
 * not hand-listed: the remote session must have every capability the local
 * one has — persona, instructions, skills, todos, plan mode, compaction,
 * delegation — and hard-coding a row list would freeze that set at the
 * version this plugin was written against. The base file is copied verbatim
 * into our group (a pure indentation shift, so block scalars, comments and
 * `!!js` expressions survive byte-for-byte) after a few surgical line edits:
 *
 *   1. `fs:`/`shell:` keys are removed from nested `isolate:` blocks, so a
 *      base that shadows those services (the shipped `minimal` preset does)
 *      cannot re-shadow them inside our realm.
 *   2. Rows naming a LOCAL provider of the remote-owned world are disabled —
 *      the host filesystem, the host shell, and the local pty backend. Only
 *      backends and consumers are touched, never a service other rows
 *      inject, so no row is ever left waiting for a provider we removed.
 *   3. Relative `name:` specifiers are absolutized against the base preset's
 *      own directory, which is no longer the directory of the copy.
 *
 * A base that cannot be transformed safely (tabs, multi-document YAML) falls
 * back to the built-in composition below, which is the shipped `standard`
 * row set minus what a remote world cannot honor.
 *
 * Layout per workspace:
 *   $DSH_HOME/.agent-presets/remote-ssh-<profile>-<hash8>/
 *     agent.cordis.yml   — the composition (group + isolate + world rows + base)
 *     preset.yml         — display metadata for the picker chip
 *     source.json        — what this file was generated from (staleness check)
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory-name (and id) prefix every preset authored here carries. */
export const REMOTE_PRESET_PREFIX = 'remote-ssh-'

/** Bumping this regenerates every authored preset on the next use. */
export const GENERATOR_VERSION = 3

/** Preset ids this module owns (also the deletion guard). */
export const REMOTE_PRESET_ID = /^remote-ssh-[a-z0-9-]+$/

/**
 * Local providers of a service the remote realm owns, plus the local pty
 * rows that reach the host through `ctx.subprocess` rather than `ctx.shell`.
 *
 * Disabling a row is only safe when nothing is left waiting for it, so this
 * list holds BACKENDS whose service another row in the same realm provides
 * (`fs`, `shell` — provided here) and CONSUMERS that nothing injects
 * (`tool-*`). The `terminals` REGISTRY row is deliberately absent: it is a
 * provider other rows inject, and dropping its backend alone already stops
 * a persistent shell from silently opening on the wrong machine.
 */
export const LOCAL_WORLD_ROWS = new Set([
	'@deepseek-ai/dsh-fs-local',
	'@deepseek-ai/dsh-fs-sandbox',
	'@deepseek-ai/dsh-fs-e2b',
	'@deepseek-ai/dsh-bash-local',
	'@deepseek-ai/dsh-bash-sandbox',
	'@deepseek-ai/dsh-pwsh-local',
	'@deepseek-ai/dsh-pwsh-sandbox',
	'@deepseek-ai/dsh-terminal-bash',
	'@deepseek-ai/dsh-tool-bash-persistent',
	'@deepseek-ai/dsh-tool-terminal',
])

/** Services this plugin publishes into the preset's realm. */
const REALM_SERVICES = ['fs', 'shell']

/** Directory name (also the preset id) must match ^[a-z0-9][a-z0-9-]*$. */
export function presetIdFor(profileId, root) {
	const digest = createHash('sha256').update(String(profileId) + '\0' + String(root)).digest('hex').slice(0, 8)
	const clean = String(profileId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'profile'
	return REMOTE_PRESET_PREFIX + clean + '-' + digest
}

/** Single-quoted YAML scalar. */
function yamlString(value) {
	return "'" + String(value).replaceAll("'", "''") + "'"
}

/** This package's directory (world plugins are referenced by absolute path). */
function packageDir() {
	return fileURLToPath(new URL('.', import.meta.url))
}

/** Leading-space count of a line (tabs are rejected before this runs). */
function indentOf(line) {
	return line.length - line.trimStart().length
}

/** Strip surrounding quotes from a YAML scalar written on one line. */
function unquote(value) {
	const text = value.trim()
	if (text.length >= 2 && (text[0] === "'" || text[0] === '"') && text.at(-1) === text[0]) {
		const inner = text.slice(1, -1)
		return text[0] === "'" ? inner.replaceAll("''", "'") : inner
	}
	return text
}

/**
 * Why this base composition cannot be shifted into a group verbatim, or
 * undefined when it can.
 *
 * The copy is a pure indentation shift, which preserves every YAML block
 * construct — but only for a single-document, space-indented file. A tab
 * changes meaning when the surrounding indentation grows, and a document
 * marker cannot appear inside a nested sequence at all.
 */
function unshiftable(text) {
	const lines = text.split('\n')
	for (const [index, line] of lines.entries()) {
		if (/^\s*$/.test(line)) continue
		if (line.startsWith('\t') || /^ *\t/.test(line)) {
			return `line ${String(index + 1)} is indented with a tab`
		}
		if (/^(---|\.\.\.)(\s|$)/.test(line)) {
			return `line ${String(index + 1)} starts a second YAML document`
		}
	}
	return undefined
}

/**
 * Rewrite one base composition so it can live inside the remote realm.
 *
 * Line-oriented on purpose: the text is handed back to the loader as-is, so
 * a re-serialization would have to reproduce this YAML dialect exactly
 * (`!!js` tags, block scalars, comments) to avoid changing what the user
 * composed. Editing lines changes only the lines that must change.
 *
 * @param {string} text - the base `agent.cordis.yml` contents.
 * @param {object} [options]
 * @param {string} [options.baseDir] - directory relative `name:` rows resolve against.
 * @returns {{ ok: boolean, text: string, notes: string[], reason?: string }}
 */
export function transformBaseComposition(text, options = {}) {
	const reason = unshiftable(text)
	if (reason) return { ok: false, text, notes: [], reason }
	const baseDir = options.baseDir || ''
	const notes = []
	const lines = text.split('\n')
	const out = []
	/** Row currently being rewritten: { keyIndent, itemIndent, name } */
	let row = null
	/** Open `isolate:` block: { indent, keptKeys, headerIndex } */
	let isolate = null

	const closeIsolate = () => {
		if (isolate && isolate.keptKeys === 0) out[isolate.headerIndex] = null
		isolate = null
	}

	for (const line of lines) {
		if (/^\s*$/.test(line) || /^\s*#/.test(line)) {
			out.push(line)
			continue
		}
		const indent = indentOf(line)
		const body = line.trimStart()

		if (isolate && indent <= isolate.indent) closeIsolate()
		if (row && indent < row.keyIndent) row = null

		// `- ` opens a new row; its keys sit two columns further right.
		if (body.startsWith('- ')) {
			closeIsolate()
			row = { itemIndent: indent, keyIndent: indent + 2, name: null, disabled: false }
		}

		const keyBody = body.startsWith('- ') ? body.slice(2) : body
		// `- name: x` writes the row's first key two columns right of the dash,
		// so a key's column is not always its line's indentation.
		const keyColumn = body.startsWith('- ') ? indent + 2 : indent

		// isolate: block — drop the realm keys this plugin owns.
		const isolateHead = /^isolate:\s*$/.exec(keyBody)
		if (isolateHead) {
			isolate = { indent: keyColumn, keptKeys: 0, headerIndex: out.length }
			out.push(line)
			continue
		}
		const isolateFlow = /^isolate:\s*\{(.*)\}\s*$/.exec(keyBody)
		if (isolateFlow) {
			const kept = isolateFlow[1]
				.split(',')
				.map(part => part.trim())
				.filter(part => part !== '' && !REALM_SERVICES.includes(part.split(':')[0].trim()))
			if (kept.length !== isolateFlow[1].split(',').filter(p => p.trim() !== '').length) {
				notes.push('removed fs/shell from an inline isolate realm')
			}
			if (kept.length === 0) continue
			out.push(line.replace(/\{.*\}/, '{ ' + kept.join(', ') + ' }'))
			continue
		}
		if (isolate && indent > isolate.indent) {
			const key = /^([A-Za-z_][\w-]*)\s*:/.exec(body)
			if (key && REALM_SERVICES.includes(key[1])) {
				notes.push(`removed \`${key[1]}\` from an isolate realm (the remote world owns it)`)
				continue
			}
			isolate.keptKeys += 1
			out.push(line)
			continue
		}

		// name: — absolutize relative specifiers, disable local world rows.
		const nameMatch = /^name:\s*(\S.*?)\s*$/.exec(keyBody)
		if (nameMatch && row && keyColumn === row.keyIndent) {
			const specifier = unquote(nameMatch[1])
			row.name = specifier
			if (specifier.startsWith('.') && baseDir) {
				const absolute = resolvePath(baseDir, specifier)
				out.push(' '.repeat(indent) + (body.startsWith('- ') ? '- ' : '') + 'name: ' + yamlString(absolute))
				notes.push(`resolved ${specifier} against the base preset directory`)
			} else {
				out.push(line)
			}
			if (LOCAL_WORLD_ROWS.has(specifier)) {
				row.disabled = true
				out.push(' '.repeat(row.keyIndent) + '# dsh-remote-ssh: disabled — this row runs on the LOCAL machine.')
				out.push(' '.repeat(row.keyIndent) + 'disabled: true')
				notes.push(`disabled \`${specifier}\` (local world provider)`)
			}
			continue
		}

		// A row we just disabled must not carry its own `disabled:` key too.
		if (row?.disabled && keyColumn === row.keyIndent && /^disabled\s*:/.test(keyBody)) continue

		out.push(line)
	}
	closeIsolate()

	return { ok: true, text: out.filter(line => line !== null).join('\n'), notes }
}

/** Indent a whole composition fragment under `config:` of our group. */
function shift(text, spaces = 4) {
	const pad = ' '.repeat(spaces)
	return text
		.split('\n')
		.map(line => (/^\s*$/.test(line) ? '' : pad + line))
		.join('\n')
		.replace(/\n+$/, '')
}

/**
 * The composition used when no usable base preset exists (a deployment with
 * no roster, an unreadable base, or one this module refuses to shift). It is
 * the shipped `standard` row set minus the rows a remote world cannot honor.
 */
export function fallbackBaseComposition() {
	return [
		'# dsh-remote-ssh built-in base: no usable base preset was found, so this',
		'# is the standard coding-agent row set. Rows that would reach the LOCAL',
		'# machine (persistent pty shells) are deliberately absent.',
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

/**
 * Render the whole composition document for one remote workspace.
 *
 * @param {object} options
 * @param {string} options.profileId - remote profile id (baked into the world rows).
 * @param {string} options.root - remote absolute directory the session develops in.
 * @param {string} [options.label] - human label for the machine (prompt text).
 * @param {string} [options.target] - `remote://…` display form (prompt text).
 * @param {string} options.baseText - the (already transformed) base composition.
 * @param {string} [options.baseId] - base preset id, for the file header.
 * @param {string[]} [options.notes] - transformation notes, for the file header.
 */
export function renderComposition(options) {
	const here = packageDir()
	const world = (id, file) => [
		'    - id: ' + id,
		'      name: ' + yamlString(join(here, file)),
		'      config:',
		'        profile: ' + yamlString(options.profileId),
		'        root: ' + yamlString(options.root),
		...options.label ? ['        label: ' + yamlString(options.label)] : [],
		...options.target ? ['        target: ' + yamlString(options.target)] : [],
	]
	return [
		'# Generated by dsh-remote-dev — do not edit by hand.',
		'#',
		'# One remote workspace. Every row below sits in a realm whose `fs` and',
		'# `shell` services are this machine\'s SSH connection, so the standard',
		'# tools operate on ' + (options.target || options.root) + '.',
		'#',
		'# Base preset: ' + (options.baseId || '(built-in)'),
		...(options.notes || []).map(note => '#   · ' + note),
		'#',
		'# Regenerated automatically when the base preset changes. To customize a',
		'# single remote workspace, copy it into a preset of your own.',
		'- id: remote-world',
		'  name: cordis:group',
		'  group: true',
		'  isolate:',
		'    fs: true',
		'    shell: true',
		'  config:',
		...world('remote-fs', 'remote-fs.js'),
		...world('remote-shell', 'remote-shell.js'),
		...world('remote-context', 'remote-context.js'),
		'',
		'    # ── base composition ────────────────────────────────────────────',
		shift(options.baseText),
		'',
	].join('\n')
}

/** Metadata document (the picker chip). */
function renderMetadata({ label, root, target }) {
	const tail = root.split(/[\\/]/).filter(Boolean).at(-1) || root
	return [
		'name: ' + yamlString(tail + ' [SSH: ' + label + ']'),
		'description: ' + yamlString(
			'Remote workspace ' + (target || root) + '. Files and commands run on ' + label + ' over SSH.',
		),
		'order: 100',
		'',
	].join('\n')
}

/** Content stamp of one base composition (what staleness compares). */
export function sourceStamp(base) {
	return {
		generator: GENERATOR_VERSION,
		baseId: base?.id || '',
		basePath: base?.path || '',
		baseHash: createHash('sha256').update(base?.text || '').digest('hex').slice(0, 16),
	}
}

/** Read the recorded stamp of an authored preset (absent = must regenerate). */
export async function readSourceStamp(directory) {
	try {
		return JSON.parse(await readFile(join(directory, 'source.json'), 'utf8'))
	} catch {
		return null
	}
}

/**
 * Author (or refresh) the preset for one remote workspace.
 *
 * Idempotent: an unchanged base and unchanged binding rewrite nothing, so
 * the standing mount of a preset already composed in this process keeps its
 * generation (the roster restarts a mount when the file's stamp changes).
 *
 * @param {object} options
 * @param {string} options.home - the DSH home directory (holds .agent-presets).
 * @param {string} options.profileId - remote profile id.
 * @param {string} options.profileName - display name of the machine.
 * @param {string} options.root - remote absolute directory to develop in.
 * @param {string} [options.target] - remote://… display form, for metadata.
 * @param {{id: string, path: string, text: string} | null} [options.base] - base preset.
 * @returns {Promise<{presetId: string, directory: string, wrote: boolean, baseId: string, notes: string[]}>}
 */
export async function ensureRemotePreset(options) {
	const { home, profileId, profileName, root, target } = options
	if (!home) throw new Error('ensureRemotePreset: home is required')
	if (!profileId) throw new Error('ensureRemotePreset: profileId is required')
	if (!root) throw new Error('ensureRemotePreset: root is required')
	const label = profileName || profileId
	const presetId = presetIdFor(profileId, root)
	const directory = join(home, '.agent-presets', presetId)

	const base = options.base || null
	let baseText = base?.text || ''
	let notes = []
	let baseId = base?.id || ''
	if (baseText) {
		const transformed = transformBaseComposition(baseText, { baseDir: dirname(base.path || '') })
		if (transformed.ok) {
			baseText = transformed.text
			notes = transformed.notes
		} else {
			baseText = ''
			notes = [`base preset "${baseId}" could not be reused (${transformed.reason}); using the built-in row set`]
			baseId = ''
		}
	}
	if (!baseText) {
		baseText = fallbackBaseComposition()
		if (!notes.length) notes = ['no base preset was available; using the built-in row set']
	}

	const composition = renderComposition({
		profileId, root, label, target, baseText, baseId: base?.id, notes,
	})
	const metadata = renderMetadata({ label, root, target })
	const stamp = { ...sourceStamp(base), profileId, root }

	await mkdir(directory, { recursive: true })
	const previous = await readFile(join(directory, 'agent.cordis.yml'), 'utf8').catch(() => null)
	if (previous === composition) {
		await writeFile(join(directory, 'preset.yml'), metadata, 'utf8')
		await writeFile(join(directory, 'source.json'), JSON.stringify(stamp, null, 2) + '\n', 'utf8')
		return { presetId, directory, wrote: false, baseId: base?.id || '', notes }
	}
	await writeFile(join(directory, 'agent.cordis.yml'), composition, 'utf8')
	await writeFile(join(directory, 'preset.yml'), metadata, 'utf8')
	await writeFile(join(directory, 'source.json'), JSON.stringify(stamp, null, 2) + '\n', 'utf8')
	return { presetId, directory, wrote: true, baseId: base?.id || '', notes }
}

/**
 * Whether the authored preset was generated from a different base (or by an
 * older generator) than the one in force now.
 * @param {object} options - { home, presetId, base }.
 */
export async function presetNeedsRefresh(options) {
	const { home, presetId, base } = options
	if (!home || !presetId) return true
	const directory = join(home, '.agent-presets', presetId)
	const stamp = await readSourceStamp(directory)
	if (!stamp) return true
	const wanted = sourceStamp(base)
	return stamp.generator !== wanted.generator
		|| stamp.baseId !== wanted.baseId
		|| stamp.baseHash !== wanted.baseHash
}

/**
 * Delete one authored remote preset. Unknown ids resolve without touching
 * anything beyond the (absent) directory.
 * @param {object} options - { home, presetId }.
 */
export async function removeRemotePreset(options) {
	const { home, presetId } = options
	if (!home || !presetId) throw new Error('removeRemotePreset: home and presetId are required')
	if (!REMOTE_PRESET_ID.test(presetId)) {
		throw new Error('removeRemotePreset: refusing to delete a preset not authored here: ' + presetId)
	}
	const directory = join(home, '.agent-presets', presetId)
	if (!isAbsolute(directory)) throw new Error('removeRemotePreset: home must be an absolute path')
	await rm(directory, { recursive: true, force: true })
	return true
}

/**
 * List every remote-ssh preset under the user preset root, with the baked
 * profile/root read back from its stamp (or, for pre-stamp presets, parsed
 * out of the composition).
 * @param {object} options - { home }.
 */
export async function listRemotePresets(options) {
	const { home } = options
	if (!home) throw new Error('listRemotePresets: home is required')
	const base = join(home, '.agent-presets')
	let names = []
	try {
		names = (await readdir(base)).filter(name => REMOTE_PRESET_ID.test(name))
	} catch {
		return []
	}
	const out = []
	for (const presetId of names.sort()) {
		const directory = join(base, presetId)
		const composition = await readFile(join(directory, 'agent.cordis.yml'), 'utf8').catch(() => null)
		if (!composition) continue
		const stamp = await readSourceStamp(directory)
		const profile = stamp?.profileId || (/profile: '([^']*)'/.exec(composition) || [])[1] || ''
		const root = stamp?.root || (/root: '([^']*)'/.exec(composition) || [])[1] || ''
		let display = ''
		try {
			const meta = await readFile(join(directory, 'preset.yml'), 'utf8')
			display = (/name: '(.*)'\s*$/m.exec(meta) || [])[1]?.replaceAll("''", "'") || ''
		} catch {
			/* metadata is optional */
		}
		out.push({ presetId, profile, root, name: display, baseId: stamp?.baseId || '' })
	}
	return out
}

/**
 * Read back one authored preset's composition, for listing/validation.
 * @param {object} options - { home, presetId }.
 */
export async function readRemotePreset(options) {
	const { home, presetId } = options
	if (!home || !presetId) return undefined
	if (!REMOTE_PRESET_ID.test(presetId)) return undefined
	try {
		const composition = await readFile(join(home, '.agent-presets', presetId, 'agent.cordis.yml'), 'utf8')
		return { presetId, composition }
	} catch {
		return undefined
	}
}

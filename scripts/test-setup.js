/**
 * Installer validation: argument parsing, the pnpm build-decision rewrite, and
 * the bundle-list reconcile — the three pure pieces of `setup.js`.
 *
 * The rewrite is the part that must never go wrong: it edits a file the
 * profile owns (dsh scaffolds it, pnpm appends to it, people edit it), so
 * every case below pins that it changes only the entries it owns.
 *
 * Usage: node scripts/test-setup.js
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	addBundleToManifest, DEFAULT_PROFILE_BUNDLES, DENIED_BUILDS, ensureProfileManifest,
	findDshCommand, main, parseArgs, patchAllowBuilds, profileDir, PROFILE_TEMPLATES,
	PROFILE_WORKSPACE_TEMPLATE,
} from '../packages/remote-ssh/setup.js'

let pass = 0
let fail = 0
function ok(label, cond, extra) {
	if (cond) {
		pass += 1
		console.log('PASS', label)
	} else {
		fail += 1
		console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra, null, 2).slice(0, 900))
	}
}

/* ── 1. arguments ───────────────────────────────────────────────────────── */

ok('defaults to the web profile', parseArgs([]).profile === 'web')
ok('the setup verb is optional', parseArgs(['setup', '--profile', 'x']).profile === 'x')
ok('install is accepted as a verb too', parseArgs(['install']).profile === 'web')
ok('short flags work', parseArgs(['-p', 'headless', '-n']).profile === 'headless' && parseArgs(['-n']).dryRun === true)
ok('a bare argument is the package spec', parseArgs(['./packages/remote-ssh']).package === './packages/remote-ssh')
ok('--dsh takes a multi-word command', parseArgs(['--dsh', 'pnpm dsh']).dsh === 'pnpm dsh')
ok('unknown options fail loudly', (() => {
	try {
		parseArgs(['--nope'])
		return false
	} catch {
		return true
	}
})())
ok('a value-less option fails loudly', (() => {
	try {
		parseArgs(['--profile'])
		return false
	} catch {
		return true
	}
})())
ok('a path traversal profile name is refused', (() => {
	try {
		parseArgs(['--profile', '../evil'])
		return false
	} catch {
		return true
	}
})())

/* ── 2. the pnpm build decision ─────────────────────────────────────────── */

const fresh = patchAllowBuilds(PROFILE_WORKSPACE_TEMPLATE)
ok('a scaffolded file gains the block', fresh.changed
	&& /^allowBuilds:$/m.test(fresh.text)
	&& DENIED_BUILDS.every(name => new RegExp(`^  ${name}: false$`, 'm').test(fresh.text)), fresh.text)
ok('the original settings survive', fresh.text.includes('nodeLinker: hoisted')
	&& fresh.text.includes('autoInstallPeers: false') && fresh.text.startsWith('packages:'))
ok('the reason is written down', fresh.text.includes('# Added by dsh-remote-dev'))
ok('re-running changes nothing', patchAllowBuilds(fresh.text).changed === false)

// The exact state a failed `dsh plugin add` leaves behind: pnpm writes its own
// placeholders into the profile before throwing ERR_PNPM_IGNORED_BUILDS.
const afterFailure = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

allowBuilds:
  cpu-features: set this to true or false
  ssh2: set this to true or false
`
const repaired = patchAllowBuilds(afterFailure)
ok('pnpm placeholders are resolved', repaired.changed
	&& /^  cpu-features: false$/m.test(repaired.text)
	&& /^  ssh2: false$/m.test(repaired.text), repaired.text)
ok('nothing is duplicated while repairing',
	repaired.text.split('allowBuilds:').length - 1 === 1
	&& repaired.text.split('ssh2:').length - 1 === 1, repaired.text)

const withOthers = `packages:
  - .

allowBuilds:
  esbuild: true
  # keep this comment
  '@scope/thing': false
`
const extended = patchAllowBuilds(withOthers)
ok('other packages are untouched', extended.text.includes('esbuild: true')
	&& extended.text.includes("'@scope/thing': false") && extended.text.includes('# keep this comment'))
ok('our entries join the same block', /^  ssh2: false$/m.test(extended.text)
	&& extended.text.split('allowBuilds:').length - 1 === 1, extended.text)

const decided = patchAllowBuilds(`allowBuilds:
  ssh2: true
  cpu-features: false
`)
ok('an existing decision is never overruled', decided.changed === false
	&& /ssh2: true/.test(decided.text), decided)
ok('and it is reported', decided.notes.some(note => note.includes('kept your existing choice')), decided.notes)

const settingsAfter = patchAllowBuilds(`allowBuilds:
  esbuild: true

nodeLinker: hoisted
`)
ok('a later top-level setting stays outside the block',
	/^  ssh2: false$/m.test(settingsAfter.text)
	&& settingsAfter.text.indexOf('ssh2: false') < settingsAfter.text.indexOf('nodeLinker'), settingsAfter.text)

ok('an empty inline mapping is expanded', patchAllowBuilds('allowBuilds: {}\n').changed === true)
const inline = patchAllowBuilds('allowBuilds: { esbuild: true }\n')
ok('a non-empty inline mapping is left alone with an explanation',
	inline.changed === false && inline.notes.some(note => note.includes('by hand')), inline)
ok('dangerouslyAllowAllBuilds short-circuits',
	patchAllowBuilds('dangerouslyAllowAllBuilds: true\n').changed === false)
ok('--allow-native writes true instead',
	/^  ssh2: true$/m.test(patchAllowBuilds(PROFILE_WORKSPACE_TEMPLATE, { allow: true }).text))
ok('a file without a trailing newline still parses',
	patchAllowBuilds('nodeLinker: hoisted').text.includes('\nallowBuilds:\n'))

// pnpm identifies a non-registry build by its dep path, so the key it writes
// can itself contain colons. Splitting on the first one appended a duplicate
// entry instead of resolving the placeholder (caught against real pnpm 11).
const depPathKey = `packages:
  - .

allowBuilds:
  fakedep@file:../fakedep-1.0.0.tgz: set this to true or false
`
const depPath = patchAllowBuilds(depPathKey, { packages: ['fakedep@file:../fakedep-1.0.0.tgz'] })
ok('a key containing colons is recognized', depPath.changed
	&& depPath.text.split('fakedep@file').length - 1 === 1
	&& /fakedep@file:\.\.\/fakedep-1\.0\.0\.tgz: false$/m.test(depPath.text), depPath.text)

// pnpm also writes version-qualified keys (`ssh2@1.17.0`); that is a decision
// about the same package and must not be duplicated by a bare-name entry.
const versioned = patchAllowBuilds(`allowBuilds:
  ssh2@1.17.0: set this to true or false
  cpu-features@0.0.10: false
`)
ok('a version-qualified key is the same decision', versioned.text.split('ssh2').length - 1 === 1
	&& /ssh2@1\.17\.0: false$/m.test(versioned.text)
	&& versioned.text.split('cpu-features').length - 1 === 1, versioned.text)

ok('a valueless key is parsed, not duplicated', (() => {
	const result = patchAllowBuilds('allowBuilds:\n  ssh2:\n')
	return result.text.split('ssh2').length - 1 === 1 && /ssh2: false$/m.test(result.text)
})(), patchAllowBuilds('allowBuilds:\n  ssh2:\n').text)

ok('quoted keys are matched unquoted', (() => {
	const result = patchAllowBuilds(`allowBuilds:\n  'ssh2': false\n  "cpu-features": false\n`)
	return result.changed === false
})())

/* ── 3. the bundle list ─────────────────────────────────────────────────── */

const manifest = { name: 'dsh-profile-web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }
ok('a bundle is appended', addBundleToManifest(manifest, 'dsh-remote-dev') === true
	&& manifest.dsh.profile.bundles.at(-1) === 'dsh-remote-dev')
ok('appending twice is a no-op', addBundleToManifest(manifest, 'dsh-remote-dev') === false
	&& manifest.dsh.profile.bundles.length === 2)
const bare = {}
ok('a manifest without the block gains one', addBundleToManifest(bare, 'dsh-remote-dev') === true
	&& bare.dsh.profile.bundles[0] === 'dsh-remote-dev')

// A profile `pnpm add` alone would create keeps none of its in-box bundles, so
// the fallback path seeds the manifest dsh would have written.
const scaffoldHome = mkdtempSync(join(tmpdir(), 'dsh-remote-scaffold-'))
const webDir = profileDir('web', scaffoldHome)
mkdirSync(webDir, { recursive: true })
ok('a manifest is created', ensureProfileManifest(webDir, 'web') === true)
const seeded = JSON.parse(readFileSync(join(webDir, 'package.json'), 'utf8'))
ok('with the shipped web bundles',
	JSON.stringify(seeded.dsh.profile.bundles) === JSON.stringify(PROFILE_TEMPLATES.web), seeded)
ok('and the dsh manifest shape', seeded.name === 'dsh-profile-web' && seeded.private === true
	&& typeof seeded.dependencies === 'object', seeded)
ok('plus the user patch layer', existsSync(join(webDir, 'cordis.patch.yml')))
ok('an existing manifest is never overwritten', ensureProfileManifest(webDir, 'web') === false)
const otherDir = profileDir('mybox', scaffoldHome)
mkdirSync(otherDir, { recursive: true })
ensureProfileManifest(otherDir, 'mybox')
ok('an unknown profile name gets the default bundles',
	JSON.stringify(JSON.parse(readFileSync(join(otherDir, 'package.json'), 'utf8')).dsh.profile.bundles)
	=== JSON.stringify(DEFAULT_PROFILE_BUNDLES))
await rm(scaffoldHome, { recursive: true, force: true })

/* ── 4. dsh discovery ───────────────────────────────────────────────────── */

ok('an explicit command wins', JSON.stringify(findDshCommand('pnpm dsh')) === '["pnpm","dsh"]')
ok('discovery answers null or a command', (() => {
	const found = findDshCommand('')
	return found === null || (Array.isArray(found) && found.length > 0)
})())

/* ── 5. end to end, without touching the real home ──────────────────────── */

const HOME = mkdtempSync(join(tmpdir(), 'dsh-remote-setup-'))
const dir = profileDir('web', HOME)
ok('profileDir lands under the home', dir === join(HOME, 'profiles', 'web'))

// --dry-run must not create or change anything.
const dryCode = main(['setup', '--home', HOME, '--dry-run', '--lang', 'en'])
ok('dry run succeeds', dryCode === 0)
ok('dry run writes nothing', !existsSync(dir), dir)

// A real run with a stub "dsh" that only records how it was called.
const stub = join(HOME, 'fake-dsh.js')
const { writeFileSync } = await import('node:fs')
writeFileSync(stub, `#!/usr/bin/env node
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
// Stand in for \`dsh plugin add\`: it runs from the operator's directory and
// finds the profile through DSH_HOME, exactly as the real CLI does. Record the
// argv, then do what pnpm+dsh do — write the dependency into the manifest.
const profile = process.argv[process.argv.indexOf('--profile') + 1]
const dir = join(process.env.DSH_HOME, 'profiles', profile)
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'called.json'), JSON.stringify(process.argv.slice(2)))
const file = join(dir, 'package.json')
let manifest = { name: 'dsh-profile-' + profile, private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }
try { manifest = JSON.parse(readFileSync(file, 'utf8')) } catch {}
manifest.dependencies = { ...manifest.dependencies, 'dsh-remote-dev': '^9.9.9' }
writeFileSync(file, JSON.stringify(manifest, undefined, 2))
`)
const code = main(['setup', '--home', HOME, '--lang', 'en', '--dsh', `${process.execPath} ${stub}`])
ok('the install runs and verifies', code === 0)
ok('the child is told which home to use', existsSync(join(dir, 'called.json')), dir)
const called = JSON.parse(readFileSync(join(dir, 'called.json'), 'utf8'))
ok('dsh is called with the profile and package', called[0] === 'plugin' && called[1] === '--profile'
	&& called[2] === 'web' && called[3] === 'add' && called[4].startsWith('dsh-remote-dev'), called)
const workspace = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
ok('the profile file was scaffolded with the decision', workspace.includes('nodeLinker: hoisted')
	&& /^  ssh2: false$/m.test(workspace), workspace)
const written = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
ok('the bundle is registered', (written.dsh?.profile?.bundles ?? []).includes('dsh-remote-dev'), written)

// Running the whole thing again must be a no-op that still succeeds.
const again = main(['setup', '--home', HOME, '--lang', 'en', '--dsh', `${process.execPath} ${stub}`])
const secondWorkspace = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
ok('a second run is idempotent', again === 0 && secondWorkspace === workspace, { again })
const secondManifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
ok('the bundle is listed once',
	secondManifest.dsh.profile.bundles.filter(name => name === 'dsh-remote-dev').length === 1,
	secondManifest.dsh.profile.bundles)

// A failing installer must surface the failure rather than claim success.
const failing = join(HOME, 'failing-dsh.js')
writeFileSync(failing, 'process.exit(1)\n')
const failCode = main(['setup', '--home', HOME, '--profile', 'other', '--lang', 'en',
	'--dsh', `${process.execPath} ${failing}`])
ok('a failed install exits nonzero', failCode === 1)
ok('but the profile decision is already recorded',
	/^  ssh2: false$/m.test(readFileSync(join(profileDir('other', HOME), 'pnpm-workspace.yaml'), 'utf8')))

await rm(HOME, { recursive: true, force: true })

console.log(`\n${String(pass)} passed, ${String(fail)} failed`)
process.exit(fail === 0 ? 0 : 1)

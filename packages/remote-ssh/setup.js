#!/usr/bin/env node
/**
 * One-command installer for the dsh-remote-dev plugin.
 *
 *   npx dsh-remote-dev@latest setup            # profile "web"
 *   npx dsh-remote-dev@latest setup --profile headless
 *
 * Why this exists: `dsh plugin add` forwards to pnpm, and pnpm 11 refuses an
 * install whose dependency tree contains ANY package with a build script
 * unless that package is listed in the project's `allowBuilds` (this is the
 * `ERR_PNPM_IGNORED_BUILDS` error, and it is a hard failure — `dsh` then skips
 * the `dsh.profile.bundles` reconcile, so the plugin is downloaded but never
 * activated). This plugin's only dependency, `ssh2`, ships two such scripts:
 * its own `install` (compiles an OPTIONAL native crypto accelerator) and the
 * optional `cpu-features` (node-gyp). Neither is needed — ssh2 is a pure
 * JavaScript SSH client and falls back to Node's own crypto — so the right
 * answer is to DENY both builds explicitly, which also means no compiler
 * toolchain is required on the machine.
 *
 * That decision belongs to the profile (the pnpm project doing the install),
 * so this script writes it there, then runs the install for you:
 *
 *   1. ensure `$DSH_HOME/profiles/<name>/pnpm-workspace.yaml` exists
 *      (the same file `dsh` itself scaffolds, created only when missing);
 *   2. record `allowBuilds: { ssh2: false, cpu-features: false }` in it,
 *      normalizing the `set this to true or false` placeholders pnpm writes
 *      after a failed attempt, and never overruling a decision you made;
 *   3. run `dsh plugin --profile <name> add dsh-remote-dev`, falling back to
 *      `pnpm add` plus the same bundle-list reconcile `dsh` performs when no
 *      `dsh` command can be found;
 *   4. verify the profile really lists the bundle, and say what to run next.
 *
 * Idempotent, and safe to run on the half-finished state a failed install
 * leaves behind: every step is a no-op when it is already true.
 *
 * @module dsh-remote-dev/setup
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Package name as published (also the default install spec). */
export const PACKAGE_NAME = 'dsh-remote-dev'

/** Build scripts this plugin's dependency tree carries, and our answer to them. */
export const DENIED_BUILDS = ['ssh2', 'cpu-features']

/**
 * The pnpm settings a dsh profile needs, verbatim from the harness's own
 * scaffold. Only written when the file does not exist — `dsh` writes exactly
 * this, and whichever of us gets there first is fine.
 */
export const PROFILE_WORKSPACE_TEMPLATE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/** The in-box bundle list each shipped profile name starts from. */
export const PROFILE_TEMPLATES = {
	web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
	headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
}

/** What a profile name with no shipped template starts from. */
export const DEFAULT_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base']

/** The user patch layer `dsh` seeds a new profile with. */
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

/**
 * Create the profile manifest `dsh` would create.
 *
 * Only used on the fallback path: when a `dsh` command is available it does
 * this itself (and stays the authority on what a new profile contains), but
 * `pnpm add` alone would leave a manifest with our bundle and none of the
 * in-box ones — a profile that boots without its own app.
 * @param {string} dir - the profile directory.
 * @param {string} name - the profile name.
 * @returns {boolean} true when a manifest was created.
 */
export function ensureProfileManifest(dir, name) {
	const manifestFile = join(dir, 'package.json')
	if (existsSync(manifestFile)) return false
	const bundles = PROFILE_TEMPLATES[name] ?? DEFAULT_PROFILE_BUNDLES
	writeFileSync(manifestFile, JSON.stringify({
		name: `dsh-profile-${name}`,
		private: true,
		dependencies: {},
		dsh: { profile: { bundles: [...bundles] } },
	}, undefined, 2) + '\n')
	const patchFile = join(dir, 'cordis.patch.yml')
	if (!existsSync(patchFile)) writeFileSync(patchFile, PROFILE_PATCH_TEMPLATE)
	return true
}

/**
 * Split one `key: value` line of a block mapping.
 *
 * The key is everything before the first colon FOLLOWED BY whitespace (or the
 * end of the line), which is what YAML means and what a naive split on the
 * first colon gets wrong: pnpm identifies a non-registry build by its dep
 * path, so keys like `pkg@file:../pkg-1.0.0.tgz` are normal here.
 * @param {string} line - one indented mapping line.
 * @returns {{ key: string, value: string } | undefined}
 */
function parseEntry(line) {
	const match = /^(\s+)(.+?):(?:[ \t]+(.*?))?[ \t]*$/.exec(line)
	if (match === null) return undefined
	const rawKey = match[2].trim()
	const unquoted = /^(['"])(.*)\1$/.exec(rawKey)
	return {
		indent: match[1],
		rawKey,
		key: unquoted === null ? rawKey : unquoted[2],
		value: (match[3] ?? '').trim(),
	}
}

/**
 * Whether an `allowBuilds` key decides the build of `name`.
 *
 * pnpm writes either the bare package name or a version/dep-path qualified
 * form (`ssh2@1.17.0`), and both are a decision about the same package.
 * @param {string} key - the key found in the file.
 * @param {string} name - the package name we are deciding for.
 */
function matchesPackage(key, name) {
	return key === name || key.startsWith(`${name}@`)
}

/* ── argument parsing ────────────────────────────────────────────────────── */

/**
 * Parse the command line.
 *
 * A leading verb (`setup`, `install`) is accepted and ignored, so both
 * `npx dsh-remote-dev` and `npx dsh-remote-dev setup` do the same thing.
 * @param {string[]} argv - arguments after the program name.
 * @returns {object} the resolved options.
 */
export function parseArgs(argv) {
	const options = {
		profile: process.env.DSH_PROFILE || 'web',
		package: '',
		dsh: process.env.DSH_BIN || '',
		home: process.env.DSH_HOME || '',
		allowNative: false,
		dryRun: false,
		help: false,
		lang: '',
	}
	const rest = [...argv]
	if (rest[0] === 'setup' || rest[0] === 'install') rest.shift()
	while (rest.length > 0) {
		const argument = rest.shift()
		const value = () => {
			const next = rest.shift()
			if (next === undefined) throw new Error(`${argument} needs a value`)
			return next
		}
		switch (argument) {
			case '--profile': case '-p': options.profile = value(); break
			case '--package': case '--pkg': options.package = value(); break
			case '--dsh': options.dsh = value(); break
			case '--home': options.home = value(); break
			case '--lang': options.lang = value(); break
			case '--allow-native': options.allowNative = true; break
			case '--dry-run': case '-n': options.dryRun = true; break
			case '--help': case '-h': options.help = true; break
			case '--yes': case '-y': break // accepted for symmetry with npx
			default:
				if (argument.startsWith('-')) throw new Error(`unknown option ${argument}`)
				// A bare argument is the package spec (a path, a tarball, a version).
				options.package = argument
		}
	}
	if (!/^[\w.@-]+$/.test(options.profile)) {
		throw new Error(`invalid profile name ${JSON.stringify(options.profile)}`)
	}
	return options
}

/* ── the pnpm build decision ─────────────────────────────────────────────── */

/**
 * Record a build decision for each named package in a pnpm-workspace.yaml.
 *
 * Line-oriented on purpose: this file belongs to the profile (dsh scaffolds
 * it, pnpm appends to it, people edit it), so the rewrite touches only the
 * entries it owns and leaves formatting, comments and every other setting
 * exactly as they were.
 *
 * @param {string} text - current file contents ('' for a new file).
 * @param {object} [options]
 * @param {string[]} [options.packages] - package names to decide for.
 * @param {boolean} [options.allow] - true to build them, false (default) to deny.
 * @returns {{ text: string, changed: boolean, notes: string[] }}
 */
export function patchAllowBuilds(text, options = {}) {
	const packages = options.packages ?? DENIED_BUILDS
	const decision = options.allow === true ? 'true' : 'false'
	const notes = []
	const lines = text.split('\n')

	// `dangerouslyAllowAllBuilds: true` already answers every build question.
	if (lines.some(line => /^dangerouslyAllowAllBuilds:\s*true\s*$/.test(line))) {
		return { text, changed: false, notes: ['dangerouslyAllowAllBuilds is set — nothing to decide'] }
	}

	const header = lines.findIndex(line => /^allowBuilds:/.test(line))
	if (header === -1) {
		const body = [
			'',
			'# Added by dsh-remote-dev: ssh2 ships an install script that compiles an',
			'# OPTIONAL native crypto accelerator, and pulls the optional node-gyp',
			'# package cpu-features. The pure-JavaScript paths are what this plugin',
			'# uses, so both builds are denied — no compiler needed, and pnpm stops',
			'# failing the install with ERR_PNPM_IGNORED_BUILDS.',
			'allowBuilds:',
			...packages.map(name => `  ${name}: ${decision}`),
		]
		const separator = text === '' || text.endsWith('\n') ? '' : '\n'
		notes.push(`added allowBuilds for ${packages.join(', ')}`)
		return { text: text + separator + body.join('\n') + '\n', changed: true, notes }
	}

	// An inline empty mapping (`allowBuilds: {}`) becomes a block we can extend.
	if (/^allowBuilds:\s*\{\s*\}\s*$/.test(lines[header])) lines[header] = 'allowBuilds:'
	if (/^allowBuilds:\s*\S/.test(lines[header])) {
		notes.push('allowBuilds is written inline — add the entries by hand: ' + packages.join(', '))
		return { text, changed: false, notes }
	}

	let end = header + 1
	const entries = []
	for (; end < lines.length; end += 1) {
		const line = lines[end]
		if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
		if (!/^\s+\S/.test(line)) break
		const entry = parseEntry(line)
		if (entry !== undefined) entries.push({ ...entry, index: end })
	}

	let changed = false
	const additions = []
	for (const name of packages) {
		const current = entries.find(entry => matchesPackage(entry.key, name))
		if (current === undefined) {
			additions.push(`  ${name}: ${decision}`)
			changed = true
			continue
		}
		if (current.value === 'true' || current.value === 'false') {
			// A decision already made — including one that disagrees with ours —
			// is the operator's, and pnpm is satisfied either way.
			if (current.value !== decision) notes.push(`kept your existing choice ${name}: ${current.value}`)
			continue
		}
		// pnpm's own `set this to true or false` placeholder, or anything else
		// pnpm cannot act on: rewrite the line from its parsed parts, because a
		// key may itself contain a colon and a regex would truncate it.
		lines[current.index] = `${current.indent}${current.rawKey}: ${decision}`
		notes.push(`resolved the pending decision for ${name}`)
		changed = true
	}
	if (additions.length > 0) {
		notes.push(`added allowBuilds for ${additions.map(line => line.trim().split(':')[0]).join(', ')}`)
		lines.splice(end, 0, ...additions)
	}
	return { text: lines.join('\n'), changed, notes }
}

/**
 * Append a bundle to a profile manifest's layer list, mirroring what
 * `dsh plugin` reconciles after a successful pnpm run.
 * @param {object} manifest - the parsed profile package.json.
 * @param {string} packageName - the bundle package name.
 * @returns {boolean} true when the list changed.
 */
export function addBundleToManifest(manifest, packageName) {
	const profile = manifest.dsh?.profile ?? {}
	const bundles = [...profile.bundles ?? []]
	if (bundles.includes(packageName)) return false
	bundles.push(packageName)
	manifest.dsh = { ...manifest.dsh, profile: { ...profile, bundles } }
	return true
}

/* ── environment ─────────────────────────────────────────────────────────── */

/** The Harness home directory. */
export function dshHome(override = '') {
	return override || process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** The profile directory for one profile name. */
export function profileDir(name, home = dshHome()) {
	return join(home, 'profiles', name)
}

/** Whether `command` is an executable on PATH (no process is started). */
function onPath(command) {
	const extensions = process.platform === 'win32'
		? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
		: ['']
	for (const dir of (process.env.PATH || '').split(delimiter)) {
		if (dir === '') continue
		for (const extension of extensions) {
			if (existsSync(join(dir, command + extension))) return true
		}
	}
	return false
}

/**
 * The command that runs the dsh CLI here, as an argv array.
 *
 * Checked in the order that respects intent: an explicit choice, a global
 * install, a local install in the current directory, then a Harness checkout
 * (where `dsh` is a workspace script). Nothing is executed to find out.
 * @param {string} explicit - the `--dsh` value, when given.
 * @returns {string[] | null} argv prefix, or null when dsh cannot be located.
 */
export function findDshCommand(explicit = '') {
	if (explicit) return explicit.split(' ').filter(Boolean)
	if (onPath('dsh')) return ['dsh']
	const local = join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
	if (existsSync(local)) return [local]
	try {
		const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
		const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
		if (dependencies['@deepseek-ai/dsh'] !== undefined || manifest.name === 'deepseek-harness') {
			if (onPath('pnpm')) return ['pnpm', 'dsh']
		}
	} catch {
		/* not a package directory — fall through */
	}
	return null
}

/**
 * Run a command with inherited stdio; returns the exit code.
 *
 * `DSH_HOME` is passed explicitly: this script resolves the home the same way
 * `dsh` does, but a `--home` override would otherwise send the child to a
 * different profile than the one just prepared.
 */
function run(argv, cwd, home) {
	const [command, ...args] = argv
	const result = spawnSync(command, args, {
		cwd,
		stdio: 'inherit',
		shell: process.platform === 'win32',
		env: { ...process.env, DSH_HOME: home },
	})
	if (result.error !== undefined) {
		if (result.error.code === 'ENOENT') return 127
		throw result.error
	}
	return result.status ?? 1
}

/**
 * Resolve a path-like install spec against the current directory.
 *
 * A registry spec (`dsh-remote-dev@0.6.1`) is left alone; a local path is
 * made absolute because the fallback install runs inside the profile.
 * @param {string} spec - the spec from `--package` or the default.
 */
function absoluteSpec(spec) {
	if (spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec)) {
		return resolve(process.cwd(), spec)
	}
	return spec
}

/** This package's own version, for the default install spec. */
function ownVersion() {
	try {
		const here = dirname(fileURLToPath(import.meta.url))
		return JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version || ''
	} catch {
		return ''
	}
}

/* ── messages ────────────────────────────────────────────────────────────── */

const MESSAGES = {
	zh: {
		title: 'dsh-remote-dev 安装程序',
		profile: 'profile',
		step1: '1/3 准备 profile 目录',
		step2: '2/3 记录 pnpm 构建脚本决定（拒绝 ssh2 / cpu-features 的可选原生编译）',
		step3: '3/3 安装并注册插件',
		created: '已创建',
		patched: '已更新',
		unchanged: '无需修改',
		installing: '执行：',
		noDsh: '找不到 dsh 命令，改用 pnpm 直接安装到 profile',
		needPnpm: '需要 pnpm（dsh 的 profile 用 pnpm 管理）。请先安装 pnpm 再重试：npm i -g pnpm',
		installFailed: '安装失败（退出码 {code}）。上面的 pnpm 输出说明了原因。',
		verifyFailed: 'profile 里没有登记这个插件，安装可能未完成。',
		done: '完成！插件已装入 profile',
		next: '接下来：启动 Harness，然后在 设置 → 远程连接 添加一台机器；再用 添加工作区 → 远程机器 选择目录。',
		start: '启动命令',
		dryRun: '（--dry-run：以上均未真正执行）',
		help: `用法: npx dsh-remote-dev setup [选项]

  -p, --profile <名称>   目标 profile，默认 web（也可用 DSH_PROFILE）
      --package <spec>   要安装的包，默认 dsh-remote-dev@<当前版本>；可传本地路径
      --dsh <命令>       运行 dsh 的命令，默认自动探测（例如 --dsh "pnpm dsh"）
      --home <路径>      Harness 主目录，默认 ~/.dsh（也可用 DSH_HOME）
      --allow-native     允许编译 ssh2 的可选原生加速（默认拒绝，功能不受影响）
  -n, --dry-run          只打印将要做的修改
      --lang zh|en       输出语言
  -h, --help             显示本帮助`,
	},
	en: {
		title: 'dsh-remote-dev setup',
		profile: 'profile',
		step1: '1/3 preparing the profile directory',
		step2: '2/3 recording the pnpm build decision (denying ssh2 / cpu-features native builds)',
		step3: '3/3 installing and registering the plugin',
		created: 'created',
		patched: 'updated',
		unchanged: 'already correct',
		installing: 'running:',
		noDsh: 'no dsh command found — installing into the profile with pnpm directly',
		needPnpm: 'pnpm is required (dsh profiles are pnpm projects). Install it and retry: npm i -g pnpm',
		installFailed: 'the install failed (exit code {code}); the pnpm output above says why.',
		verifyFailed: 'the profile does not list the bundle — the install did not complete.',
		done: 'done — the plugin is installed in profile',
		next: 'Next: start the Harness, add a machine under Settings → Remote Connections, then use Add workspace → Remote machines.',
		start: 'start with',
		dryRun: '(--dry-run: nothing above was actually changed)',
		help: `Usage: npx dsh-remote-dev setup [options]

  -p, --profile <name>   target profile, default web (or DSH_PROFILE)
      --package <spec>    package to install, default dsh-remote-dev@<version>; a local path works too
      --dsh <command>     command that runs dsh, autodetected by default (e.g. --dsh "pnpm dsh")
      --home <path>       Harness home, default ~/.dsh (or DSH_HOME)
      --allow-native      build ssh2's optional native accelerator instead of denying it
  -n, --dry-run           print the changes without making them
      --lang zh|en        output language
  -h, --help              show this help`,
	},
}

/** Pick the output language from the flag, then the environment. */
function pickLanguage(flag) {
	if (flag === 'zh' || flag === 'en') return flag
	const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || ''
	return /^zh/i.test(locale) ? 'zh' : 'en'
}

/* ── main ────────────────────────────────────────────────────────────────── */

/**
 * Run the installer.
 * @param {string[]} argv - arguments after the program name.
 * @returns {number} the process exit code.
 */
export function main(argv) {
	let options
	try {
		options = parseArgs(argv)
	} catch (error) {
		process.stderr.write(`dsh-remote-dev: ${String(error.message)}\n`)
		return 2
	}
	const t = MESSAGES[pickLanguage(options.lang)]
	if (options.help) {
		process.stdout.write(t.help + '\n')
		return 0
	}

	const version = ownVersion()
	const spec = options.package || (version ? `${PACKAGE_NAME}@${version}` : PACKAGE_NAME)
	const home = dshHome(options.home)
	const dir = profileDir(options.profile, home)
	process.stdout.write(`\n${t.title} — ${t.profile}: ${options.profile}\n${dir}\n\n`)

	// 1. the profile directory and its pnpm settings file
	process.stdout.write(`${t.step1}\n`)
	const workspaceFile = join(dir, 'pnpm-workspace.yaml')
	const existed = existsSync(workspaceFile)
	if (!options.dryRun) {
		mkdirSync(dir, { recursive: true })
		if (!existed) writeFileSync(workspaceFile, PROFILE_WORKSPACE_TEMPLATE)
	}
	process.stdout.write(`   ${existed ? t.unchanged : t.created}: ${workspaceFile}\n\n`)

	// 2. the build decision pnpm demands
	process.stdout.write(`${t.step2}\n`)
	const before = existed ? readFileSync(workspaceFile, 'utf8') : PROFILE_WORKSPACE_TEMPLATE
	const patched = patchAllowBuilds(before, { allow: options.allowNative })
	for (const note of patched.notes) process.stdout.write(`   · ${note}\n`)
	if (patched.changed && !options.dryRun) writeFileSync(workspaceFile, patched.text)
	process.stdout.write(`   ${patched.changed ? t.patched : t.unchanged}\n\n`)

	// 3. install + register
	process.stdout.write(`${t.step3}\n`)
	const dsh = findDshCommand(options.dsh)
	// `dsh plugin` locates the profile itself and anchors a relative path spec
	// to the directory it was invoked from, so it runs where the operator is —
	// which is also where a `pnpm dsh` style command resolves. Only the pnpm
	// fallback runs inside the profile, and it needs an absolute spec.
	const command = dsh === null
		? ['pnpm', 'add', absoluteSpec(spec)]
		: [...dsh, 'plugin', '--profile', options.profile, 'add', spec]
	const commandCwd = dsh === null ? dir : process.cwd()
	if (dsh === null) {
		process.stdout.write(`   ${t.noDsh}\n`)
		// `dsh plugin` scaffolds a new profile before installing; without it,
		// seed the same manifest so the profile keeps its in-box bundles.
		if (!options.dryRun && ensureProfileManifest(dir, options.profile)) {
			process.stdout.write(`   ${t.created}: ${join(dir, 'package.json')}\n`)
		}
	}
	process.stdout.write(`   ${t.installing} ${command.join(' ')}\n\n`)
	if (options.dryRun) {
		process.stdout.write(`${t.dryRun}\n`)
		return 0
	}
	if (dsh === null && !onPath('pnpm')) {
		process.stderr.write(`\ndsh-remote-dev: ${t.needPnpm}\n`)
		return 1
	}
	const code = run(command, commandCwd, home)
	if (code !== 0) {
		process.stderr.write(`\ndsh-remote-dev: ${t.installFailed.replace('{code}', String(code))}\n`)
		return code
	}

	// The bundle list is what actually activates the plugin. `dsh plugin`
	// reconciles it itself; the pnpm fallback path leaves it to us.
	const manifestFile = join(dir, 'package.json')
	let manifest
	try {
		manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
	} catch {
		process.stderr.write(`\ndsh-remote-dev: ${t.verifyFailed}\n`)
		return 1
	}
	const installedName = Object.keys(manifest.dependencies ?? {})
		.find(name => name === PACKAGE_NAME || spec.startsWith(name)) ?? PACKAGE_NAME
	if (addBundleToManifest(manifest, installedName)) {
		writeFileSync(manifestFile, JSON.stringify(manifest, undefined, 2) + '\n')
	}
	if (!(manifest.dsh?.profile?.bundles ?? []).includes(installedName)) {
		process.stderr.write(`\ndsh-remote-dev: ${t.verifyFailed}\n`)
		return 1
	}

	const starter = dsh === null ? 'dsh' : dsh.join(' ')
	process.stdout.write(`\n✓ ${t.done} "${options.profile}".\n`)
	process.stdout.write(`  ${t.start}: ${starter} --profile ${options.profile}\n`)
	process.stdout.write(`  ${t.next}\n\n`)
	return 0
}

/* Executed directly (bin / `node setup.js`), not when imported by a test. */
const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1])
const invokedDirectly = invokedPath !== '' && isAbsolute(invokedPath)
	&& pathToFileURL(invokedPath).href === import.meta.url
if (invokedDirectly) process.exit(main(process.argv.slice(2)))

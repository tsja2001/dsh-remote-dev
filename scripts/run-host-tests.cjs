/** Run contract tests against an installed Desktop host without booting its profile. */
const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { createRequire, registerHooks } = require('node:module')
const { resolve, join } = require('node:path')
const { pathToFileURL } = require('node:url')

const app = process.env.DSH_HOST_APP
if (!app) {
	console.error('Set DSH_HOST_APP to an installed DeepSeek Harness.app to test its bundled interfaces.')
	process.exit(1)
}
const executable = join(app, 'Contents/MacOS/DeepSeek Harness')
if (!process.env.DSH_HOST_TEST_CHILD) {
	const result = spawnSync(executable, [__filename, ...process.argv.slice(2)], {
		stdio: 'inherit',
		env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOST_TEST_CHILD: '1' },
	})
	if (result.error) throw result.error
	process.exit(result.status ?? 1)
}

const anchor = join(app, 'Contents/Resources/app.asar/dsh/package.json')
if (!existsSync(anchor)) throw new Error('Installed host package.json was not found')
const host = createRequire(anchor)
let resolvingHost = false
registerHooks({
	resolve(specifier, context, next) {
		// Core services must share the host's classes and module identities. Ordinary
		// dependencies (ssh2, YAML, zod) continue resolving from the tested package.
		if (!resolvingHost && specifier.startsWith('@deepseek-ai/')) {
			resolvingHost = true
			try {
				return { url: pathToFileURL(host.resolve(specifier)).href, shortCircuit: true }
			} finally {
				resolvingHost = false
			}
		}
		return next(specifier, context)
	},
})
;(async () => {
	const files = process.argv.slice(2)
	if (!files.length) throw new Error('Pass at least one contract test script')
	for (const file of files) await import(pathToFileURL(resolve(file)).href)
})().catch(error => {
	console.error(error)
	process.exitCode = 1
})

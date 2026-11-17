/** Exercise the production profile resolver against a freshly installed tarball. */
const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const app = process.env.DSH_HOST_APP
if (!app) throw new Error('DSH_HOST_APP must name an installed DeepSeek Harness.app')
if (!process.env.DSH_PROFILE_TEST_CHILD) {
	const child = spawnSync(path.join(app, 'Contents/MacOS/DeepSeek Harness'), ['--expose-internals', __filename], {
		stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_PROFILE_TEST_CHILD: '1' },
	})
	if (child.error) throw child.error
	process.exit(child.status ?? 1)
}
const repository = path.resolve(__dirname, '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const scratch = fs.mkdtempSync(path.join(tmpdir(), 'dsh-installed-profile-'))
const anchor = path.join(app, 'Contents/Resources/app.asar/dsh/package.json')
const host = createRequire(anchor)
;(async () => {
	let resolutionFiber
	try {
		execFileSync(npm, ['pack', path.join(repository, 'packages/remote-ssh'), '--ignore-scripts', '--pack-destination', scratch], { cwd: repository, stdio: 'pipe' })
		const tarball = path.join(scratch, fs.readdirSync(scratch).find(name => name.endsWith('.tgz')))
		const profileDir = path.join(scratch, 'profiles/test')
		fs.mkdirSync(profileDir, { recursive: true })
		fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
			name: 'isolated-installed-profile', private: true,
			dsh: { profile: { bundles: ['dsh-remote-dev'] } },
		}))
		execFileSync(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: profileDir, stdio: 'pipe' })
		assert.equal(fs.existsSync(path.join(profileDir, 'node_modules/@deepseek-ai')), false)
		const boot = await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-app-boot')).href)
		const { Context } = await import(pathToFileURL(host.resolve('@deepseek-ai/cordis')).href)
		const { FsError } = await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-fs')).href)
		const profile = boot.loadProfileDirectory('compat-test', profileDir, anchor)
		assert.deepEqual(profile.skippedBundles, [])
		const resolution = await boot.createRuntimeResolution({ installAnchor: anchor, profile, home: scratch })
		const ctx = new Context()
		resolutionFiber = ctx.plugin(boot.PluginPackages, { resolution })
		await resolutionFiber.await()
		const pluginDir = path.join(profileDir, 'node_modules/dsh-remote-dev')
		const plugin = await import(pathToFileURL(path.join(pluginDir, 'index.js')).href)
		assert.equal(typeof plugin.apply, 'function')
		const { RemoteSshFileSystem } = await import(pathToFileURL(path.join(pluginDir, 'remote-fs.js')).href)
		const remote = new RemoteSshFileSystem({
			profileId: 'fixture', root: '/fixture',
			acquire: async () => ({ statPath: async () => undefined }),
		})
		await assert.rejects(remote.readText({ targetKey: '/fixture/missing', displayPath: '/fixture/missing' }), error => error instanceof FsError)
		console.log('PASS installed profile imports through production runtime resolution; FsError shares host identity')
	} finally {
		if (resolutionFiber) await resolutionFiber.dispose()
		fs.rmSync(scratch, { recursive: true, force: true })
	}
})().catch(error => { console.error(error); process.exitCode = 1 })

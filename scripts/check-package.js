/** Verify that installing the tarball never installs or replaces host core packages. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = join(repositoryRoot, 'packages', 'remote-ssh')
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const scratch = mkdtempSync(join(tmpdir(), 'dsh-remote-package-check-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const corePackages = Object.keys(manifest.peerDependencies)
const install = args => execFileSync(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...args], {
	cwd: scratch, stdio: 'inherit',
})
const coreManifest = name => join(scratch, 'node_modules', name, 'package.json')

try {
	for (const name of Object.keys(manifest.dependencies)) {
		assert.ok(!name.startsWith('@deepseek-ai/'), `host core must be a peer: ${name}`)
	}
	execFileSync(npm, ['pack', packageRoot, '--pack-destination', scratch], {
		cwd: repositoryRoot, stdio: 'inherit',
	})
	const tarballs = readdirSync(scratch).filter(name => name.endsWith('.tgz'))
	assert.equal(tarballs.length, 1)
	const tarball = join(scratch, tarballs[0])
	writeFileSync(join(scratch, 'package.json'), JSON.stringify({
		name: 'dsh-remote-package-consumer-check', private: true, type: 'module',
	}, null, 2) + '\n')

	console.log('Checking a clean consumer: no automatic host-core installation...')
	install([tarball])
	for (const name of corePackages) assert.equal(existsSync(coreManifest(name)), false, `${name} was auto-installed`)
	const pluginPath = join(scratch, 'node_modules/dsh-remote-dev/package.json')
	const packed = JSON.parse(readFileSync(pluginPath, 'utf8'))
	assert.equal(packed.engines.dsh, '0.2.2-rc.3')

	console.log('Providing the exact supported host interfaces for runtime imports...')
	install(['--save-exact', ...corePackages.map(name => `${name}@${manifest.peerDependencies[name]}`)])
	const before = new Map(corePackages.map(name => [name, readFileSync(coreManifest(name), 'utf8')]))
	// Reinstall into an existing host: its selected core versions must survive unchanged.
	install([tarball])
	for (const [name, text] of before) assert.equal(readFileSync(coreManifest(name), 'utf8'), text, `${name} was replaced`)

	const smoke = `
		import assert from 'node:assert/strict'
		const plugin = await import('dsh-remote-dev')
		assert.equal(typeof plugin.apply, 'function')
		assert.equal(typeof plugin.RemoteManager, 'function')
		for (const name of ['transport', 'presets', 'remote-fs', 'remote-shell', 'remote-subprocess']) {
			const mod = await import('dsh-remote-dev/' + name)
			assert.ok(Object.keys(mod).length > 0, name + ' exports')
		}
		console.log('Package runtime imports passed with supported host interfaces')
	`
	execFileSync(process.execPath, ['--input-type=module', '--eval', smoke], { cwd: scratch, stdio: 'inherit' })
	console.log('Package check passed: core peers are not auto-installed or downgraded.')
} finally {
	rmSync(scratch, { recursive: true, force: true })
}

/**
 * Pack the publishable workspace, install that tarball into an empty consumer,
 * and import both public host entry points. This catches missing runtime
 * dependencies that `npm pack --dry-run` cannot detect.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = join(repositoryRoot, 'packages', 'remote-ssh')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-remote-package-check-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

try {
	console.log('Packing @tsja/dsh-remote-ssh...')
	execFileSync(npm, ['pack', packageRoot, '--pack-destination', scratch], {
		cwd: repositoryRoot,
		stdio: 'inherit',
	})

	const tarballs = readdirSync(scratch).filter((name) => name.endsWith('.tgz'))
	if (tarballs.length !== 1) {
		throw new Error(`expected one package tarball, found ${tarballs.length}`)
	}

	writeFileSync(join(scratch, 'package.json'), JSON.stringify({
		name: 'dsh-remote-package-consumer-check',
		private: true,
		type: 'module',
	}, null, 2) + '\n')

	console.log('Installing the tarball into a clean consumer...')
	execFileSync(npm, [
		'install',
		'--no-audit',
		'--no-fund',
		join(scratch, tarballs[0]),
	], {
		cwd: scratch,
		stdio: 'inherit',
	})

	const smokeTest = `
		const plugin = await import('@tsja/dsh-remote-ssh')
		const transport = await import('@tsja/dsh-remote-ssh/transport')
		if (typeof plugin.apply !== 'function') throw new Error('missing apply export')
		if (typeof plugin.RemoteManager !== 'function') throw new Error('missing RemoteManager export')
		if (typeof transport.RemoteConnection !== 'function') throw new Error('missing RemoteConnection export')
		console.log('Package consumer import passed')
	`
	execFileSync(process.execPath, ['--input-type=module', '--eval', smokeTest], {
		cwd: scratch,
		stdio: 'inherit',
	})

	console.log('Package check passed: tarball dependencies and public imports are usable.')
} finally {
	rmSync(scratch, { recursive: true, force: true })
}

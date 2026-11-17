/** Optional real-SSH gate for the remote subprocess and the host's search helper. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { RemoteConnection } from '../packages/remote-ssh/transport.js'
import { RemoteSshSubprocess } from '../packages/remote-ssh/remote-subprocess.js'
import { posixQuote } from '../packages/remote-ssh/world-support.js'

if (!process.env.DSH_TEST_KEY || !process.env.DSH_TEST_ROOT) {
	throw new Error('Set DSH_TEST_KEY and DSH_TEST_ROOT to a disposable SSH fixture; no personal-key defaults are used')
}
const root = process.env.DSH_TEST_ROOT.replace(/\/+$/, '') + '/subprocess-' + randomUUID()
const conn = new RemoteConnection({
	host: process.env.DSH_TEST_HOST || '127.0.0.1', port: Number(process.env.DSH_TEST_PORT || 2222),
	user: process.env.DSH_TEST_USER || 'dev', auth: 'key', keyPath: process.env.DSH_TEST_KEY,
})
let subprocess
let created = false
try {
	await conn.connect()
	assert.equal(conn.platform, 'posix')
	const mkdir = await conn.exec(`mkdir -p ${posixQuote(root)}`)
	assert.equal(mkdir.code, 0)
	created = true
	await conn.writeFile(root + '/fixture.txt', 'remote-search-needle\n')
	const support = { profileId: 'ssh-fixture', root, acquire: async () => conn, platformOf: async () => conn.platform }
	subprocess = new RemoteSshSubprocess(support)
	const stdio = { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } }
	const literal = 'literal $(printf injected); quote\' and spaces'
	const handle = subprocess.spawn({ argv: ['/usr/bin/printf', '%s', literal], cwd: root, stdio, graceMs: 1000 })
	assert.deepEqual(await handle.done, { exitCode: 0, signal: null })
	assert.equal(handle.collected.stdout.readFrom(0).text, literal)
	console.log('PASS real SSH subprocess preserves literal argv and independent output')
	const nonzero = subprocess.spawn({ argv: ['/bin/sh', '-c', 'exit 7'], cwd: root, stdio, graceMs: 1000 })
	assert.equal((await nonzero.done).exitCode, 7)
	console.log('PASS real SSH subprocess preserves nonzero exit status')

	const { runRipgrep } = await import('@deepseek-ai/dsh-tool-fs-search')
	const ctx = {
		workingDirectory: { ensure: async () => root },
		subprocess: { spawn(spec) {
			return subprocess.spawn({ ...spec, env: {
				...spec.env, ...process.env.DSH_TEST_REMOTE_PATH ? { PATH: process.env.DSH_TEST_REMOTE_PATH } : {},
			} })
		} },
	}
	const exec = { agent: {}, signal: new AbortController().signal }
	const files = await runRipgrep(ctx, exec, 'glob', ['--files'], 65536, 1000, 65536)
	assert.equal(files.noMatches, false)
	assert.ok(files.stdout.includes('fixture.txt'))
	const matches = await runRipgrep(ctx, exec, 'grep', ['--fixed-strings', 'remote-search-needle', 'fixture.txt'], 65536, 1000, 65536)
	assert.ok(matches.stdout.includes('remote-search-needle'))
	const empty = await runRipgrep(ctx, exec, 'grep', ['--fixed-strings', 'missing-needle', 'fixture.txt'], 65536, 1000, 65536)
	assert.equal(empty.noMatches, true)
	console.log('PASS actual host glob/grep execution helper searches through SSH and handles no matches')
} finally {
	await subprocess?.dispose()
	if (created && conn.state === 'connected') {
		await conn.unlinkFile(root + '/fixture.txt').catch(() => {})
		await conn.exec(`rmdir ${posixQuote(root)}`).catch(() => {})
	}
	conn.close()
}

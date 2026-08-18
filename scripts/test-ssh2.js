/**
 * Standalone validation of the ssh2 transport against a local sshd.
 *
 * Usage:
 *   1) (optional) start a test server:
 *        docker run -d --name dsh-sshd-test -p 2222:2222 \
 *          -e PUID=1000 -e PGID=1000 -e TZ=UTC -e SUDO_ACCESS=true \
 *          -e USER_NAME=dev -e USER_PASSWORD=test1234 -e PASSWORD_ACCESS=true \
 *          -e PUBLIC_KEY="$(cat ~/.ssh/id_ed25519.pub)" \
 *          linuxserver/openssh-server
 *   2) node scripts/test-ssh2.js
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RemoteConnection, classifyError, expandTilde } from '../packages/remote-ssh/transport.js'

const target = {
  host: process.env.DSH_TEST_HOST || '127.0.0.1',
  port: Number(process.env.DSH_TEST_PORT || 2222),
  user: process.env.DSH_TEST_USER || 'dev',
}
const PASSWORD = process.env.DSH_TEST_PASSWORD || 'test1234'
const NO_PASSWORD = process.env.DSH_TEST_NO_PASSWORD === '1' // server without password auth
let failed = 0

function check(label, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// 0) pure helpers
check('expandTilde ~', expandTilde('~/x') === join(homedir(), 'x'), expandTilde('~/x'))
check('expandTilde $HOME', expandTilde('$HOME/x') === join(homedir(), 'x'))
check('expandTilde passthrough', expandTilde('/abs/x') === '/abs/x')
check('classify auth error', classifyError(new Error('All configured authentication methods failed')).code === 'AUTH')
check('classify refused', classifyError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })).code === 'REFUSED')
check('classify dns', classifyError(Object.assign(new Error('getaddrinfo ENOTFOUND nope'), { code: 'ENOTFOUND' })).code === 'DNS')
check('classify keyfile', classifyError(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })).code === 'KEYFILE')
check('classify has zh+en', (() => { const c = classifyError(new Error('x')); return typeof c.zh === 'string' && typeof c.en === 'string' })())

// 1) password authentication + TOFU fingerprint capture
let fpForPin = ''
if (NO_PASSWORD) {
	console.log('SKIP  password auth + connect (server has no password auth) — key path covers the rest')
} else {
	const pw = new RemoteConnection({ ...target, auth: 'password', password: PASSWORD })
	await pw.connect()
	check('password auth + connect', true, `platform=${pw.platform}`)
	check('fingerprint captured (TOFU)', /^SHA256:[A-Za-z0-9+/]+$/.test(pw.fingerprint || ''), pw.fingerprint)
	fpForPin = pw.fingerprint

	const r1 = await pw.exec('echo HELLO_FROM_SSH2 && uname -a')
	check('exec echo', r1.code === 0 && r1.stdout.includes('HELLO_FROM_SSH2'), `exit=${r1.code} out=${r1.stdout.trim().slice(0, 60)}`)

	const list = await pw.listDir('/')
	check('sftp list /', Array.isArray(list) && list.length > 0, `${list.length} entries`)
	check('list entries carry mtime', list.every((e) => e.mtime === null || typeof e.mtime === 'number'))
	check('list sorted dirs-first', (() => {
		const firstFile = list.findIndex((e) => e.type !== 'directory')
		if (firstFile === -1) return true
		return list.slice(firstFile).every((e) => e.type !== 'directory')
	})())

	await pw.writeFile('/tmp/dsh-remote-test.txt', 'hello remote world\n')
	const readBack = await pw.readFile('/tmp/dsh-remote-test.txt')
	check('sftp write+read', readBack.trim() === 'hello remote world', readBack.trim())

	const home = await pw.home()
	check('sftp home()', typeof home === 'string' && home.startsWith('/'), home)

	const bad = await pw.exec('exit 42')
	check('exit code propagation', bad.code === 42, `code=${bad.code}`)

	pw.close()

	// host-key pinning: wrong pin must abort with HOSTKEY, right pin must pass
	try {
		const badPin = new RemoteConnection({ ...target, auth: 'password', password: PASSWORD, hostFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' })
		await badPin.connect()
		check('hostkey mismatch rejected', false)
	} catch (err) {
		check('hostkey mismatch rejected', err.classified?.code === 'HOSTKEY', err.classified?.code || err.message.slice(0, 50))
	}

	const pinned = new RemoteConnection({ ...target, auth: 'password', password: PASSWORD, hostFingerprint: pw.fingerprint })
	await pinned.connect()
	const pinExec = await pinned.exec('echo PINNED_OK')
	check('hostkey pinned connect + exec', pinExec.code === 0 && pinExec.stdout.includes('PINNED_OK'))
	pinned.close()
}

// 3) key authentication (path from DSH_TEST_KEY, or default; skipped when absent)
const keyPath = process.env.DSH_TEST_KEY || join(homedir(), '.ssh', 'id_ed25519')
const key = new RemoteConnection({ ...target, auth: 'key', keyPath })
if (!existsSync(keyPath)) {
	console.log(`SKIP  key auth (no key file at ${keyPath})`)
} else {
	await key.connect()
	const r2 = await key.exec('echo KEY_AUTH_OK')
	check('key auth + exec', r2.code === 0 && r2.stdout.includes('KEY_AUTH_OK'), `exit=${r2.code}`)
	if (NO_PASSWORD) {
		// key-only server: run the full coverage here
		check('fingerprint captured via key (TOFU)', /^SHA256:[A-Za-z0-9+/]+$/.test(key.fingerprint || ''), key.fingerprint)
		const list = await key.listDir('/')
		check('sftp list /', Array.isArray(list) && list.length > 0, `${list.length} entries`)
		check('list entries carry mtime', list.every((e) => e.mtime === null || typeof e.mtime === 'number'))
		await key.writeFile('/tmp/dsh-remote-test.txt', 'hello remote world\n')
		const readBack = await key.readFile('/tmp/dsh-remote-test.txt')
		check('sftp write+read', readBack.trim() === 'hello remote world', readBack.trim())
		const home = await key.home()
		check('sftp home()', typeof home === 'string' && home.startsWith('/'), home)
		const bad = await key.exec('exit 42')
		check('exit code propagation', bad.code === 42, `code=${bad.code}`)
		try {
			const badPin = new RemoteConnection({ ...target, auth: 'key', keyPath, hostFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' })
			await badPin.connect()
			check('hostkey mismatch rejected', false)
		} catch (err) {
			check('hostkey mismatch rejected', err.classified?.code === 'HOSTKEY', err.classified?.code || err.message.slice(0, 50))
		}
		const pinnedKey = new RemoteConnection({ ...target, auth: 'key', keyPath, hostFingerprint: key.fingerprint })
		await pinnedKey.connect()
		const pinExec = await pinnedKey.exec('echo PINNED_OK')
		check('hostkey pinned connect + exec', pinExec.code === 0 && pinExec.stdout.includes('PINNED_OK'))
		pinnedKey.close()
	}
	key.close()
}

// 4) wrong password must fail cleanly with a classified AUTH error
const badPw = new RemoteConnection({ ...target, auth: 'password', password: 'wrong-password' })
try {
	await badPw.connect()
	check('wrong password rejected', false)
} catch (err) {
	check('wrong password rejected', err.classified?.code === 'AUTH', err.classified?.code || String(err.message).slice(0, 60))
}

// 5) refused port classifies as REFUSED
const refused = new RemoteConnection({ host: '127.0.0.1', port: 2299, user: 'dev', auth: 'password', password: 'x' })
try {
	await refused.connect()
	check('refused port rejected', false)
} catch (err) {
	check('refused port rejected', ['REFUSED', 'TIMEOUT'].includes(err.classified?.code), err.classified?.code || String(err.message).slice(0, 60))
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

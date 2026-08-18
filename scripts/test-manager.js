/**
 * End-to-end validation of the RemoteManager (product Host logic) without the
 * harness: profile save → connect → exec → sftp write/read → test → probe →
 * browse → status, plus the v0.2 store semantics (blank-keeps-secret, port
 * coercion, agent migration).
 *
 * Usage: node scripts/test-manager.js
 * Env: DSH_TEST_HOST/PORT/USER/PASSWORD, DSH_TEST_KEY, DSH_TEST_NO_PASSWORD=1
 */

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteManager } from '../packages/remote-ssh/index.js'
import { loadProfiles, profilesFile } from '../packages/remote-ssh/profiles.js'

// Fresh profile store per run (test isolation).
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-remote-mgr-'))

const TARGET = {
  host: process.env.DSH_TEST_HOST || '127.0.0.1',
  port: Number(process.env.DSH_TEST_PORT || 2222),
  user: process.env.DSH_TEST_USER || 'dev',
}
const PASSWORD = process.env.DSH_TEST_PASSWORD || 'test1234'
const NO_PASSWORD = process.env.DSH_TEST_NO_PASSWORD === '1'
const keyPath = process.env.DSH_TEST_KEY || join(process.env.HOME || '', '.ssh', 'id_ed25519')

const manager = new RemoteManager()
let failed = 0

function check(label, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const AUTH = NO_PASSWORD ? 'key' : 'password'
const CREDS = NO_PASSWORD ? { auth: 'key', keyPath } : { auth: 'password', password: PASSWORD }

// profile save
const p = await manager.saveProfile({
  name: 'docker-test', ...TARGET, ...CREDS,
})
check('saveProfile', p.id && p.name === 'docker-test', p.id)
check('save strips secrets from RPC view', !('password' in p) && !('passphrase' in p))

// port string coercion + default name
const coerced = await manager.saveProfile({ ...TARGET, port: String(TARGET.port), user: TARGET.user, ...CREDS })
check('port coerced to number', typeof coerced.port === 'number' && coerced.port === TARGET.port)
check('default name user@host', coerced.name === TARGET.user + '@' + TARGET.host, coerced.name)
await manager.deleteProfile(coerced.id)

const st = await manager.connect(p.id)
check('connect (' + AUTH + ')', st.status === 'connected' && st.platform === 'posix', 'platform=' + st.platform)
check('connect pins fingerprint (TOFU)', /^SHA256:/.test(st.hostFingerprint || ''), st.hostFingerprint)

const conn = await manager.require(p.id)
const e = await conn.exec('echo MANAGER_OK && whoami')
check('exec via manager', e.code === 0 && e.stdout.includes('MANAGER_OK'), 'exit=' + e.code + ' out=' + e.stdout.trim())

await conn.writeFile('/tmp/dsh-mgr.txt', 'manager write test\n')
const rb = await conn.readFile('/tmp/dsh-mgr.txt')
check('sftp write+read via manager', rb.trim() === 'manager write test', rb.trim())

const t = await manager.test(p.id)
check('test()', t.ok === true && t.platform === 'posix' && t.fingerprint === st.hostFingerprint)

// probe with raw (unsaved) form values
const probe = await manager.probe({ ...TARGET, ...CREDS })
check('probe (form values)', probe.ok === true && typeof probe.latencyMs === 'number', probe.latencyMs + 'ms')

// browse lists entries; browseClose keeps user-opened connections open
const browse1 = await manager.browse({ id: p.id })
check('browse lists entries', Array.isArray(browse1.entries) && browse1.entries.length > 0, browse1.path)
check('browse returns home', typeof browse1.home === 'string' && browse1.home.startsWith('/'), browse1.home)
await manager.browseClose(p.id)
check('browseClose keeps user-opened connection', manager.statusAll()[0].status === 'connected')

check('statusAll connected', manager.statusAll().length >= 1 && manager.statusAll()[0].status === 'connected')
check('statusAll carries secretStore + lastError', manager.statusAll()[0].secretStore === 'file' && manager.statusAll()[0].lastError === null)

await manager.disconnect(p.id)
check('statusAll after disconnect', manager.statusAll()[0].status === 'disconnected')

// blank secret on edit keeps the stored value
const keepName = await manager.saveProfile({ id: p.id, name: 'docker-test-renamed', ...TARGET, ...CREDS, ...(NO_PASSWORD ? { passphrase: '' } : { password: '' }) })
const reconnect = await manager.connect(keepName.id)
check('edit with blank secret keeps it (reconnect ok)', reconnect.status === 'connected')
await manager.disconnect(keepName.id)

// legacy agent profile migrates to explicit key auth
const legacyId = 'plegacy'
writeFileSync(profilesFile(), JSON.stringify([{
  id: legacyId, name: 'legacy-agent', ...TARGET, port: String(TARGET.port),
  auth: 'agent', password: '', keyPath: '', bind_path: '/srv/app',
}]))
const migrated = loadProfiles().find((x) => x.id === legacyId)
check('agent -> key migration', migrated && migrated.auth === 'key', (migrated && migrated.auth) + ' keyPath=' + (migrated && migrated.keyPath))
check('migration normalizes port + bind_path', migrated && migrated.port === TARGET.port && migrated.bindPath === '/srv/app')
if (migrated && migrated.keyPath && existsSync(migrated.keyPath)) {
  const ms = await manager.connect(legacyId)
  check('migrated agent profile connects', ms.status === 'connected')
  await manager.disconnect(legacyId)
} else {
  console.log('SKIP  migrated agent profile connect (no default key found)')
}

// wrong credentials fail cleanly with a classified AUTH error
const bad = await manager.saveProfile({
  name: 'docker-bad', ...TARGET, ...(NO_PASSWORD ? { auth: 'key', keyPath: keyPath + '.missing' } : { auth: 'password', password: 'nope' }),
})
try {
  await manager.connect(bad.id)
  check('wrong credentials rejected', false)
} catch (err) {
  const expected = NO_PASSWORD ? 'KEYFILE' : 'AUTH'
  check('wrong credentials rejected', err.classified && err.classified.code === expected, (err.classified && err.classified.code) || String(err.message).slice(0, 60))
}

// hostkey mismatch surfaces HOSTKEY through the manager
await manager.saveProfile({ id: p.id, name: 'docker-test-renamed', ...TARGET, ...CREDS, hostFingerprint: 'SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=' })
try {
  await manager.connect(p.id)
  check('hostkey mismatch via manager rejected', false)
} catch (err) {
  check('hostkey mismatch via manager rejected', err.classified && err.classified.code === 'HOSTKEY', (err.classified && err.classified.code) || String(err.message).slice(0, 60))
}

// v0.3: workspace-directory binding semantics (the picker confirm path)
await manager.saveProfile({ id: p.id, name: 'docker-test-renamed', ...TARGET, ...CREDS })
manager.resetFingerprint(p.id) // the mismatch test above pinned a bogus one
const bound = manager.bind(p.id, '/tmp')
check('bind persists bindPath', bound.bindPath === '/tmp' && !!bound.boundAt, bound.bindPath)
check('bind survives a reload', (loadProfiles().find((x) => x.id === p.id) || {}).bindPath === '/tmp')
check('resolveBound joins relative', manager.resolveBound(p.id, 'src/a.js') === '/tmp/src/a.js', manager.resolveBound(p.id, 'src/a.js'))
check('resolveBound keeps absolute', manager.resolveBound(p.id, '/etc/hosts') === '/etc/hosts')
check('resolveBound keeps windows drive', manager.resolveBound(p.id, 'C:/x/y') === 'C:/x/y')
check('withDefaultCwd wraps posix cd', manager.withDefaultCwd(p.id, 'pwd', 'linux').startsWith("cd '/tmp' && "), manager.withDefaultCwd(p.id, 'pwd', 'linux'))
check('unbound profile passthrough', manager.withDefaultCwd('no-such-id', 'pwd', 'linux') === 'pwd')
const contexts = manager.boundContexts()
check('boundContexts lists the profile', contexts.some((x) => x.id === p.id), contexts.map((x) => x.bindPath).join(','))
// exec through the tool path runs inside the bound directory
const connB = await manager.require(p.id)
const wrapped = manager.withDefaultCwd(p.id, 'pwd', connB.platform)
const rB = await connB.exec(wrapped)
check('exec with bound cwd', rB.code === 0 && rB.stdout.trim() === '/tmp', rB.stdout.trim())
// binding another machine reorders boundContexts (most recent first)
await manager.saveProfile({ name: 'second-bound', host: '192.0.2.99', port: 22, user: 'x', auth: 'password', password: 'y' })
const second = loadProfiles().find((x) => x.name === 'second-bound')
manager.bind(second.id, '/srv')
check('boundContexts most-recent first', manager.boundContexts()[0].id === second.id)
// clearing the binding clears the timestamp (the legacy /srv/app profile may stay bound)
manager.bind(p.id, '')
check('unbind clears', (loadProfiles().find((x) => x.id === p.id) || {}).bindPath === '' && !manager.boundContexts().some((x) => x.id === p.id))

manager.closeAll()
console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)

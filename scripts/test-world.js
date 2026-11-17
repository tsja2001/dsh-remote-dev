import { rm, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { RemoteConnection } from '../packages/remote-ssh/transport.js'
import { MANAGER_KEY, posixQuote } from '../packages/remote-ssh/world-support.js'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

/**
 * End-to-end validation of the remote world plugins (remote-fs / remote-shell /
 * presets) against a real SSH server: the full FileSystem contract over SFTP,
 * the ShellExecutor contract over exec channels, and preset authoring.
 *
 * Usage: node scripts/test-world.js
 * Env: DSH_TEST_HOST/PORT/USER, DSH_TEST_KEY, DSH_TEST_NO_PASSWORD=1
 */

const HOST = process.env.DSH_TEST_HOST || '127.0.0.1'
const PORT = Number(process.env.DSH_TEST_PORT || 2222)
const USER = process.env.DSH_TEST_USER || 'dev'
const KEY_PATH = process.env.DSH_TEST_KEY || ''

const PROFILE = {
  id: 'ptest', name: 'TestBox', host: HOST, port: PORT, user: USER,
  auth: 'key', keyPath: KEY_PATH, password: '', passphrase: '',
}
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-remote-world-'))
const ROOT = (process.env.DSH_TEST_ROOT || '/tmp').replace(/\/+$/, '') + '/dsh-world-' + randomUUID()

let pass = 0, fail = 0
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('PASS', label) }
  else { fail++; console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}

const conn = new RemoteConnection(PROFILE)
await conn.connect()
console.log('platform:', conn.platform)
async function remote(command) {
  const result = await conn.exec(command)
  if (result.code !== 0) throw new Error(`remote fixture command failed: ${result.stderr}`)
  return result.stdout
}
// The SSH server may be in a container: create fixtures through SSH/SFTP,
// never through the test runner's local filesystem.
await remote(`mkdir -p ${posixQuote(ROOT)}`)

const provides = {}
const ctx = {
  provide(name, value) { provides[name] = value; return () => { delete provides[name] } },
  effect(fn) { const d = fn(); return () => d?.() },
}
globalThis[MANAGER_KEY] = { connection: async () => conn }

const fsMod = await import('../packages/remote-ssh/remote-fs.js')
fsMod.apply(ctx, { profile: 'ptest', root: ROOT, anchor: '/no/such/host/dir' })
ok('fs provided', provides.fs !== undefined)
const fs = provides.fs

const t1 = await fs.resolve('hello.txt')
ok('resolve joins root', t1.targetKey === ROOT + '/hello.txt', t1)

// An explicit execution-world cwd is honored; only the known local anchor
// maps to the bound remote root.
const tRemote = await fs.resolve('hello.txt', { cwd: '/tmp' })
ok('resolve honors remote cwd', tRemote.targetKey.endsWith('/tmp/hello.txt'), tRemote)
const tHost = await fs.resolve('hello.txt', { cwd: '/no/such/host/dir' })
ok('resolve maps original anchor to root', tHost.targetKey === ROOT + '/hello.txt', tHost)
const t2 = await fs.resolve('/etc/hostname')
ok('resolve absolute remote path canonically', t2.targetKey === (await conn.realpath('/etc')) + '/hostname', t2)

const w1 = await fs.writeText(t1, 'line one\nline two\n')
ok('write create', w1.operation === 'create' && w1.before === null, w1)

const s1 = await fs.stat(t1)
ok('stat file', s1?.type === 'file' && typeof s1.version === 'string' && s1.size > 0, s1)

const r1 = await fs.readText(t1)
ok('readText', r1 === 'line one\nline two\n', JSON.stringify(r1))

let refused = null
try { await fs.writeText(t1, 'x', { kind: 'createIfAbsent' }) } catch (e) { refused = e }
ok('guarded create refuses', refused?.code === 'FS_NOT_OBSERVED', refused?.code)

const w2 = await fs.writeText(t1, 'line one\nline two v2\n', { kind: 'replaceIfVersion', version: s1.version })
ok('guarded replace ok', w2.operation === 'update' && w2.before === 'line one\nline two\n', w2)

let stale = null
try { await fs.writeText(t1, 'x', { kind: 'replaceIfVersion', version: s1.version }) } catch (e) { stale = e }
ok('stale version refuses', stale?.code === 'FS_STALE_VERSION', stale?.code)

const e1 = await fs.editText(t1, { oldString: 'line two v2', newString: 'LINE TWO EDITED', replaceAll: false }, { kind: 'replaceIfVersion', version: w2.version })
ok('editText applies', e1.after === 'line one\nLINE TWO EDITED\n' && e1.before.includes('line two v2'), e1)

await conn.writeFile(join(ROOT, 'dup.txt'), 'aa bb aa\n')
const tDup = await fs.resolve('dup.txt')
let nf = null, amb = null
try { await fs.editText(tDup, { oldString: 'zz', newString: 'y', replaceAll: false }) } catch (e) { nf = e }
try { await fs.editText(tDup, { oldString: 'aa', newString: 'y', replaceAll: false }) } catch (e) { amb = e }
ok('edit not found', nf?.code === 'FS_EDIT_NOT_FOUND', nf?.code)
ok('edit ambiguous', amb?.code === 'FS_AMBIGUOUS_EDIT', amb?.code)
const e2 = await fs.editText(tDup, { oldString: 'aa', newString: 'y', replaceAll: true })
ok('edit replaceAll', e2.after === 'y bb y\n', e2)

await conn.writeFile(join(ROOT, 'crlf.txt'), 'a\r\nb\r\n')
const tCrlf = await fs.resolve('crlf.txt')
const e3 = await fs.editText(tCrlf, { oldString: 'b', newString: 'B', replaceAll: false })
ok('edit crlf normalized basis', e3.after === 'a\nB\n')
const stored = await conn.readFile(join(ROOT, 'crlf.txt'))
ok('crlf stored with CR', stored === 'a\r\nB\r\n', JSON.stringify(stored))

await conn.writeFile(join(ROOT, 'bin.dat'), Buffer.from([0, 1, 2, 3]))
const tBin = await fs.resolve('bin.dat')
let bin = null
try { await fs.readText(tBin) } catch (e) { bin = e }
ok('binary rejected', bin?.code === 'FS_NOT_TEXT', bin?.code)
let overflow
try { await fs.readBytes(tBin, undefined, 2) } catch (error) { overflow = error }
ok('readBytes overflow rejects instead of truncating', overflow?.code === 'FS_TOO_LARGE', overflow?.code)
const bytes = await fs.readByteRange(tBin, { offset: 0, length: 2 })
ok('readByteRange returns requested prefix', bytes.length === 2 && bytes[0] === 0 && bytes[1] === 1, bytes)

await conn.writeFile(join(ROOT, 'stream.txt'), 'one\ntwo\nthree')
const tStream = await fs.resolve('stream.txt')
const lines = []
for await (const chunk of await fs.streamText(tStream)) lines.push(chunk)
ok('streamText preserves newlines', lines.join('') === 'one\ntwo\nthree', lines)

await remote(`mkdir -p ${posixQuote(join(ROOT, 'sub'))}`)
const dir = await fs.resolve('.')
const entries = await fs.listDir(dir)
const names = entries.map((x) => x.name).sort()
ok('listDir entries', names.includes('hello.txt') && names.includes('sub') && names.includes('bin.dat'), names)
const subEntry = entries.find((x) => x.name === 'sub')
ok('listDir target resolvable', (await fs.stat(subEntry.target))?.type === 'directory')
ok('contains', fs.contains(dir, subEntry.target) && !fs.contains(subEntry.target, dir))
await remote(`ln -s ${posixQuote(join(ROOT, 'hello.txt'))} ${posixQuote(join(ROOT, 'link.txt'))}`)
const li = await fs.lstat('link.txt')
ok('lstat sees symlink', li?.type === 'symlink', li)
const li2 = await fs.lstat('hello.txt')
ok('lstat regular', li2?.type === 'file', li2)

const tMiss = await fs.resolve('nope.txt')
ok('stat absent', (await fs.stat(tMiss)) === undefined)
let rmiss = null
try { await fs.readText(tMiss) } catch (e) { rmiss = e }
ok('read missing maps', rmiss?.code === 'FS_NOT_FOUND', rmiss?.code)

const shellMod = await import('../packages/remote-ssh/remote-shell.js')
shellMod.apply(ctx, { profile: 'ptest', root: ROOT })
ok('shell provided', provides.shell !== undefined)
const shell = provides.shell
ok('shell sandboxMode undefined', shell.sandboxMode === undefined)

const spec = shell.resolve({ command: 'pwd && echo hi' })
ok('resolve defaults workdir', spec.workdir === ROOT && spec.timeoutMs > 0, spec)
const run1 = await shell.run(spec)
ok('run pwd in root', run1.exitCode === 0 && run1.stdout.text.trim().split('\n')[0] === ROOT && run1.stdout.text.includes('hi'), run1)

// workdir that exists remotely is honored; one that does not falls back to root
const runTmp = await shell.run(shell.resolve({ command: 'pwd', workdir: '/tmp' }))
ok('workdir existing remotely honored', runTmp.exitCode === 0 && runTmp.stdout.text.trim() === '/tmp', runTmp)
const runMissing = await shell.run(shell.resolve({ command: 'pwd', workdir: '/no/such/host/dir' }))
ok('missing workdir falls back to root', runMissing.exitCode === 0 && runMissing.stdout.text.trim() === ROOT, runMissing)

const run2 = await shell.run(shell.resolve({ command: 'printf "[%s]" "$MYVAR"', env: { MYVAR: "it's quoted" } }))
ok('env exported', run2.exitCode === 0 && run2.stdout.text === "[it's quoted]", run2)

const run3 = await shell.run(shell.resolve({ command: 'cat', stdin: 'piped-input' }))
ok('stdin piped', run3.stdout.text === 'piped-input', run3)

const run4 = await shell.run(shell.resolve({ command: 'sleep 5', timeoutMs: 800 }))
ok('timeout kills', run4.timedOut === true && run4.exitCode === null, run4)

const ac = new AbortController()
setTimeout(() => ac.abort(), 300)
const run5 = await shell.run(shell.resolve({ command: 'sleep 5', signal: ac.signal }))
ok('abort kills', run5.aborted === true, run5)

const run6 = await shell.run(shell.resolve({ command: 'exit 42' }))
ok('nonzero resolves', run6.exitCode === 42 && run6.timedOut === false, run6)

const run7 = await shell.run(shell.resolve({ command: 'head -c 100000 /dev/zero | tr \'\\0\' "x"', stdoutMaxBytes: 1000 }))
ok('output capped', run7.stdout.text.length <= 1010 && run7.stdout.truncated === true, { len: run7.stdout.text.length })

const bg = await shell.start(shell.resolve({ command: 'echo bg-start; sleep 1; echo bg-end' }))
await new Promise((r) => setTimeout(r, 250))
const read1 = bg.readOutput()
ok('bg incremental', read1.delta.includes('bg-start') && !read1.delta.includes('bg-end'), read1)
await bg.done
const read2 = bg.readOutput()
ok('bg completes', read2.delta.includes('bg-end') && bg.status === 'completed', { status: bg.status })

const bg2 = await shell.start(shell.resolve({ command: 'sleep 30' }))
await new Promise((r) => setTimeout(r, 250))
ok('bg kill', bg2.kill() === true)
await bg2.done
ok('bg killed status', bg2.status === 'killed')

const { ensureRemotePreset, removeRemotePreset, readRemotePreset, listRemotePresets } = await import('../packages/remote-ssh/presets.js')
const tmpHome = join(process.env.DSH_HOME, 'preset-home')
await rm(tmpHome, { recursive: true, force: true })
const pres = await ensureRemotePreset({ home: tmpHome, profileId: 'ptest', profileName: 'TestBox', root: ROOT, target: 'remote://' + USER + '@' + HOST + ':' + PORT + ROOT })
ok('preset authored', /^remote-ssh-[a-z0-9-]+$/.test(pres.presetId) && pres.wrote === true, pres)
const again = await ensureRemotePreset({ home: tmpHome, profileId: 'ptest', profileName: 'TestBox', root: ROOT, target: 'remote://' + USER + '@' + HOST + ':' + PORT + ROOT })
ok('preset idempotent', again.wrote === false && again.presetId === pres.presetId)
const comp = await readFile(join(pres.directory, 'agent.cordis.yml'), 'utf8')
const parsed = yaml.load(comp)
const world = parsed[0]
const rowNames = world.config.map(row => row.name)
ok('composition shape', world.name === 'cordis:group' && world.isolate.fs === true
  && world.isolate.shell === true && world.isolate.subprocess === true && world.isolate.workingDirectory === true
  && rowNames.some(name => name.endsWith('remote-fs.js')) && rowNames.some(name => name.endsWith('remote-shell.js'))
  && rowNames.some(name => name.endsWith('remote-subprocess.js'))
  && rowNames.includes('@deepseek-ai/dsh-tool-fs') && rowNames.includes('@deepseek-ai/dsh-tool-bash'))
const meta = await readFile(join(pres.directory, 'preset.yml'), 'utf8')
ok('preset metadata', yaml.load(meta).name.includes('[SSH: TestBox]'), meta)
ok('composition parses', Array.isArray(parsed) && world.name === 'cordis:group' && world.isolate.fs === true)
const back = await readRemotePreset({ home: tmpHome, presetId: pres.presetId })
ok('preset read back', back?.composition === comp)
const listing = await listRemotePresets({ home: tmpHome })
ok('preset listed', listing.length === 1 && listing[0].presetId === pres.presetId && listing[0].profile === 'ptest' && listing[0].root === ROOT && listing[0].name.includes('TestBox'), listing)
let removeRefused = null
try { await removeRemotePreset({ home: tmpHome, presetId: '../evil' }) } catch (e) { removeRefused = e }
ok('remove refuses foreign ids', removeRefused !== undefined)
await removeRemotePreset({ home: tmpHome, presetId: pres.presetId })
const gone = await readRemotePreset({ home: tmpHome, presetId: pres.presetId })
ok('preset removed', gone === undefined)

await remote(`rm -rf -- ${posixQuote(ROOT)}`)
conn.close()
console.log('\nTOTAL: ' + pass + ' pass, ' + fail + ' fail')
process.exit(fail ? 1 : 0)
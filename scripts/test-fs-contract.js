import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FsError } from '@deepseek-ai/dsh-fs'
import { parsePatch } from '@deepseek-ai/dsh-fs-patch'
import { RemoteSshFileSystem, apply } from '../packages/remote-ssh/remote-fs.js'
import { MANAGER_KEY } from '../packages/remote-ssh/world-support.js'

/**
 * Filesystem contract regression tests. This in-memory SFTP connection never
 * opens a socket, reads credentials, invokes a shell, or touches a host file.
 * Reads deliberately support short packets and deterministic races so the
 * tests exercise the remote provider's I/O, not just its string helpers.
 */
class MemorySftp {
  constructor() {
    this.files = new Map()
    this.aliases = new Map()
    this.platform = 'posix'
    this.readMax = Infinity
    this.reads = []
    this.opened = 0
    this.closed = 0
    this.fullReads = 0
    this.published = 0
    this.unlinked = 0
    this.set('/work', '', 'directory')
    this.set('/', '', 'directory')
  }

  set(path, content, type = 'file', mode = 0o100640) {
    this.files.set(path, { bytes: Buffer.from(content), type, mode, mtime: 100 })
  }

  bytes(path) { return this.files.get(path)?.bytes }
  text(path) { return this.bytes(path)?.toString('utf8') }

  canonical(path) {
    for (const [alias, real] of this.aliases) {
      if (path === alias || path.startsWith(alias + '/')) return real + path.slice(alias.length)
    }
    return path
  }

  entry(path) {
    const entry = this.files.get(this.canonical(path))
    if (!entry) throw Object.assign(new Error('no such file'), { code: 2 })
    return entry
  }

  attrs(entry) {
    return { size: entry.bytes.length, mtime: entry.mtime, mode: entry.mode,
      isFile: () => entry.type === 'file', isDirectory: () => entry.type === 'directory',
      isSymbolicLink: () => entry.type === 'symlink' }
  }

  async realpath(path) {
    this.entry(path)
    return this.canonical(path)
  }

  async statPath(path, options = {}) {
    if (options.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    if (this.statError) throw this.statError
    const attrs = this.attrs(this.entry(path))
    await this.afterStat?.(path)
    return attrs
  }

  async lstatPath(path) {
    if (this.aliases.has(path)) return this.attrs({ type: 'symlink', bytes: Buffer.alloc(0), mode: 0o120777, mtime: 100 })
    return this.statPath(path)
  }

  async readDirRaw(path) {
    return [...this.files].filter(([key]) => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/'))
      .map(([key, entry]) => ({ filename: key.slice(path.length + 1), attrs: this.attrs(entry) }))
  }

  async readFileBytes(path) {
    this.fullReads++
    if (this.readError) throw this.readError
    const bytes = Buffer.from(this.entry(path).bytes)
    await this.afterFullRead?.(path)
    return bytes
  }

  async openReadHandle(path) {
    if (this.readError) throw this.readError
    this.entry(path)
    this.opened++
    await this.afterOpen?.(path)
    let closed = false
    return {
      read: async (buffer, offset, length, position) => {
        assert.equal(closed, false)
        const data = this.entry(path).bytes
        const bytesRead = Math.min(length, this.readMax, Math.max(0, data.length - position))
        data.copy(buffer, offset, position, position + bytesRead)
        this.reads.push({ path, position, requested: length, bytesRead })
        await this.afterRead?.(path, position, bytesRead)
        if (this.packetError) throw this.packetError
        return { buffer, bytesRead }
      },
      close: async () => {
        assert.equal(closed, false, 'each descriptor closes exactly once')
        closed = true
        this.closed++
        if (this.closeError) throw this.closeError
      },
    }
  }

  async writeFileAtomic(path, bytes, options = {}) {
    this.lastWriteOptions = options
    await this.beforePublish?.(path)
    await options.beforePublish?.()
    if (options.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    // Simulate a race after the provider's final check: no-clobber publication
    // must still refuse an intervening creator at the transport boundary.
    await this.beforeCommit?.(path)
    if (options.createIfAbsent && this.files.has(path)) throw Object.assign(new Error('already exists'), { code: 'EEXIST' })
    if (this.writeError) throw this.writeError
    this.set(path, bytes, 'file', options.mode ?? 0o100600)
    this.published++
    await this.afterPublish?.(path)
  }

  async unlinkFile(path) {
    if (this.unlinkError) throw this.unlinkError
    this.entry(path)
    this.files.delete(path)
    this.unlinked++
  }
}

function fixture() {
  const conn = new MemorySftp()
  let acquired = 0
  const support = { profileId: 'memory-only', root: '/work', anchor: '/host', platformCache: 'posix',
    acquire: async () => { acquired++; return conn }, platformOf: async () => conn.platform }
  return { fs: new RemoteSshFileSystem(support), conn, support, acquisitions: () => acquired }
}

function target(path = '/work/file.txt') { return { targetKey: path, displayPath: path } }
function code(expected) { return (err) => err instanceof FsError && err.code === expected }
async function stream(fs, path = target(), signal) {
  const iterator = fs.streamText(path, signal)
  assert.equal(typeof iterator.then, 'function', 'current host expects Promise<AsyncIterable<string>>')
  let out = ''
  for await (const chunk of await iterator) out += chunk
  return out
}
function hunks(body) { return parsePatch(`*** Begin Patch\n*** Update File: file.txt\n${body}\n*** End Patch`)[0].hunks }

await test('remote identity and plain-object service defaults', async () => {
  const { fs, support, acquisitions } = fixture()
  assert.equal(fs.profileId, 'memory-only')
  assert.equal(fs.root, '/work')
  assert.throws(() => { fs.root = '/local' }, TypeError)
  assert.throws(() => { fs.profileId = 'other' }, TypeError)
  support.root = '/changed'
  assert.equal(fs.root, '/work')
  assert.equal(fs.sandboxMode, undefined)
  assert.equal(fs.processPathFromHostPath('/work/file.txt'), undefined)
  assert.equal(fs.processPathFromHostPath('C:\\work\\file.txt'), undefined)
  await assert.rejects(fs.watch(target(), () => {}, new AbortController().signal), code('FS_IO_ERROR'))
  assert.equal(acquisitions(), 0)
  assert.equal(fs.processPath({ targetKey: '/canonical', displayPath: '/alias' }), '/canonical')
  assert.equal(fs.fileUrl(target('/work/空 格#?.txt')), 'file:///work/%E7%A9%BA%20%E6%A0%BC%23%3F.txt')
  assert.equal(fs.contains(target('/work'), target('/work/file')), true)
  assert.equal(fs.contains(target('/work'), target('/work-other/file')), false)
})

await test('plugin registers remote identity and disposes its plain-object service', async () => {
  const conn = new MemorySftp()
  const prior = globalThis[MANAGER_KEY]
  globalThis[MANAGER_KEY] = { connection: async () => conn }
  let provided, cleanup
  try {
    apply({ provide: (name, value) => { assert.equal(name, 'fs'); provided = value; return () => { provided = undefined } },
      effect: (effect) => { cleanup = effect() } }, { profile: 'memory-only', root: '/work' })
    assert.equal(provided.root, '/work')
    assert.equal(provided.profileId, 'memory-only')
    assert.equal(typeof provided.moveFile, 'function')
    assert.equal(provided.processPathFromHostPath('/work'), undefined)
    cleanup()
    assert.equal(provided, undefined)
  } finally {
    if (prior === undefined) delete globalThis[MANAGER_KEY]
    else globalThis[MANAGER_KEY] = prior
  }
})

await test('resolution anchors remote root and missing children share ancestor identity', async () => {
  const { fs, conn } = fixture()
  conn.aliases.set('/alias', '/work')
  assert.deepEqual(await fs.resolve('new/sub/file', { cwd: '/host' }), target('/work/new/sub/file'))
  assert.deepEqual(await fs.resolve('/alias/new.txt'), target('/work/new.txt'))
  conn.set('/work/new.txt', 'hello')
  assert.deepEqual(await fs.resolve('/alias/new.txt'), target('/work/new.txt'))
  conn.statError = Object.assign(new Error('permission denied'), { code: 3 })
  conn.realpath = async () => { throw conn.statError }
  await assert.rejects(fs.resolve('/blocked'), code('FS_PERMISSION_DENIED'))
})

await test('explicit remote cwd is honored while missing and non-directory cwd fail closed', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/sub', '', 'directory')
  conn.set('/work/sub/file.txt', 'sub file')
  assert.deepEqual(await fs.resolve('file.txt', { cwd: '/work/sub' }), target('/work/sub/file.txt'))
  assert.equal((await fs.lstat('file.txt', { cwd: '/work/sub' })).type, 'file')
  await assert.rejects(fs.resolve('file.txt', { cwd: '/missing' }), code('FS_NOT_FOUND'))
  await assert.rejects(fs.resolve('file.txt', { cwd: '/work/sub/file.txt' }), code('FS_NOT_DIRECTORY'))
  await assert.rejects(fs.resolve('file.txt', { cwd: 'relative' }), code('FS_NOT_DIRECTORY'))
  assert.deepEqual(await fs.resolve('/work/sub/file.txt', { cwd: '/missing' }), target('/work/sub/file.txt'))
  await assert.rejects(fs.resolve(''), code('FS_NOT_FOUND'))
  await assert.rejects(fs.lstat('  '), code('FS_NOT_FOUND'))
})

await test('raw whole reads are inclusive, complete, binary-safe, and bounded', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/file.txt', Buffer.from([0, 1, 2, 3]))
  assert.deepEqual([...await fs.readBytes(target(), undefined, 4)], [0, 1, 2, 3])
  assert.equal(conn.fullReads, 0)
  const opened = conn.opened
  await assert.rejects(fs.readBytes(target(), undefined, 3), code('FS_TOO_LARGE'))
  assert.equal(conn.opened, opened, 'stat rejects known overflow before opening content')
  await assert.rejects(fs.readBytes(target(), undefined, 0), code('FS_TOO_LARGE'))
  conn.set('/work/file.txt', '')
  assert.equal((await fs.readBytes(target(), undefined, 0)).length, 0)
  assert.equal(conn.opened, conn.closed)
})

await test('raw whole read detects post-stat growth and transfers at most cap plus one', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/file.txt', 'a')
  conn.readMax = 2
  conn.afterOpen = () => conn.set('/work/file.txt', 'abcdefghij')
  await assert.rejects(fs.readBytes(target(), undefined, 4), code('FS_TOO_LARGE'))
  assert.equal(conn.reads.reduce((sum, read) => sum + read.bytesRead, 0), 5)
  assert.equal(conn.closed, 1)
})

await test('byte windows seek without downloading skipped content or the whole file', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/file.txt', '0123456789'.repeat(10000))
  conn.readMax = 2
  assert.equal(Buffer.from(await fs.readByteRange(target(), { offset: 99993, length: 20 })).toString(), '3456789')
  assert.equal(conn.reads[0].position, 99993)
  assert.equal(conn.reads.reduce((sum, read) => sum + read.bytesRead, 0), 7)
  assert.equal(conn.fullReads, 0)
  assert.equal((await fs.readByteRange(target(), { offset: 100000, length: 3 })).length, 0)
  const opened = conn.opened
  assert.equal((await fs.readByteRange(target(), { offset: 0, length: 0 })).length, 0)
  assert.equal(conn.opened, opened)
  await assert.rejects(fs.readByteRange(target(), { offset: -1, length: 1 }), code('FS_IO_ERROR'))
  await assert.rejects(fs.readByteRange(target(), { offset: 0, length: 0.5 }), code('FS_IO_ERROR'))
  assert.equal(conn.closed, conn.opened)
})

await test('text streams preserve CRLF, blank lines, trailing newline, and split UTF-8', async () => {
  const { fs, conn } = fixture()
  conn.readMax = 1
  const text = '一😀\r\n\nsecond\r\n尾\n'
  conn.set('/work/file.txt', text)
  assert.equal(await stream(fs), text)
  assert.equal(await fs.readText(target()), text)
  assert.equal(conn.closed, conn.opened)
  conn.set('/work/file.txt', '')
  assert.equal(await stream(fs), '')
})

await test('text validation rejects NUL samples and malformed or incomplete UTF-8', async () => {
  const { fs, conn } = fixture()
  conn.readMax = 1
  for (const bytes of [Buffer.from([65, 0, 66]), Buffer.from([0xc0, 0xaf]), Buffer.from([65, 0xe4, 0xb8])]) {
    conn.set('/work/file.txt', bytes)
    await assert.rejects(fs.readText(target()), code('FS_NOT_TEXT'))
    await assert.rejects(stream(fs), code('FS_NOT_TEXT'))
    assert.equal(conn.closed, conn.opened)
  }
})

await test('binary sample boundary agrees between whole and streamed reads', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/file.txt', Buffer.concat([Buffer.alloc(8192, 65), Buffer.from([0])]))
  conn.readMax = 1000
  assert.equal(await stream(fs), await fs.readText(target()))
  await assert.rejects(fs.editText(target(), { oldString: 'A', newString: 'B', replaceAll: true }), code('FS_NOT_TEXT'))
})

await test('read boundaries reject directories and map SFTP status errors to host FsError', async () => {
  const { fs, conn } = fixture()
  await assert.rejects(fs.readText(target('/work')), code('FS_NOT_REGULAR_FILE'))
  await assert.rejects(stream(fs, target('/work')), code('FS_NOT_REGULAR_FILE'))
  await assert.rejects(fs.readByteRange(target('/work'), { offset: 0, length: 0 }), code('FS_NOT_REGULAR_FILE'))
  await assert.rejects(fs.readBytes(target(), undefined, 2), code('FS_NOT_FOUND'))
  assert.equal(await fs.stat(target()), undefined)
  conn.set('/work/file.txt', 'a')
  conn.readError = Object.assign(new Error('denied'), { code: 3 })
  await assert.rejects(fs.readText(target()), code('FS_PERMISSION_DENIED'))
})

await test('read cancellation closes descriptors and early stream return also closes', async () => {
  const { fs, conn, acquisitions } = fixture()
  conn.set('/work/file.txt', 'abcdef')
  const pre = AbortSignal.abort()
  await assert.rejects(fs.readBytes(target(), pre, 6), code('FS_ABORTED'))
  assert.equal(acquisitions(), 0)
  conn.readMax = 2
  const controller = new AbortController()
  conn.afterRead = () => controller.abort()
  await assert.rejects(fs.readBytes(target(), controller.signal, 6), code('FS_ABORTED'))
  assert.equal(conn.closed, conn.opened)
  conn.afterRead = undefined
  for await (const _chunk of await fs.streamText(target())) break
  assert.equal(conn.closed, conn.opened)
  conn.packetError = Object.assign(new Error('connection lost'), { code: 7 })
  await assert.rejects(stream(fs), code('FS_IO_ERROR'))
  assert.equal(conn.closed, conn.opened)
})

await test('descriptor cleanup errors stay typed and do not mask cancellation', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/file.txt', 'text')
  conn.closeError = Object.assign(new Error('channel close failed'), { code: 7 })
  await assert.rejects(fs.readBytes(target(), undefined, 4), code('FS_IO_ERROR'))
  await assert.rejects(stream(fs), code('FS_IO_ERROR'))
  const controller = new AbortController()
  conn.afterRead = () => controller.abort()
  await assert.rejects(fs.readBytes(target(), controller.signal, 4), code('FS_ABORTED'))
  assert.equal(conn.closed, conn.opened)
})

await test('connection acquisition receives cancellation and maps arbitrary abort reasons', async () => {
  const { fs, support } = fixture()
  const controller = new AbortController()
  let received
  support.acquire = (_reason, { signal }) => {
    received = signal
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  const pending = fs.readText(target(), controller.signal)
  controller.abort(new Error('custom reason'))
  await assert.rejects(pending, code('FS_ABORTED'))
  assert.equal(received, controller.signal)
})

await test('whole text read keeps the current host full-file semantics above the old 20 MiB ceiling', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/file.txt', Buffer.alloc(20 * 1024 * 1024 + 1, 65))
  const text = await fs.readText(target())
  assert.equal(text.length, 20 * 1024 * 1024 + 1)
  assert.equal(text.at(-1), 'A')
})

await test('writes honor current create/replace guards and exact caller storage semantics', async () => {
  const { fs, conn } = fixture()
  const created = await fs.writeText(target(), 'old\r\n')
  assert.equal(created.operation, 'create')
  assert.equal(created.before, null)
  assert.equal(created.after, 'old\n')
  assert.equal(conn.text('/work/file.txt'), 'old\r\n')
  await assert.rejects(fs.writeText(target(), 'x', { kind: 'createIfAbsent' }), code('FS_NOT_OBSERVED'))
  const updated = await fs.writeText(target(), 'new\n', { kind: 'replaceIfVersion', version: created.version })
  assert.equal(updated.before, 'old\n')
  assert.equal(updated.after, 'new\n')
  assert.equal(conn.text('/work/file.txt'), 'new\n', 'write stores caller text, not previous CRLF style')
  assert.equal(updated.version, (await fs.stat(target())).version)
  assert.notEqual(updated.version, created.version, 'same-size same-second provider writes get new versions')
  await assert.rejects(fs.writeText(target(), 'x', { kind: 'replaceIfVersion', version: created.version }), code('FS_STALE_VERSION'))
  await assert.rejects(fs.writeText(target('/work/missing'), 'x', { kind: 'replaceIfVersion', version: 'missing' }), code('FS_STALE_VERSION'))
  await assert.rejects(fs.writeText(target('/work'), 'x'), code('FS_NOT_REGULAR_FILE'))
})

await test('write contextual basis is bounded, optional, and LF-normalized', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/file.txt', Buffer.from([0, 1]))
  assert.equal((await fs.writeText(target(), 'text')).before, null)
  conn.set('/work/file.txt', Buffer.from([0xc0]))
  assert.equal((await fs.writeText(target(), 'text')).before, null)
  conn.set('/work/file.txt', Buffer.alloc(10 * 1024 * 1024, 65))
  const opens = conn.opened
  assert.equal((await fs.writeText(target(), 'small')).before, null)
  assert.equal(conn.opened, opens, 'at-limit basis is not read')
  assert.equal((await fs.writeText(target(), 'x'.repeat(10 * 1024 * 1024))).before, null)
  conn.set('/work/file.txt', 'old')
  conn.readError = Object.assign(new Error('permission denied'), { code: 3 })
  assert.equal((await fs.writeText(target(), 'replacement')).before, null)
  assert.equal(conn.text('/work/file.txt'), 'replacement')
})

await test('publication rechecks expected versions and atomic create races never clobber', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/file.txt', 'before')
  const version = (await fs.stat(target())).version
  conn.beforePublish = () => conn.set('/work/file.txt', 'external update')
  await assert.rejects(fs.writeText(target(), 'overwrite', { kind: 'replaceIfVersion', version }), code('FS_STALE_VERSION'))
  assert.equal(conn.text('/work/file.txt'), 'external update')
  assert.equal(conn.published, 0)
  conn.beforePublish = undefined
  conn.beforeCommit = (path) => conn.set(path, 'racing creator')
  await assert.rejects(fs.writeText(target('/work/new'), 'new', { kind: 'createIfAbsent' }), code('FS_NOT_OBSERVED'))
  assert.equal(conn.text('/work/new'), 'racing creator')
})

await test('writes abort before publication and preserve transport errors', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/file.txt', 'before')
  const controller = new AbortController()
  conn.beforePublish = () => controller.abort()
  await assert.rejects(fs.writeText(target(), 'after', undefined, controller.signal), code('FS_ABORTED'))
  assert.equal(conn.text('/work/file.txt'), 'before')
  conn.beforePublish = undefined
  conn.writeError = Object.assign(new Error('permission denied'), { code: 3 })
  await assert.rejects(fs.writeText(target(), 'after'), code('FS_PERMISSION_DENIED'))
  assert.equal(conn.text('/work/file.txt'), 'before')
})

await test('edit guards are plain {version}, checked before literal validation', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/file.txt', 'aa aa\r\n')
  await assert.rejects(fs.editText(target(), { oldString: 'missing', newString: 'x' }, { version: 'stale' }), code('FS_STALE_VERSION'))
  await assert.rejects(fs.editText(target(), { oldString: '', newString: 'x' }, { version: 'stale' }), code('FS_STALE_VERSION'))
  await assert.rejects(fs.editText(target('/work/missing'), { oldString: 'x', newString: 'y' }), code('FS_STALE_VERSION'))
  await assert.rejects(fs.editText(target('/work'), { oldString: 'x', newString: 'y' }), code('FS_NOT_REGULAR_FILE'))
  await assert.rejects(fs.editText(target(), { oldString: '', newString: 'x' }), code('FS_EDIT_NOT_FOUND'))
  await assert.rejects(fs.editText(target(), { oldString: 'missing', newString: 'x' }), code('FS_EDIT_NOT_FOUND'))
  await assert.rejects(fs.editText(target(), { oldString: 'aa', newString: 'x' }), code('FS_AMBIGUOUS_EDIT'))
  const version = (await fs.stat(target())).version
  const edited = await fs.editText(target(), { oldString: 'aa', newString: '$&$1', replaceAll: true }, { version })
  assert.deepEqual({ before: edited.before, after: edited.after }, { before: 'aa aa\n', after: '$&$1 $&$1\n' })
  assert.equal(conn.text('/work/file.txt'), '$&$1 $&$1\r\n')
  assert.equal(edited.version, (await fs.stat(target())).version)
})

await test('literal edits normalize CRLF search and replacement before matching', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/file.txt', 'one\r\ntwo\r\n')
  const edited = await fs.editText(target(), { oldString: 'one\r\ntwo', newString: 'new\r\ntext', replaceAll: false })
  assert.equal(edited.after, 'new\ntext\n')
  assert.equal(conn.text('/work/file.txt'), 'new\r\ntext\r\n')
})

await test('two guarded edits sharing a connection serialize across provider instances', async () => {
  const { fs, conn, support } = fixture()
  const second = new RemoteSshFileSystem(support)
  conn.set('/work/file.txt', 'aa')
  const version = (await fs.stat(target())).version
  const edit = { oldString: 'aa', newString: 'bb', replaceAll: false }
  const outcomes = await Promise.allSettled([fs.editText(target(), edit, { version }), second.editText(target(), edit, { version })])
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
  assert.equal(outcomes.find((outcome) => outcome.status === 'rejected').reason.code, 'FS_STALE_VERSION')
  assert.equal(conn.text('/work/file.txt'), 'bb')
  assert.equal(conn.published, 1)
  assert.equal((await fs.writeText(target(), 'after failure')).after, 'after failure', 'failed guard releases lock')
})

await test('patches use host hunk matching, normalized basis, and source line endings', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/file.txt', 'heading\r\n  smart “text”  \r\ntail\r\n')
  const version = (await fs.stat(target())).version
  const patch = hunks('@@ heading\n-smart "text"\n+new text')
  const result = await fs.patchText(target(), patch, { version })
  assert.equal(result.before, 'heading\n  smart “text”  \ntail\n')
  assert.equal(result.after, 'heading\nnew text\ntail\n')
  assert.equal(conn.text('/work/file.txt'), 'heading\r\nnew text\r\ntail\r\n')
  assert.equal(result.version, (await fs.stat(target())).version)
  const unchanged = conn.text('/work/file.txt')
  await assert.rejects(fs.patchText(target(), hunks('@@\n-no match\n+x')), code('FS_PATCH_MISMATCH'))
  await assert.rejects(fs.patchText(target(), hunks('@@\n-no match\n+x'), { version }), code('FS_STALE_VERSION'))
  await assert.rejects(fs.patchText(target('/work/missing'), patch), code('FS_STALE_VERSION'))
  assert.equal(conn.text('/work/file.txt'), unchanged)
})

await test('patches preserve host EOF and insertion semantics', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/file.txt', 'first\ntail')
  assert.equal((await fs.patchText(target(), hunks('@@\n-tail\n+last\n*** End of File'))).after, 'first\nlast\n')
  assert.equal((await fs.patchText(target(), hunks('@@\n+appended'))).after, 'first\nlast\nappended\n')
})

await test('delete has a version guard, bounded basis, and never removes a directory', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/file.txt', 'text\r\n')
  await assert.rejects(fs.deleteFile(target(), { version: 'stale' }), code('FS_STALE_VERSION'))
  assert.equal(conn.unlinked, 0)
  const version = (await fs.stat(target())).version
  assert.deepEqual(await fs.deleteFile(target(), { version }), { before: 'text\n' })
  assert.equal(conn.bytes('/work/file.txt'), undefined)
  await assert.rejects(fs.deleteFile(target()), code('FS_STALE_VERSION'))
  await assert.rejects(fs.deleteFile(target('/work')), code('FS_NOT_REGULAR_FILE'))
  conn.set('/work/file.txt', Buffer.from([0]))
  assert.deepEqual(await fs.deleteFile(target()), { before: null })
  conn.set('/work/file.txt', Buffer.alloc(10 * 1024 * 1024, 65))
  const opened = conn.opened
  assert.deepEqual(await fs.deleteFile(target()), { before: null })
  assert.equal(conn.opened, opened)
})

await test('delete abort and failed removal leave content intact', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/file.txt', 'before')
  const controller = new AbortController()
  conn.afterRead = () => controller.abort()
  await assert.rejects(fs.deleteFile(target(), undefined, controller.signal), code('FS_ABORTED'))
  assert.equal(conn.text('/work/file.txt'), 'before')
  conn.afterRead = undefined
  conn.unlinkError = Object.assign(new Error('permission denied'), { code: 3 })
  await assert.rejects(fs.deleteFile(target()), code('FS_PERMISSION_DENIED'))
  assert.equal(conn.text('/work/file.txt'), 'before')
})

await test('move publishes patched source with its mode and CRLF, then removes source', async () => {
  const { fs, conn } = fixture()
  const destination = target('/work/dest.txt')
  conn.set('/work/file.txt', 'one\r\ntwo\r\n', 'file', 0o100750)
  conn.set('/work/dest.txt', 'old destination\r\n', 'file', 0o100600)
  const version = (await fs.stat(target())).version
  const destinationVersion = (await fs.stat(destination)).version
  const result = await fs.moveFile(target(), destination, { expectedSource: { version },
    expectedDestination: { kind: 'replaceIfVersion', version: destinationVersion }, hunks: hunks('@@\n-two\n+TWO') })
  assert.equal(result.sourceDeleted, true)
  assert.equal(result.sourceBefore, 'one\ntwo\n')
  assert.equal(result.destination.operation, 'update')
  assert.equal(result.destination.before, 'old destination\n')
  assert.equal(result.destination.after, 'one\nTWO\n')
  assert.equal(result.destination.version, (await fs.stat(destination)).version)
  assert.equal(conn.text('/work/dest.txt'), 'one\r\nTWO\r\n')
  assert.equal(conn.entry('/work/dest.txt').mode, 0o750)
  assert.equal(conn.bytes('/work/file.txt'), undefined)
})

await test('move preflight failures have no effects', async () => {
  const { fs, conn } = fixture()
  const destination = target('/work/dest.txt')
  conn.set('/work/file.txt', 'source')
  conn.set('/work/dest.txt', 'destination')
  await assert.rejects(fs.moveFile(target(), target(), {}), code('FS_SAME_TARGET'))
  await assert.rejects(fs.moveFile(target(), destination, { expectedSource: { version: 'stale' } }), code('FS_STALE_VERSION'))
  await assert.rejects(fs.moveFile(target(), destination, { expectedDestination: { kind: 'createIfAbsent' } }), code('FS_NOT_OBSERVED'))
  await assert.rejects(fs.moveFile(target(), destination, { expectedDestination: { kind: 'replaceIfVersion', version: 'stale' } }), code('FS_STALE_VERSION'))
  await assert.rejects(fs.moveFile(target(), destination, { hunks: hunks('@@\n-missing\n+new') }), code('FS_PATCH_MISMATCH'))
  await assert.rejects(fs.moveFile(target('/work/missing'), destination, {}), code('FS_STALE_VERSION'))
  assert.equal(conn.published, 0)
  assert.equal(conn.unlinked, 0)
  assert.equal(conn.text('/work/file.txt'), 'source')
  assert.equal(conn.text('/work/dest.txt'), 'destination')
})

await test('move reports a committed destination when source removal fails', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/file.txt', 'source\n')
  conn.unlinkError = Object.assign(new Error('permission denied'), { code: 3 })
  const result = await fs.moveFile(target(), target('/work/dest.txt'), { expectedDestination: { kind: 'createIfAbsent' } })
  assert.equal(result.sourceDeleted, false)
  assert.equal(result.sourceFailure.code, 'FS_PERMISSION_DENIED')
  assert.match(result.sourceFailure.message, /file\.txt/)
  assert.equal(result.destination.operation, 'create')
  assert.equal(result.destination.before, null)
  assert.equal(result.destination.after, 'source\n')
  assert.equal(conn.text('/work/file.txt'), 'source\n')
  assert.equal(conn.text('/work/dest.txt'), 'source\n')
})

await test('move protects a concurrently changed source after destination publication', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/file.txt', 'source\n')
  conn.afterPublish = () => conn.set('/work/file.txt', 'external changed source\n')
  const result = await fs.moveFile(target(), target('/work/dest.txt'), {})
  assert.equal(result.sourceDeleted, false)
  assert.equal(result.sourceFailure.code, 'FS_STALE_VERSION')
  assert.equal(conn.text('/work/dest.txt'), 'source\n')
  assert.equal(conn.text('/work/file.txt'), 'external changed source\n')
})

await test('move cancellation is honored before staging and finishes after commit checkpoint', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/file.txt', 'source\n')
  const early = new AbortController()
  conn.afterFullRead = () => early.abort()
  await assert.rejects(fs.moveFile(target(), target('/work/dest.txt'), {}, early.signal), code('FS_ABORTED'))
  assert.equal(conn.published, 0)
  conn.afterFullRead = undefined
  const late = new AbortController()
  conn.beforePublish = () => late.abort()
  const result = await fs.moveFile(target(), target('/work/dest.txt'), {}, late.signal)
  assert.equal(result.sourceDeleted, true)
  assert.equal(conn.text('/work/dest.txt'), 'source\n')
  assert.equal(conn.bytes('/work/file.txt'), undefined)
})

await test('opposite-direction moves complete in canonical lock order', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/a', 'a')
  conn.set('/work/b', 'b')
  const outcomes = await Promise.allSettled([fs.moveFile(target('/work/a'), target('/work/b'), {}), fs.moveFile(target('/work/b'), target('/work/a'), {})])
  assert.equal(outcomes.length, 2)
  assert.equal(outcomes.every((outcome) => outcome.status === 'fulfilled'), true)
  assert.equal(conn.text('/work/a'), 'a')
  assert.equal(conn.bytes('/work/b'), undefined)
})

await test('listing versions agree with child stat and errors stay typed', async () => {
  const { fs, conn } = fixture()
  conn.set('/work/z.txt', 'z')
  conn.set('/work/a.txt', 'a')
  const entries = await fs.listDir(target('/work'))
  assert.deepEqual(entries.map((entry) => entry.name), ['a.txt', 'z.txt'])
  for (const entry of entries) assert.equal(entry.version, (await fs.stat(entry.target)).version)
  assert.equal(conn.fullReads, 0)
  await assert.rejects(fs.listDir(target('/work/a.txt')), code('FS_NOT_DIRECTORY'))
})

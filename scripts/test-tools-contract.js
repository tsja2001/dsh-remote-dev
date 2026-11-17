/**
 * Network-free tests of the seven actual tool definitions against dsh-tools,
 * plus SSH channel cancellation and safe SFTP publication regressions.
 * Run: node scripts/test-tools-contract.js
 * Installed desktop contract: node scripts/run-host-tests.cjs scripts/test-tools-contract.js
 */
import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import { Client } from 'ssh2'
import { assertSupportedJsonSchema, validateJsonSchemaValue, defineTool, ToolsService } from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { applyRemoteTools } from '../packages/remote-ssh/tools.js'
import { RemoteConnection } from '../packages/remote-ssh/transport.js'

let passed = 0
let failed = 0
async function test(name, body) {
	try { await body(); passed++; console.log('PASS', name) }
	catch (err) { failed++; console.error('FAIL', name, err.stack || err) }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))
async function bounded(promise) {
	let timer
	try {
		return await Promise.race([promise, new Promise((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error('deferred SFTP regression did not settle')), 1000)
		})])
	} finally { clearTimeout(timer) }
}
const status = {
	id: 'ptest', name: 'Test', host: 'example.invalid', port: 22, user: 'dev',
	auth: 'password', keyPath: '', bindPath: '/work', boundAt: '',
	hostFingerprint: '', status: 'disconnected', platform: null, lastError: null,
	secretStore: 'file',
}
const calls = []
const connection = {
	platform: null,
	async exec(command, opts) { calls.push(['exec', command, opts]); return { code: undefined, signal: null, stdout: 'out', stderr: '' } },
	async readFile(path, opts) { calls.push(['read', path, opts]); return 'text' },
	async writeFile(path, content, opts) { calls.push(['write', path, opts, content]) },
	async listDir(path, opts) { calls.push(['list', path, opts]); return [{ name: 'file', type: 'file', size: undefined, mtime: null }, { name: 'zero', type: 'file', size: 0, mtime: 0 }] },
}
const manager = {
	async connectAdhoc(args, opts) { calls.push(['connect', args, opts]); return { ...status, password: 'must-not-leak', optional: undefined } },
	async disconnect(id) { calls.push(['disconnect', id]); return { ok: true } },
	statusAll() { return [status] },
	async require(id, opts) { calls.push(['require', id, opts]); return connection },
	withDefaultCwd(_id, command) { return `cd '/work' && ${command}` },
	resolveBound(_id, path) { return path.startsWith('/') ? path : `/work/${path}` },
	boundContexts() { return [] },
}
const definitions = new Map()
applyRemoteTools({
	get(name) { return name === 'tools' ? { register(tool) { definitions.set(tool.name, tool) } } : undefined },
	inject() {},
}, manager)
const args = {
	remote_dev_connect: { profile: 'ptest' }, remote_dev_disconnect: { profile: 'ptest' }, remote_dev_status: {},
	remote_dev_exec: { profile: 'ptest', command: 'pwd' }, remote_dev_read: { profile: 'ptest', path: 'file' },
	remote_dev_write: { profile: 'ptest', path: 'file', content: 'new' }, remote_dev_list: { profile: 'ptest', path: '.' },
}
function canonical(tool, value) {
	assert.notEqual(snapshotJsonValue(value), undefined, `${tool.name}: lossless JSON`)
	assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [], `${tool.name}: output validation`)
	const rendered = tool.output.render(args[tool.name], value)
	assert.ok(Array.isArray(rendered) && rendered.every((block) => block.type === 'text' && typeof block.text === 'string'))
	return value
}

await test('all seven actual defineTool definitions compile and validate outputs', async () => {
	assert.deepEqual([...definitions.keys()].sort(), Object.keys(args).sort())
	for (const tool of definitions.values()) {
		assertSupportedJsonSchema(tool.parameters)
		assertSupportedJsonSchema(tool.output.schema)
		canonical(tool, await tool.execute(args[tool.name], { signal: new AbortController().signal }))
	}
})
await test('namespaced tools coexist with existing remote plugins in either registration order', async () => {
	const existing = ['remote_hosts', 'remote_exec', 'remote_ls', 'remote_read', 'remote_write']
	for (const legacyFirst of [true, false]) {
		const ctx = new Context()
		ctx.provide('systemPrompt', { tools: () => () => {} })
		const registry = new ToolsService(ctx)
		const disposers = []
		const legacy = new Map()
		const registerLegacy = () => {
			for (const name of existing) {
				const tool = defineTool({ name, description: 'Existing remote plugin', parameters: {},
					output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
					execute: async () => ({}) })
				legacy.set(name, tool)
				disposers.push(registry.register(tool))
			}
		}
		const registerRepair = () => applyRemoteTools({
			get(name) { return name === 'tools' ? { register(tool) { disposers.push(registry.register(tool)) } } : undefined },
			inject() {},
		}, manager)
		try {
			if (legacyFirst) { registerLegacy(); registerRepair() }
			else { registerRepair(); registerLegacy() }
			assert.deepEqual(registry.definitions().map(tool => tool.name).sort(), [...existing, ...Object.keys(args)].sort())
			for (const name of existing) assert.equal(registry.definitions().find(tool => tool.name === name), legacy.get(name))
		} finally {
			for (const dispose of disposers.reverse()) dispose()
		}
		assert.equal(registry.definitions().length, 0)
	}
})
await test('prompt guidance names only the namespaced tool family', async () => {
	let section
	applyRemoteTools({
		get(name) { return name === 'tools' ? { register() {} } : name === 'systemPrompt' ? { section(value) { section = value; return () => {} } } : undefined },
		effect(fn) { fn() }, inject() {},
	}, manager)
	assert.equal(section.name, 'tool:remote-dev')
	assert.ok(section.text().includes('remote_dev_connect'))
	assert.ok(section.text().includes('remote_dev_exec'))
	assert.equal(/\bremote_(?:connect|exec|read|write|list)\b/.test(section.text()), false)
})
await test('required properties compile from property-local DSL and reject missing arguments', async () => {
	const tool = definitions.get('remote_dev_exec')
	assert.deepEqual(tool.parameters.required, ['profile', 'command'])
	assert.equal(tool.parameters.properties.profile.required, undefined)
	await assert.rejects(tool.execute({ profile: 'ptest' }), /command/)
	await assert.rejects(definitions.get('remote_dev_write').execute({ profile: 'ptest', path: 'file' }), /content/)
})
await test('status accepts null platform/error and secretStore but strips secrets and unknown fields', async () => {
	const tool = definitions.get('remote_dev_connect')
	const value = canonical(tool, await tool.execute(args.remote_dev_connect))
	assert.equal(value.secretStore, 'file')
	assert.equal(value.lastError, null)
	assert.equal(value.platform, null)
	assert.equal('password' in value, false)
	assert.equal('optional' in value, false)
	const prior = manager.statusAll
	manager.statusAll = () => [{ ...status, keyPath: undefined, lastError: { code: 'RESET', zh: '断开', en: 'Closed', detail: 'private detail' } }]
	try {
		const result = canonical(definitions.get('remote_dev_status'), await definitions.get('remote_dev_status').execute({}))
		assert.equal('keyPath' in result[0], false)
		assert.equal('detail' in result[0].lastError, false)
	} finally { manager.statusAll = prior }
})
await test('nullable exit, signal, platform and absent directory metadata are lossless JSON', async () => {
	const exec = canonical(definitions.get('remote_dev_exec'), await definitions.get('remote_dev_exec').execute(args.remote_dev_exec))
	assert.equal(exec.exit_code, null)
	assert.equal(exec.signal, null)
	assert.equal(exec.platform, null)
	const list = canonical(definitions.get('remote_dev_list'), await definitions.get('remote_dev_list').execute(args.remote_dev_list))
	assert.deepEqual(list.entries.map((entry) => [entry.size, entry.mtime]), [[null, null], [0, 0]])
})
await test('tool execution forwards signal through acquisition and each SSH operation', async () => {
	const signal = new AbortController().signal
	for (const name of ['remote_dev_connect', 'remote_dev_exec', 'remote_dev_read', 'remote_dev_write', 'remote_dev_list']) {
		calls.length = 0
		await definitions.get(name).execute(args[name], { signal })
		for (const call of calls.filter((call) => call[2] && typeof call[2] === 'object')) assert.equal(call[2].signal, signal)
		if (name !== 'remote_dev_connect') assert.equal(calls[0][0], 'require')
	}
})
await test('exec uses documented timeout default, clamps max, and preserves bound cwd', async () => {
	for (const [timeout_ms, expected] of [[undefined, 30000], [12, 12], [999999, 600000], [-5, 1]]) {
		calls.length = 0
		await definitions.get('remote_dev_exec').execute({ ...args.remote_dev_exec, ...(timeout_ms === undefined ? {} : { timeout_ms }) })
		const call = calls.find((call) => call[0] === 'exec')
		assert.equal(call[2].timeoutMs, expected)
		assert.equal(call[1], "cd '/work' && pwd")
	}
})
await test('all tools reject pre-aborted work without touching manager or transport', async () => {
	const controller = new AbortController()
	const reason = new Error('caller cancelled')
	controller.abort(reason)
	calls.length = 0
	for (const tool of definitions.values()) await assert.rejects(tool.execute(args[tool.name], { signal: controller.signal }), (err) => err === reason)
	assert.deepEqual(calls, [])
})
await test('abort while acquiring prevents subsequent file side effects', async () => {
	const original = manager.require
	const controller = new AbortController()
	manager.require = async (_id, opts) => { assert.equal(opts.signal, controller.signal); controller.abort(); return connection }
	calls.length = 0
	try { await assert.rejects(definitions.get('remote_dev_write').execute(args.remote_dev_write, { signal: controller.signal }), { name: 'AbortError' }) }
	finally { manager.require = original }
	assert.deepEqual(calls, [])
})

class ExecStream extends EventEmitter {
	constructor(autoClose = true) { super(); this.stderr = new EventEmitter(); this.closeCount = 0; this.autoClose = autoClose }
	close() { this.closeCount++; if (this.autoClose) queueMicrotask(() => this.emit('close', 0)) }
	end(input) { this.input = input }
}
function fakeConnection() {
	const conn = new RemoteConnection({ host: 'example.invalid', auth: 'password', password: 'fake' })
	const client = { endCount: 0, end() { this.endCount++ } }
	conn.client = client
	conn.state = 'connected'
	return { conn, client }
}
await test('startExec signal closes only its channel and done waits for actual close', async () => {
	const { conn, client } = fakeConnection()
	const stream = new ExecStream(false)
	client.exec = (_command, callback) => callback(null, stream)
	const controller = new AbortController()
	const session = await conn.startExec('long-running', { signal: controller.signal })
	let done = false
	session.done.then(() => { done = true })
	controller.abort()
	await tick()
	assert.equal(stream.closeCount, 1)
	assert.equal(done, false)
	stream.emit('close', 0)
	await session.done
	assert.equal(session.signal, 'abort')
	assert.equal(session.code, null)
	assert.equal(client.endCount, 0)
	assert.equal(conn.client, client)
	assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
await test('exec buffers stdout/stderr, uses a default deadline and removes abort listener', async () => {
	const { conn, client } = fakeConnection()
	let options
	const start = conn.startExec.bind(conn)
	conn.startExec = (command, opts) => { options = opts; return start(command, opts) }
	const stream = new ExecStream()
	client.exec = (_command, callback) => callback(null, stream)
	const signal = new AbortController().signal
	const result = conn.exec('output', { signal })
	stream.emit('data', Buffer.from('out'))
	stream.stderr.emit('data', Buffer.from('err'))
	stream.emit('close', 42)
	assert.deepEqual(await result, { code: 42, signal: null, stdout: 'out', stderr: 'err' })
	assert.equal(options.timeoutMs, 30000)
	assert.equal(getEventListeners(signal, 'abort').length, 0)
})
await test('exec active timeout preserves timeout cause on synchronous close', async () => {
	const { conn, client } = fakeConnection()
	const stream = new ExecStream()
	stream.close = () => { stream.closeCount++; stream.emit('close', 0) }
	client.exec = (_command, callback) => callback(null, stream)
	const result = await conn.exec('long-running', { timeoutMs: 5 })
	assert.equal(result.signal, 'timeout')
	assert.equal(result.code, null)
	assert.equal(client.endCount, 0)
})
await test('abort during exec allocation rejects and closes a late channel', async () => {
	const { conn, client } = fakeConnection()
	let callback
	client.exec = (_command, cb) => { callback = cb }
	const controller = new AbortController()
	const pending = conn.startExec('waiting', { signal: controller.signal })
	controller.abort()
	await assert.rejects(pending, { name: 'AbortError' })
	const stream = new ExecStream()
	callback(null, stream)
	assert.equal(stream.closeCount, 1)
	assert.equal(client.endCount, 0)
	assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
await test('channel allocation deadline rejects without ending shared SSH client', async () => {
	const { conn, client } = fakeConnection()
	let callback
	client.exec = (_command, cb) => { callback = cb }
	await assert.rejects(conn.startExec('waiting', { timeoutMs: 5 }), { code: 'ETIMEDOUT' })
	const stream = new ExecStream()
	callback(null, stream)
	assert.equal(stream.closeCount, 1)
	assert.equal(client.endCount, 0)
})
await test('startExec retains unbounded default and observer callbacks, kill is idempotent', async () => {
	const { conn, client } = fakeConnection()
	const stream = new ExecStream()
	client.exec = (_command, callback) => callback(null, stream)
	const signal = new AbortController().signal
	let closed = 0
	const session = await conn.startExec('background', { signal, onClose() { closed++ }, stdin: 'input' })
	assert.equal(stream.input, 'input')
	assert.equal(session.kill(), true)
	await session.done
	assert.equal(session.kill(), false)
	assert.equal(closed, 1)
	assert.equal(session.status, 'killed')
	assert.equal(getEventListeners(signal, 'abort').length, 0)
})

class FakeSftp extends EventEmitter {
	constructor(files = new Map()) { super(); this.files = files; this.endCount = 0; this.log = []; this.hang = new Set(); this.pending = {}; this._extensions = {} }
	respond(method, callback, ...values) {
		if (this.hang.has(method)) { this.pending[method] = () => callback(...values); return }
		queueMicrotask(() => callback(...values))
	}
	end() { this.endCount++; queueMicrotask(() => this.emit('close')) }
	readFile(path, options, callback) {
		if (typeof options === 'function') { callback = options; options = {} }
		const data = this.files.get(path)?.data || Buffer.from('text')
		this.respond('readFile', callback, null, options.encoding ? data.toString() : data)
	}
	writeFile(path, content, callback) { this.files.set(path, { data: Buffer.from(content), mode: 0o644 }); this.respond('writeFile', callback, null) }
	stat(path, callback) { this.respond('stat', callback, this.files.has(path) ? null : Object.assign(new Error('missing'), { code: 2 }), this.files.get(path)) }
	lstat(path, callback) { this.stat(path, callback) }
	realpath(path, callback) { this.respond('realpath', callback, null, `/home/dev/${path}`) }
	readdir(_path, callback) {
		const attrs = { isDirectory: () => false, isSymbolicLink: () => false, mtime: 0 }
		this.respond('readdir', callback, null, [{ filename: 'z', attrs }, ['.', attrs], ['a', { ...attrs, isDirectory: () => true, size: 0 }]])
	}
	open(path, flags, mode, callback) {
		if (typeof mode === 'function') { callback = mode; mode = 0o644 }
		this.log.push(['open', path, flags])
		if (flags === 'wx' && this.files.has(path)) return this.respond('open', callback, Object.assign(new Error('exists'), { code: 'EEXIST' }))
		if (flags === 'wx') this.files.set(path, { data: Buffer.alloc(0), mode })
		this.respond('open', callback, null, Buffer.from(path))
	}
	write(handle, buffer, offset, length, _position, callback) { this.files.get(handle.toString()).data = Buffer.from(buffer.subarray(offset, offset + length)); this.respond('write', callback, null, length) }
	read(_handle, buffer, offset, length, _position, callback) { const size = buffer.write('text'.slice(0, length), offset); this.respond('read', callback, null, size, buffer) }
	fchmod(handle, mode, callback) { this.files.get(handle.toString()).mode = mode; this.respond('fchmod', callback, null) }
	close(handle, callback) { this.log.push(['close', handle.toString()]); this.respond('close', callback, null) }
	rename(from, to, callback) {
		this.log.push(['rename', from, to])
		if (this.files.has(to)) return this.respond('rename', callback, Object.assign(new Error('exists'), { code: 4 }))
		this.files.set(to, this.files.get(from)); this.files.delete(from); this.respond('rename', callback, null)
	}
	ext_openssh_rename(from, to, callback) { this.log.push(['posix-rename', from, to]); this.files.set(to, this.files.get(from)); this.files.delete(from); this.respond('rename', callback, null) }
	unlink(path, callback) { this.log.push(['unlink', path]); const found = this.files.delete(path); this.respond('unlink', callback, found ? null : Object.assign(new Error('missing'), { code: 2 })) }
}
function sftpConnection() {
	const { conn, client } = fakeConnection()
	const files = new Map()
	const channels = []
	client.sftp = (callback) => { const channel = new FakeSftp(files); channels.push(channel); callback(null, channel) }
	return { conn, client, files, channels }
}
await test('legacy SFTP methods reuse one shared channel and preserve zero timestamps', async () => {
	const { conn, channels } = sftpConnection()
	await conn.writeFile('/file', 'hello')
	assert.equal(await conn.readFile('/file'), 'hello')
	assert.equal((await conn.readFileBytes('/file')).toString(), 'hello')
	assert.equal(await conn.realpath('.'), '/home/dev/.')
	assert.equal((await conn.listDir('/'))[0].name, 'a')
	assert.equal((await conn.listDir('/'))[1].mtime, 0)
	assert.equal((await conn.listDir('/'))[1].size, null)
	assert.equal(channels.length, 1)
	assert.equal(channels[0].endCount, 0)
})
await test('successful cancellable SFTP call releases only its owned channel and listeners', async () => {
	const { conn, client, channels } = sftpConnection()
	const shared = await conn.sftp()
	const signal = new AbortController().signal
	assert.equal(await conn.readFile('/file', { signal }), 'text')
	assert.equal(channels.length, 2)
	assert.equal(channels[1].endCount, 1)
	assert.equal(shared.endCount, 0)
	assert.equal(client.endCount, 0)
	assert.equal(getEventListeners(signal, 'abort').length, 0)
})
await test('SFTP abort rejects stalled requests and leaves shared work alive', async () => {
	const { conn, client, files, channels } = sftpConnection()
	const shared = await conn.sftp()
	shared.hang.add('readFile')
	const other = conn.readFile('/other')
	client.sftp = (callback) => { const channel = new FakeSftp(files); channel.hang.add('readFile'); channels.push(channel); callback(null, channel) }
	const controller = new AbortController()
	const pending = conn.readFile('/cancelled', { signal: controller.signal })
	await tick()
	controller.abort()
	await assert.rejects(pending, { name: 'AbortError' })
	assert.equal(channels[1].endCount, 1)
	assert.equal(shared.endCount, 0)
	shared.pending.readFile()
	assert.equal(await other, 'text')
	assert.equal(client.endCount, 0)
	assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
await test('SFTP cancellation waits until its owned channel actually closes', async () => {
	const { conn, client } = fakeConnection()
	const sftp = new FakeSftp()
	sftp.hang.add('readFile')
	sftp.end = () => { sftp.endCount++ }
	client.sftp = (callback) => callback(null, sftp)
	const controller = new AbortController()
	let settled = false
	const pending = conn.readFile('/file', { signal: controller.signal })
	pending.then(() => { settled = true }, () => { settled = true })
	await tick()
	controller.abort()
	await tick()
	assert.equal(settled, false)
	assert.equal(sftp.endCount, 1)
	sftp.emit('close')
	await assert.rejects(pending, { name: 'AbortError' })
	assert.equal(client.endCount, 0)
})
await test('all cancellable SFTP entry points reject pre-abort without opening channels', async () => {
	const { conn, channels } = sftpConnection()
	const controller = new AbortController()
	controller.abort()
	const opts = { signal: controller.signal }
	for (const [method, args] of [
		['readFile', ['/file', opts]], ['writeFile', ['/file', 'new', opts]],
		['readFileBytes', ['/file', opts]], ['statPath', ['/file', opts]],
		['lstatPath', ['/file', opts]], ['realpath', ['.', opts]], ['home', [opts]],
		['readDirRaw', ['/', opts]], ['listDir', ['/', opts]], ['openReadHandle', ['/file', opts]],
		['unlinkFile', ['/file', opts]], ['writeFileAtomic', ['/file', Buffer.from('new'), opts]],
	]) await assert.rejects(Promise.resolve().then(() => conn[method](...args)), { name: 'AbortError' })
	assert.equal(channels.length, 0)
})
await test('SFTP allocation cancellation rejects promptly and releases late channels', async () => {
	const { conn, client } = fakeConnection()
	let callback
	client.sftp = (cb) => { callback = cb }
	const controller = new AbortController()
	const pending = conn.listDir('/', { signal: controller.signal })
	controller.abort()
	await assert.rejects(pending, { name: 'AbortError' })
	const late = new FakeSftp()
	callback(null, late)
	assert.equal(late.endCount, 1)
	assert.equal(client.endCount, 0)
})
await test('openReadHandle owns channel until close and supports abort during reads', async () => {
	const { conn, channels } = sftpConnection()
	const controller = new AbortController()
	const handle = await conn.openReadHandle('/file', { signal: controller.signal })
	assert.equal(channels[0].endCount, 0)
	const buffer = Buffer.alloc(4)
	assert.deepEqual(await handle.read(buffer, 0, 4, 0), { bytesRead: 4, buffer: Buffer.from('text') })
	controller.abort()
	await tick()
	await assert.rejects(handle.read(buffer, 0, 4, 0), { name: 'AbortError' })
	await handle.close()
	assert.equal(channels[0].endCount, 1)
	assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
await test('read handle close waits for owned channel release and is idempotent', async () => {
	const { conn, channels } = sftpConnection()
	const signal = new AbortController().signal
	const handle = await conn.openReadHandle('/file', { signal })
	const sftp = channels[0]
	sftp.end = () => { sftp.endCount++ }
	let settled = false
	const closing = handle.close().then(() => { settled = true })
	await tick()
	assert.equal(sftp.endCount, 1)
	assert.equal(settled, false)
	sftp.emit('close')
	await closing
	await handle.close()
	assert.equal(sftp.endCount, 1)
	assert.equal(getEventListeners(signal, 'abort').length, 0)
})
await test('atomic replace stages fully, preserves mode and invokes guard just before publish', async () => {
	const { conn, files } = sftpConnection()
	files.set('/file', { data: Buffer.from('old'), mode: 0o100755 })
	const sftp = await conn.sftp()
	sftp._extensions['posix-rename@openssh.com'] = '1'
	let guarded = false
	await conn.writeFileAtomic('/file', Buffer.from('new'), { async beforePublish() {
		guarded = true
		assert.equal(files.get('/file').data.toString(), 'old')
		assert.equal([...files.entries()].find(([path]) => path !== '/file')[1].data.toString(), 'new')
		assert.equal(sftp.log.at(-1)[0], 'close')
	} })
	assert.equal(guarded, true)
	assert.equal(files.get('/file').data.toString(), 'new')
	assert.equal(files.get('/file').mode, 0o755)
	assert.equal(files.size, 1)
	assert.equal(sftp.log.some(([method]) => method === 'unlink'), false)
})
await test('failed staged write closes handle and removes only its owned temporary file', async () => {
	const { conn, files } = sftpConnection()
	files.set('/file', { data: Buffer.from('old'), mode: 0o644 })
	const sftp = await conn.sftp()
	sftp.write = (_handle, _buffer, _offset, _length, _position, callback) => queueMicrotask(() => callback(new Error('write failed')))
	await assert.rejects(conn.writeFileAtomic('/file', Buffer.from('new')), /write failed/)
	assert.equal(files.get('/file').data.toString(), 'old')
	assert.equal(files.size, 1)
	assert.ok(sftp.log.some(([method]) => method === 'close'))
	assert.equal(sftp.log.some(([method, path]) => method === 'unlink' && path === '/file'), false)
})
await test('atomic guard failure cleans only stage and preserves target', async () => {
	const { conn, files } = sftpConnection()
	files.set('/file', { data: Buffer.from('old'), mode: 0o644 })
	await assert.rejects(conn.writeFileAtomic('/file', Buffer.from('new'), { beforePublish() { throw new Error('stale') } }), /stale/)
	assert.equal(files.get('/file').data.toString(), 'old')
	assert.equal(files.size, 1)
	assert.equal((await conn.sftp()).log.some(([method, path]) => method === 'unlink' && path === '/file'), false)
})
await test('atomic createIfAbsent reports EEXIST without clobber and portable replace fails safely', async () => {
	const { conn, files } = sftpConnection()
	files.set('/file', { data: Buffer.from('old'), mode: 0o644 })
	await assert.rejects(conn.writeFileAtomic('/file', Buffer.from('new'), { createIfAbsent: true }), { code: 'EEXIST' })
	await assert.rejects(conn.writeFileAtomic('/file', Buffer.from('new')), { code: 4 })
	assert.equal(files.get('/file').data.toString(), 'old')
	assert.equal(files.size, 1)
	await conn.writeFileAtomic('/new', Buffer.from('created'), { createIfAbsent: true, mode: 0o600 })
	assert.equal(files.get('/new').mode, 0o600)
	await conn.unlinkFile('/new')
	await assert.rejects(conn.unlinkFile('/new'), { code: 2 })
})
await test('atomic cancellation before publish cleans stage and never publishes or disconnects', async () => {
	const { conn, files, client } = sftpConnection()
	files.set('/file', { data: Buffer.from('old'), mode: 0o644 })
	const controller = new AbortController()
	await assert.rejects(conn.writeFileAtomic('/file', Buffer.from('new'), {
		signal: controller.signal, beforePublish() { controller.abort() },
	}), { name: 'AbortError' })
	assert.equal(files.get('/file').data.toString(), 'old')
	assert.equal(files.size, 1)
	assert.equal(client.endCount, 0)
})
await test('atomic publication survives abort after commit, awaits rename ACK and owned close', async () => {
	for (const createIfAbsent of [true, false]) {
		const { conn, files, client, channels } = sftpConnection()
		if (!createIfAbsent) files.set('/file', { data: Buffer.from('old'), mode: 0o644 })
		client.sftp = (callback) => {
			const channel = new FakeSftp(files)
			channel._extensions['posix-rename@openssh.com'] = '1'
			channel.hang.add('rename')
			channel.end = () => { channel.endCount++ }
			channels.push(channel)
			callback(null, channel)
		}
		const controller = new AbortController()
		let settled = false
		const pending = conn.writeFileAtomic('/file', Buffer.from('committed'), { signal: controller.signal, createIfAbsent })
		pending.then(() => { settled = true }, () => { settled = true })
		await tick()
		const channel = channels[0]
		assert.equal(files.get('/file').data.toString(), 'committed')
		assert.equal(typeof channel.pending.rename, 'function')
		controller.abort()
		await tick()
		assert.equal(settled, false)
		assert.equal(channel.endCount, 0, 'abort must not close a channel awaiting the publication ACK')
		channel.pending.rename()
		await tick()
		assert.equal(channel.endCount, 1)
		assert.equal(settled, false, 'success must still await owned channel closure')
		channel.emit('close')
		await bounded(pending)
		assert.equal(files.get('/file').data.toString(), 'committed')
		assert.equal(files.size, 1)
		assert.equal(client.endCount, 0)
		assert.equal(channels.length, 1)
		assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
	}
})
await test('atomic publication reports a failed rename ACK after abort and cleans only its stage', async () => {
	const { conn, files, client, channels } = sftpConnection()
	files.set('/file', { data: Buffer.from('old'), mode: 0o644 })
	const renameError = Object.assign(new Error('rename refused'), { code: 'EACCES' })
	client.sftp = (callback) => {
		const channel = new FakeSftp(files)
		channel._extensions['posix-rename@openssh.com'] = '1'
		channel.hang.add('rename')
		channel.ext_openssh_rename = (from, to, ack) => {
			channel.log.push(['posix-rename', from, to])
			channel.respond('rename', ack, renameError)
		}
		channels.push(channel)
		callback(null, channel)
	}
	const controller = new AbortController()
	let settled = false
	const pending = conn.writeFileAtomic('/file', Buffer.from('new'), { signal: controller.signal })
	pending.then(() => { settled = true }, () => { settled = true })
	await tick()
	controller.abort()
	await tick()
	assert.equal(settled, false)
	assert.equal(channels[0].endCount, 0)
	channels[0].pending.rename()
	await assert.rejects(bounded(pending), (err) => err === renameError)
	assert.equal(files.get('/file').data.toString(), 'old')
	assert.equal(files.size, 1)
	assert.equal(channels[0].log.some(([method, path]) => method === 'unlink' && path === '/file'), false)
	assert.equal(channels[0].endCount, 1)
	assert.equal(client.endCount, 0)
})
await test('atomic cancelled exclusive OPEN awaits late success and closes/unlinks the owned stage', async () => {
	for (const createBeforeAbort of [true, false]) {
		const { conn, files, client, channels } = sftpConnection()
		files.set('/file', { data: Buffer.from('old'), mode: 0o644 })
		let acknowledgeOpen
		let stagePath
		let wrote = false
		client.sftp = (callback) => {
			const channel = new FakeSftp(files)
			channel.open = (path, flags, mode, ack) => {
				assert.equal(flags, 'wx')
				stagePath = path
				channel.log.push(['open', path, flags])
				if (createBeforeAbort) files.set(path, { data: Buffer.alloc(0), mode })
				acknowledgeOpen = () => {
					if (!createBeforeAbort) files.set(path, { data: Buffer.alloc(0), mode })
					ack(null, Buffer.from(path))
				}
			}
			channel.write = () => { wrote = true; throw new Error('cancelled OPEN must never progress to a write') }
			channels.push(channel)
			callback(null, channel)
		}
		const controller = new AbortController()
		let settled = false
		const pending = conn.writeFileAtomic('/file', Buffer.from('new'), { signal: controller.signal })
		pending.then(() => { settled = true }, () => { settled = true })
		await tick()
		assert.equal(typeof acknowledgeOpen, 'function')
		controller.abort()
		await tick()
		assert.equal(settled, false, 'resource ownership must be known before cancellation settles')
		assert.equal(channels[0].endCount, 0)
		acknowledgeOpen()
		await assert.rejects(bounded(pending), { name: 'AbortError' })
		assert.equal(files.get('/file').data.toString(), 'old')
		assert.equal(files.has(stagePath), false)
		assert.equal(files.size, 1)
		assert.equal(wrote, false)
		assert.deepEqual(channels[0].log.slice(-2), [['close', stagePath], ['unlink', stagePath]])
		assert.equal(channels[0].endCount, 1)
		assert.equal(channels.length, 1)
		assert.equal(client.endCount, 0)
		assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
	}
})
await test('atomic cancelled exclusive OPEN failure never unlinks an unrelated collision', async () => {
	const { conn, files, client, channels } = sftpConnection()
	files.set('/file', { data: Buffer.from('old'), mode: 0o644 })
	const unrelated = { data: Buffer.from('someone else'), mode: 0o600 }
	let acknowledgeOpen
	let stagePath
	client.sftp = (callback) => {
		const channel = new FakeSftp(files)
		channel.open = (path, _flags, _mode, ack) => {
			stagePath = path
			files.set(path, unrelated)
			acknowledgeOpen = () => ack(Object.assign(new Error('already exists'), { code: 'EEXIST' }))
		}
		channels.push(channel)
		callback(null, channel)
	}
	const controller = new AbortController()
	const pending = conn.writeFileAtomic('/file', Buffer.from('new'), { signal: controller.signal })
	await tick()
	controller.abort()
	acknowledgeOpen()
	await assert.rejects(bounded(pending), { name: 'AbortError' })
	assert.equal(files.get(stagePath), unrelated)
	assert.equal(files.get('/file').data.toString(), 'old')
	assert.equal(channels[0].log.some(([method]) => method === 'close' || method === 'unlink'), false)
	assert.equal(channels[0].endCount, 1)
	assert.equal(client.endCount, 0)
})
await test('connect cancellation retires its new client and ignores late ready', async () => {
	const originalConnect = Client.prototype.connect
	const originalEnd = Client.prototype.end
	let client
	Client.prototype.connect = function () { client = this; return this }
	Client.prototype.end = function () { this.emit('close'); return this }
	try {
		const conn = new RemoteConnection({ host: 'example.invalid', auth: 'password', password: 'fake' })
		const controller = new AbortController()
		const pending = conn.connect({ signal: controller.signal })
		controller.abort()
		await assert.rejects(pending, { name: 'AbortError' })
		client.emit('ready')
		await tick()
		assert.equal(conn.client, null)
		assert.equal(conn.state, 'closed')
		assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
	} finally { Client.prototype.connect = originalConnect; Client.prototype.end = originalEnd }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0

/** Network-free SSH subprocess/working-directory contract tests. Never connects or spawns a host child. */
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { EventEmitter } from 'node:events'
import { Duplex } from 'node:stream'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { posix } from 'node:path'
import { readFile } from 'node:fs/promises'

let hostSpawnCalls = 0
const originals = new Map()
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
	originals.set(name, childProcess[name])
	childProcess[name] = () => { hostSpawnCalls++; throw new Error('Host process spawning is forbidden in remote contract tests') }
}
syncBuiltinESMExports()
after(() => {
	for (const [name, original] of originals) childProcess[name] = original
	syncBuiltinESMExports()
	assert.equal(hostSpawnCalls, 0)
})

const { RemoteSshSubprocess, RemoteSshWorkingDirectory, apply } = await import('../packages/remote-ssh/remote-subprocess.js')
const { MANAGER_KEY } = await import('../packages/remote-ssh/world-support.js')
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
	let resolve, reject
	const promise = new Promise((yes, no) => { resolve = yes; reject = no })
	return { promise, resolve, reject }
}
function abortable(promise, signal) {
	signal?.throwIfAborted()
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason)
		signal?.addEventListener('abort', abort, { once: true })
		promise.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort))
	})
}

/** Independent shell lexer: quotation must keep all attacker-controlled bytes in a single word. */
function words(command) {
	const result = []
	let word = '', started = false, single = false, double = false
	const flush = () => { if (started) result.push(word); word = ''; started = false }
	for (let i = 0; i < command.length; i++) {
		const c = command[i]
		if (single) { if (c === "'") single = false; else word += c; continue }
		if (double) { if (c === '"') double = false; else if (c === '\\') word += command[++i]; else word += c; continue }
		if (c === "'") { single = true; started = true }
		else if (c === '"') { double = true; started = true }
		else if (c === '\\') { word += command[++i]; started = true }
		else if (/\s/.test(c)) flush()
		else if (';|&<>'.includes(c)) {
			flush()
			if ((c === '|' || c === '&') && command[i + 1] === c) { result.push(c + c); i++ }
			else result.push(c)
		} else { word += c; started = true }
	}
	assert.equal(single || double, false, 'balanced POSIX quotation')
	flush()
	return result
}
function argvOf(command) {
	const tokens = words(command)
	const start = tokens.indexOf('exec') + 1
	assert.ok(start > 0)
	const end = tokens.indexOf('<', start)
	return tokens.slice(start, end < 0 ? undefined : end)
}

function network({ platform = 'posix', root = '/remote/project', autoClose = true, gate, inspect } = {}) {
	const client = new EventEmitter()
	const sessions = []
	const stats = []
	const acquisitions = []
	const directories = new Set([root, '/remote/project/sub', '/tmp'])
	const conn = {
		platform, client,
		async statPath(path, { signal } = {}) { signal?.throwIfAborted(); stats.push(path); return directories.has(path) ? { isDirectory: () => true } : undefined },
		async realpath(path, { signal } = {}) { signal?.throwIfAborted(); return path },
		async startExec(command, options = {}) {
			options.signal?.throwIfAborted()
			const closed = deferred()
			const input = []
			const stream = new Duplex({ read() {}, write(chunk, _encoding, callback) { input.push(Buffer.from(chunk)); callback() } })
			stream.stderr = new EventEmitter()
			stream.stderr.pause = () => {}
			stream.stderr.resume = () => {}
			const session = {
				stream, command, options, input, code: null, signal: null, done: closed.promise, closeRequests: 0,
				stdout(data) { options.onStdout?.(Buffer.isBuffer(data) ? data : Buffer.from(data)) },
				stderr(data) { options.onStderr?.(Buffer.isBuffer(data) ? data : Buffer.from(data)) },
				finish(code = 0, signal = null, emitExit = true) {
					this.code = code; this.signal = signal
					if (emitExit) stream.emit('exit', code, signal)
					stream.emit('close', code, signal)
					closed.resolve()
				},
				kill() { throw new Error('Do not invent process kill guarantees; close the owned channel') },
			}
			stream.close = () => { session.closeRequests++; if (autoClose) session.finish(null, null, false) }
			sessions.push(session)
			if (options.stdin !== undefined) stream.end(options.stdin)
			if (inspect) queueMicrotask(() => inspect(session, argvOf(command)))
			return session
		},
	}
	const support = Object.freeze({
		profileId: 'test-profile', root,
		async acquire(reason, { signal } = {}) { acquisitions.push({ reason, signal }); return abortable(gate?.promise ?? Promise.resolve(conn), signal) },
		async platformOf() { return platform },
	})
	return { support, conn, sessions, directories, stats, acquisitions, service: new RemoteSshSubprocess(support) }
}
function spec(overrides = {}) {
	return { argv: ['rg', '--no-config', '--files'], cwd: '/remote/project', graceMs: 100, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 128 } }, ...overrides }
}
async function started(net, input = spec()) {
	const handle = net.service.spawn(input)
	await tick()
	assert.equal(net.sessions.length, 1)
	return [handle, net.sessions[0]]
}

test('spawn is synchronous with immutable world identity and independently readable byte offsets', async () => {
	const gate = deferred()
	const net = network({ gate })
	const handle = net.service.spawn(spec())
	assert.equal(typeof handle.then, 'undefined')
	assert.equal(typeof handle.terminate, 'function')
	assert.deepEqual(handle.collected.stdout.readFrom(0), { text: '', nextOffset: 0, lossy: false })
	assert.equal(net.sessions.length, 0)
	for (const name of ['profileId', 'root', 'support']) assert.throws(() => { net.service[name] = 'host' }, TypeError)
	gate.resolve(net.conn)
	await tick()
	net.sessions[0].stdout('abc')
	assert.deepEqual(handle.collected.stdout.readFrom(1), { text: 'bc', nextOffset: 3, lossy: false })
	assert.equal(handle.collected.stdout.readFrom(0).text, 'abc')
	net.sessions[0].stderr('diagnostic')
	net.sessions[0].finish(1)
	assert.deepEqual(await handle.done, { exitCode: 1, signal: null })
	assert.equal(await handle.waitForExit(), true)
	assert.equal(handle.collected.stderr.readFrom(0).text, 'diagnostic')
	assert.ok(net.acquisitions[0].signal instanceof AbortSignal)
})

test('POSIX argv, cwd, env values and tombstones survive injection strings as literal words', async () => {
	const root = "/remote/project'; touch /host-pwn; '"
	const net = network({ root })
	const argv = ['/remote/bin/prog', '', "a'b", '$(touch /host-pwn)', '`id`', 'x; echo BAD', 'one\ntwo', '"quoted"', '*', '\\', '--flag=a b']
	const old = process.env.REMOTE_CONTRACT_HOST_SECRET
	process.env.REMOTE_CONTRACT_HOST_SECRET = 'host-secret-must-not-appear'
	try {
		const [handle, session] = await started(net, spec({ argv, cwd: root, env: { VALUE: "'$(id);\n`uname`", DROP_ME: undefined, EMPTY: '' } }))
		assert.deepEqual(argvOf(session.command), argv)
		const tokens = words(session.command)
		assert.deepEqual(tokens.slice(0, 7), ['cd', root, '||', 'exit', '125', ';', 'export'])
		assert.ok(tokens.includes("VALUE='$(id);\n`uname`"))
		assert.ok(tokens.includes('DROP_ME'))
		assert.ok(tokens.includes('unset'))
		assert.ok(tokens.includes('EMPTY='))
		assert.deepEqual(tokens.slice(-2), ['<', '/dev/null'])
		assert.equal(session.command.includes('host-secret-must-not-appear'), false)
		assert.equal(session.command.includes('REMOTE_CONTRACT_HOST_SECRET'), false)
		session.finish()
		await handle.done
	} finally {
		if (old === undefined) delete process.env.REMOTE_CONTRACT_HOST_SECRET
		else process.env.REMOTE_CONTRACT_HOST_SECRET = old
	}
})

test('only known packaged ripgrep executables are translated; ordinary remote paths stay intact', async () => {
	for (const [path, expected] of [
		['/app/node_modules/@vscode/ripgrep/bin/rg', 'rg'],
		['/Applications/Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/@vscode/ripgrep/bin/rg', 'rg'],
		['C:\\app\\node_modules\\@vscode\\ripgrep\\bin\\rg.exe', 'rg'],
		['/app/node_modules/@vscode/ripgrep-linux-x64/bin/rg', 'rg'],
		['/remote/bin/rg', '/remote/bin/rg'],
		['/remote/ripgrep/bin/rg', '/remote/ripgrep/bin/rg'],
		['rg', 'rg'],
	]) {
		const net = network()
		const [handle, session] = await started(net, spec({ argv: [path, '--no-config', '--json', 'some;pattern'] }))
		assert.deepEqual(argvOf(session.command), [expected, '--no-config', '--json', 'some;pattern'])
		session.finish()
		await handle.done
	}
})

test('missing cwd rejects before exec; never falls back to remote root or host cwd', async () => {
	const net = network()
	const handle = net.service.spawn(spec({ cwd: '/does/not/exist' }))
	await assert.rejects(handle.done, /remote cwd is not a directory/)
	assert.deepEqual(net.stats, ['/does/not/exist'])
	assert.equal(net.sessions.length, 0)
	assert.equal(await handle.waitForExit(), true)
})

test('collect retains byte tails, reports lossiness, handles split UTF-8, and preserves readers after settlement', async () => {
	const net = network()
	const [handle, session] = await started(net, spec({ stdio: { stdin: 'ignore', stdout: { maxBytes: 7 }, stderr: { maxBytes: 4 } } }))
	session.stdout(Buffer.from([0xe2]))
	assert.deepEqual(handle.collected.stdout.readFrom(0), { text: '', nextOffset: 0, lossy: false })
	session.stdout(Buffer.from([0x82, 0xac]))
	assert.deepEqual(handle.collected.stdout.readFrom(0), { text: '€', nextOffset: 3, lossy: false })
	session.stdout('123456')
	assert.deepEqual(handle.collected.stdout.readFrom(0), { text: '123456', nextOffset: 9, lossy: true })
	assert.deepEqual(handle.collected.stdout.readFrom(3), { text: '123456', nextOffset: 9, lossy: false })
	session.stderr('diagnostic')
	session.finish()
	await handle.done
	assert.deepEqual(handle.collected.stderr.readFrom(0), { text: 'stic', nextOffset: 10, lossy: true })
	assert.equal(handle.collected.stdout.readFrom(9).text, '')
	assert.throws(() => handle.collected.stdout.readFrom(-1), /offset/)
})

test('pipe streams exist synchronously and accept input before SSH allocation', async () => {
	const gate = deferred()
	const net = network({ gate })
	const handle = net.service.spawn(spec({ stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } }))
	assert.ok(handle.stdin && handle.stdout && handle.stderr)
	assert.deepEqual(handle.collected, {})
	const stdout = [], stderr = []
	handle.stdout.on('data', chunk => stdout.push(chunk))
	handle.stderr.on('data', chunk => stderr.push(chunk))
	handle.stdin.end('input before allocation')
	gate.resolve(net.conn)
	await tick()
	const session = net.sessions[0]
	session.stdout('out')
	session.stderr('err')
	session.finish()
	await handle.done
	assert.equal(Buffer.concat(session.input).toString(), 'input before allocation')
	assert.equal(Buffer.concat(stdout).toString(), 'out')
	assert.equal(Buffer.concat(stderr).toString(), 'err')
})

test('batch stdin and inherited diagnostic streams use only the SSH channel', async () => {
	const net = network()
	const captures = []
	const out = process.stdout.write, err = process.stderr.write
	let handle
	try {
		process.stdout.write = function (chunk, ...rest) { if (String(chunk) !== 'remote output') return out.call(this, chunk, ...rest); captures.push(['stdout', String(chunk)]); return true }
		process.stderr.write = function (chunk, ...rest) { if (String(chunk) !== 'remote error') return err.call(this, chunk, ...rest); captures.push(['stderr', String(chunk)]); return true }
		const pair = await started(net, spec({ stdio: { stdin: { data: 'batch\0bytes' }, stdout: 'inherit', stderr: 'inherit' } }))
		handle = pair[0]
		pair[1].stdout('remote output')
		pair[1].stderr('remote error')
		pair[1].finish()
		await handle.done
	} finally { process.stdout.write = out; process.stderr.write = err }
	assert.equal(handle.stdin, undefined)
	assert.equal(handle.stdout, undefined)
	assert.equal(Buffer.concat(net.sessions[0].input).toString(), 'batch\0bytes')
	assert.deepEqual(captures, [['stdout', 'remote output'], ['stderr', 'remote error']])
})

test('abort/terminate close only the owned channel and wait for actual closure without inventing a signal', async () => {
	const net = network({ autoClose: false })
	const abort = new AbortController()
	const [handle, session] = await started(net, spec({ signal: abort.signal }))
	let completed = false
	handle.done.finally(() => { completed = true })
	abort.abort(new Error('caller deadline'))
	handle.terminate()
	assert.equal(session.closeRequests, 1)
	await tick()
	assert.equal(completed, false)
	const bounded = new AbortController()
	const waiting = handle.waitForExit(bounded.signal)
	bounded.abort()
	assert.equal(await waiting, false)
	assert.equal(net.conn.client.listenerCount('close'), 1)
	session.finish(null, null, false)
	assert.deepEqual(await handle.done, { exitCode: null, signal: null })
	assert.equal(await handle.waitForExit(), true)
	assert.equal(net.conn.client.listenerCount('close'), 0)
	handle.terminate()
	assert.equal(session.closeRequests, 1)
})

test('remote exit signal is reported only when observed', async () => {
	const net = network()
	const [handle, session] = await started(net)
	session.finish(null, 'TERM')
	assert.deepEqual(await handle.done, { exitCode: null, signal: 'SIGTERM' })
})

test('cancelled connection acquisition never opens an exec channel or ends a shared connection', async () => {
	const gate = deferred()
	const net = network({ gate })
	const abort = new AbortController()
	const handle = net.service.spawn(spec({ signal: abort.signal }))
	abort.abort()
	await assert.rejects(handle.done)
	assert.equal(await handle.waitForExit(), true)
	gate.resolve(net.conn)
	await tick()
	assert.equal(net.sessions.length, 0)
})

test('transport failures reject done and waitForExit rather than claiming remote process quiescence', async () => {
	for (const mode of ['channel-error', 'connection-close']) {
		const net = network({ autoClose: false })
		const [handle, session] = await started(net)
		if (mode === 'channel-error') session.stream.emit('error', new Error('link reset'))
		else net.conn.client.emit('close')
		session.finish(0)
		await assert.rejects(handle.done, { code: 'REMOTE_SUBPROCESS_TRANSPORT' })
		await assert.rejects(handle.waitForExit(), { code: 'REMOTE_SUBPROCESS_TRANSPORT' })
	}
})

test('transport loss without any subsequent channel close still rejects promptly', async () => {
	const net = network({ autoClose: false })
	const [handle] = await started(net)
	net.conn.client.emit('end')
	await assert.rejects(handle.done, { code: 'REMOTE_SUBPROCESS_TRANSPORT' })
	await assert.rejects(handle.waitForExit(), { code: 'REMOTE_SUBPROCESS_TRANSPORT' })
})

test('actual transport allocation cancellation closes a late fake channel without touching the shared client', async () => {
	const { RemoteConnection } = await import('../packages/remote-ssh/transport.js')
	const net = network()
	const transport = new RemoteConnection({ id: 'offline' })
	transport.client = net.conn.client
	let open, closes = 0
	net.conn.client.exec = (_command, callback) => { open = callback }
	net.conn.client.end = () => { throw new Error('shared connection must survive') }
	net.conn.startExec = transport.startExec.bind(transport)
	const abort = new AbortController()
	const handle = net.service.spawn(spec({ signal: abort.signal }))
	await tick()
	assert.equal(typeof open, 'function')
	abort.abort()
	await assert.rejects(handle.done)
	// Opening has been requested remotely: cancellation cannot prove process exit.
	await assert.rejects(handle.waitForExit())
	const stream = new EventEmitter()
	stream.close = () => { closes++ }
	open(null, stream)
	assert.equal(closes, 1)
})

test('actual transport channel-only termination preserves unknown remote exit facts', async () => {
	const { RemoteConnection } = await import('../packages/remote-ssh/transport.js')
	const net = network()
	const transport = new RemoteConnection({ id: 'offline' })
	transport.client = net.conn.client
	const stream = new EventEmitter()
	stream.stderr = new EventEmitter()
	let closes = 0
	stream.close = () => { closes++ }
	net.conn.client.exec = (_command, callback) => callback(null, stream)
	net.conn.startExec = transport.startExec.bind(transport)
	const handle = net.service.spawn(spec())
	await tick()
	handle.terminate()
	assert.equal(closes, 1)
	let settled = false
	handle.done.then(() => { settled = true })
	await tick()
	assert.equal(settled, false)
	stream.emit('close')
	assert.deepEqual(await handle.done, { exitCode: null, signal: null })
	assert.equal(await handle.waitForExit(), true)
})

test('pre-abort and invalid/unsupported specs fail synchronously', () => {
	const net = network()
	const aborted = new AbortController(); aborted.abort()
	for (const input of [
		spec({ signal: aborted.signal }), spec({ argv: [] }), spec({ argv: ['a\0b'] }), spec({ cwd: 'relative' }),
		spec({ graceMs: 0 }), spec({ graceMs: Infinity }), spec({ graceMs: 2147483648 }),
		spec({ env: { 'BAD;KEY': 'value' } }), spec({ env: { VALUE: 'bad\0value' } }), spec({ stdio: {} }),
		spec({ stdio: { stdin: 'ignore', stdout: { maxBytes: 10, spill: { maxBytes: 100 } }, stderr: 'pipe' } }),
		spec({ stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', control: 'pipe' } }),
	]) assert.throws(() => net.service.spawn(input))
	assert.equal(net.sessions.length, 0)
})

test('Windows argv and PTY fail actionably while terminalEnvironment reports remote platform', async () => {
	const net = network({ platform: 'windows' })
	await assert.rejects(net.service.spawn(spec()).done, { code: 'REMOTE_SUBPROCESS_UNSUPPORTED' })
	assert.equal(net.sessions.length, 0)
	assert.deepEqual(await net.service.terminalEnvironment(), { platform: 'windows' })
	await assert.rejects(net.service.spawnTerminal({ argv: ['cmd.exe'] }), /external SSH terminal/)
})

test('service disposal cancels pending remote environment inspection', async () => {
	const net = network({ gate: deferred() })
	const inspection = assert.rejects(net.service.terminalEnvironment(), { code: 'REMOTE_SUBPROCESS_DISPOSED' })
	await net.service.dispose()
	await inspection
	assert.equal(net.sessions.length, 0)
	await assert.rejects(net.service.resolveExecutable('rg'), { code: 'REMOTE_SUBPROCESS_DISPOSED' })
})

test('terminalEnvironment and resolveExecutable inspect remotely with explicit env and cancellation', async () => {
	const net = network({ inspect(session, argv) {
		assert.equal(argv[0], '/bin/sh')
		if (argv[2].includes('${SHELL-}')) session.stdout('/bin/zsh')
		else { assert.equal(argv.at(-1), 'rg'); session.stdout('/usr/bin/rg') }
		session.finish()
	} })
	assert.deepEqual(await net.service.terminalEnvironment(), { platform: 'posix', defaultShell: '/bin/zsh' })
	assert.equal(await net.service.resolveExecutable('/host/node_modules/@vscode/ripgrep/bin/rg', { PATH: '/custom/bin' }), '/usr/bin/rg')
	assert.ok(net.sessions[1].command.includes("export PATH='/custom/bin'"))
	await assert.rejects(net.service.resolveExecutable('./rg'), /absolute remote path or bare/)
	const missing = network({ inspect: session => session.finish(127) })
	await assert.rejects(missing.service.resolveExecutable('rg'), /install ripgrep on the remote PATH/)
	const abort = new AbortController(); abort.abort()
	await assert.rejects(net.service.resolveExecutable('rg', undefined, abort.signal))
})

function directoryContext(support, options = {}) {
	const roots = new Set([support.root, support.root + '/a', support.root + '/a/b', '/remote/other'])
	const resolves = [], events = [], notices = [], warnings = [], hooks = new Map(), effects = [], provided = new Map()
	const definitions = new Map()
	const ctx = {
		fs: {
			profileId: support.profileId, root: support.root,
			async resolve(path, opts = {}) {
				opts.signal?.throwIfAborted()
				resolves.push({ path, ...opts })
				if (options.resolve) await options.resolve(path, opts)
				opts.signal?.throwIfAborted()
				const targetKey = posix.resolve(opts.cwd ?? support.root, path)
				return { targetKey, displayPath: targetKey }
			},
			async stat(target, signal) { signal?.throwIfAborted(); return roots.has(target.targetKey) ? { type: 'directory' } : undefined },
			processPath(target) { return target.targetKey },
		},
		sessionProjections: { async register(value) {
			if (!definitions.has(value.key)) definitions.set(value.key, value)
			const definition = definitions.get(value.key)
			assert.equal(definition.stateVersion, value.stateVersion)
			return { stateOf(session) {
				let state = definition.init(session.header)
				for (const event of session.events) state = definition.apply(state, event)
				return definition.stateSchema.parse(state)
			} }
		} },
		systemPrompt: { context(value) { hooks.set('context', value) }, getContextOrder() { return 100 } },
		on(name, listener) { hooks.set(name, listener) },
		async waterfall(name, request, next) {
			assert.equal(name, 'working-directory/access')
			if (options.access) return options.access(request, next)
			return next()
		},
		logger: { warn(message) { warnings.push(message) } },
		provide(name, value) { provided.set(name, value); return () => provided.delete(name) },
		effect(effect) { effects.push(effect()) },
	}
	const session = {
		header: { cwd: '/host/anchor' }, events,
		append(type, data) { events.push({ type, data }) },
	}
	const agent = { session, ctx: { fiber: { assertActive() {} } }, inject(notice) { notices.push(notice) } }
	return { ctx, roots, resolves, events, notices, warnings, hooks, effects, provided, session, agent, definitions }
}
async function working(options = {}) {
	const net = network()
	const fake = directoryContext(net.support, options)
	const service = new RemoteSshWorkingDirectory(fake.ctx, net.support, { anchor: '/host/anchor' })
	await service.initialize()
	return { ...fake, service, net }
}

test('working-directory maps header anchor to root and persists canonical remote paths and context', async () => {
	const w = await working()
	assert.equal(w.session.header.cwd, '/host/anchor')
	assert.equal(w.service.get(w.session), '/remote/project')
	assert.equal(await w.service.ensure(w.agent), '/remote/project')
	assert.equal(w.resolves[0].path, '/remote/project')
	assert.equal(await w.service.set(w.agent, 'a/../a'), '/remote/project/a')
	assert.equal(w.service.get(w.session), '/remote/project/a')
	assert.deepEqual(w.events, [
		{ type: 'working-directory/change', data: { cwd: '/remote/project' } },
		{ type: 'working-directory/change', data: { cwd: '/remote/project/a' } },
	])
	assert.equal(w.notices.length, 1)
	assert.equal(w.session.header.cwd, '/host/anchor')
	assert.ok(w.hooks.get('context').text({ agent: w.agent }).includes('/remote/project/a'))
	for (const name of ['root', 'profileId', 'support']) assert.throws(() => { w.service[name] = 'host' }, TypeError)
	const assembly = { contexts: [] }
	assert.equal(await w.hooks.get('system-prompt/assemble')(null, { agent: w.agent }, async () => assembly), assembly)
	assert.ok(assembly.contexts[0].text.includes('/remote/project/a'))
})

test('host-owned shared projection and replay retain remote paths, including a remote path equal to the local anchor', async () => {
	const net = network()
	const fake = directoryContext(net.support)
	const host = await fake.ctx.sessionProjections.register({
		key: 'workingDirectory', stateVersion: 1, stateSchema: { parse: value => value },
		init: header => header.cwd ?? null,
		apply: (state, event) => event.type === 'working-directory/change' ? event.data.cwd : state,
	})
	const config = { anchor: '/host/anchor' }
	const remote = new RemoteSshWorkingDirectory(fake.ctx, net.support, config)
	await remote.initialize()
	assert.equal(host.stateOf(fake.session), '/host/anchor')
	assert.equal(remote.get(fake.session), net.support.root)
	await remote.ensure(fake.agent)
	assert.equal(host.stateOf(fake.session), net.support.root)
	fake.roots.add('/host/anchor')
	assert.equal(await remote.set(fake.agent, '/host/anchor'), '/host/anchor')
	assert.equal(remote.get(fake.session), '/host/anchor')
	const restored = new RemoteSshWorkingDirectory(fake.ctx, net.support, config)
	await restored.initialize()
	assert.equal(restored.get(fake.session), '/host/anchor')
	assert.equal(host.stateOf(fake.session), '/host/anchor')
})

test('directory changes serialize per session, using the preceding committed cwd', async () => {
	const gate = deferred()
	let blocked = true
	const w = await working({ async resolve(path) { if (path === 'a' && blocked) { blocked = false; await gate.promise } } })
	const first = w.service.set(w.agent, 'a')
	const second = w.service.set(w.agent, 'b')
	await tick()
	assert.equal(w.resolves.length, 1)
	gate.resolve()
	assert.deepEqual(await Promise.all([first, second]), ['/remote/project/a', '/remote/project/a/b'])
	assert.equal(w.resolves[1].cwd, '/remote/project/a')
})

test('missing current cwd recovers only to original remote root; unavailable roots and explicit paths fail', async () => {
	const w = await working()
	await w.service.set(w.agent, 'a')
	w.roots.delete('/remote/project/a')
	assert.equal(await w.service.ensure(w.agent), '/remote/project')
	assert.equal(w.service.get(w.session), '/remote/project')
	assert.equal(w.resolves.some(call => call.path === '/host/anchor'), false)
	await assert.rejects(w.service.set(w.agent, '/host/missing'), { code: 'WORKING_DIRECTORY_NOT_FOUND' })
	assert.equal(w.service.get(w.session), '/remote/project')
	w.roots.delete('/remote/project')
	await assert.rejects(w.service.ensure(w.agent), { code: 'WORKING_DIRECTORY_UNAVAILABLE' })
})

test('access rejection and filesystem failure do not silently change cwd or poison subsequent requests', async () => {
	let denied = true
	const w = await working({ access(_request, next) { if (denied) throw new Error('checkout lock'); return next() } })
	await assert.rejects(w.service.set(w.agent, 'a'), /checkout lock/)
	assert.equal(w.events.length, 0)
	denied = false
	await assert.rejects(w.service.set(w.agent, ''), { code: 'WORKING_DIRECTORY_INVALID' })
	assert.equal(await w.service.set(w.agent, 'a'), '/remote/project/a')
	w.ctx.fs.resolve = async () => { throw new Error('remote disconnected') }
	await assert.rejects(w.service.ensure(w.agent), /remote disconnected/)
	assert.equal(w.service.get(w.session), '/remote/project/a')
})

test('queued directory requests and active filesystem work cancel on disposal without committing', async () => {
	const w = await working({ resolve(_path, opts) { return abortable(new Promise(() => {}), opts.signal) } })
	const first = w.service.set(w.agent, 'a')
	const abort = new AbortController()
	const second = w.service.set(w.agent, 'b', abort.signal)
	const firstRejected = assert.rejects(first, { code: 'WORKING_DIRECTORY_UNAVAILABLE' })
	const secondRejected = assert.rejects(second)
	await tick()
	abort.abort()
	await w.service.dispose()
	await Promise.all([firstRejected, secondRejected])
	assert.equal(w.events.length, 0)
	assert.equal(w.resolves.length, 1)
	await assert.rejects(w.service.ensure(w.agent), { code: 'WORKING_DIRECTORY_UNAVAILABLE' })
})

test('notice injection failure warns after the remote cwd is durably committed', async () => {
	const w = await working()
	w.agent.inject = () => { throw new Error('closed message queue') }
	assert.equal(await w.service.set(w.agent, '/remote/other'), '/remote/other')
	assert.equal(w.service.get(w.session), '/remote/other')
	assert.match(w.warnings[0], /committed.*closed message queue/)
})

test('plugin apply provides both services sharing remote identity, and disposal removes them', async () => {
	const net = network()
	const fake = directoryContext(net.support)
	const previous = globalThis[MANAGER_KEY]
	globalThis[MANAGER_KEY] = { connection: async id => { assert.equal(id, 'test-profile'); return net.conn } }
	try {
		await apply(fake.ctx, { profile: 'test-profile', root: net.support.root, anchor: '/host/anchor' })
		const subprocess = fake.provided.get('subprocess'), directory = fake.provided.get('workingDirectory')
		assert.ok(subprocess && directory)
		assert.equal(subprocess.support, directory.support)
		assert.equal(subprocess.profileId, 'test-profile')
		assert.equal(directory.get(fake.session), net.support.root)
		const handle = subprocess.spawn(spec())
		await tick()
		await Promise.all(fake.effects.map(dispose => dispose()))
		assert.equal(fake.provided.size, 0)
		await handle.done
		assert.equal(net.sessions[0].closeRequests, 1)
		assert.throws(() => subprocess.spawn(spec()), { code: 'REMOTE_SUBPROCESS_DISPOSED' })
	} finally {
		if (previous === undefined) delete globalThis[MANAGER_KEY]
		else globalThis[MANAGER_KEY] = previous
	}
})

test('a host or mismatched filesystem cannot back the remote working-directory service', () => {
	const net = network()
	for (const fs of [{}, { profileId: 'other', root: net.support.root }]) {
		assert.throws(() => new RemoteSshWorkingDirectory({ fs }, net.support), { code: 'WORKING_DIRECTORY_UNAVAILABLE' })
	}
})

test('implementation contains no host subprocess fallback and documents remote ripgrep prerequisites', async () => {
	const source = await readFile(new URL('../packages/remote-ssh/remote-subprocess.js', import.meta.url), 'utf8')
	assert.equal(/(?:from\s*|import\s*\()['"](?:node:)?child_process/.test(source), false)
	assert.match(source, /install ripgrep on\s*\n?\s*\*?\s*the remote PATH/)
	assert.equal(hostSpawnCalls, 0)
})

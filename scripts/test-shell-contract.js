#!/usr/bin/env node
/** Network-free DSH 0.2.2 shell contract checks; no SSH client or host required. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, RemoteSshShell } from '../packages/remote-ssh/remote-shell.js'
import { MANAGER_KEY } from '../packages/remote-ssh/world-support.js'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deferred = () => {
	let resolve
	let reject
	const promise = new Promise((yes, no) => { resolve = yes; reject = no })
	return { promise, resolve, reject }
}

function fixture(t, options = {}) {
	const calls = []
	const acquisitions = []
	const platforms = []
	const stats = []
	const conn = {
		async statPath(path, opts) {
			stats.push({ path, opts })
			if (options.statPath) return options.statPath(path, opts)
			return { isDirectory: () => path === '/remote/other' }
		},
		startExec(command, opts) {
			const closed = deferred()
			let finished = false
			const call = {
				command, opts, kills: 0,
				stdout(data) { if (!finished) opts.onStdout(Buffer.from(data)) },
				stderr(data) { if (!finished) opts.onStderr(Buffer.from(data)) },
				finish(code = 0, signal = null) {
					if (finished) return
					finished = true
					opts.signal?.removeEventListener('abort', abort)
					session.code = code
					session.signal = signal
					session.status = signal ? 'killed' : 'completed'
					if (options.closeGate) void options.closeGate.then(() => closed.resolve())
					else closed.resolve()
				},
			}
			const session = {
				status: 'running', code: null, signal: null, done: closed.promise,
				kill() {
					if (finished) return false
					call.kills++
					call.finish(null, options.killSignal === undefined ? 'SIGKILL' : options.killSignal)
					return true
				},
			}
			const abort = () => {
				opts.onAbort?.()
				call.kills++
				call.finish(null, 'abort')
			}
			call.session = session
			calls.push(call)
			if (options.spawnError) throw options.spawnError
			if (options.open) return options.open(call)
			if (opts.signal?.aborted) abort()
			else opts.signal?.addEventListener('abort', abort, { once: true })
			return Promise.resolve(session)
		},
	}
	const support = {
		profileId: 'shell-contract-profile', root: '/remote/root',
		async acquire(reason, opts) {
			acquisitions.push({ reason, opts })
			return options.acquire ? options.acquire(reason, opts, conn) : conn
		},
		async platformOf(connection, opts) {
			platforms.push({ connection, opts })
			return options.platformOf ? options.platformOf(connection, opts) : options.platform ?? 'posix'
		},
	}
	const shell = new RemoteSshShell(support, { timeoutMs: 1000, ...options.config })
	t.after(async () => {
		for (const call of calls) call.finish()
		await shell.dispose()
	})
	return { shell, calls, support, conn, acquisitions, platforms, stats }
}

const check = (name, fn) => test(name, { timeout: 1500 }, fn)

check('resolve supplies rc.3 defaults, caps budgets, and exposes immutable binding identity', (t) => {
	const { shell } = fixture(t)
	const spec = shell.resolve({ command: 'pwd' })
	assert.equal(shell.profileId, 'shell-contract-profile')
	assert.equal(shell.root, '/remote/root')
	assert.throws(() => { shell.root = '/local' }, TypeError)
	assert.throws(() => { shell.profileId = 'other' }, TypeError)
	assert.equal(shell.sandboxMode, undefined)
	assert.equal(spec.workdir, '/remote/root')
	assert.equal(spec.onExpiry, 'kill')
	assert.equal(spec.timeoutMs, 1000)
	assert.equal(shell.resolve({ command: '', timeoutMs: 900000 }).timeoutMs, 600000)
	assert.throws(() => shell.resolve({ command: '', stdoutMaxBytes: Infinity }), /positive finite/)
	assert.throws(() => shell.resolve({ command: '', timeoutMs: -1 }), /positive finite/)
	assert.throws(() => shell.resolve({ command: '', onExpiry: 'detach' }), /onExpiry/)
})

check('foreground result is memoized, split, non-consuming, and resolves nonzero exits', async (t) => {
	const { shell, calls, acquisitions, platforms } = fixture(t)
	const proc = await shell.execute(shell.resolve({ command: 'printf answer; exit 7', stdin: 'payload' }))
	assert.equal(proc.status, 'running')
	assert.equal(calls[0].opts.stdin, 'payload')
	assert.equal(acquisitions[0].reason, 'shell')
	assert.ok(acquisitions[0].opts.signal instanceof AbortSignal)
	assert.equal(platforms[0].opts.signal, acquisitions[0].opts.signal)
	const result = proc.result()
	assert.equal(proc.result(), result)
	calls[0].stdout('answer')
	calls[0].stderr('warning')
	assert.deepEqual(proc.readOutput(), { delta: 'answer\n[stderr]\nwarning', lossy: false })
	calls[0].finish(7)
	await proc.done
	assert.equal(proc.status, 'completed')
	assert.deepEqual(await result, {
		exitCode: 7, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
		stdout: { text: 'answer', truncated: false }, stderr: { text: 'warning', truncated: false },
	})
	assert.deepEqual(proc.readOutput(), { delta: '', lossy: false })
	assert.equal(proc.kill(), false)
})

check('observers have independent byte cursors and do not steal consuming reads', async (t) => {
	const { shell, calls } = fixture(t)
	const proc = await shell.execute(shell.resolve({ command: 'stream' }))
	calls[0].stdout('one\n')
	const first = proc.observed.stdout.readFrom(0)
	assert.deepEqual(first, { text: 'one\n', nextOffset: 4, lossy: false })
	assert.deepEqual(proc.observed.stdout.readFrom(0), first)
	assert.equal(proc.readOutput().delta, 'one\n')
	calls[0].stdout('two')
	calls[0].stderr('err')
	assert.deepEqual(proc.observed.stdout.readFrom(first.nextOffset), { text: 'two', nextOffset: 7, lossy: false })
	assert.deepEqual(proc.observed.stderr.readFrom(0), { text: 'err', nextOffset: 3, lossy: false })
	calls[0].finish()
	await proc.done
	assert.equal(proc.readOutput().delta, 'two\n[stderr]\nerr')
	assert.equal(proc.readOutput().delta, '')
	assert.equal((await proc.result()).stdout.text, 'one\ntwo')
})

check('stdout and stderr retain bounded tails and report only unread gaps as lossy', async (t) => {
	const { shell, calls } = fixture(t, { config: { maxOutputBytes: 6 } })
	const proc = await shell.execute(shell.resolve({ command: 'large', stdoutMaxBytes: 4 }))
	calls[0].stdout('ab')
	assert.deepEqual(proc.readOutput(), { delta: 'ab', lossy: false })
	calls[0].stdout('cdef')
	assert.deepEqual(proc.readOutput(), { delta: 'cdef', lossy: false })
	calls[0].stdout('g'.repeat(1000000) + 'TAIL')
	calls[0].stderr('x'.repeat(1000000) + 'ERROR!')
	assert.deepEqual(proc.observed.stdout.readFrom(0), { text: 'TAIL', nextOffset: 1000010, lossy: true })
	assert.deepEqual(proc.readOutput(), { delta: 'TAIL\n[stderr]\nERROR!', lossy: true })
	assert.deepEqual(proc.readOutput(), { delta: '', lossy: false })
	calls[0].finish()
	await proc.done
	const result = await proc.result()
	assert.deepEqual(result.stdout, { text: 'TAIL', truncated: true })
	assert.deepEqual(result.stderr, { text: 'ERROR!', truncated: true })
})

check('raw UTF-8 capture preserves split characters and byte caps at a cut prefix', async (t) => {
	const { shell, calls } = fixture(t, { config: { maxOutputBytes: 5 } })
	const proc = await shell.execute(shell.resolve({ command: 'unicode' }))
	const emoji = Buffer.from('😀')
	calls[0].stdout(emoji.subarray(0, 2))
	assert.deepEqual(proc.observed.stdout.readFrom(0), { text: '', nextOffset: 0, lossy: false })
	assert.deepEqual(proc.readOutput(), { delta: '', lossy: false })
	calls[0].stdout(emoji.subarray(2))
	assert.deepEqual(proc.readOutput(), { delta: '😀', lossy: false })
	calls[0].stdout('éZ')
	calls[0].finish()
	await proc.done
	const output = (await proc.result()).stdout
	assert.deepEqual(output, { text: 'éZ', truncated: true })
	assert.ok(Buffer.byteLength(output.text) <= 5)
	assert.equal(proc.observed.stdout.readFrom(4).lossy, false)
})

check('kill is idempotent and preserves the transport termination signal', async (t) => {
	const { shell, calls } = fixture(t)
	const proc = await shell.execute(shell.resolve({ command: 'long task' }))
	calls[0].stdout('before kill')
	assert.equal(proc.kill(), true)
	assert.equal(proc.kill(), false)
	await proc.done
	assert.equal(proc.status, 'killed')
	assert.equal(calls[0].kills, 1)
	const result = await proc.result()
	assert.equal(result.exitCode, null)
	assert.equal(result.signal, 'SIGKILL')
	assert.equal(result.aborted, false)
	assert.equal(result.timedOut, false)
	assert.equal(result.stdout.text, 'before kill')
})

check('self-reported terminating signals retain their actual signal name', async (t) => {
	const { shell, calls } = fixture(t)
	const proc = await shell.execute(shell.resolve({ command: 'self terminate' }))
	calls[0].finish(null, 'TERM')
	await proc.done
	assert.equal(proc.status, 'killed')
	assert.equal(proc.signal, 'SIGTERM')
	assert.equal((await proc.result()).aborted, false)
})

check('caller abort kills its execution and leaves a concurrent execution alone', async (t) => {
	const { shell, calls } = fixture(t)
	const abort = new AbortController()
	const owned = await shell.execute(shell.resolve({ command: 'owned', signal: abort.signal }))
	const other = await shell.execute(shell.resolve({ command: 'other' }))
	abort.abort(new Error('cancel owner'))
	await owned.done
	const result = await owned.result()
	assert.equal(result.aborted, true)
	assert.equal(result.timedOut, false)
	assert.equal(owned.status, 'killed')
	assert.equal(other.status, 'running')
	assert.equal(calls[1].kills, 0)
	calls[1].finish()
	await other.done
})

check('timeout kills classify only the first cancellation cause', async (t) => {
	const { shell } = fixture(t)
	const abort = new AbortController()
	const proc = await shell.execute(shell.resolve({ command: 'timeout', timeoutMs: 15, signal: abort.signal }))
	await proc.done
	abort.abort()
	const result = await proc.result()
	assert.equal(result.timedOut, true)
	assert.equal(result.aborted, false)
	assert.equal(result.timeoutMs, 15)
	assert.equal(proc.status, 'killed')
})

check('abort before timeout remains the sole cause and listeners detach at close', async (t) => {
	const { shell, calls } = fixture(t)
	const abort = new AbortController()
	const proc = await shell.execute(shell.resolve({ command: 'abort', timeoutMs: 15, signal: abort.signal }))
	abort.abort()
	await proc.done
	await pause(25)
	assert.equal((await proc.result()).aborted, true)
	assert.equal((await proc.result()).timedOut, false)
	assert.equal(calls[0].kills, 1)
	const after = new AbortController()
	const complete = await shell.execute(shell.resolve({ command: 'already finished', signal: after.signal }))
	calls[1].finish()
	await complete.done
	after.abort()
	assert.equal(calls[1].opts.signal.aborted, false)
	assert.equal((await complete.result()).aborted, false)
})

check('onExpiry none arms no transport deadline and keeps caller abort ownership', async (t) => {
	const { shell, calls } = fixture(t)
	const abort = new AbortController()
	const proc = await shell.execute(shell.resolve({ command: 'background', timeoutMs: 5, onExpiry: 'none', signal: abort.signal }))
	assert.equal(calls[0].opts.timeoutMs, undefined)
	await pause(25)
	assert.equal(proc.status, 'running')
	abort.abort()
	await proc.done
	const result = await proc.result()
	assert.equal(result.aborted, true)
	assert.equal(result.timedOut, false)
	assert.equal(result.timeoutMs, 5)
})

check('pre-aborted and preparation-aborted callers reject without spawning a channel', async (t) => {
	const abort = new AbortController()
	const reason = new Error('already cancelled')
	abort.abort(reason)
	const first = fixture(t)
	await assert.rejects(first.shell.execute(first.shell.resolve({ command: 'never', signal: abort.signal })), (error) => error === reason)
	assert.equal(first.acquisitions.length, 0)
	assert.equal(first.calls.length, 0)
	const ready = deferred()
	const second = fixture(t, { acquire: () => ready.promise })
	const preparing = new AbortController()
	const operation = second.shell.execute(second.shell.resolve({ command: 'still never', signal: preparing.signal }))
	await pause(0)
	preparing.abort(reason)
	await assert.rejects(operation, (error) => error === reason)
	assert.equal(second.acquisitions[0].opts.signal.aborted, true)
	ready.resolve(second.conn)
	await pause(0)
	assert.equal(second.calls.length, 0)
})

check('preparation timeout returns a settled empty handle and suppresses a late spawn', async (t) => {
	const ready = deferred()
	const { shell, calls, conn, acquisitions } = fixture(t, { acquire: () => ready.promise })
	const proc = await shell.execute(shell.resolve({ command: 'late connection', timeoutMs: 10 }))
	await proc.done
	assert.equal(proc.status, 'killed')
	assert.equal(acquisitions[0].opts.signal.aborted, true)
	assert.deepEqual(await proc.result(), {
		exitCode: null, signal: null, timedOut: true, aborted: false, timeoutMs: 10,
		stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
	})
	assert.deepEqual(proc.observed.stdout.readFrom(0), { text: '', nextOffset: 0, lossy: false })
	ready.resolve(conn)
	await pause(0)
	assert.equal(calls.length, 0)
})

check('onExpiry none also leaves preparation unbounded until the caller cancels', async (t) => {
	const ready = deferred()
	const { shell, conn, calls } = fixture(t, { acquire: () => ready.promise })
	const abort = new AbortController()
	let returned = false
	const operation = shell.execute(shell.resolve({ command: 'wait', timeoutMs: 5, onExpiry: 'none', signal: abort.signal }))
	operation.then(() => { returned = true }, () => { returned = true })
	await pause(20)
	assert.equal(returned, false)
	abort.abort(new Error('stop preparation'))
	await assert.rejects(operation, /stop preparation/)
	ready.resolve(conn)
	await pause(0)
	assert.equal(calls.length, 0)
})

check('spawn failure resolves done, appears on independent stderr readers, and rejects only result', async (t) => {
	const error = new Error('fake channel open failure')
	const { shell } = fixture(t, { spawnError: error })
	const proc = await shell.execute(shell.resolve({ command: 'spawn' }))
	await proc.done
	assert.equal(proc.status, 'killed')
	const observation = proc.observed.stderr.readFrom(0)
	assert.match(observation.text, /fake channel open failure/)
	assert.deepEqual(proc.observed.stderr.readFrom(0), observation)
	assert.match(proc.readOutput().delta, /\[stderr\]\n.*fake channel open failure/)
	assert.deepEqual(proc.readOutput(), { delta: '', lossy: false })
	const result = proc.result()
	assert.equal(proc.result(), result)
	await assert.rejects(result, (failure) => failure === error)
})

check('async provider failure has the same non-rejecting done contract', async (t) => {
	const failed = new Error('provider lost channel')
	const { shell, calls } = fixture(t)
	const proc = await shell.execute(shell.resolve({ command: 'provider failure' }))
	calls[0].session.error = failed
	calls[0].finish(null, 'error')
	await proc.done
	assert.equal(proc.status, 'killed')
	assert.match(proc.readOutput().delta, /provider lost channel/)
	await assert.rejects(proc.result(), (error) => error === failed)
})

check('kill during channel opening cancels only the published execution', async (t) => {
	const opened = deferred()
	const { shell, calls } = fixture(t, {
		open(call) {
			call.opts.signal.addEventListener('abort', () => opened.reject(call.opts.signal.reason), { once: true })
			return opened.promise
		},
	})
	const proc = await shell.execute(shell.resolve({ command: 'pending open' }))
	assert.equal(proc.status, 'running')
	assert.equal(proc.kill(), true)
	assert.equal(proc.kill(), false)
	await proc.done
	assert.equal(calls[0].opts.signal.aborted, true)
	assert.equal(proc.status, 'killed')
	assert.equal((await proc.result()).aborted, false)
	assert.equal((await proc.result()).timedOut, false)
})

check('remote directory checks, env quoting, empty stdin, and Windows selection are preserved', async (t) => {
	const { shell, calls } = fixture(t)
	const proc = await shell.execute(shell.resolve({ command: 'pwd', workdir: '/remote/other', env: { SAFE: "it's remote", 'invalid-key': 'ignored' }, dshEnv: { DSH_LOCAL_SECRET: 'host-only' } }))
	assert.match(calls[0].command, /^cd '\/remote\/other' \|\| exit 99;/)
	assert.ok(calls[0].command.includes("export SAFE='it'\\''s remote'"))
	assert.ok(!calls[0].command.includes('invalid-key'))
	assert.ok(!calls[0].command.includes('host-only'))
	assert.equal(calls[0].opts.stdin, '')
	calls[0].finish()
	await proc.done
	const win = fixture(t, { platform: 'windows' })
	const windows = await win.shell.execute(win.shell.resolve({ command: 'ver' }))
	assert.match(win.calls[0].command, /^cd \/d /)
	assert.ok(!win.calls[0].command.includes('bash -c'))
	win.calls[0].finish()
	await windows.done
})

check('an owned kill stays killed when the transport closes without a signal', async (t) => {
	const { shell } = fixture(t, { killSignal: null })
	const proc = await shell.execute(shell.resolve({ command: 'plain close' }))
	assert.equal(proc.kill(), true)
	await proc.done
	assert.equal(proc.status, 'killed')
	assert.equal((await proc.result()).signal, null)
	assert.equal((await proc.result()).aborted, false)
})

check('preparation infrastructure errors reject execute rather than fabricate an outcome', async (t) => {
	const error = new Error('connection unavailable')
	const { shell, calls } = fixture(t, { acquire: () => Promise.reject(error) })
	await assert.rejects(shell.execute(shell.resolve({ command: 'no connection' })), (failure) => failure === error)
	assert.equal(calls.length, 0)
})

check('the deadline includes platform preparation and cannot launch after a late detection', async (t) => {
	const detection = deferred()
	const { shell, calls, platforms } = fixture(t, { platformOf: () => detection.promise })
	const proc = await shell.execute(shell.resolve({ command: 'late platform', timeoutMs: 10 }))
	await proc.done
	assert.equal((await proc.result()).timedOut, true)
	assert.equal(platforms[0].opts.signal.aborted, true)
	detection.resolve('posix')
	await pause(0)
	assert.equal(calls.length, 0)
})

check('abort during directory preparation prevents spawning and does not poison directory cache', async (t) => {
	const checked = deferred()
	const { shell, calls, stats } = fixture(t, { statPath: () => checked.promise })
	const abort = new AbortController()
	const operation = shell.execute(shell.resolve({ command: 'late stat', workdir: '/remote/other', signal: abort.signal }))
	await pause(0)
	assert.equal(stats.length, 1)
	abort.abort(new Error('cancel directory preparation'))
	await assert.rejects(operation, /cancel directory preparation/)
	assert.equal(stats[0].opts.signal.aborted, true)
	checked.resolve({ isDirectory: () => true })
	await pause(0)
	assert.equal(calls.length, 0)
	assert.equal(shell._dirBad.has('/remote/other'), false)
	assert.equal(shell._dirOk.has('/remote/other'), false)
})

check('asynchronous channel opening failures reject only result and retain their reason', async (t) => {
	const error = new Error('async channel denied')
	const { shell } = fixture(t, { open: () => Promise.reject(error) })
	const proc = await shell.execute(shell.resolve({ command: 'async open' }))
	await proc.done
	assert.equal(proc.status, 'killed')
	assert.match(proc.observed.stderr.readFrom(0).text, /async channel denied/)
	await assert.rejects(proc.result(), (failure) => failure === error)
})

check('transport channel opening timeout is an owned timeout rather than provider failure', async (t) => {
	const error = Object.assign(new Error('channel opening timed out'), { code: 'ETIMEDOUT' })
	const { shell } = fixture(t, { open: () => Promise.reject(error) })
	const proc = await shell.execute(shell.resolve({ command: 'channel timeout' }))
	await proc.done
	assert.equal(proc.status, 'killed')
	assert.equal((await proc.result()).timedOut, true)
	assert.equal((await proc.result()).aborted, false)
	assert.equal(proc.observed.stderr.readFrom(0).text, '')
})

check('service disposal closes and awaits all its live handles without cancelling another world', async (t) => {
	const close = deferred()
	t.after(() => close.resolve())
	const { shell, calls, support } = fixture(t, { closeGate: close.promise })
	const otherShell = new RemoteSshShell(support, { timeoutMs: 1000 })
	t.after(() => otherShell.dispose())
	const foreground = await shell.execute(shell.resolve({ command: 'long foreground' }))
	const background = await shell.execute(shell.resolve({ command: 'long background', onExpiry: 'none' }))
	const other = await otherShell.execute(otherShell.resolve({ command: 'other preset' }))
	calls[0].stdout('retained before unload')
	assert.equal(shell._handles.size, 2)
	let disposed = false
	const disposal = shell.dispose()
	assert.equal(shell.dispose(), disposal)
	disposal.then(() => { disposed = true })
	await pause(0)
	assert.equal(disposed, false, 'disposal must await the delayed channel done promises')
	assert.equal(calls[0].opts.signal.aborted, true)
	assert.equal(calls[1].opts.signal.aborted, true)
	assert.equal(calls[2].opts.signal.aborted, false)
	assert.equal(other.status, 'running')
	close.resolve()
	await disposal
	await Promise.all([foreground.done, background.done])
	assert.equal(foreground.status, 'killed')
	assert.equal(background.status, 'killed')
	assert.equal((await foreground.result()).aborted, true)
	assert.equal((await foreground.result()).stdout.text, 'retained before unload')
	assert.equal((await background.result()).timedOut, false)
	assert.equal(shell._handles.size, 0)
	assert.equal(shell._executions.size, 0)
	await assert.rejects(shell.execute(shell.resolve({ command: 'after disposal' })), /service disposed/)
	assert.equal(calls.length, 3)
	calls[2].finish()
	await other.done
})

check('disposal cancels preparation promptly and cannot spawn from a late acquired connection', async (t) => {
	const ready = deferred()
	const { shell, calls, conn, acquisitions } = fixture(t, { acquire: () => ready.promise })
	const operation = shell.execute(shell.resolve({ command: 'dispose while preparing', onExpiry: 'none' }))
	await pause(0)
	await shell.dispose()
	await assert.rejects(operation, /service disposed/)
	assert.equal(acquisitions[0].opts.signal.aborted, true)
	assert.equal(shell._executions.size, 0)
	ready.resolve(conn)
	await pause(0)
	assert.equal(calls.length, 0)
})

check('disposal immediately after execute registration still cancels before preparation starts', async (t) => {
	const { shell, calls, acquisitions } = fixture(t)
	const operation = shell.execute(shell.resolve({ command: 'queued preparation' }))
	await shell.dispose()
	await assert.rejects(operation, /service disposed/)
	assert.equal(calls.length, 0)
	assert.equal(acquisitions.length, 0)
})

check('disposal cancels an in-flight channel open and awaits its published handle', async (t) => {
	const opening = deferred()
	const { shell, calls } = fixture(t, {
		open(call) {
			call.opts.signal.addEventListener('abort', () => opening.reject(call.opts.signal.reason), { once: true })
			return opening.promise
		},
	})
	const proc = await shell.execute(shell.resolve({ command: 'opening on unload', onExpiry: 'none' }))
	await shell.dispose()
	await proc.done
	assert.equal(calls[0].opts.signal.aborted, true)
	assert.equal(proc.status, 'killed')
	assert.equal((await proc.result()).aborted, true)
	assert.equal(proc.observed.stderr.readFrom(0).text, '')
	assert.equal(shell._handles.size, 0)
})

check('a channel published late after unload is closed and joined before disposal resolves', async (t) => {
	const opening = deferred()
	const { shell, calls } = fixture(t, { open: () => opening.promise })
	const proc = await shell.execute(shell.resolve({ command: 'late channel on unload', onExpiry: 'none' }))
	let disposed = false
	const disposal = shell.dispose()
	disposal.then(() => { disposed = true })
	await pause(0)
	assert.equal(disposed, false)
	opening.resolve(calls[0].session)
	await disposal
	assert.equal(calls[0].kills, 1)
	assert.equal(proc.status, 'killed')
	assert.equal((await proc.result()).aborted, true)
})

check('disposal leaves settled results unchanged and preserves a prior timeout cause', async (t) => {
	const { shell, calls } = fixture(t)
	const finished = await shell.execute(shell.resolve({ command: 'already complete' }))
	calls[0].finish(9)
	await finished.done
	const result = await finished.result()
	const expired = await shell.execute(shell.resolve({ command: 'expired before unload', timeoutMs: 5 }))
	await expired.done
	await shell.dispose()
	assert.equal((await expired.result()).timedOut, true)
	assert.equal((await expired.result()).aborted, false)
	assert.equal((await finished.result()), result)
	assert.equal(result.exitCode, 9)
	assert.equal(result.aborted, false)
	assert.equal(calls[0].opts.signal.aborted, false)
})

check('apply effect awaits shell disposal before unregistering the preset shell service', async (t) => {
	const close = deferred()
	t.after(() => close.resolve())
	const { conn, calls } = fixture(t, { closeGate: close.promise })
	conn.platform = 'posix'
	const previous = globalThis[MANAGER_KEY]
	globalThis[MANAGER_KEY] = { connection: async () => conn }
	t.after(() => {
		if (previous === undefined) delete globalThis[MANAGER_KEY]
		else globalThis[MANAGER_KEY] = previous
	})
	let service
	let cleanup
	let unprovided = false
	const ctx = {
		provide(name, value) {
			assert.equal(name, 'shell')
			service = value
			return () => { unprovided = true }
		},
		effect(factory) { cleanup = factory() },
	}
	apply(ctx, { profile: 'disposal-fixture', root: '/remote/root' })
	const proc = await service.execute(service.resolve({ command: 'preset unload', onExpiry: 'none' }))
	const disposal = cleanup()
	await pause(0)
	assert.equal(calls[0].opts.signal.aborted, true)
	assert.equal(unprovided, false)
	close.resolve()
	await disposal
	assert.equal(unprovided, true)
	assert.equal(proc.status, 'killed')
	assert.equal((await proc.result()).aborted, true)
})

check('legacy run and start are projections of execute with background abort ownership', async (t) => {
	const { shell, calls } = fixture(t)
	const foreground = shell.run(shell.resolve({ command: 'legacy run' }))
	await pause(0)
	calls[0].stdout('legacy')
	calls[0].finish()
	assert.equal((await foreground).stdout.text, 'legacy')
	const abort = new AbortController()
	const background = await shell.start(shell.resolve({ command: 'legacy start', timeoutMs: 5, signal: abort.signal }))
	assert.equal(calls[1].opts.timeoutMs, undefined)
	await pause(15)
	assert.equal(background.status, 'running')
	abort.abort()
	await background.done
	assert.equal((await background.result()).aborted, true)
})

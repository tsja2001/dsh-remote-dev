/**
 * Remote-ssh shell world plugin.
 *
 * Loaded by an agent-preset composition (a cordis:group with
 * `isolate: { shell: true }`), this plugin provides `ctx.shell` for that
 * realm: a ShellExecutor over the plugin's SSH transport. The standard bash
 * tool then runs commands on the remote machine — same name, same schema,
 * same cards — while `workdir` and the session-relative defaults resolve
 * against the baked remote root.
 *
 * The dsh-shell 0.2.2 contract exposes execute(): one live handle with a
 * lazy foreground result(), independent observed stream readers, and consuming
 * readOutput(). Output retains bounded tails; only infrastructure failures
 * reject result(), while done always resolves. Legacy run()/start() delegate
 * to the same implementation. Preset/service disposal cancels preparation and
 * closes and awaits this service's owned channels, without closing the shared
 * SSH connection. Channel close is the transport's observation boundary: it
 * does not prove the remote process tree stopped. Remote confinement is the
 * remote user's.
 *
 * Environment policy: the harness process's ambient/managed DSH_* facts and
 * executor overrides describe THIS machine, so they are dropped — the remote
 * command runs with the remote login environment plus the caller's explicit
 * `env` entries, exported before the command.
 */

import { worldSupport, posixQuote, winQuote } from './world-support.js'

const DEFAULT_TIMEOUT_MS = 120000
const MAX_TIMEOUT_MS = 600000
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024

/** Reject budgets that cannot bound a buffer or a timer. */
function positiveNumber(name, value) {
	const number = Number(value)
	if (!Number.isFinite(number) || number <= 0) throw new Error(`remote shell: ${name} must be a positive finite number`)
	return number
}

/** Bounded raw-byte tail with whole-stream offsets and independent readers. */
function makeCollector(maxBytes) {
	const limit = Math.max(1, Math.floor(positiveNumber('maxOutputBytes', maxBytes)))
	let bytes = Buffer.alloc(0)
	let total = 0
	let ended = false
	return {
		push(chunk) {
			const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
			total += next.length
			if (next.length >= limit) bytes = Buffer.from(next.subarray(next.length - limit))
			else bytes = Buffer.concat([bytes.subarray(Math.max(0, bytes.length + next.length - limit)), next])
			// Do not turn a cut UTF-8 prefix into replacement characters that
			// exceed the byte cap. Whole-stream coordinates still include it.
			let start = 0
			while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
			if (start) bytes = Buffer.from(bytes.subarray(start))
		},
		end() { ended = true },
		readFrom(fromByte) {
			const offset = Math.max(0, Math.floor(Number(fromByte) || 0))
			const base = total - bytes.length
			let end = bytes.length
			if (!ended && end) {
				// Keep a split UTF-8 character for the next observation rather
				// than consuming half of it at a transport chunk boundary.
				let start = end - 1
				while (start > 0 && (bytes[start] & 0xc0) === 0x80) start--
				const lead = bytes[start]
				const width = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 1
				if (end - start < width) end = start
			}
			const start = Math.min(end, Math.max(0, offset - base))
			return { text: bytes.subarray(start, end).toString('utf8'), nextOffset: base + end, lossy: offset < base }
		},
	}
}

function finalOutput(reader) {
	const { text, lossy } = reader.readFrom(0)
	return { text, truncated: lossy }
}

export class RemoteSshShell {
	constructor(support, config = {}) {
		this.support = support
		Object.defineProperties(this, {
			profileId: { value: support.profileId, enumerable: true },
			root: { value: support.root, enumerable: true },
		})
		this.defaultTimeoutMs = Math.min(positiveNumber('timeoutMs', config.timeoutMs ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS)
		this.maxOutputBytes = positiveNumber('maxOutputBytes', config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)
		this._disposeController = new AbortController()
		this._handles = new Set()
		this._executions = new Set()
		this._disposePromise = null
	}

	get sandboxMode() {
		return undefined
	}

	async conn(signal) {
		return this.support.acquire('shell', { signal })
	}

	/** Compose the remote command line: workdir, exported env, then the command. */
	buildCommand(spec, posix) {
		const statements = []
		if (spec.workdir) {
			statements.push(posix ? 'cd ' + posixQuote(spec.workdir) : 'cd /d ' + winQuote(spec.workdir))
		}
		const env = { ...(spec.env || {}) }
		for (const [key, value] of Object.entries(env)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
			statements.push(posix ? 'export ' + key + '=' + posixQuote(String(value)) : 'set ' + key + '=' + winQuote(String(value)))
		}
		const body = posix ? 'bash -c ' + posixQuote(spec.command) : String(spec.command)
		if (posix) {
			// A failed cd aborts the whole line with a distinct exit (99). Env
			// exports chain normally; the body runs last.
			const prologue = statements.length ? statements.join(' && ') + ' && ' : ''
			if (spec.workdir) {
				return statements.slice(1).length
					? statements[0] + ' || exit 99; ' + statements.slice(1).join(' && ') + ' && ' + body
					: statements[0] + ' || exit 99; ' + body
			}
			return prologue + body
		}
		const prologue = statements.length ? statements.join(' && ') + ' && ' : ''
		return prologue + body
	}

	/**
	 * Pick the workdir for a run: honor an explicitly requested one only when
	 * it exists on the REMOTE machine (agent sessions pass their host cwd,
	 * which usually does not exist remotely); otherwise fall back to the
	 * bound workspace root. Results are memoized per directory.
	 */
	async workdirFor(request, connection, signal) {
		const wanted = request.workdir
		if (!wanted) return this.support.root
		this._dirOk = this._dirOk || new Set()
		this._dirBad = this._dirBad || new Set()
		if (this._dirOk.has(wanted)) return wanted
		if (this._dirBad.has(wanted) || wanted === this.support.root) return this.support.root
		if (wanted.startsWith('/') || /^[A-Za-z]:[\\/]/.test(wanted) || wanted.startsWith('\\\\')) {
			try {
				const conn = connection || await this.conn(signal)
				signal?.throwIfAborted()
				const st = await conn.statPath(wanted, { signal })
				signal?.throwIfAborted()
				if (!st || !st.isDirectory()) throw new Error('not a directory')
				this._dirOk.add(wanted)
				return wanted
			} catch {
				if (signal?.aborted) throw signal.reason
				this._dirBad.add(wanted)
				return this.support.root
			}
		}
		return this.support.root
	}

	resolve(request) {
		const timeoutMs = Math.min(positiveNumber('request.timeoutMs', request.timeoutMs ?? this.defaultTimeoutMs), MAX_TIMEOUT_MS)
		const stdoutMaxBytes = positiveNumber('request.stdoutMaxBytes', request.stdoutMaxBytes ?? this.maxOutputBytes)
		const onExpiry = request.onExpiry ?? 'kill'
		if (onExpiry !== 'kill' && onExpiry !== 'none') throw new Error('remote shell: onExpiry must be kill or none')
		return {
			command: request.command,
			workdir: request.workdir ?? this.support.root,
			timeoutMs,
			onExpiry,
			stdoutMaxBytes,
			...request.signal ? { signal: request.signal } : {},
			...request.stdin !== undefined ? { stdin: request.stdin } : {},
			...request.env !== undefined ? { env: request.env } : {},
			sandboxPolicy: request.sandboxPolicy,
		}
	}

	/** Track preparation as well as live handles so unload cannot miss either. */
	execute(spec) {
		if (this._disposeController.signal.aborted) return Promise.reject(this._disposeController.signal.reason)
		// Register ownership before any preparation callbacks can run.
		const opening = Promise.resolve().then(() => this._execute(spec))
		const owned = opening.then((handle) => {
			this._handles.add(handle)
			return handle.done.then(() => { this._handles.delete(handle) })
		}, () => { /* preparation failure has no published channel to await */ })
		this._executions.add(owned)
		void owned.then(() => { this._executions.delete(owned) })
		return opening
	}

	/** Cancel this world's work and await channel settlement, never the shared connection. */
	dispose() {
		if (this._disposePromise) return this._disposePromise
		// Publish the promise before abort listeners run, preserving idempotence
		// even if a listener re-enters disposal.
		this._disposePromise = Promise.resolve().then(async () => {
			await Promise.all([...this._executions])
		})
		this._disposeController.abort(Object.assign(new Error('remote shell service disposed'), { name: 'AbortError' }))
		for (const handle of this._handles) handle.kill()
		return this._disposePromise
	}

	/** Prepare under one deadline, then publish the shared batch/stream handle. */
	async _execute(spec) {
		const stdout = makeCollector(spec.stdoutMaxBytes)
		const stderr = makeCollector(this.maxOutputBytes)
		const cancellation = new AbortController()
		const signal = cancellation.signal
		const startedAt = Date.now()
		let firstCause = null
		let timer
		let settled = false
		const cancel = (cause, reason) => {
			if (settled || firstCause) return
			firstCause = cause
			cancellation.abort(reason)
		}
		const disposal = this._disposeController.signal
		const onAbort = () => cancel('abort', spec.signal.reason)
		const onDispose = () => cancel('abort', disposal.reason)
		const disarm = () => {
			clearTimeout(timer)
			spec.signal?.removeEventListener('abort', onAbort)
			disposal.removeEventListener('abort', onDispose)
		}
		if (disposal.aborted) onDispose()
		else disposal.addEventListener('abort', onDispose, { once: true })
		if (spec.signal?.aborted) onAbort()
		else spec.signal?.addEventListener('abort', onAbort, { once: true })
		if ((spec.onExpiry ?? 'kill') === 'kill' && !signal.aborted) {
			timer = setTimeout(() => cancel('timeout', new Error('remote shell execution timed out')), spec.timeoutMs)
		}

		let conn
		let command
		let preparationTimedOut = false
		let onPreparationAbort
		try {
			const cancelled = new Promise((_, reject) => {
				onPreparationAbort = () => reject(signal.reason)
				if (signal.aborted) onPreparationAbort()
				else signal.addEventListener('abort', onPreparationAbort, { once: true })
			})
			const preparing = async () => {
				signal.throwIfAborted()
				conn = await this.conn(signal)
				signal.throwIfAborted()
				const platform = await this.support.platformOf(conn, { signal })
				signal.throwIfAborted()
				const workdir = await this.workdirFor(spec, conn, signal)
				signal.throwIfAborted()
				return this.buildCommand({ ...spec, workdir }, platform !== 'windows' && platform !== false)
			}
			command = await Promise.race([preparing(), cancelled])
			signal.throwIfAborted()
		} catch (error) {
			if (firstCause !== 'timeout') {
				disarm()
				throw error
			}
			preparationTimedOut = true
		} finally {
			signal.removeEventListener('abort', onPreparationAbort)
		}

		let session
		let failure
		let resultPromise
		let stdoutOffset = 0
		let stderrOffset = 0
		const handle = {
			status: preparationTimedOut ? 'killed' : 'running',
			exitCode: null,
			signal: null,
			observed: {
				stdout: { readFrom: (offset) => stdout.readFrom(offset) },
				stderr: { readFrom: (offset) => stderr.readFrom(offset) },
			},
			done: null,
			readOutput() {
				const out = stdout.readFrom(stdoutOffset)
				const err = stderr.readFrom(stderrOffset)
				stdoutOffset = out.nextOffset
				stderrOffset = err.nextOffset
				const separator = out.text && !out.text.endsWith('\n') ? '\n' : ''
				return {
					delta: out.text + (err.text ? `${separator}[stderr]\n${err.text}` : ''),
					lossy: out.lossy || err.lossy,
				}
			},
			kill() {
				if (settled || handle.status !== 'running') return false
				handle.status = 'killed'
				// A published channel uses its explicit kill operation, preserving
				// the transport's signal. Pending channel opens use our owned
				// cancellation signal; neither is classified as caller abort.
				disarm()
				if (session) {
					try { session.kill() } catch { /* already closed */ }
				} else cancellation.abort(new Error('remote shell execution killed'))
				return true
			},
			result() {
				resultPromise ??= handle.done.then(() => {
					if (failure) throw failure.error
					return {
						exitCode: handle.exitCode,
						signal: handle.signal,
						timedOut: firstCause === 'timeout',
						aborted: firstCause === 'abort',
						timeoutMs: spec.timeoutMs,
						stdout: finalOutput(stdout),
						stderr: finalOutput(stderr),
					}
				})
				return resultPromise
			},
		}

		const complete = () => {
			settled = true
			stdout.end()
			stderr.end()
			disarm()
		}
		const failed = (error) => {
			// Cancellation before a channel opened is still an owned terminal
			// outcome. A genuine provider failure is read once on stderr and
			// rejects only the lazy result projection.
			// The transport's channel-open timer can win the same deadline by
			// a millisecond; it remains our timeout, not an infrastructure error.
			if (!firstCause && spec.onExpiry !== 'none' && error?.code === 'ETIMEDOUT') cancel('timeout', error)
			const ownedTermination = signal.aborted || handle.status === 'killed'
			handle.status = 'killed'
			if (!ownedTermination) {
				failure = { error }
				let detail = 'unprintable provider failure'
				try { detail = String(error) } catch { /* preserve never-rejecting done */ }
				stderr.push(`remote exec failed before reporting an outcome: ${detail}`)
			}
			complete()
		}
		let spawned
		try {
			spawned = preparationTimedOut ? Promise.resolve() : conn.startExec(command, {
				...spec.onExpiry === 'none' ? {} : { timeoutMs: Math.max(1, spec.timeoutMs - (Date.now() - startedAt)) },
				signal,
				// Older transports require onAbort to enable signal handling.
				onAbort() {},
				onStdout: (data) => { if (!settled) stdout.push(data) },
				onStderr: (data) => { if (!settled) stderr.push(data) },
				stdin: spec.stdin ?? '',
			})
		} catch (error) {
			spawned = Promise.reject(error)
		}
		handle.done = Promise.resolve(spawned).then(async (running) => {
			if (running) {
				session = running
				// A transport may publish the channel after cancellation/kill.
				if (signal.aborted && session.status === 'running') session.kill()
				await session.done
				if (session.error) throw session.error
				if (!firstCause && session.signal === 'timeout') firstCause = 'timeout'
				if (!firstCause && session.signal === 'abort' && handle.status !== 'killed') firstCause = 'abort'
				handle.exitCode = session.signal ? null : session.code ?? null
				handle.signal = session.signal && !['timeout', 'abort', 'error'].includes(session.signal)
					? (session.signal.startsWith('SIG') ? session.signal : `SIG${session.signal}`) : null
				handle.status = handle.status === 'killed' || signal.aborted || session.signal ? 'killed' : 'completed'
			}
			complete()
		}).catch(failed)
		return handle
	}

	/** Compatibility for callers of the pre-0.2.2 foreground API. */
	async run(spec) {
		return (await this.execute(spec)).result()
	}

	/** Legacy start() never armed a deadline; the caller still owns its signal. */
	async start(spec) {
		return this.execute({ ...spec, onExpiry: 'none' })
	}
}

/**
 * Plugin entry: provide `ctx.shell` in the calling (isolated) realm.
 * @param {object} ctx - cordis context of the preset row.
 * @param {object} config - { profile, root, timeoutMs?, maxOutputBytes? }.
 */
export function apply(ctx, config = {}) {
	const support = worldSupport(ctx, config)
	const shell = new RemoteSshShell(support, config)
	const unprovide = ctx.provide('shell', shell)
	ctx.effect(() => async () => {
		await shell.dispose()
		unprovide()
	})
}

export default { apply }

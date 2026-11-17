/**
 * Subprocess and session-directory services for one SSH execution world.
 *
 * POSIX argv is quoted element by element, never interpolated as shell syntax.
 * Only the remote login environment and explicit spec.env entries are used;
 * process.env and host executables are never consulted. The host's packaged
 * @vscode/ripgrep executable is translated to remote `rg`: install ripgrep on
 * the remote PATH before using the standard glob/grep tools (no auto-download).
 *
 * The managed range is exactly one SSH exec channel. terminate() closes that
 * channel, not the shared connection, and waitForExit() observes its closure.
 * Neither operation proves that remote descendants or detached jobs have exited.
 * A lost transport rejects done/waitForExit instead of claiming quiescence.
 * Windows argv, control descriptors, spill files, and PTYs are unsupported.
 */
import { PassThrough } from 'node:stream'
import { posix, win32, parse, join } from 'node:path'
import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { worldSupport, posixQuote } from './world-support.js'

const MAX_TIMER_DELAY_MS = 2147483647
const PACKAGED_RG = /(?:^|\/)node_modules\/@vscode\/ripgrep(?:-[a-z0-9-]+)?\/(?:bin\/)?rg(?:\.exe)?$/i

function failure(message, code = 'REMOTE_SUBPROCESS_FAILED', cause) {
	return Object.assign(new Error(`remote subprocess: ${message}`, cause === undefined ? undefined : { cause }), { code })
}

function directoryFailure(message, code) {
	return Object.assign(new Error(`remote working-directory: ${message}`), { name: 'WorkingDirectoryError', code })
}

function text(value, name, empty = false) {
	if (typeof value !== 'string' || (!empty && !value.length) || value.includes('\0')) {
		throw failure(`${name} must be ${empty ? 'a' : 'a nonempty'} NUL-free string`, 'REMOTE_SUBPROCESS_INVALID')
	}
	return value
}

function absolute(path) {
	return typeof path === 'string' && !path.includes('\0') && (posix.isAbsolute(path) || win32.isAbsolute(path))
}

function remoteExecutable(command) {
	// Match the package identity, never merely an arbitrary executable basename.
	const executable = parse(process.execPath)
	const sidecar = process.platform === 'win32' ? join(executable.dir, `${executable.name}-rg.exe`) : `${process.execPath}-rg`
	return PACKAGED_RG.test(command.replaceAll('\\', '/')) || ('pkg' in process && command === sidecar) ? 'rg' : command
}

function environment(env) {
	if (env === undefined) return {}
	if (!env || typeof env !== 'object' || Array.isArray(env)) throw failure('env must be an object', 'REMOTE_SUBPROCESS_INVALID')
	const copy = Object.create(null)
	for (const [key, value] of Object.entries(env)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw failure(`invalid environment name ${JSON.stringify(key)}`, 'REMOTE_SUBPROCESS_INVALID')
		copy[key] = value === undefined ? undefined : text(value, `env.${key}`, true)
	}
	return copy
}

function prologue(env) {
	return Object.entries(env).map(([key, value]) => value === undefined
		? `unset ${key} || exit 125; `
		: `export ${key}=${posixQuote(value)} || exit 125; `).join('')
}

function linkSignals(signals) {
	const control = new AbortController()
	const cleanups = []
	for (const signal of signals.filter(Boolean)) {
		if (signal.aborted) { control.abort(signal.reason); break }
		const listener = () => control.abort(signal.reason)
		signal.addEventListener('abort', listener, { once: true })
		cleanups.push(() => signal.removeEventListener('abort', listener))
	}
	return { signal: control.signal, dispose: () => cleanups.forEach(cleanup => cleanup()) }
}

/** Raw-byte tail. Offset reads do not consume bytes or split an unfinished UTF-8 suffix. */
function collector(limit) {
	let bytes = Buffer.alloc(0)
	let total = 0
	let ended = false
	return {
		push(chunk) {
			const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
			total += next.length
			bytes = next.length >= limit
				? Buffer.from(next.subarray(next.length - limit))
				: Buffer.concat([bytes.subarray(Math.max(0, bytes.length + next.length - limit)), next])
			let start = 0
			while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
			if (start) bytes = Buffer.from(bytes.subarray(start))
		},
		end() { ended = true },
		readFrom(offset) {
			if (!Number.isSafeInteger(offset) || offset < 0) throw failure('output offset must be a nonnegative safe integer', 'REMOTE_SUBPROCESS_INVALID')
			const base = total - bytes.length
			let end = bytes.length
			if (!ended && end) {
				let start = end - 1
				while (start > 0 && (bytes[start] & 0xc0) === 0x80) start--
				const lead = bytes[start]
				const width = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 1
				if (end - start < width) end = start
			}
			return { text: bytes.subarray(Math.min(end, Math.max(0, offset - base)), end).toString('utf8'), nextOffset: base + end, lossy: offset < base }
		},
	}
}

function outputMode(mode, name) {
	if (mode === 'pipe' || mode === 'inherit') return mode
	if (!mode || typeof mode !== 'object' || !Number.isSafeInteger(mode.maxBytes) || mode.maxBytes <= 0) {
		throw failure(`${name} must be pipe, inherit, or { maxBytes: positive integer }`, 'REMOTE_SUBPROCESS_INVALID')
	}
	if (mode.spill !== undefined) throw failure('spill files are unsupported; use bounded collection without spill', 'REMOTE_SUBPROCESS_UNSUPPORTED')
	return { maxBytes: mode.maxBytes }
}

function validateSpec(spec) {
	spec?.signal?.throwIfAborted()
	if (!spec || !Array.isArray(spec.argv) || !spec.argv.length) throw failure('argv must contain an executable', 'REMOTE_SUBPROCESS_INVALID')
	const argv = spec.argv.map((value, index) => text(value, `argv[${index}]`, index !== 0))
	if (argv[0].startsWith('-')) throw failure('executable must not start with a shell exec option', 'REMOTE_SUBPROCESS_INVALID')
	text(spec.cwd, 'cwd')
	if (!absolute(spec.cwd)) throw failure('cwd must be an absolute remote path', 'REMOTE_SUBPROCESS_INVALID')
	if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) throw failure('graceMs must be positive and within the timer limit', 'REMOTE_SUBPROCESS_INVALID')
	const stdio = spec.stdio
	if (!stdio || typeof stdio !== 'object') throw failure('stdio must specify all three streams', 'REMOTE_SUBPROCESS_INVALID')
	if (stdio.control !== undefined) throw failure('separate control descriptors are unsupported over SSH exec', 'REMOTE_SUBPROCESS_UNSUPPORTED')
	let stdin = stdio.stdin
	if (stdin !== 'ignore' && stdin !== 'pipe') {
		if (!stdin || typeof stdin !== 'object' || typeof stdin.data !== 'string') throw failure('stdin must be ignore, pipe, or { data: string }', 'REMOTE_SUBPROCESS_INVALID')
		stdin = { data: stdin.data }
	}
	return { ...spec, argv, env: environment(spec.env), stdio: { stdin, stdout: outputMode(stdio.stdout, 'stdout'), stderr: outputMode(stdio.stderr, 'stderr') } }
}

function identity(owner, support) {
	Object.defineProperties(owner, {
		support: { value: support, enumerable: true },
		profileId: { value: support.profileId, enumerable: true },
		root: { value: support.root, enumerable: true },
	})
}

export class RemoteSshSubprocess {
	constructor(support) {
		identity(this, support)
		this.lifecycle = new AbortController()
		this.handles = new Set()
	}

	/** Synchronous handle creation; connection and channel allocation happen asynchronously. */
	spawn(input) {
		this.lifecycle.signal.throwIfAborted()
		const spec = validateSpec(input)
		const allocation = new AbortController()
		const linked = linkSignals([allocation.signal, this.lifecycle.signal])
		const collected = {}
		const collectors = {}
		const outputs = {}
		for (const name of ['stdout', 'stderr']) {
			const mode = spec.stdio[name]
			if (typeof mode === 'object') {
				collectors[name] = collector(mode.maxBytes)
				collected[name] = Object.freeze({ readFrom: offset => collectors[name].readFrom(offset) })
			} else if (mode === 'pipe') {
				outputs[name] = new PassThrough()
				outputs[name].on('error', () => {})
			}
		}
		const stdin = spec.stdio.stdin === 'pipe' ? new PassThrough() : undefined
		stdin?.on('error', () => {})
		let session
		let terminated = false
		let range = 'pending'
		let settled = false
		const cleanup = []
		let rejectObservation
		const closeChannel = () => {
			try { session?.stream.close() } catch (error) {
				if (session) session.error ??= error
				rejectObservation?.(failure('cannot close or observe the SSH channel', 'REMOTE_SUBPROCESS_TRANSPORT', error))
			}
		}
		const terminate = () => {
			if (settled || terminated) return
			terminated = true
			// After allocation the handle, not a transport's synthetic kill signal,
			// owns channel closure. Pending allocations retain cancellation support.
			if (session) closeChannel()
			else allocation.abort(failure('channel allocation cancelled', 'REMOTE_SUBPROCESS_ABORTED'))
		}
		const onAbort = () => terminate()
		spec.signal?.addEventListener('abort', onAbort, { once: true })
		this.lifecycle.signal.addEventListener('abort', onAbort, { once: true })
		const deliver = (name, chunk) => {
			if (settled) return
			if (collectors[name]) collectors[name].push(chunk)
			else if (outputs[name]) {
				if (!outputs[name].write(chunk)) (name === 'stdout' ? session?.stream : session?.stream?.stderr)?.pause()
			} else {
				// 'inherit' means the harness diagnostic stream, never a host child.
				(name === 'stdout' ? process.stdout : process.stderr).write(chunk)
			}
		}
		const done = (async () => {
			let attempted = false
			try {
				const conn = await this.support.acquire('subprocess', { signal: linked.signal })
				linked.signal.throwIfAborted()
				const platform = await this.support.platformOf(conn)
				linked.signal.throwIfAborted()
				if (platform !== 'posix') throw failure('Windows argv execution is unsupported; use a POSIX SSH target for subprocess/search tools', 'REMOTE_SUBPROCESS_UNSUPPORTED')
				if (!posix.isAbsolute(spec.cwd)) throw failure('cwd must be an absolute POSIX remote path', 'REMOTE_SUBPROCESS_INVALID')
				const info = await conn.statPath(spec.cwd, { signal: linked.signal })
				linked.signal.throwIfAborted()
				if (!info?.isDirectory()) throw failure(`remote cwd is not a directory: ${JSON.stringify(spec.cwd)}`, 'REMOTE_SUBPROCESS_CWD')
				const argv = [remoteExecutable(spec.argv[0]), ...spec.argv.slice(1)]
				const command = `cd ${posixQuote(spec.cwd)} || exit 125; ${prologue(spec.env)}exec ${argv.map(posixQuote).join(' ')}${spec.stdio.stdin === 'ignore' ? ' < /dev/null' : ''}`
				let transportError
				const observationFailure = new Promise((_resolve, reject) => { rejectObservation = reject })
				observationFailure.catch(() => {})
				const transportLost = error => {
					transportError ??= failure('SSH transport failed; remote process state is unknown', 'REMOTE_SUBPROCESS_TRANSPORT', error instanceof Error ? error : undefined)
					rejectObservation(transportError)
					if (session) { session.error ??= transportError; closeChannel() }
				}
				const client = conn.client
				for (const event of ['error', 'end', 'close']) {
					client?.on(event, transportLost)
					cleanup.push(() => client?.removeListener(event, transportLost))
				}
				attempted = true
				const opening = Promise.resolve(conn.startExec(command, {
					signal: linked.signal,
					onStdout: chunk => deliver('stdout', chunk),
					onStderr: chunk => deliver('stderr', chunk),
					...(typeof spec.stdio.stdin === 'object' ? { stdin: spec.stdio.stdin.data } : {}),
				}))
				// A provider failure can precede allocation's return; retire any late channel.
				opening.then(late => {
					if (settled) { try { late.stream.close() } catch { /* transport already lost */ } }
				}, () => {})
				session = await Promise.race([opening, observationFailure])
				range = 'channel'
				// Fail immediately when observation is lost, even if no close event follows.
				const streamError = error => { session.error ??= error; transportLost(error) }
				for (const source of [session.stream, session.stream?.stderr]) {
					source?.on('error', streamError)
					cleanup.push(() => source?.removeListener('error', streamError))
				}
				for (const name of ['stdout', 'stderr']) {
					const source = name === 'stdout' ? session.stream : session.stream?.stderr
					if (outputs[name] && source) {
						const resume = () => source.resume()
						outputs[name].on('drain', resume)
						cleanup.push(() => outputs[name].removeListener('drain', resume))
						if (outputs[name].writableNeedDrain) source.pause()
					}
				}
				let remoteExit
				const exited = (code, signal) => { remoteExit = { code, signal } }
				session.stream?.on('exit', exited)
				cleanup.push(() => session.stream?.removeListener('exit', exited))
				if (transportError) { session.error ??= transportError; closeChannel() }
				else if (terminated) closeChannel()
				else if (stdin) stdin.pipe(session.stream)
				await Promise.race([session.done, observationFailure])
				if (session.error || transportError) throw failure('SSH channel failed; remote process state is unknown', 'REMOTE_SUBPROCESS_TRANSPORT', session.error ?? transportError)
				if (session.signal === 'error') throw failure('SSH channel failed; remote process state is unknown', 'REMOTE_SUBPROCESS_TRANSPORT')
				range = 'empty'
				const rawSignal = remoteExit?.signal ?? (terminated ? null : session.signal)
				const signal = rawSignal && !['abort', 'timeout'].includes(rawSignal) ? (rawSignal.startsWith('SIG') ? rawSignal : `SIG${rawSignal}`) : null
				return { exitCode: signal ? null : (remoteExit?.code ?? (terminated ? null : session.code) ?? null), signal }
			} catch (error) {
				range = attempted ? 'unknown' : 'empty'
				throw error
			} finally {
				settled = true
				linked.dispose()
				spec.signal?.removeEventListener('abort', onAbort)
				this.lifecycle.signal.removeEventListener('abort', onAbort)
				cleanup.forEach(dispose => dispose())
				stdin?.unpipe()
				stdin?.destroy()
				for (const name of ['stdout', 'stderr']) { collectors[name]?.end(); outputs[name]?.end() }
			}
		})()
		const handle = Object.freeze({
			stdin, stdout: outputs.stdout, stderr: outputs.stderr, control: undefined,
			collected: Object.freeze(collected), done, terminate,
			waitForExit(signal) {
				if (signal?.aborted) return Promise.resolve(false)
				return new Promise((resolve, reject) => {
					const abort = () => { dispose(); resolve(false) }
					const dispose = () => signal?.removeEventListener('abort', abort)
					signal?.addEventListener('abort', abort, { once: true })
					done.then(() => { dispose(); resolve(true) }, error => {
						dispose()
						if (range === 'empty') resolve(true)
						else reject(error)
					})
				})
			},
		})
		this.handles.add(handle)
		done.then(() => this.handles.delete(handle), () => this.handles.delete(handle))
		return handle
	}

	async terminalEnvironment(signal) {
		const linked = linkSignals([this.lifecycle.signal, signal])
		try {
			linked.signal.throwIfAborted()
			const conn = await this.support.acquire('terminal environment', { signal: linked.signal })
			const platform = await this.support.platformOf(conn)
			linked.signal.throwIfAborted()
			if (platform === 'windows') return { platform: 'windows' }
			const shell = (await this.inspect(['/bin/sh', '-c', 'printf %s "${SHELL-}"'], undefined, linked.signal)).trim()
			return { platform: 'posix', ...(shell ? { defaultShell: shell } : {}) }
		} finally { linked.dispose() }
	}

	async resolveExecutable(command, env, signal) {
		const linked = linkSignals([this.lifecycle.signal, signal])
		try {
			linked.signal.throwIfAborted()
			command = remoteExecutable(text(command, 'executable'))
			if ((!posix.isAbsolute(command) && /[\\/]/.test(command)) || command.startsWith('-')) throw failure('executable must be an absolute remote path or bare PATH name', 'REMOTE_SUBPROCESS_INVALID')
			const script = 'p=$1; case "$p" in /*) ;; *) p=$(command -v "$p") || exit 127 ;; esac; case "$p" in /*) ;; *) exit 127 ;; esac; [ -f "$p" ] && [ -x "$p" ] || exit 127; printf %s "$p"'
			let path
			try {
				path = await this.inspect(['/bin/sh', '-c', script, 'remote-executable', command], env, linked.signal)
			} catch (error) {
				linked.signal.throwIfAborted()
				if (error.code !== 'REMOTE_SUBPROCESS_INSPECTION') throw error
				throw failure(`executable ${JSON.stringify(command)} is unavailable on the remote target${command === 'rg' ? '; install ripgrep on the remote PATH before using glob/grep (automatic download is disabled)' : ''}`, 'SUBPROCESS_EXECUTABLE_NOT_FOUND', error)
			}
			if (!posix.isAbsolute(path) || path.includes('\0')) throw failure('remote executable lookup returned no absolute path', 'SUBPROCESS_EXECUTABLE_NOT_FOUND')
			const conn = await this.support.acquire('executable realpath', { signal: linked.signal })
			const canonical = await conn.realpath(path, { signal: linked.signal })
			linked.signal.throwIfAborted()
			return canonical
		} finally { linked.dispose() }
	}

	async inspect(argv, env, signal) {
		const handle = this.spawn({ argv, cwd: this.root, env, signal, graceMs: 3000, stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } } })
		const result = await handle.done
		signal?.throwIfAborted()
		const stdout = handle.collected.stdout.readFrom(0)
		if (result.exitCode !== 0 || result.signal || stdout.lossy) throw failure('remote environment inspection failed', 'REMOTE_SUBPROCESS_INSPECTION')
		return stdout.text
	}

	async spawnTerminal(_spec) {
		throw failure('SSH PTY subprocess support is unavailable; use the remote shell tool or an external SSH terminal; a local terminal will not be opened', 'REMOTE_SUBPROCESS_UNSUPPORTED')
	}

	async dispose() {
		this.lifecycle.abort(failure('service disposed', 'REMOTE_SUBPROCESS_DISPOSED'))
		const handles = [...this.handles]
		for (const handle of handles) handle.terminate()
		await Promise.allSettled(handles.map(handle => handle.done))
	}
}

/** Current host working-directory projection contract, with remote path semantics. */
export class RemoteSshWorkingDirectory {
	constructor(ctx, support, config = {}) {
		identity(this, support)
		this.ctx = ctx
		this.anchor = config.anchor
		this.defaultDirectory = config.defaultDirectory ?? this.root
		if (!absolute(this.defaultDirectory)) throw directoryFailure('defaultDirectory must be absolute', 'WORKING_DIRECTORY_INVALID')
		if (ctx.fs?.profileId !== this.profileId || ctx.fs?.root !== this.root) throw directoryFailure('a matching remote filesystem provider is required', 'WORKING_DIRECTORY_UNAVAILABLE')
		this.pending = new WeakMap()
		this.operations = new Set()
		this.lifecycle = new AbortController()
	}

	async initialize() {
		const schema = z.string().min(1).refine(absolute).nullable()
		// The global host service may already own this key; registrations share the
		// first definition. Keep its definition compatible and publish remote cwd
		// events into it, while a private projection owns anchor initialization.
		this.currentProjection = await this.ctx.sessionProjections.register({
			key: 'workingDirectory', stateVersion: 1, stateSchema: schema,
			init: header => header.cwd ?? null,
			apply: (state, event) => event.type === 'working-directory/change' ? event.data.cwd : state,
			wire: { viewSchema: schema, view: state => state },
		})
		this.projection = await this.ctx.sessionProjections.register({
			key: `remote-ssh:working-directory:${encodeURIComponent(this.profileId)}:${encodeURIComponent(this.root)}`, stateVersion: 1, stateSchema: schema,
			init: header => this.original(header),
			apply: (state, event) => event.type === 'working-directory/change' ? event.data.cwd : state,
		})
		this.lifecycle.signal.throwIfAborted()
		this.ctx.systemPrompt.context({
			name: 'working-directory:current', order: this.ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY'), required: true, interpolate: false,
			text: context => context.agent === undefined ? '' : this.contextText(context.agent.session),
		})
		this.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
			if (context.agent === undefined) return next()
			await this.ensure(context.agent, context.signal)
			const assembly = await next()
			this.lifecycle.signal.throwIfAborted()
			const text = this.contextText(context.agent.session)
			const contribution = assembly.contexts.find(entry => entry.name === 'working-directory:current')
			if (contribution === undefined) assembly.contexts.unshift({ name: 'working-directory:current', text, interpolate: false })
			else { contribution.text = text; contribution.interpolate = false }
			return assembly
		}, { prepend: true })
	}

	original(header) {
		// Legacy rows have no anchor metadata: their immutable header is host-local.
		return !this.anchor || header.cwd === this.anchor ? this.defaultDirectory : (header.cwd ?? this.defaultDirectory)
	}

	get(session) { return this.projection.stateOf(session) ?? this.defaultDirectory }
	contextText(session) { return `Current working directory: ${JSON.stringify(this.get(session))}.` }

	ensure(agent, signal) {
		return this.serialize(agent, signal, control => this.ctx.waterfall('working-directory/access', { agent, path: null, signal: control }, async () => {
			const current = this.get(agent.session)
			const target = await this.ctx.fs.resolve(current, { cwd: current, signal: control })
			const info = await this.ctx.fs.stat(target, control)
			control.throwIfAborted()
			agent.ctx.fiber.assertActive()
			if (info?.type === 'directory') {
				if (this.currentProjection.stateOf(agent.session) !== current) agent.session.append('working-directory/change', { cwd: current })
				return current
			}
			const original = this.original(agent.session.header)
			const restored = await this.directory(original, original, control, () => directoryFailure(`directory ${JSON.stringify(current)} and original remote directory ${JSON.stringify(original)} are unavailable`, 'WORKING_DIRECTORY_UNAVAILABLE'))
			this.commit(agent, restored, true, control)
			return restored
		}))
	}

	set(agent, path, signal) {
		return this.serialize(agent, signal, control => this.ctx.waterfall('working-directory/access', { agent, path, signal: control }, async () => {
			if (typeof path !== 'string' || !path.length || path.includes('\0')) throw directoryFailure('cd must be a nonempty NUL-free path', 'WORKING_DIRECTORY_INVALID')
			const directory = await this.directory(path, this.get(agent.session), control)
			this.commit(agent, directory, false, control)
			return directory
		}))
	}

	async directory(path, cwd, signal, missing = () => directoryFailure(`directory does not exist: ${JSON.stringify(path)}`, 'WORKING_DIRECTORY_NOT_FOUND')) {
		const target = await this.ctx.fs.resolve(path, { cwd, signal })
		const info = await this.ctx.fs.stat(target, signal)
		signal.throwIfAborted()
		if (info?.type !== 'directory') throw missing()
		const directory = this.ctx.fs.processPath(target)
		if (!absolute(directory)) throw directoryFailure('filesystem returned a nonabsolute remote directory', 'WORKING_DIRECTORY_UNAVAILABLE')
		return directory
	}

	commit(agent, directory, recovered, signal) {
		signal.throwIfAborted()
		agent.ctx.fiber.assertActive()
		const previous = this.get(agent.session)
		if (previous === directory && this.currentProjection.stateOf(agent.session) === directory) return
		agent.session.append('working-directory/change', { cwd: directory })
		if (previous === directory) return
		try {
			agent.inject(createUserMessage({
				content: [{ type: 'text', text: recovered
					? `The working directory ${JSON.stringify(previous)} is unavailable. The working directory is now ${JSON.stringify(directory)}.`
					: `The working directory changed from ${JSON.stringify(previous)} to ${JSON.stringify(directory)}.` }],
				source: { kind: 'working-directory' },
			}))
		} catch (error) {
			this.ctx.logger.warn(`working-directory: committed ${JSON.stringify(directory)}, but could not queue its notice: ${String(error)}`)
		}
	}

	serialize(agent, signal, action) {
		const linked = linkSignals([this.lifecycle.signal, signal])
		const operation = (this.pending.get(agent.session) ?? Promise.resolve()).then(() => {
			linked.signal.throwIfAborted()
			agent.ctx.fiber.assertActive()
			return action(linked.signal)
		})
		const settled = operation.finally(() => { linked.dispose(); this.operations.delete(settled) })
		this.operations.add(settled)
		this.pending.set(agent.session, settled.then(() => {}, () => {}))
		return settled
	}

	async dispose() {
		this.lifecycle.abort(directoryFailure('service disposed', 'WORKING_DIRECTORY_UNAVAILABLE'))
		await Promise.allSettled([...this.operations])
	}
}

export const inject = ['fs', 'sessionProjections', 'systemPrompt']

export async function apply(ctx, config = {}) {
	const support = worldSupport(ctx, config)
	const subprocess = new RemoteSshSubprocess(support)
	const workingDirectory = new RemoteSshWorkingDirectory(ctx, support, config)
	await workingDirectory.initialize()
	ctx.effect(() => async () => { await Promise.all([subprocess.dispose(), workingDirectory.dispose()]) })
	const disposers = [ctx.provide('subprocess', subprocess), ctx.provide('workingDirectory', workingDirectory)]
	ctx.effect(() => () => disposers.reverse().forEach(dispose => dispose()))
}

export default { inject, apply }

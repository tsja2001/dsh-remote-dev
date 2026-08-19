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
 * Semantics honored (see dsh-shell's contract):
 * - run() resolves for nonzero exits, timeouts, and aborts (never rejects
 *   for those); only infrastructure failures reject.
 * - start() returns immediately with a consuming readOutput() handle whose
 *   done never rejects; kill() is idempotent.
 * - sandboxMode stays undefined: remote confinement is the remote user's.
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

/** Collected-output cap with lossy truncation, mirroring the local shape. */
function makeCollector(maxBytes) {
	let text = ''
	let truncated = false
	return {
		push(chunk) {
			if (truncated) return
			const next = text + chunk
			if (Buffer.byteLength(next, 'utf8') > maxBytes) {
				const keep = Buffer.byteLength(text, 'utf8')
				const room = Math.max(0, maxBytes - keep)
				if (room > 0) text += Buffer.from(next, 'utf8').subarray(keep, keep + room).toString('utf8')
				truncated = true
				return
			}
			text = next
		},
		result() {
			return { text, truncated }
		},
	}
}

export class RemoteSshShell {
	constructor(support, config = {}) {
		this.support = support
		this.defaultTimeoutMs = Math.min(Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
		this.maxOutputBytes = Number(config.maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES
	}

	get sandboxMode() {
		return undefined
	}

	async conn() {
		return this.support.acquire('shell')
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
	async workdirFor(request) {
		const wanted = request.workdir
		if (!wanted) return this.support.root
		this._dirOk = this._dirOk || new Set()
		this._dirBad = this._dirBad || new Set()
		if (this._dirOk.has(wanted)) return wanted
		if (this._dirBad.has(wanted) || wanted === this.support.root) return this.support.root
		if (wanted.startsWith('/') || /^[A-Za-z]:[\\/]/.test(wanted) || wanted.startsWith('\\\\')) {
			try {
				const conn = await this.conn()
				const st = await conn.statPath(wanted)
				if (!st || !st.isDirectory()) throw new Error('not a directory')
				this._dirOk.add(wanted)
				return wanted
			} catch {
				this._dirBad.add(wanted)
				return this.support.root
			}
		}
		return this.support.root
	}

	resolve(request) {
		const timeoutMs = Math.min(
			Math.max(1, Number(request.timeoutMs) || this.defaultTimeoutMs),
			MAX_TIMEOUT_MS,
		)
		const stdoutMaxBytes = request.stdoutMaxBytes ?? this.maxOutputBytes
		return {
			command: request.command,
			workdir: request.workdir ?? this.support.root,
			timeoutMs,
			stdoutMaxBytes,
			...request.signal ? { signal: request.signal } : {},
			...request.stdin !== undefined ? { stdin: request.stdin } : {},
			...request.env !== undefined ? { env: request.env } : {},
			sandboxPolicy: request.sandboxPolicy,
		}
	}

	async run(spec) {
		const conn = await this.conn()
		const posix = await this.support.platformOf(conn)
		const stdout = makeCollector(spec.stdoutMaxBytes)
		const stderr = makeCollector(this.maxOutputBytes)
		const workdir = await this.workdirFor(spec)
		const command = this.buildCommand(workdir === spec.workdir ? spec : { ...spec, workdir }, posix)
		let firstCause = null
		const onAbort = () => {
			if (!firstCause) firstCause = 'abort'
		}
		const session = await conn.startExec(command, {
			timeoutMs: spec.timeoutMs,
			signal: spec.signal,
			onAbort,
			onStdout: (d) => stdout.push(d.toString('utf8')),
			onStderr: (d) => stderr.push(d.toString('utf8')),
			stdin: spec.stdin,
		})
		await session.done
		if (session.signal === 'timeout') firstCause = firstCause || 'timeout'
		return {
			exitCode: session.signal ? null : session.code,
			signal: session.signal && session.signal !== 'timeout' && session.signal !== 'abort' ? 'SIGKILL' : null,
			timedOut: firstCause === 'timeout' || session.signal === 'timeout',
			aborted: firstCause === 'abort' || session.signal === 'abort',
			timeoutMs: spec.timeoutMs,
			stdout: stdout.result(),
			stderr: stderr.result(),
		}
	}

	async start(spec) {
		const conn = await this.conn()
		const posix = await this.support.platformOf(conn)
		const command = this.buildCommand({ ...spec, timeoutMs: undefined }, posix)
		let pending = ''
		let lossy = false
		const handle = {
			status: 'running',
			exitCode: null,
			signal: null,
			done: null,
			readOutput() {
				const delta = pending
				pending = ''
				const wasLossy = lossy
				lossy = false
				return { delta, lossy: wasLossy }
			},
			kill() {
				if (this.status !== 'running') return false
				this._killed = true
				try { session.kill() } catch { /* already closed */ }
				return true
			},
		}
		const session = await conn.startExec(command, {
			stdin: spec.stdin,
			onStdout: (d) => { pending += d.toString('utf8') },
			onStderr: (d) => { pending += '\n[stderr]\n' + d.toString('utf8') },
		})
		handle.done = session.done.then(() => {
			handle.exitCode = session.signal ? null : session.code
			handle.signal = session.signal && session.signal !== 'timeout' && session.signal !== 'abort' ? 'SIGKILL' : null
			// A channel we closed ourselves reports a plain exit; the kill flag
			// keeps the handle's lifecycle honest for job consumers.
			handle.status = session.signal || handle._killed ? 'killed' : 'completed'
		})
		return handle
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
	const dispose = ctx.provide('shell', shell)
	ctx.effect(() => dispose)
}

export default { apply }

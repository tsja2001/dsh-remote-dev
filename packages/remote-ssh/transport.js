/**
 * dsh-remote-ssh transport: one SSH connection per profile, backed by ssh2
 * (pure JavaScript, no native dependencies). Supports password and
 * private-key (with passphrase) authentication.
 *
 * The connection object is a small state machine
 * (connecting -> connected -> degraded/closed) that reports transitions
 * through an onState hook so the manager can keep its status table honest,
 * and classifies every failure into a stable error code with localized
 * (zh/en) user-facing text — shared by the browser UI and the model tools.
 *
 * @module dsh-remote-dev/transport
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { Client } from 'ssh2'

/** Default private-key candidates used ONLY to migrate legacy 'agent' profiles. */
export const LEGACY_KEY_CANDIDATES = ['id_ed25519', 'id_rsa', 'id_ecdsa']

/** First existing default private key path, or '' when none exists. */
export function firstExistingDefaultKey() {
	for (const name of LEGACY_KEY_CANDIDATES) {
		const p = join(homedir(), '.ssh', name)
		if (existsSync(p)) return p
	}
	return ''
}

/** Expand a leading `~` or `$HOME` to the real home directory. */
export function expandTilde(p) {
	const s = String(p ?? '').trim()
	if (s === '~') return homedir()
	if (s.startsWith('~/') || s.startsWith('~\\')) return join(homedir(), s.slice(2))
	if (s.startsWith('$HOME/') || s.startsWith('$HOME\\')) return join(homedir(), s.slice(6))
	return s
}

/**
 * Stable error codes with localized user-facing text. Everything the UI and
 * the tools surface goes through classifyError so users never see raw dumps.
 */
export const ERROR_TEXT = {
	AUTH: {
		zh: '认证失败：请检查用户名、密码或密钥是否正确',
		en: 'Authentication failed: check the username, password, or key',
	},
	KEYFILE: {
		zh: '密钥文件不存在、不可读，或口令错误',
		en: 'Key file missing/unreadable, or wrong passphrase',
	},
	DNS: { zh: '主机名解析失败：检查主机地址', en: 'Hostname could not be resolved' },
	TIMEOUT: { zh: '连接超时：网络不可达或防火墙拦截', en: 'Connection timed out (unreachable or firewalled)' },
	REFUSED: { zh: '端口未开放：目标机器上的 sshd 未运行或端口不对', en: 'Connection refused: no sshd listening on that port' },
	UNREACH: { zh: '网络不可达：路由或防火墙拒绝', en: 'Network unreachable' },
	RESET: { zh: '连接被重置：网络中断或服务端关闭', en: 'Connection reset by peer' },
	HOSTKEY: {
		zh: '主机指纹与记录不一致：可能存在中间人攻击，或服务器已重装',
		en: 'Host key fingerprint changed: possible MITM, or the server was reinstalled',
	},
	OTHER: { zh: '连接失败', en: 'Connection failed' },
}

/** Classify one error into {code, zh, en, detail}; detail is the raw message. */
export function classifyError(err) {
	const message = String(err?.message || err || '')
	const code = String(err?.code || '')
	const m = message.toLowerCase()
	if (m.includes('host key verification') || m.includes('fingerprint')) {
		return mk('HOSTKEY', message)
	}
	if (code === 'ENOENT' || m.includes('cannot parse privatekey') || m.includes('no such file') || m.includes('eacces') || m.includes('permission denied') && m.includes('key')) {
		return mk('KEYFILE', message)
	}
	if (m.includes('all configured authentication methods failed') || m.includes('authentication failed') || code === 'EACCES') {
		return mk('AUTH', message)
	}
	if (code === 'ENOTFOUND' || m.includes('getaddrinfo') || m.includes('could not resolve') || m.includes('nodename nor servname')) {
		return mk('DNS', message)
	}
	if (code === 'ETIMEDOUT' || m.includes('timed out') || m.includes('timeout') || m.includes('connection timeout')) {
		return mk('TIMEOUT', message)
	}
	if (code === 'ECONNREFUSED' || m.includes('refused')) {
		return mk('REFUSED', message)
	}
	if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || m.includes('unreachable') || m.includes('no route to host')) {
		return mk('UNREACH', message)
	}
	if (code === 'ECONNRESET' || m.includes('socket closed') || m.includes('connection lost') || m.includes('keepalive')) {
		return mk('RESET', message)
	}
	return mk('OTHER', message)

	function mk(code_, detail) {
		return { code: code_, ...ERROR_TEXT[code_], detail }
	}
}

/** OpenSSH-style SHA256 fingerprint (base64, padding stripped) of a host key buffer. */
export function fingerprintOf(keyBuffer) {
	return 'SHA256:' + createHash('sha256').update(keyBuffer).digest('base64').replace(/=+$/, '')
}

function abortReason(signal) {
	return signal?.reason ?? Object.assign(new Error('Operation aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
}

/** Close a channel owned by one operation, never its shared SSH client. */
function releaseChannel(channel) {
	if (!channel) return
	// Late callbacks may deliver a channel after its caller has cancelled.
	channel.on?.('error', () => {})
	try { channel.end ? channel.end() : channel.close?.() } catch { /* already closed */ }
}

/** One callback request, with prompt cancellation and late callback suppression. */
function sftpCall(sftp, method, args, signal) {
	return new Promise((resolve, reject) => {
		signal?.throwIfAborted()
		let settled = false
		const finish = (err, value) => {
			if (settled) return
			settled = true
			signal?.removeEventListener('abort', onAbort)
			sftp.removeListener?.('close', onClose)
			sftp.removeListener?.('error', onError)
			if (err !== null && err !== undefined) reject(err)
			else resolve(value)
		}
		const onAbort = () => finish(abortReason(signal))
		const onClose = () => finish(signal?.aborted ? abortReason(signal) : new Error('SFTP channel closed'))
		const onError = (err) => finish(err)
		signal?.addEventListener('abort', onAbort, { once: true })
		sftp.once?.('close', onClose)
		sftp.once?.('error', onError)
		try { sftp[method](...args, (err, value) => finish(err, value)) } catch (err) { finish(err) }
	})
}

/** One live SSH connection for one resolved profile (secrets already inline). */
export class RemoteConnection {
	/**
	 * @param {object} profile - profile with password/passphrase resolved inline
	 * @param {object} [hooks] - { onState(state, classifiedError) } lifecycle sink
	 */
	constructor(profile, hooks = {}) {
		this.profile = profile
		this.hooks = hooks
		this.client = null
		/** Shared SFTP channel (reused across operations; reopened when lost). */
		this._sftp = null
		this._sftpAlive = false
		/** 'posix' | 'windows' — detected on connect, drives tool hints. */
		this.platform = null
		/** 'connecting' | 'connected' | 'degraded' | 'closed' */
		this.state = 'idle'
		/** Last classified error, as produced by classifyError. */
		this.lastError = null
		/** Host key fingerprint captured during handshake (TOFU). */
		this.fingerprint = null
		/** SFTP-realpath'd home directory, cached for the browser UI. */
		this.homePath = null
	}

	setState(state, classified = null) {
		this.state = state
		this.lastError = classified
		try {
			this.hooks.onState?.(state, classified)
		} catch {
			/* listener errors must not break the connection */
		}
	}

	/** Build the ssh2 connect config from a profile (password / key only). */
	buildConfig() {
		const p = this.profile
		const cfg = {
			host: p.host,
			port: Number(p.port) || 22,
			username: p.user,
			readyTimeout: p.readyTimeoutMs || 15000,
			keepaliveInterval: 15000,
			keepaliveCountMax: 3,
		}
		if (p.auth === 'password') {
			if (!p.password) {
				throw Object.assign(new Error('profile uses password auth but has no password'), { code: 'NO_PASSWORD' })
			}
			cfg.password = p.password
		} else if (p.auth === 'key') {
			let keyPath = expandTilde(p.keyPath || '')
			if (!keyPath) {
				throw Object.assign(new Error('key auth needs a private-key path'), { code: 'KEYFILE' })
			}
			if (!isAbsolute(keyPath)) keyPath = resolve(process.cwd(), keyPath)
			let keyData
			try {
				keyData = readFileSync(keyPath)
			} catch (err) {
				throw Object.assign(new Error(`cannot read private key ${keyPath}: ${err.message}`), { code: 'ENOENT' })
			}
			cfg.privateKey = keyData
			if (p.passphrase) cfg.passphrase = p.passphrase
		} else {
			throw new Error(`unsupported auth method: ${p.auth || '(unset)'} — use 'password' or 'key'`)
		}
		// Host-key TOFU: when the profile carries a pinned fingerprint, verify
		// it during the handshake; a mismatch aborts with a classified error.
		if (p.hostFingerprint) {
			const pinned = p.hostFingerprint
			cfg.hostVerifier = (key) => {
				const seen = fingerprintOf(key)
				this.fingerprint = seen
				if (seen !== pinned) {
					const err = new Error(
						`host key verification failed: pinned ${pinned}, got ${seen}`,
					)
					this._hostkeyMismatch = { pinned, seen }
					return false
				}
				return true
			}
		} else {
			// First connection: record whatever the server presents (TOFU).
			cfg.hostVerifier = (key) => {
				this.fingerprint = fingerprintOf(key)
				return true
			}
		}
		return cfg
	}

	/** Establish the connection; optional cancellation owns only this new client. */
	connect(opts = {}) {
		return new Promise((resolve, reject) => {
			opts.signal?.throwIfAborted()
			this.setState('connecting')
			this._hostkeyMismatch = null
			const client = new Client()
			this._connectingClient = client
			let settled = false
			const finish = (err, value) => {
				if (settled) return
				settled = true
				opts.signal?.removeEventListener('abort', onAbort)
				if (this._connectingClient === client) this._connectingClient = null
				if (err !== null && err !== undefined) reject(err)
				else resolve(value)
			}
			const retire = (classified) => {
				if (this.client === client) this.client = null
				this.setState('closed', classified)
			}
			const onAbort = () => {
				retire(null)
				finish(abortReason(opts.signal))
				client.end()
			}
			const onError = (err) => {
				const mismatch = this._hostkeyMismatch
				const classified = mismatch
					? { code: 'HOSTKEY', ...ERROR_TEXT.HOSTKEY, detail: `pinned ${mismatch.pinned}, got ${mismatch.seen}`, ...mismatch }
					: classifyError(err)
				if (!settled || this.client === client) retire(classified)
				finish(Object.assign(new Error(`ssh connect to ${this.profile.host} failed: ${err.message}`), { classified }))
			}
			// Keep the error listener after settlement: a closing SSH client can
			// report another error while its channels drain.
			client.on('error', onError)
			client.once('close', () => {
				const err = new Error('connection closed')
				if (!settled || this.client === client) retire(classifyError(err))
				finish(err)
			})
			client.once('ready', async () => {
				if (settled) return client.end()
				this.client = client
				try {
					await this.detectPlatform(opts)
					opts.signal?.throwIfAborted()
					if (settled) return
					this.setState('connected')
					finish(null, this)
				} catch (err) {
					if (settled) return
					retire(opts.signal?.aborted ? null : classifyError(err))
					finish(err)
					client.end()
				}
			})
			opts.signal?.addEventListener('abort', onAbort, { once: true })
			try {
				client.connect(this.buildConfig())
			} catch (err) {
				onError(err)
				client.end()
			}
		})
	}

	/** Detect the remote platform once per connection. */
	async detectPlatform(opts = {}) {
		opts.signal?.throwIfAborted()
		try {
			const r = await this.execRaw('uname -s', opts)
			const out = String(r.stdout || '').trim().toLowerCase()
			this.platform = out.includes('mingw') || out.includes('windows') ? 'windows' : 'posix'
		} catch {
			opts.signal?.throwIfAborted()
			try {
				await this.execRaw('ver', opts)
				this.platform = 'windows'
			} catch {
				opts.signal?.throwIfAborted()
				this.platform = 'posix'
			}
		}
		opts.signal?.throwIfAborted()
		return this.platform
	}

	/**
	 * Start one exec channel and hand back a session handle with incremental
	 * callbacks, optional stdin, and a timeout/abort-driven close. Shared by the
	 * buffered {@link execRaw} and the streaming world executors.
	 */
	startExec(command, opts = {}) {
		opts.signal?.throwIfAborted()
		const client = this.client
		if (!client) throw new Error('not connected')
		const timeoutMs = opts.timeoutMs === undefined ? undefined : Math.min(Math.max(Number(opts.timeoutMs) || 30000, 1), 600000)
		return new Promise((resolve, reject) => {
			let opening = true
			let timer = null
			const cleanupOpening = () => {
				opening = false
				if (timer) clearTimeout(timer)
				opts.signal?.removeEventListener('abort', abortOpening)
			}
			const abortOpening = () => {
				if (!opening) return
				cleanupOpening()
				try { opts.onAbort?.() } catch { /* observer only */ }
				reject(abortReason(opts.signal))
			}
			opts.signal?.addEventListener('abort', abortOpening, { once: true })
			const started = Date.now()
			if (timeoutMs !== undefined) {
				timer = setTimeout(() => {
					if (!opening) return
					cleanupOpening()
					reject(Object.assign(new Error('remote exec channel opening timed out'), { code: 'ETIMEDOUT' }))
				}, timeoutMs)
			}
			const opened = (err, stream) => {
				if (!opening) {
					// SSH2 cannot cancel an in-flight channel-open request. Retire a
					// late channel immediately; never retire the shared connection.
					if (stream) { stream.on('error', () => {}); try { stream.close() } catch { /* closed */ } }
					return
				}
				cleanupOpening()
				if (err) return reject(Object.assign(new Error(`remote exec failed: ${err.message}`), { code: 'EXEC' }))
				let settled = false
				let terminalSignal = null
				const session = {
					stream,
					status: 'running',
					code: null,
					signal: null,
					/** Resolves after the SSH channel closes; never rejects. */
					done: null,
					stdoutBytes: 0,
					stderrBytes: 0,
					kill() {
						if (settled || terminalSignal) return false
						terminate('SIGKILL')
						return true
					},
				}
				const finish = (code, signal) => {
					if (settled) return
					settled = true
					if (timer) clearTimeout(timer)
					opts.signal?.removeEventListener('abort', onAbort)
					session.code = code ?? null
					session.signal = signal ?? null
					session.status = signal ? 'killed' : 'completed'
					session.doneResolve()
					try { opts.onClose?.(session) } catch { /* observer only */ }
				}
				const terminate = (signal) => {
					if (settled || terminalSignal) return
					// Preserve the first cause even if close emits inline, but do not
					// resolve done until the channel actually reports closure.
					terminalSignal = signal
					session.status = 'killed'
					if (timer) clearTimeout(timer)
					try { stream.close() } catch { finish(null, signal) }
				}
				const onAbort = () => {
					if (settled || terminalSignal) return
					try { opts.onAbort?.() } catch { /* observer only */ }
					terminate('abort')
				}
				session.done = new Promise((res) => { session.doneResolve = res })
				stream.on('close', (code, signal) => finish(terminalSignal ? null : code, terminalSignal || signal))
				stream.on('data', (d) => {
					if (settled) return
					session.stdoutBytes += d.length
					try { opts.onStdout?.(d) } catch { /* observer only */ }
				})
				stream.stderr.on('data', (d) => {
					if (settled) return
					session.stderrBytes += d.length
					try { opts.onStderr?.(d) } catch { /* observer only */ }
				})
				stream.on('error', (e) => {
					if (settled) return
					session.error = e
					terminate('error')
				})
				if (timeoutMs !== undefined) timer = setTimeout(() => terminate('timeout'), Math.max(1, timeoutMs - (Date.now() - started)))
				opts.signal?.addEventListener('abort', onAbort, { once: true })
				if (opts.signal?.aborted) onAbort()
				if (!settled && opts.stdin !== undefined && opts.stdin !== null) {
					try { stream.end(opts.stdin) } catch { /* channel refused stdin */ }
				}
				// Without stdin, leave it open to avoid discarding unread output.
				resolve(session)
			}
			try { client.exec(command, opened) } catch (err) { cleanupOpening(); reject(err) }
		})
	}

	/** Run one command non-interactively; resolves with code/signal/stdout/stderr. */
	execRaw(command, opts = {}) {
		let stdout = ''
		let stderr = ''
		return this.startExec(command, {
			...opts,
			// Buffered commands have a bounded default; streaming startExec keeps
			// its historical no-deadline default for background jobs.
			timeoutMs: opts.timeoutMs ?? 30000,
			onStdout: (d) => { stdout += d.toString() },
			onStderr: (d) => { stderr += d.toString() },
		}).then(async (session) => {
			await session.done
			if (session.error) throw session.error
			return { code: session.code, signal: session.signal, stdout, stderr }
		})
	}

	/** Command alias used by tools and the UI. */
	exec(command, opts = {}) {
		return this.execRaw(command, opts)
	}

	/**
	 * Obtain the connection's shared SFTP channel (lazily opened, reused for
	 * every operation). A dead channel is dropped so the next call reopens.
	 */
	sftp() {
		if (this._sftp && this._sftpAlive) return Promise.resolve(this._sftp)
		if (this._sftpOpening) return this._sftpOpening
		const client = this.client
		if (!client) return Promise.reject(new Error('not connected'))
		const pending = new Promise((resolve, reject) => {
			client.sftp((err, sftp) => {
				if (err) return reject(err)
				if (this.client !== client) { releaseChannel(sftp); reject(new Error('connection closed')); return }
				this._sftp = sftp
				this._sftpAlive = true
				const retire = () => {
					if (this._sftp !== sftp) return
					this._sftp = null
					this._sftpAlive = false
				}
				sftp.on('close', retire)
				sftp.on('error', retire)
				resolve(sftp)
			})
		})
		this._sftpOpening = pending
		const clear = () => { if (this._sftpOpening === pending) this._sftpOpening = null }
		pending.then(clear, clear)
		return pending
	}

	/**
	 * Legacy calls reuse the shared SFTP channel. Cancellable calls own a fresh
	 * channel so abort can close their work without interrupting other callers.
	 * Resource-creating/committing operations can retain that channel until ACK
	 * with the callback's holdAbortClose hook; request-level cancellation is separate.
	 */
	async withSftp(opts, operation) {
		const signal = opts?.signal
		signal?.throwIfAborted()
		if (!signal) return operation(await this.sftp(), () => {})
		const client = this.client
		if (!client) throw new Error('not connected')
		const { sftp, closed } = await new Promise((resolve, reject) => {
			let settled = false
			const onAbort = () => {
				settled = true
				signal.removeEventListener('abort', onAbort)
				reject(abortReason(signal))
			}
			signal.addEventListener('abort', onAbort, { once: true })
			try {
				client.sftp((err, channel) => {
					if (settled) { releaseChannel(channel); return }
					settled = true
					signal.removeEventListener('abort', onAbort)
					if (err) reject(err)
					else {
						channel.on('error', () => {})
						const closed = new Promise((done) => channel.once('close', done))
						resolve({ sftp: channel, closed })
					}
				})
			} catch (err) {
				settled = true
				signal.removeEventListener('abort', onAbort)
				reject(err)
			}
		})
		let released = false
		const onAbort = () => {
			if (released) return
			released = true
			releaseChannel(sftp)
		}
		signal.addEventListener('abort', onAbort, { once: true })
		try {
			signal.throwIfAborted()
			return await operation(sftp, () => signal.removeEventListener('abort', onAbort))
		} finally {
			signal.removeEventListener('abort', onAbort)
			onAbort()
			await closed
		}
	}

	/** Resolve a remote path through SFTP (symlinks collapsed). */
	realpath(path, opts = {}) {
		return this.withSftp(opts, (sftp) => sftpCall(sftp, 'realpath', [path], opts.signal))
	}

	/** The remote home directory, cached after the first lookup. */
	async home(opts = {}) {
		opts.signal?.throwIfAborted()
		if (!this.homePath) this.homePath = await this.realpath('.', opts)
		return this.homePath
	}

	/** Read a remote text file (UTF-8). */
	readFile(path, opts = {}) {
		return this.withSftp(opts, async (sftp) => String(await sftpCall(sftp, 'readFile', [path, { encoding: 'utf8' }], opts.signal)))
	}

	/** Write a remote text file (UTF-8). */
	writeFile(path, content, opts = {}) {
		return this.withSftp(opts, async (sftp) => {
			await sftpCall(sftp, 'writeFile', [path, content], opts.signal)
			return true
		})
	}

	/** Read a remote file as raw bytes (binary-safe). */
	readFileBytes(path, opts = {}) {
		return this.withSftp(opts, (sftp) => sftpCall(sftp, 'readFile', [path], opts.signal))
	}

	/** Stat a remote path (follows symlinks); resolves ssh2 Stats. */
	statPath(path, opts = {}) {
		return this.withSftp(opts, (sftp) => sftpCall(sftp, 'stat', [path], opts.signal))
	}

	/** Lstat a remote path (does not follow the final symlink). */
	lstatPath(path, opts = {}) {
		return this.withSftp(opts, (sftp) => sftpCall(sftp, 'lstat', [path], opts.signal))
	}

	/** Read raw ssh2 directory entries ({ filename, longname, attrs }). */
	readDirRaw(path, opts = {}) {
		return this.withSftp(opts, async (sftp) => {
			const list = await sftpCall(sftp, 'readdir', [path], opts.signal)
			return (list || [])
				.map((entry) => (Array.isArray(entry) ? { filename: entry[0], attrs: entry[1] } : entry))
				.filter((entry) => entry.filename !== '.' && entry.filename !== '..')
		})
	}

	/** Open a remote file for streaming reads; resolves { read(buf, off, len, pos), close() }. */
	openReadHandle(path, opts = {}) {
		return new Promise((resolve, reject) => {
			// Keep an operation-owned channel alive until the handle closes, rather
			// than releasing it as soon as open() returns.
			const lifetime = this.withSftp(opts, async (sftp) => {
				const handle = await sftpCall(sftp, 'open', [path, 'r'], opts.signal)
				opts.signal?.throwIfAborted()
				let closed = false
				let finish
				const done = new Promise((res) => { finish = res })
				const onAbort = () => { closed = true; finish() }
				sftp.once('close', onAbort)
				opts.signal?.addEventListener('abort', onAbort, { once: true })
				const close = async () => {
					if (closed) return lifetime
					closed = true
					try { await sftpCall(sftp, 'close', [handle]) } finally { finish(); await lifetime }
				}
				resolve({
					read: async (buffer, offset, length, position) => {
						opts.signal?.throwIfAborted()
						if (closed) throw new Error('SFTP read handle closed')
						const bytesRead = await sftpCall(sftp, 'read', [handle, buffer, offset, length, position], opts.signal)
						return { bytesRead, buffer }
					},
					close,
				})
				try { await done } finally {
					opts.signal?.removeEventListener('abort', onAbort)
					sftp.removeListener('close', onAbort)
				}
			})
			lifetime.catch(reject)
		})
	}

	/**
	 * Stage a sibling file, recheck the caller's guard, then publish by rename.
	 * Replacement uses OpenSSH posix-rename when advertised. Without it the
	 * server may refuse replacement; never unlink the destination to retry.
	 * createIfAbsent relies on the SFTP v3 standard rename no-overwrite contract.
	 * Cancellation stops publication until rename dispatch. Thereafter its ACK
	 * determines the outcome, even when the caller cancels while it is in flight.
	 */
	writeFileAtomic(path, bytes, opts = {}) {
		return this.withSftp(opts, async (sftp, holdAbortClose) => {
			// OPEN creates a resource before its ACK, and rename can commit before
			// its ACK. Keep this owned channel available to learn and clean up those
			// outcomes; cancellable preparation requests still observe opts.signal.
			holdAbortClose()
			const slash = path.lastIndexOf('/')
			const dir = slash < 0 ? '.' : slash === 0 ? '/' : path.slice(0, slash)
			const tmp = `${dir.replace(/\/+$/, '')}/.dsh-remote-tmp-${randomUUID()}`
			const call = (method, ...args) => sftpCall(sftp, method, args, opts.signal)
			let mode = opts.mode
			if (mode === undefined && !opts.createIfAbsent) {
				try {
					const attrs = await call('stat', path)
					if (typeof attrs.mode === 'number') mode = attrs.mode & 0o7777
				} catch (err) {
					if (err.code !== 2 && err.code !== 'ENOENT') throw err
				}
			}
			let staged = false
			let publishing = false
			try {
				// Do not abandon OPEN's ACK on abort: only a successful exclusive
				// open establishes ownership, including success delivered after abort.
				opts.signal?.throwIfAborted()
				const handle = await sftpCall(sftp, 'open', [tmp, 'wx', mode ?? 0o666])
				staged = true
				try {
					opts.signal?.throwIfAborted()
					const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
					await call('write', handle, buffer, 0, buffer.length, 0)
					if (mode !== undefined) await call('fchmod', handle, mode)
					if (sftp._extensions?.['fsync@openssh.com'] === '1') await call('ext_openssh_fsync', handle)
				} finally {
					await sftpCall(sftp, 'close', [handle])
				}
				await opts.beforePublish?.()
				opts.signal?.throwIfAborted()
				const extension = !opts.createIfAbsent && sftp._extensions?.['posix-rename@openssh.com'] === '1'
				try {
					// Commit checkpoint: the request can publish before its ACK, so
					// neither cancellation nor channel retirement may abandon it.
					publishing = true
					await sftpCall(sftp, extension ? 'ext_openssh_rename' : 'rename', [tmp, path])
				} catch (err) {
					if (opts.createIfAbsent) {
						// SFTP v3 reports an existing target as generic FAILURE on
						// many servers; expose a stable EEXIST when it still exists.
						try { await sftpCall(sftp, 'lstat', [path]) } catch { throw err }
						err.code = 'EEXIST'
					}
					throw err
				}
				staged = false
			} catch (err) {
				// Cleanup only a sibling we successfully created; never the target.
				if (staged) await sftpCall(sftp, 'unlink', [tmp]).catch(() => {})
				if (!publishing && opts.signal?.aborted) throw abortReason(opts.signal)
				throw err
			}
		})
	}

	/** Remove one remote file; missing paths remain errors. */
	unlinkFile(path, opts = {}) {
		return this.withSftp(opts, (sftp) => sftpCall(sftp, 'unlink', [path], opts.signal))
	}

	/**
	 * List a remote directory; returns name/type/size/mtime entries sorted
	 * directories-first for direct display in the browser UI.
	 */
	async listDir(path, opts = {}) {
		const entries = await this.readDirRaw(path, opts)
		return entries.map(({ filename: name, attrs }) => ({
			name,
			type: attrs.isDirectory() ? 'directory' : attrs.isSymbolicLink() ? 'symlink' : 'file',
			size: attrs.size ?? null,
			mtime: attrs.mtime ?? null,
		})).sort((a, b) => {
				const ad = a.type === 'directory' ? 0 : 1
				const bd = b.type === 'directory' ? 0 : 1
				if (ad !== bd) return ad - bd
				return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
			})
	}

	/** Close the connection (idempotent). */
	close() {
		releaseChannel(this._sftp)
		this._sftp = null
		this._sftpAlive = false
		this._sftpOpening = null
		this.homePath = null
		try {
			this._connectingClient?.end()
			if (this.client !== this._connectingClient) this.client?.end()
		} catch {
			/* already closed */
		}
		this.client = null
		if (this.state !== 'closed') this.setState('closed', null)
	}
}

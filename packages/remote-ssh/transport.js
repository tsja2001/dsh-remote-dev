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

import { createHash } from 'node:crypto'
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

	/** Establish the connection; resolves with this once the channel is ready. */
	connect() {
		return new Promise((resolve, reject) => {
			this.setState('connecting')
			const client = new Client()
			let settled = false
			const finish = (err, value) => {
				if (settled) return
				settled = true
				if (err) reject(err)
				else resolve(value)
			}
			const onError = (err) => {
				const mismatch = this._hostkeyMismatch
				const classified = mismatch
					? {
							code: 'HOSTKEY',
							...ERROR_TEXT.HOSTKEY,
							detail: `pinned ${mismatch.pinned}, got ${mismatch.seen}`,
							pinned: mismatch.pinned,
							seen: mismatch.seen,
						}
					: classifyError(err)
				this.setState('closed', classified)
				finish(Object.assign(new Error(`ssh connect to ${this.profile.host} failed: ${err.message}`), { classified }))
			}
			client.once('error', onError)
			client.once('ready', () => {
				this.client = client
				// Post-ready failures (network drop, keepalive timeout) retire the
				// connection instead of leaving a zombie in the manager's table.
				client.on('close', () => {
					if (this.client === client) {
						this.client = null
						this.setState('closed', classifyError(new Error('connection closed')))
					}
				})
				client.on('error', () => {
					if (this.client === client) {
						this.client = null
						this.setState('closed', classifyError(new Error('connection error')))
					}
				})
				this.detectPlatform()
					.then(() => {
						this.setState('connected')
						finish(null, this)
					})
					.catch((err) => {
						client.end()
						this.client = null
						this.setState('closed', classifyError(err))
						finish(err)
					})
			})
			try {
				client.connect(this.buildConfig())
			} catch (err) {
				const classified = classifyError(err)
				err.classified = classified
				this.setState('closed', classified)
				finish(err)
			}
		})
	}

	/** Detect the remote platform once per connection. */
	async detectPlatform() {
		try {
			const r = await this.execRaw('uname -s')
			const out = String(r.stdout || '').trim().toLowerCase()
			this.platform = out.includes('mingw') || out.includes('windows') ? 'windows' : 'posix'
		} catch {
			try {
				await this.execRaw('ver')
				this.platform = 'windows'
			} catch {
				this.platform = 'posix'
			}
		}
		return this.platform
	}

	/**
	 * Start one exec channel and hand back a session handle with incremental
	 * callbacks, optional stdin, and a timeout/abort-driven close. Shared by the
	 * buffered {@link execRaw} and the streaming world executors.
	 */
	startExec(command, opts = {}) {
		const client = this.client
		if (!client) throw new Error('not connected')
		const timeoutMs = opts.timeoutMs === undefined ? undefined : Math.min(Number(opts.timeoutMs) || 30000, 600000)
		return new Promise((resolve, reject) => {
			client.exec(command, (err, stream) => {
				if (err) return reject(Object.assign(new Error(`remote exec failed: ${err.message}`), { code: 'EXEC' }))
				let settled = false
				let timer = null
				const session = {
					stream,
					/** 'running' | 'completed' | 'killed' */
					status: 'running',
					code: null,
					signal: null,
					/** Resolves once the channel closes; never rejects. */
					done: null,
					/** Bytes accepted so far, for cap enforcement by callers. */
					stdoutBytes: 0,
					stderrBytes: 0,
					kill() {
						if (settled) return false
						try {
							stream.close()
						} catch {
							/* already closed */
						}
						return true
					},
				}
				const finish = (code, signal) => {
					if (settled) return
					settled = true
					if (timer) clearTimeout(timer)
					if (opts.onAbort) opts.signal?.removeEventListener?.('abort', opts.onAbort)
					session.code = code === undefined ? null : code
					session.signal = signal === undefined ? null : signal
					session.status = signal ? 'killed' : 'completed'
					session.doneResolve?.()
					opts.onClose?.(session)
				}
				session.done = new Promise((res) => { session.doneResolve = res })
				if (timeoutMs !== undefined) {
					timer = setTimeout(() => {
						if (!settled) {
							try { stream.close() } catch { /* already closed */ }
							finish(null, 'timeout')
						}
					}, timeoutMs)
				}
				if (opts.onAbort && opts.signal) {
					if (opts.signal.aborted) {
						try { stream.close() } catch { /* already closed */ }
						finish(null, 'abort')
					} else {
						opts.signal.addEventListener('abort', () => {
							if (settled) return
							opts.onAbort()
							try { stream.close() } catch { /* already closed */ }
							finish(null, 'abort')
						})
					}
				}
				stream.on('close', (code, signal) => finish(code, signal))
				stream.on('data', (d) => {
					if (settled) return
					session.stdoutBytes += d.length
					try { opts.onStdout?.(d) } catch { /* listener errors must not break the channel */ }
				})
				stream.stderr.on('data', (d) => {
					if (settled) return
					session.stderrBytes += d.length
					try { opts.onStderr?.(d) } catch { /* listener errors must not break the channel */ }
				})
				stream.on('error', (e) => {
					if (!settled) {
						session.error = e
						finish(null, 'error')
						reject(Object.assign(new Error(`remote exec stream error: ${e.message}`), { code: 'STREAM' }))
					}
				})
				if (opts.stdin !== undefined && opts.stdin !== null) {
					try {
						stream.end(opts.stdin)
					} catch {
						/* a channel that refused stdin simply runs without it */
					}
				}
				// Without stdin, leave the channel's stdin open: ending it races the
				// remote's pending output (a channel close can discard unread data).
				// Commands that would block reading stdin must be fed via opts.stdin.
				resolve(session)
			})
		})
	}

	/** Run one command non-interactively; resolves with code/signal/stdout/stderr. */
	execRaw(command, opts = {}) {
		let stdout = ''
		let stderr = ''
		return this.startExec(command, {
			...opts,
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
		const client = this.client
		if (!client) return Promise.reject(new Error('not connected'))
		return new Promise((resolve, reject) => {
			client.sftp((err, sftp) => {
				if (err) return reject(err)
				this._sftp = sftp
				this._sftpAlive = true
				// A closed/end event means the channel is gone; reopen on next use.
				sftp.on('close', () => {
					this._sftp = null
					this._sftpAlive = false
				})
				resolve(sftp)
			})
		})
	}

	/** Resolve a remote path through SFTP (symlinks collapsed). */
	realpath(path) {
		return new Promise((resolve, reject) => {
			this.sftp().then((sftp) =>
				sftp.realpath(path, (err, abs) => (err ? reject(err) : resolve(abs))),
			).catch(reject)
		})
	}

	/** The remote home directory, cached after the first lookup. */
	async home() {
		if (!this.homePath) this.homePath = await this.realpath('.')
		return this.homePath
	}

	/** Read a remote text file (UTF-8). */
	async readFile(path) {
		const sftp = await this.sftp()
		return new Promise((resolve, reject) => {
			sftp.readFile(path, { encoding: 'utf8' }, (err, data) => (err ? reject(err) : resolve(String(data))))
		})
	}

	/** Write a remote text file (UTF-8). */
	async writeFile(path, content) {
		const sftp = await this.sftp()
		return new Promise((resolve, reject) => {
			sftp.writeFile(path, content, (err) => (err ? reject(err) : resolve(true)))
		})
	}

	/** Read a remote file as raw bytes (binary-safe). */
	async readFileBytes(path) {
		const sftp = await this.sftp()
		return new Promise((resolve, reject) => {
			sftp.readFile(path, (err, data) => (err ? reject(err) : resolve(data)))
		})
	}

	/** Stat a remote path (follows symlinks); resolves ssh2 Stats. */
	async statPath(path) {
		const sftp = await this.sftp()
		return new Promise((resolve, reject) => {
			sftp.stat(path, (err, stats) => (err ? reject(err) : resolve(stats)))
		})
	}

	/** Lstat a remote path (does not follow the final symlink). */
	async lstatPath(path) {
		const sftp = await this.sftp()
		return new Promise((resolve, reject) => {
			sftp.lstat(path, (err, stats) => (err ? reject(err) : resolve(stats)))
		})
	}

	/** Read raw ssh2 directory entries ({ filename, longname, attrs }). */
	async readDirRaw(path) {
		const sftp = await this.sftp()
		return new Promise((resolve, reject) => {
			sftp.readdir(path, (err, list) => {
				if (err) return reject(err)
				resolve(
					(list || [])
						.map((entry) => (Array.isArray(entry) ? { filename: entry[0], attrs: entry[1] } : entry))
						.filter((entry) => entry.filename !== '.' && entry.filename !== '..'),
				)
			})
		})
	}

	/** Open a remote file for streaming reads; resolves { read(buf, off, len, pos), close() }. */
	async openReadHandle(path) {
		const sftp = await this.sftp()
		return new Promise((resolve, reject) => {
			sftp.open(path, 'r', (err, handle) => {
				if (err) return reject(err)
				resolve({
					read: (buffer, offset, length, position) =>
						new Promise((res, rej) => {
							sftp.read(handle, buffer, offset, length, position, (e, bytesRead, b) =>
								e ? rej(e) : res({ bytesRead, buffer: b }),
							)
						}),
					close: () =>
						new Promise((res) => {
							sftp.close(handle, () => res())
						}),
				})
			})
		})
	}

	/**
	 * Write a remote file atomically: stage a sibling temp file, fsync-close it,
	 * then rename over the target. The remote platform drives the rename
	 * fallback (Windows SFTP rename refuses to replace an existing target).
	 */
	async writeFileAtomic(path, bytes) {
		const sftp = await this.sftp()
		const posix = this.platform !== 'windows'
		const dir = posix ? (path.lastIndexOf('/') > 0 ? path.slice(0, path.lastIndexOf('/')) : '/') : path.split('/').slice(0, -1).join('/')
		const rand = Math.random().toString(36).slice(2, 10)
		const tmp = `${dir.replace(/\/+$/, '')}/.dsh-remote-tmp-${rand}`
		const writeTmp = () =>
			new Promise((resolve, reject) => {
				sftp.writeFile(tmp, bytes, (err) => (err ? reject(err) : resolve()))
			})
		const rename = (from, to) =>
			new Promise((resolve, reject) => {
				sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
			})
		const unlink = (p) =>
			new Promise((resolve) => {
				sftp.unlink(p, () => resolve())
			})
		try {
			await writeTmp()
			try {
				await rename(tmp, path)
			} catch {
				// Standard SFTP rename refuses to replace an existing target on
				// every platform (the atomic posix-rename extension is not always
				// advertised), so clear the target and retry. The stale-version
				// guards above keep concurrent-edit races from slipping through.
				await unlink(path)
				await rename(tmp, path)
			}
		} catch (err) {
			await unlink(tmp).catch(() => {})
			throw err
		}
	}

	/**
	 * List a remote directory; returns name/type/size/mtime entries sorted
	 * directories-first for direct display in the browser UI.
	 */
	async listDir(path) {
		const sftp = await this.sftp()
		const entries = await new Promise((resolve, reject) => {
			sftp.readdir(path, (err, list) => {
				if (err) return reject(err)
				try {
					resolve(
						list.map((entry) => {
							// ssh2 returns [name, attrs] tuples in older versions and
							// { filename, longname, attrs } objects in newer ones.
							const name = Array.isArray(entry) ? entry[0] : entry.filename
							const attrs = Array.isArray(entry) ? entry[1] : entry.attrs
							return {
								name,
								type: attrs.isDirectory() ? 'directory' : attrs.isSymbolicLink() ? 'symlink' : 'file',
								size: attrs.size,
								mtime: attrs.mtime || null,
							}
						}),
					)
				} catch (e) {
					reject(e)
				}
			})
		})
		return entries
			.filter((e) => e.name !== '.' && e.name !== '..')
			.sort((a, b) => {
				const ad = a.type === 'directory' ? 0 : 1
				const bd = b.type === 'directory' ? 0 : 1
				if (ad !== bd) return ad - bd
				return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
			})
	}

	/** Close the connection (idempotent). */
	close() {
		try {
			this.client?.end()
		} catch {
			/* already closed */
		}
		this.client = null
		if (this.state !== 'closed') this.setState('closed', null)
	}
}

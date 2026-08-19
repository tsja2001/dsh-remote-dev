/**
 * Remote-ssh filesystem world plugin.
 *
 * Loaded by an agent-preset composition (a cordis:group with
 * `isolate: { fs: true }`), this plugin provides `ctx.fs` for that realm:
 * a full FileSystem implementation over the plugin's SSH/SFTP transport, so
 * the standard tools (read/write/edit/glob/grep) operate on the remote
 * machine transparently. Paths are the remote machine's own absolute paths,
 * which is what makes the experience feel local.
 *
 * Row shape (absolute path, so the preset loader resolves this file directly):
 *   - id: remote-fs
 *     name: /…/packages/remote-ssh/remote-fs.js
 *     config:
 *       profile: <profile id>
 *       root: <remote absolute directory used as the cwd default>
 */

/** Shared helpers with remote-shell (connection acquisition, platform paths). */
import { worldSupport } from './world-support.js'

/** Binary detection sample, mirroring the local backend's heuristic. */
const BINARY_SAMPLE_BYTES = 8192
/** Default whole-read ceiling (bytes); larger files stream instead. */
const MAX_READ_BYTES = 20 * 1024 * 1024

function fsError(message, code) {
	return Object.assign(new Error(message), { name: 'FsError', code })
}

function isPosix(platform) {
	return platform !== 'windows'
}

/** Normalize a remote path for the detected platform (no symlink resolution). */
function normalizePath(platform, p) {
	if (isPosix(platform)) {
		let out = p
		if (!out.startsWith('/')) out = '/' + out
		const parts = out.split('/')
		const stack = []
		for (const part of parts) {
			if (part === '' || part === '.') continue
			if (part === '..') stack.pop()
			else stack.push(part)
		}
		return '/' + stack.join('/')
	}
	// Windows: forward-slash normalization only; preserve drive/UNC shape.
	let out = String(p || '').replaceAll('\\', '/')
	if (!/^[a-zA-Z]:/.test(out) && !out.startsWith('//')) out = '/' + out.replace(/^\/+/, '')
	const parts = out.split('/')
	const stack = []
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]
		if (part === '' || part === '.') {
			if (i === 0 && parts[0] === '') stack.push('')
			continue
		}
		if (part === '..' && stack.length && !/^[a-zA-Z]:$/.test(stack[stack.length - 1]) && stack[stack.length - 1] !== '') stack.pop()
		else stack.push(part)
	}
	return stack.join('/')
}

function parentOf(platform, p) {
	if (isPosix(platform)) {
		const idx = p.lastIndexOf('/')
		return idx <= 0 ? '/' : p.slice(0, idx)
	}
	if (/^[a-zA-Z]:\/[^/]*$/.test(p) || /^[a-zA-Z]:$/.test(p)) return p
	const idx = p.lastIndexOf('/')
	return idx <= 0 ? p : p.slice(0, idx)
}

function versionOf(attrs, key) {
	const mtime = attrs.mtime instanceof Date ? attrs.mtime.getTime() : Number(attrs.mtime || 0) * 1000
	return `${key}:${Math.trunc(mtime)}:${attrs.size ?? 0}`
}

function typeOf(attrs) {
	if (attrs.isDirectory()) return 'directory'
	if (attrs.isFile()) return 'file'
	return 'other'
}

function typeOfLstat(attrs) {
	if (attrs.isSymbolicLink()) return 'symlink'
	return typeOf(attrs)
}

/** Decode with binary rejection, mirroring the local backend's contract. */
function decodeText(bytes, displayPath) {
	const buf = Buffer.from(bytes)
	if (buf.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
		throw fsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
	}
	return buf.toString('utf8')
}

/** Detect dominant CRLF so edits preserve the file's line-ending style. */
function detectsCrlf(text) {
	const sample = text.slice(0, 4096)
	const crlf = sample.split('\r\n').length - 1
	const lf = sample.split('\n').length - 1 - crlf
	return crlf > lf
}

function toLf(text) {
	return text.replaceAll('\r\n', '\n')
}

function toOriginal(text, crlf) {
	return crlf ? toLf(text).replaceAll('\n', '\r\n') : text
}

/** Count literal non-empty matches of `old` in `text`. */
function countMatches(text, old) {
	if (old === '') return 0
	let count = 0
	let idx = text.indexOf(old)
	while (idx !== -1) {
		count += 1
		idx = text.indexOf(old, idx + old.length)
	}
	return count
}

export class RemoteSshFileSystem {
	/**
	 * @param {object} support - { acquire(), root, isPosix() } from world-support.
	 */
	constructor(support) {
		this.support = support
	}

	get root() {
		return this.support.root
	}

	/** Connection for one operation; throws a friendly error when unreachable. */
	async conn() {
		return this.support.acquire('filesystem')
	}

	/**
	 * The effective cwd for path joins. The fs tools inject the SESSION's
	 * host cwd, which describes the host machine, not this remote world — a
	 * same-spelling directory may even coincidentally exist remotely. Relative
	 * paths therefore always resolve against the bound workspace root (the
	 * VSCode-Remote mental model: the picked directory IS the workspace).
	 */
	async cwdFor(_opts) {
		return this.root
	}

	/* ── identity ─────────────────────────────────────────────────────────── */

	async resolve(path, opts = {}) {
		const conn = await this.conn()
		const platform = await this.support.platformOf(conn)
		const base = await this.cwdFor(opts)
		const joined = joinFor(platform, base, String(path ?? ''))
		const real = await conn.realpath(joined).catch(() => joined)
		const key = normalizePath(platform, real)
		return { targetKey: key, displayPath: key }
	}

	processPath(target) {
		return target.displayPath
	}

	fileUrl(target) {
		const p = target.displayPath
		if (this.support.platformCache === 'windows') {
			return 'file:///' + encodeURIComponent(p.replaceAll('\\', '/')).replaceAll('%3A', ':').replaceAll('%2F', '/')
		}
		return 'file://' + p.split('/').map(encodeURIComponent).join('/').replaceAll('%3A', ':')
	}

	contains(parent, child) {
		const a = String(parent.targetKey || parent)
		const b = String(child.targetKey || child)
		if (a === b) return true
		return b.startsWith(a.endsWith('/') ? a : a + '/')
	}

	/* ── metadata ─────────────────────────────────────────────────────────── */

	async stat(target, signal) {
		if (signal?.aborted) throw fsError('stat aborted', 'FS_ABORTED')
		const conn = await this.conn()
		const attrs = await conn.statPath(String(target.targetKey || target.displayPath)).catch((err) => {
			if (isNotFound(err)) return undefined
			throw mapSftpError(err, 'stat', target.displayPath)
		})
		if (!attrs) return undefined
		return { version: versionOf(attrs, target.targetKey), type: typeOf(attrs), ...attrs.size !== undefined ? { size: attrs.size } : {} }
	}

	async lstat(path, opts = {}, signal) {
		if (signal?.aborted) throw fsError('lstat aborted', 'FS_ABORTED')
		const conn = await this.conn()
		const platform = await this.support.platformOf(conn)
		const joined = joinFor(platform, await this.cwdFor(opts), String(path ?? ''))
		const attrs = await conn.lstatPath(joined).catch((err) => {
			if (isNotFound(err)) return undefined
			throw mapSftpError(err, 'lstat', joined)
		})
		if (!attrs) return undefined
		const key = normalizePath(platform, joined)
		return { version: versionOf(attrs, key), type: typeOfLstat(attrs), ...attrs.size !== undefined ? { size: attrs.size } : {} }
	}

	/* ── reads ────────────────────────────────────────────────────────────── */

	async readText(target, signal) {
		if (signal?.aborted) throw fsError('read aborted', 'FS_ABORTED')
		const conn = await this.conn()
		const bytes = await conn.readFileBytes(String(target.targetKey || target.displayPath)).catch((err) => {
			throw mapSftpError(err, 'read', target.displayPath)
		})
		if (bytes.length > MAX_READ_BYTES) {
			throw fsError(`cannot read "${target.displayPath}": file exceeds ${MAX_READ_BYTES} bytes`, 'FS_TOO_LARGE')
		}
		return decodeText(bytes, target.displayPath)
	}

	async *streamText(target, signal) {
		const conn = await this.conn()
		const handle = await conn.openReadHandle(String(target.targetKey || target.displayPath))
		try {
			let pending = ''
			const chunk = 1 << 16
			let offset = 0
			while (true) {
				if (signal?.aborted) throw fsError('stream aborted', 'FS_ABORTED')
			const buf = await handle.read(Buffer.alloc(chunk), 0, chunk, offset)
			if (buf === undefined || buf.bytesRead <= 0) break
			offset += buf.bytesRead
			pending += buf.buffer.subarray(0, buf.bytesRead).toString('utf8')
			const nl = pending.lastIndexOf('\n')
			if (nl !== -1) {
				const out = pending.slice(0, nl)
				pending = pending.slice(nl + 1)
				for (const line of out.split('\n')) yield line
			}
			}
			if (pending !== '') {
				for (const line of pending.split('\n')) yield line
			}
		} finally {
			try { await handle.close() } catch { /* best effort */ }
		}
	}

	async readBytes(target, signal, maxBytes) {
		if (signal?.aborted) throw fsError('read aborted', 'FS_ABORTED')
		const conn = await this.conn()
		const bytes = await conn.readFileBytes(String(target.targetKey || target.displayPath)).catch((err) => {
			throw mapSftpError(err, 'read', target.displayPath)
		})
		const limit = Math.max(1, Number(maxBytes) || bytes.length)
		return new Uint8Array(bytes.subarray(0, limit))
	}

	async listDir(target, signal) {
		if (signal?.aborted) throw fsError('listDir aborted', 'FS_ABORTED')
		const conn = await this.conn()
		const entries = await conn.readDirRaw(String(target.targetKey || target.displayPath))
		return entries.map((entry) => ({
			name: entry.filename,
			type: typeOf(entry.attrs),
			target: { targetKey: normalizePath(this.support.platformCache || 'posix', joinRaw(this.support.platformCache || 'posix', String(target.targetKey || target.displayPath), entry.filename)), displayPath: normalizePath(this.support.platformCache || 'posix', joinRaw(this.support.platformCache || 'posix', String(target.targetKey || target.displayPath), entry.filename)) },
			...entry.attrs.size !== undefined ? { size: entry.attrs.size } : {},
			version: versionOf(entry.attrs, entry.filename),
		})).sort((a, b) => a.name.localeCompare(b.name))
	}

	/* ── writes ───────────────────────────────────────────────────────────── */

	async writeText(target, content, expected, signal, _sandboxPolicy) {
		if (signal?.aborted) throw fsError('write aborted', 'FS_ABORTED')
		const conn = await this.conn()
		const path = String(target.targetKey || target.displayPath)
		const before = await conn.readFileBytes(path).catch((err) => {
			if (isNotFound(err)) return null
			if (isNotDirectory(err)) return null
			throw mapSftpError(err, 'read', target.displayPath)
		})
		let beforeText = null
		if (before !== null) {
			if (expected?.kind === 'createIfAbsent') {
				throw fsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
			}
			try {
				beforeText = decodeText(before, target.displayPath)
			} catch {
				beforeText = null
			}
			if (expected?.kind === 'replaceIfVersion') {
				const attrs = await conn.statPath(path)
				const current = versionOf(attrs, path)
				if (current !== expected.version) {
					throw fsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
				}
			}
		} else if (expected?.kind === 'replaceIfVersion') {
			throw fsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
		}
		const crlf = beforeText !== null && detectsCrlf(beforeText)
		await conn.writeFileAtomic(path, Buffer.from(toOriginal(String(content ?? ''), crlf), 'utf8'))
		const attrs = await conn.statPath(path)
		return {
			operation: before === null ? 'create' : 'update',
			version: versionOf(attrs, path),
			before: beforeText === null ? null : toLf(beforeText),
			after: toLf(String(content ?? '')),
		}
	}

	async editText(target, edit, expected, signal, _sandboxPolicy) {
		if (signal?.aborted) throw fsError('edit aborted', 'FS_ABORTED')
		if (edit?.oldString === '' ) {
			throw fsError(`cannot edit "${target.displayPath}": old_string is empty`, 'FS_AMBIGUOUS_EDIT')
		}
		const conn = await this.conn()
		const path = String(target.targetKey || target.displayPath)
		const bytes = await conn.readFileBytes(path).catch((err) => {
			if (isNotFound(err)) throw fsError(`cannot edit "${target.displayPath}": file not found`, 'FS_NOT_FOUND')
			throw mapSftpError(err, 'read', target.displayPath)
		})
		const crlf = detectsCrlfBytes(bytes)
		const original = decodeText(bytes, target.displayPath)
		const normalized = toLf(original)
		if (expected?.kind === 'replaceIfVersion') {
			const attrs = await conn.statPath(path)
			if (versionOf(attrs, path) !== expected.version) {
				throw fsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
			}
		}
		const count = countMatches(normalized, edit.oldString)
		if (count === 0) {
			throw fsError(`cannot edit "${target.displayPath}": old_string not found in file`, 'FS_EDIT_NOT_FOUND')
		}
		if (count > 1 && !edit.replaceAll) {
			throw fsError(`cannot edit "${target.displayPath}": old_string appears ${count} times; make it unique or request replace_all`, 'FS_AMBIGUOUS_EDIT')
		}
		const edited = edit.replaceAll
		? normalized.split(edit.oldString).join(edit.newString)
		: normalized.replace(edit.oldString, edit.newString)
		const stored = toOriginal(edited, crlf)
		await conn.writeFileAtomic(path, Buffer.from(stored, 'utf8'))
		const attrs = await conn.statPath(path)
		return { version: versionOf(attrs, path), before: normalized, after: edited }
	}
}

/** CRLF detection over raw bytes without a full decode round-trip. */
function detectsCrlfBytes(bytes) {
	const sample = Buffer.from(bytes.subarray(0, 8192)).toString('utf8')
	return detectsCrlf(sample)
}

function isNotFound(err) {
	const code = err?.code ?? err?.message
	return code === 2 || code === 'ENOENT' || /no such file/i.test(String(err?.message || ''))
}

function isNotDirectory(err) {
	const code = err?.code ?? err?.message
	return code === 20 || code === 'ENOTDIR' || /not a directory/i.test(String(err?.message || ''))
}

function mapSftpError(err, op, displayPath) {
	if (isNotFound(err)) return fsError(`${op} "${displayPath}": no such file or directory`, 'FS_NOT_FOUND')
	if (err?.code === 13 || /permission/i.test(String(err?.message || ''))) {
		return fsError(`${op} "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED')
	}
	return fsError(`${op} "${displayPath}": ${err?.message || 'remote I/O failure'}`, 'FS_IO_ERROR')
}

/** Join for the platform without resolving symlinks. */
function joinFor(platform, base, p) {
	if (isPosix(platform)) {
		if (p.startsWith('/')) return normalizePath(platform, p)
		if (p === '' || p === '.') return normalizePath(platform, base)
		return normalizePath(platform, base.replace(/\/+$/, '') + '/' + p)
	}
	const np = String(p || '').replaceAll('\\', '/')
	if (/^[a-zA-Z]:/.test(np) || np.startsWith('//')) return normalizePath(platform, np)
	return normalizePath(platform, base.replace(/\/+$/, '') + '/' + np)
}

function joinRaw(platform, base, name) {
	return base.replace(/\/+$/, '') + '/' + name
}

/**
 * Plugin entry: provide `ctx.fs` in the calling (isolated) realm.
 * @param {object} ctx - cordis context of the preset row.
 * @param {object} config - { profile, root } baked by the authoring RPC.
 */
export function apply(ctx, config = {}) {
	const support = worldSupport(ctx, config)
	const fs = new RemoteSshFileSystem(support)
	const dispose = ctx.provide('fs', fs)
	ctx.effect(() => dispose)
}

export default { apply }

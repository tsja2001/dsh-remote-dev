/**
 * Remote filesystem provider for an isolated agent-preset world. All paths and
 * I/O belong to the remote machine; host paths have no implicit remote mapping.
 */
import { FsError } from '@deepseek-ai/dsh-fs'
import { applyHunks } from '@deepseek-ai/dsh-fs-patch'
import { worldSupport } from './world-support.js'

const BINARY_SAMPLE_BYTES = 8192
const READ_CHUNK_BYTES = 64 * 1024
const DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024

// Worlds sharing a connection also share locks and local mutation revisions.
// SFTP v3 timestamps have second precision: revisions distinguish our own
// equal-size writes in one second. External freshness still has server precision.
const connectionStates = new WeakMap()
function stateOf(conn) {
	let state = connectionStates.get(conn)
	if (!state) {
		state = { locks: new Map(), revisions: new Map() }
		connectionStates.set(conn, state)
	}
	return state
}

function fsError(message, code) {
	return new FsError(message, code)
}

function throwIfAborted(signal, verb) {
	if (signal?.aborted) throw fsError(`${verb} aborted`, 'FS_ABORTED')
}

function pathOf(target) {
	return String(target.targetKey || target.displayPath)
}

function isPosix(platform) {
	return platform !== 'windows'
}

/** Normalize the canonical remote spelling, never using the host's path API. */
function normalizePath(platform, path) {
	const p = isPosix(platform) ? String(path) : String(path).replaceAll('\\', '/')
	const unc = !isPosix(platform) && p.startsWith('//')
	const drive = !isPosix(platform) && /^[a-zA-Z]:/.test(p) ? p.slice(0, 2) : ''
	const prefix = unc ? '//' : drive ? drive + '/' : '/'
	const parts = (drive ? p.slice(2) : p).split('/')
	const stack = []
	for (const part of parts) {
		if (part === '' || part === '.') continue
		if (part === '..') {
			// UNC server/share components form the root, like a drive root.
			if (stack.length > (unc ? 2 : 0)) stack.pop()
		} else stack.push(part)
	}
	return prefix + stack.join('/')
}

function parentOf(platform, path) {
	const p = normalizePath(platform, path)
	const idx = p.lastIndexOf('/')
	if (!isPosix(platform) && /^[a-zA-Z]:\/$/.test(p)) return p
	if (!isPosix(platform) && /^\/\/[^/]+\/[^/]+$/.test(p)) return p
	return idx <= 0 ? '/' : /^[a-zA-Z]:$/.test(p.slice(0, idx)) ? p.slice(0, idx + 1) : p.slice(0, idx)
}

function joinFor(platform, base, path) {
	const p = isPosix(platform) ? path : path.replaceAll('\\', '/')
	if (isPosix(platform) ? p.startsWith('/') : /^[a-zA-Z]:/.test(p) || p.startsWith('//')) return p
	return base.replace(/\/+$/, '') + '/' + p
}

function versionOf(conn, attrs, key) {
	const mtime = attrs.mtime instanceof Date ? attrs.mtime.getTime() : Number(attrs.mtime || 0) * 1000
	return `${key}:${Math.trunc(mtime)}:${attrs.size ?? 0}:${attrs.mode ?? ''}:${stateOf(conn).revisions.get(key) ?? 0}`
}

function bumpVersion(conn, key) {
	const revisions = stateOf(conn).revisions
	revisions.set(key, (revisions.get(key) ?? 0) + 1)
}

function typeOf(attrs) {
	if (attrs.isDirectory()) return 'directory'
	if (attrs.isFile()) return 'file'
	return 'other'
}

function infoOf(conn, attrs, key) {
	return { version: versionOf(conn, attrs, key), type: typeOf(attrs), ...(attrs.size !== undefined ? { size: attrs.size } : {}) }
}

function decodeUtf8(bytes, displayPath, decoder) {
	try {
		return decoder ? decoder.decode(bytes, { stream: bytes !== undefined }) : new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch (err) {
		if (!(err instanceof TypeError)) throw err
		throw fsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
	}
}

function decodeText(bytes, displayPath, editing = false) {
	const sample = editing ? bytes : bytes.subarray(0, BINARY_SAMPLE_BYTES)
	if (sample.includes(0)) throw fsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
	return decodeUtf8(bytes, displayPath)
}

function detectsCrlf(text) {
	const sample = text.slice(0, 4096)
	const crlf = sample.split('\r\n').length - 1
	return crlf > sample.split('\n').length - 1 - crlf
}

function toLf(text) {
	return text.replaceAll('\r\n', '\n')
}

function toOriginal(text, crlf) {
	return crlf ? toLf(text).replaceAll('\n', '\r\n') : text
}

function isNotFound(err) {
	return err?.code === 2 || err?.code === 'ENOENT' || /no such file/i.test(String(err?.message || ''))
}

function isNotDirectory(err) {
	return err?.code === 20 || err?.code === 'ENOTDIR' || /not a directory/i.test(String(err?.message || ''))
}

function mapSftpError(err, op, displayPath) {
	if (err instanceof FsError) return err
	if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') return fsError(`${op} aborted`, 'FS_ABORTED')
	if (isNotFound(err) || isNotDirectory(err)) return fsError(`${op} "${displayPath}": not found`, 'FS_NOT_FOUND')
	if ([3, 13, 'EACCES', 'EPERM'].includes(err?.code) || /permission/i.test(String(err?.message || ''))) {
		return fsError(`${op} "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED')
	}
	if (err?.code === 'EISDIR') return fsError(`${op} "${displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
	if (err?.code === 'EEXIST' || err?.code === 11) return fsError(`${op} "${displayPath}": already exists`, 'FS_ALREADY_EXISTS')
	return fsError(`${op} "${displayPath}": ${err?.message || 'remote I/O failure'}`, 'FS_IO_ERROR')
}

/** readText reads the full file like the host; use streamText for large files. */
export class RemoteSshFileSystem {
	constructor(support) {
		this.support = support
		Object.defineProperties(this, {
			profileId: { value: support.profileId, enumerable: true },
			root: { value: support.root, enumerable: true },
		})
	}

	get sandboxMode() { return undefined }

	async conn(signal) {
		throwIfAborted(signal, 'filesystem')
		try { return await this.support.acquire('filesystem', { signal }) }
		catch (err) {
			throwIfAborted(signal, 'filesystem')
			throw err
		}
	}

	async watch(_target, _changed, signal) {
		signal?.throwIfAborted()
		throw fsError('Filesystem watching is not supported by this provider.', 'FS_IO_ERROR')
	}

	processPathFromHostPath(_hostPath) { return undefined }

	// Only the original host anchor maps to the remote root. A working-directory
	// provider may supply a different, explicitly validated remote cwd thereafter.
	async cwdFor(opts = {}, conn, platform, signal = opts.signal) {
		const cwd = opts.cwd
		if (!cwd || cwd === this.support.anchor || cwd === this.root) return this.root
		const absolute = isPosix(platform) ? cwd.startsWith('/') : /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith('//') || cwd.startsWith('\\\\')
		if (!absolute) throw fsError(`cannot resolve cwd "${cwd}": expected an absolute remote directory`, 'FS_NOT_DIRECTORY')
		try {
			const attrs = await conn.statPath(cwd, { signal })
			throwIfAborted(signal, 'resolve')
			if (!attrs.isDirectory()) throw fsError(`cannot resolve cwd "${cwd}": not a directory`, 'FS_NOT_DIRECTORY')
			const canonical = await conn.realpath(cwd, { signal })
			throwIfAborted(signal, 'resolve')
			return normalizePath(platform, canonical)
		} catch (err) { throw mapSftpError(err, 'resolve cwd', cwd) }
	}

	async resolve(path, opts = {}) {
		throwIfAborted(opts.signal, 'resolve')
		if (typeof path !== 'string' || path.trim() === '') throw fsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
		const conn = await this.conn(opts.signal)
		const platform = await this.support.platformOf(conn)
		const absolute = isPosix(platform) ? path.startsWith('/') : /^[a-zA-Z]:/.test(path) || path.startsWith('//') || path.startsWith('\\\\')
		const base = absolute ? this.root : await this.cwdFor(opts, conn, platform)
		const joined = joinFor(platform, base, path)
		let candidate = joined
		const missing = []
		while (true) {
			throwIfAborted(opts.signal, 'resolve')
			try {
				const real = await conn.realpath(candidate, { signal: opts.signal })
				throwIfAborted(opts.signal, 'resolve')
				const key = normalizePath(platform, real.replace(/\/+$/, '') + (missing.length ? '/' + missing.join('/') : ''))
				return { targetKey: key, displayPath: key }
			} catch (err) {
				if (!isNotFound(err)) throw mapSftpError(err, 'resolve', joined)
				const parent = parentOf(platform, candidate)
				if (parent === candidate) throw mapSftpError(err, 'resolve', joined)
				missing.unshift(candidate.slice(candidate.lastIndexOf('/') + 1))
				candidate = parent
			}
		}
	}

	processPath(target) { return pathOf(target) }

	fileUrl(target) {
		const p = this.processPath(target)
		if (this.support.platformCache === 'windows') {
			return (p.startsWith('//') ? 'file:' : 'file:///') + p.split('/').map(encodeURIComponent).join('/').replaceAll('%3A', ':')
		}
		return 'file://' + p.split('/').map(encodeURIComponent).join('/')
	}

	contains(parent, child) {
		const a = pathOf(parent)
		const b = pathOf(child)
		return a === b || b.startsWith(a.endsWith('/') ? a : a + '/')
	}

	async probe(conn, target, signal) {
		throwIfAborted(signal, 'stat')
		let attrs
		try { attrs = await conn.statPath(pathOf(target), { signal }) }
		catch (err) {
			if (!isNotFound(err) && !isNotDirectory(err)) throw mapSftpError(err, 'stat', target.displayPath)
		}
		throwIfAborted(signal, 'stat')
		return attrs
	}

	async stat(target, signal) {
		throwIfAborted(signal, 'stat')
		const conn = await this.conn(signal)
		const attrs = await this.probe(conn, target, signal)
		return attrs ? infoOf(conn, attrs, pathOf(target)) : undefined
	}

	async lstat(path, opts = {}, signal) {
		throwIfAborted(signal, 'lstat')
		const conn = await this.conn(signal)
		const platform = await this.support.platformOf(conn)
		if (typeof path !== 'string' || path.trim() === '') throw fsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
		const absolute = isPosix(platform) ? path.startsWith('/') : /^[a-zA-Z]:/.test(path) || path.startsWith('//') || path.startsWith('\\\\')
		const base = absolute ? this.root : await this.cwdFor(opts, conn, platform, signal)
		const joined = joinFor(platform, base, path)
		let attrs
		try { attrs = await conn.lstatPath(joined, { signal }) }
		catch (err) {
			if (!isNotFound(err) && !isNotDirectory(err)) throw mapSftpError(err, 'lstat', joined)
		}
		throwIfAborted(signal, 'lstat')
		if (!attrs) return undefined
		return { ...infoOf(conn, attrs, normalizePath(platform, joined)), type: attrs.isSymbolicLink() ? 'symlink' : typeOf(attrs) }
	}

	async regularFile(conn, target, signal) {
		const attrs = await this.probe(conn, target, signal)
		if (!attrs) throw fsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
		if (!attrs.isFile()) throw fsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
		return attrs
	}

	/** Bounded descriptor reads also detect growth after the metadata preflight. */
	async readWindow(conn, target, offset, length, signal) {
		throwIfAborted(signal, 'read')
		if (length === 0) return Buffer.alloc(0)
		let handle
		let failed = false
		try {
			handle = await conn.openReadHandle(pathOf(target), { signal })
			const chunks = []
			let total = 0
			while (total < length) {
				throwIfAborted(signal, 'read')
				const size = Math.min(READ_CHUNK_BYTES, length - total)
				const result = await handle.read(Buffer.alloc(size), 0, size, offset + total)
				throwIfAborted(signal, 'read')
				if (!result || result.bytesRead <= 0) break
				chunks.push(Buffer.from(result.buffer.subarray(0, result.bytesRead)))
				total += result.bytesRead
			}
			return Buffer.concat(chunks, total)
		} catch (err) {
			failed = true
			throw mapSftpError(err, 'read', target.displayPath)
		} finally {
			if (handle) {
				try { await handle.close() }
				catch (err) { if (!failed) throw mapSftpError(err, 'read', target.displayPath) }
			}
		}
	}

	async readBytes(target, signal, maxBytes) {
		throwIfAborted(signal, 'read')
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw fsError('maxBytes must be a non-negative safe integer', 'FS_IO_ERROR')
		const conn = await this.conn(signal)
		const attrs = await this.regularFile(conn, target, signal)
		if (attrs.size > maxBytes) throw fsError(`cannot read "${target.displayPath}": file exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE')
		const bytes = await this.readWindow(conn, target, 0, maxBytes + 1, signal)
		if (bytes.length > maxBytes) throw fsError(`cannot read "${target.displayPath}": file exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE')
		return bytes
	}

	async readByteRange(target, range, signal) {
		throwIfAborted(signal, 'read')
		if (!Number.isSafeInteger(range?.offset) || range.offset < 0 || !Number.isSafeInteger(range?.length) || range.length < 0
			|| !Number.isSafeInteger(range.offset + range.length)) {
			throw fsError('byte range offset and length must be non-negative safe integers', 'FS_IO_ERROR')
		}
		const conn = await this.conn(signal)
		await this.regularFile(conn, target, signal)
		return this.readWindow(conn, target, range.offset, range.length, signal)
	}

	async readText(target, signal) {
		throwIfAborted(signal, 'read')
		const conn = await this.conn(signal)
		await this.regularFile(conn, target, signal)
		try {
			const bytes = await conn.readFileBytes(pathOf(target), { signal })
			throwIfAborted(signal, 'read')
			return decodeText(bytes, target.displayPath)
		} catch (err) { throw mapSftpError(err, 'read', target.displayPath) }
	}

	async streamText(target, signal) { return this.streamChunks(target, signal) }

	async *streamChunks(target, signal) {
		throwIfAborted(signal, 'read')
		const conn = await this.conn(signal)
		await this.regularFile(conn, target, signal)
		let handle
		let failed = false
		try {
			handle = await conn.openReadHandle(pathOf(target), { signal })
			const decoder = new TextDecoder('utf-8', { fatal: true })
			let offset = 0
			while (true) {
				throwIfAborted(signal, 'read')
				const result = await handle.read(Buffer.alloc(READ_CHUNK_BYTES), 0, READ_CHUNK_BYTES, offset)
				throwIfAborted(signal, 'read')
				if (!result || result.bytesRead <= 0) break
				const bytes = result.buffer.subarray(0, result.bytesRead)
				if (offset < BINARY_SAMPLE_BYTES && bytes.subarray(0, BINARY_SAMPLE_BYTES - offset).includes(0)) {
					throw fsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
				}
				offset += result.bytesRead
				yield decodeUtf8(bytes, target.displayPath, decoder)
			}
			yield decodeUtf8(undefined, target.displayPath, decoder)
		} catch (err) {
			failed = true
			throw mapSftpError(err, 'read', target.displayPath)
		} finally {
			if (handle) {
				try { await handle.close() }
				catch (err) { if (!failed) throw mapSftpError(err, 'read', target.displayPath) }
			}
		}
	}

	async listDir(target, signal) {
		throwIfAborted(signal, 'list')
		const conn = await this.conn(signal)
		const platform = await this.support.platformOf(conn)
		const attrs = await this.probe(conn, target, signal)
		if (!attrs) throw fsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
		if (!attrs.isDirectory()) throw fsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
		try {
			const entries = await conn.readDirRaw(pathOf(target), { signal })
			const result = []
			for (const entry of entries.sort((a, b) => a.filename.localeCompare(b.filename))) {
				throwIfAborted(signal, 'list')
				const child = await this.resolve(joinFor(platform, pathOf(target), entry.filename), { signal })
				const info = entry.attrs.isSymbolicLink() ? await this.probe(conn, child, signal) : entry.attrs
				result.push({ name: entry.filename, type: info ? typeOf(info) : 'other', target: child,
					...(info ? { version: versionOf(conn, info, pathOf(child)) } : {}), ...(info?.isFile() ? { size: info.size } : {}) })
			}
			throwIfAborted(signal, 'list')
			return result
		} catch (err) { throw mapSftpError(err, 'list', target.displayPath) }
	}

	/** Canonical lock ordering prevents opposite-direction moves deadlocking. */
	async withLocks(conn, keys, op) {
		const locks = stateOf(conn).locks
		const ordered = [...new Set(keys)].sort()
		const acquire = async (index) => {
			const key = ordered[index]
			if (key === undefined) return op()
			const run = (locks.get(key) ?? Promise.resolve()).then(() => acquire(index + 1))
			const tail = run.then(() => undefined, () => undefined)
			locks.set(key, tail)
			try { return await run }
			finally { if (locks.get(key) === tail) locks.delete(key) }
		}
		return acquire(0)
	}

	async writeTarget(conn, target, expected, signal) {
		const existing = await this.probe(conn, target, signal)
		if (existing && !existing.isFile()) throw fsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
		if (expected?.kind === 'replaceIfVersion' && (!existing || versionOf(conn, existing, pathOf(target)) !== expected.version)) {
			throw fsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
		}
		if (expected?.kind === 'createIfAbsent' && existing) {
			throw fsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
		}
		return existing
	}

	async requireFile(conn, target, expected, verb, signal) {
		const existing = await this.probe(conn, target, signal)
		if (!existing) throw fsError(`cannot ${verb} "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
		if (!existing.isFile()) throw fsError(`cannot ${verb} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
		if (expected && versionOf(conn, existing, pathOf(target)) !== expected.version) {
			throw fsError(`cannot ${verb} "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
		}
		return existing
	}

	async diffBasis(conn, target, signal) {
		try {
			const info = await this.probe(conn, target, signal)
			if (!info?.isFile() || info.size >= DIFF_BASIS_MAX_BYTES) return null
			const bytes = await this.readWindow(conn, target, 0, DIFF_BASIS_MAX_BYTES, signal)
			if (bytes.length !== info.size || bytes.length >= DIFF_BASIS_MAX_BYTES) return null
			return toLf(decodeText(bytes, target.displayPath, true))
		} catch (err) {
			if (err?.code === 'FS_ABORTED') throw err
			return null
		}
	}

	async originalText(conn, target, signal) {
		try {
			throwIfAborted(signal, 'edit')
			const bytes = await conn.readFileBytes(pathOf(target), { signal })
			throwIfAborted(signal, 'edit')
			const raw = decodeText(bytes, target.displayPath, true)
			return { content: toLf(raw), crlf: detectsCrlf(raw) }
		} catch (err) { throw mapSftpError(err, 'edit', target.displayPath) }
	}

	patchContent(target, before, hunks) {
		const result = applyHunks(before, hunks)
		if (!result.ok) throw fsError(`cannot patch "${target.displayPath}": hunk at patch line ${result.failure.hunkLineNumber} (${result.failure.stage}) does not match`, 'FS_PATCH_MISMATCH')
		return result.after
	}

	async publish(conn, target, content, expected, mode, signal, beforePublish) {
		try {
			await conn.writeFileAtomic(pathOf(target), Buffer.from(content, 'utf8'), {
				createIfAbsent: expected?.kind === 'createIfAbsent', mode: mode === undefined ? undefined : mode & 0o777, signal,
				beforePublish: async () => {
					throwIfAborted(signal, 'write')
					await beforePublish?.()
					throwIfAborted(signal, 'write')
				},
			})
		} catch (err) {
			if (expected?.kind === 'createIfAbsent' && (err?.code === 'EEXIST' || err?.code === 11)) {
				throw fsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
			}
			throw mapSftpError(err, 'write', target.displayPath)
		}
		bumpVersion(conn, pathOf(target))
		// Publication is committed: do not turn a later cancellation into failure.
		const attrs = await this.probe(conn, target)
		return attrs ? versionOf(conn, attrs, pathOf(target)) : `missing:${pathOf(target)}`
	}

	async writeText(target, content, expected, signal, _sandboxPolicy) {
		throwIfAborted(signal, 'write')
		const conn = await this.conn(signal)
		return this.withLocks(conn, [pathOf(target)], async () => {
			throwIfAborted(signal, 'write')
			const existing = await this.writeTarget(conn, target, expected, signal)
			const text = String(content ?? '')
			const before = existing && Buffer.byteLength(text, 'utf8') < DIFF_BASIS_MAX_BYTES ? await this.diffBasis(conn, target, signal) : null
			const version = await this.publish(conn, target, text, expected, existing?.mode, signal,
				() => this.writeTarget(conn, target, expected, signal))
			return { operation: existing ? 'update' : 'create', version, before, after: toLf(text) }
		})
	}

	async editText(target, edit, expected, signal, _sandboxPolicy) {
		throwIfAborted(signal, 'edit')
		const conn = await this.conn(signal)
		return this.withLocks(conn, [pathOf(target)], async () => {
			const existing = await this.requireFile(conn, target, expected, 'edit', signal)
			const original = await this.originalText(conn, target, signal)
			const oldText = toLf(edit.oldString)
			const newText = toLf(edit.newString)
			if (oldText === '') throw fsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
			const count = original.content.split(oldText).length - 1
			if (count === 0) throw fsError(`old_string was not found in "${target.displayPath}"`, 'FS_EDIT_NOT_FOUND')
			if (count > 1 && !edit.replaceAll) throw fsError(`old_string matched ${count} times in "${target.displayPath}"`, 'FS_AMBIGUOUS_EDIT')
			// split/join is literal: replacement strings containing $&/$1 stay literal.
			const after = original.content.split(oldText).join(newText)
			const version = await this.publish(conn, target, toOriginal(after, original.crlf), undefined, existing.mode, signal,
				() => this.requireFile(conn, target, expected, 'edit', signal))
			return { version, before: original.content, after }
		})
	}

	async patchText(target, hunks, expected, signal, _sandboxPolicy) {
		throwIfAborted(signal, 'patch')
		const conn = await this.conn(signal)
		return this.withLocks(conn, [pathOf(target)], async () => {
			const existing = await this.requireFile(conn, target, expected, 'patch', signal)
			const original = await this.originalText(conn, target, signal)
			const after = this.patchContent(target, original.content, hunks)
			const version = await this.publish(conn, target, toOriginal(after, original.crlf), undefined, existing.mode, signal,
				() => this.requireFile(conn, target, expected, 'patch', signal))
			return { version, before: original.content, after }
		})
	}

	async remove(conn, target) {
		try { await conn.unlinkFile(pathOf(target)) }
		catch (err) {
			if (isNotFound(err)) throw fsError(`cannot delete "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
			throw mapSftpError(err, 'delete', target.displayPath)
		}
		bumpVersion(conn, pathOf(target))
	}

	async deleteFile(target, expected, signal, _sandboxPolicy) {
		throwIfAborted(signal, 'delete')
		const conn = await this.conn(signal)
		return this.withLocks(conn, [pathOf(target)], async () => {
			await this.requireFile(conn, target, expected, 'delete', signal)
			const before = await this.diffBasis(conn, target, signal)
			await this.requireFile(conn, target, expected, 'delete', signal)
			throwIfAborted(signal, 'delete')
			await this.remove(conn, target)
			return { before }
		})
	}

	async moveFile(source, destination, options = {}, signal, _sandboxPolicy) {
		throwIfAborted(signal, 'move')
		if (pathOf(source) === pathOf(destination)) throw fsError(`cannot move "${source.displayPath}" to itself`, 'FS_SAME_TARGET')
		const conn = await this.conn(signal)
		return this.withLocks(conn, [pathOf(source), pathOf(destination)], async () => {
			const sourceInfo = await this.requireFile(conn, source, options.expectedSource, 'move', signal)
			const sourceVersion = versionOf(conn, sourceInfo, pathOf(source))
			const existing = await this.writeTarget(conn, destination, options.expectedDestination, signal)
			const original = await this.originalText(conn, source, signal)
			const after = options.hunks === undefined ? original.content : this.patchContent(source, original.content, options.hunks)
			const content = toOriginal(after, original.crlf)
			const before = existing && Buffer.byteLength(content, 'utf8') < DIFF_BASIS_MAX_BYTES ? await this.diffBasis(conn, destination, signal) : null
			await this.requireFile(conn, source, options.expectedSource, 'move', signal)
			throwIfAborted(signal, 'move')
			// Commit checkpoint: after staging starts, finish and report both effects.
			const version = await this.publish(conn, destination, content, options.expectedDestination, sourceInfo.mode, undefined, async () => {
				await this.requireFile(conn, source, { version: sourceVersion }, 'move')
				await this.writeTarget(conn, destination, options.expectedDestination)
			})
			const outcome = { sourceBefore: Buffer.byteLength(original.content, 'utf8') < DIFF_BASIS_MAX_BYTES ? original.content : null,
				destination: { operation: existing ? 'update' : 'create', version, before, after } }
			try {
				// Never delete a changed source after publishing the earlier content.
				await this.requireFile(conn, source, { version: sourceVersion }, 'move')
				await this.remove(conn, source)
			} catch (err) {
				if (!(err instanceof FsError)) throw err
				return { ...outcome, sourceDeleted: false, sourceFailure: { code: err.code, message: err.message } }
			}
			return { ...outcome, sourceDeleted: true }
		})
	}
}

export function apply(ctx, config = {}) {
	const fs = new RemoteSshFileSystem(worldSupport(ctx, config))
	const dispose = ctx.provide('fs', fs)
	ctx.effect(() => dispose)
}

export default { apply }

/**
 * dsh-remote-ssh profile store: a JSON file under
 * `$DSH_HOME/remote/profiles.json` (default `~/.dsh/remote/profiles.json`),
 * written with mode 0600.
 *
 * v0.2 semantics:
 * - every profile is normalized on load (port -> number, paths tilde-expanded,
 *   legacy auth:'agent' migrated to explicit key auth);
 * - saving with a blank password/passphrase keeps the previously stored value
 *   (the browser never receives secrets back, so an untouched field must not
 *   wipe what is on disk);
 * - the file may carry a one-time `.pre-v02.bak` sibling, written before the
 *   first shape migration touches an existing file.
 *
 * SECURITY NOTE: when the credentials service is available (standard dsh
 * compositions), secrets live in credential refs and only blank placeholders
 * remain in this file — see index.js. In minimal compositions the file keeps
 * secrets itself (0600, documented).
 *
 * @module dsh-remote-dev/profiles
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expandTilde, firstExistingDefaultKey } from './transport.js'

export function profilesFile() {
	const home = process.env.DSH_HOME || join(homedir(), '.dsh')
	return join(home, 'remote', 'profiles.json')
}

/** Read + normalize every profile; migrates the stored shape once on change. */
export function loadProfiles() {
	let parsed
	try {
		parsed = JSON.parse(readFileSync(profilesFile(), 'utf8'))
	} catch {
		return []
	}
	if (!Array.isArray(parsed)) return []
	const normalized = parsed.map(normalizeProfile)
	if (JSON.stringify(normalized) !== JSON.stringify(parsed)) {
		backupOnce()
		saveProfiles(normalized)
	}
	return normalized
}

/** Write the whole list durably with 0600 permissions. */
export function saveProfiles(profiles) {
	const file = profilesFile()
	mkdirSync(join(file, '..'), { recursive: true })
	writeFileSync(file, JSON.stringify(profiles, null, 2))
	try {
		chmodSync(file, 0o600)
	} catch {
		/* non-posix filesystem */
	}
}

/** One-time backup before the first v0.2 shape migration rewrites the file. */
function backupOnce() {
	const file = profilesFile()
	const backup = file + '.pre-v02.bak'
	try {
		if (existsSync(file) && !existsSync(backup)) {
			copyFileSync(file, backup)
			chmodSync(backup, 0o600)
		}
	} catch {
		/* best effort — a failed backup must not block the migration */
	}
}

export function nextId() {
	return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Coerce one stored/input profile into the canonical v0.2 shape.
 * Legacy auth:'agent' becomes key auth with the first existing default key.
 */
export function normalizeProfile(input) {
	const port = Number.parseInt(input.port, 10)
	const auth = input.auth === 'key' ? 'key' : input.auth === 'agent' ? 'key' : 'password'
	let keyPath = expandTilde(input.keyPath ?? input.key_path ?? '')
	if (auth === 'key' && input.auth === 'agent' && !keyPath) {
		// agent -> key migration: pin an explicit default key when one exists
		keyPath = firstExistingDefaultKey()
	}
	return {
		id: input.id || nextId(),
		name: String(input.name ?? '').trim() || undefined,
		host: String(input.host ?? '').trim(),
		port: Number.isFinite(port) && port >= 1 && port <= 65535 ? port : 22,
		user: String(input.user ?? '').trim(),
		auth,
		password: input.password || '',
		keyPath,
		passphrase: input.passphrase || '',
		bindPath: String(input.bindPath ?? input.bind_path ?? '').trim(),
		boundAt: input.boundAt || '',
		hostFingerprint: input.hostFingerprint || '',
		createdAt: input.createdAt || new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	}
}

/**
 * Upsert one profile. Blank secrets keep the previously stored values unless
 * the auth method moved away from them; the host fingerprint is kept unless
 * the caller passes a string value (use '' via resetFingerprint to clear).
 */
export function upsertProfile(input) {
	const profiles = loadProfiles()
	const idx = input.id ? profiles.findIndex((p) => p.id === input.id) : -1
	const existing = idx >= 0 ? profiles[idx] : undefined
	const clean = normalizeProfile(input)
	clean.createdAt = existing?.createdAt || clean.createdAt
	if (existing) {
		// blank password on an unchanged password-auth profile keeps the secret
		if (clean.auth === 'password' && existing.auth === 'password' && !clean.password && existing.password) {
			clean.password = existing.password
		}
		// blank passphrase on an unchanged key-auth profile keeps the secret
		if (clean.auth === 'key' && existing.auth === 'key' && !clean.passphrase && existing.passphrase) {
			clean.passphrase = existing.passphrase
		}
		// fingerprint survives form saves that do not carry it
		if (typeof input.hostFingerprint !== 'string' && existing.hostFingerprint) {
			clean.hostFingerprint = existing.hostFingerprint
		}
	}
	// the binding timestamp survives form saves (existing branch above keeps
	// it); a cleared binding clears it; a freshly entered binding stamps now
	if (!clean.bindPath) clean.boundAt = ''
	else if (!clean.boundAt) clean.boundAt = existing?.boundAt || new Date().toISOString()
	if (idx >= 0) profiles[idx] = clean
	else profiles.push(clean)
	saveProfiles(profiles)
	return clean
}

/** Clear the pinned host fingerprint (explicit re-trust after reinstall). */
export function resetFingerprint(id) {
	const profiles = loadProfiles()
	const p = profiles.find((x) => x.id === id)
	if (!p) throw new Error(`profile not found: ${id}`)
	p.hostFingerprint = ''
	p.updatedAt = new Date().toISOString()
	saveProfiles(profiles)
	return p
}

export function deleteProfile(id) {
	saveProfiles(loadProfiles().filter((p) => p.id !== id))
}

/** Manager-owned connection acquisition must not transfer cancellation to another waiter. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { RemoteManager } from '../packages/remote-ssh/index.js'
import { saveProfiles } from '../packages/remote-ssh/profiles.js'
import { waitForSignal } from '../packages/remote-ssh/world-support.js'

const previousHome = process.env.DSH_HOME
const home = await mkdtemp(join(tmpdir(), 'dsh-manager-contract-'))
process.env.DSH_HOME = home
saveProfiles([{ id: 'fixture', name: 'Fixture', host: 'unused.invalid', port: 22, user: 'test', auth: 'password' }])
after(async () => {
	if (previousHome === undefined) delete process.env.DSH_HOME
	else process.env.DSH_HOME = previousHome
	await rm(home, { recursive: true, force: true })
})

function deferred() {
	let resolve, reject
	const promise = new Promise((yes, no) => { resolve = yes; reject = no })
	return { promise, resolve, reject }
}

test('cancelled acquisition never closes a shared live connection', async () => {
	const manager = new RemoteManager()
	let closed = 0
	const conn = { state: 'connected', close() { closed++ } }
	manager.connections.set('fixture', conn)
	const controller = new AbortController()
	controller.abort(new Error('cancelled'))
	await assert.rejects(manager.require('fixture', { signal: controller.signal }), /cancelled/)
	assert.equal(closed, 0)
	assert.equal(await manager.require('fixture'), conn)
	manager.closeAll()
	assert.equal(closed, 1)
})

test('shared acquisition is deduplicated while one caller aborts', async () => {
	const manager = new RemoteManager()
	const ready = deferred()
	let opens = 0
	manager.openConnection = async () => { opens++; return ready.promise }
	const controller = new AbortController()
	const abandoned = manager.connection('fixture', { signal: controller.signal })
	const remaining = manager.connection('fixture')
	controller.abort(new Error('one waiter stopped'))
	await assert.rejects(abandoned, /one waiter stopped/)
	const conn = { state: 'connected' }
	ready.resolve(conn)
	assert.equal(await remaining, conn)
	assert.equal(opens, 1)
	assert.equal(manager.acquiring.size, 0)
	manager.closeAll()
})

test('failed shared acquisition can be retried and preserves caller cancellation', async () => {
	const manager = new RemoteManager()
	manager.openConnection = async () => { throw new Error('connection refused') }
	await assert.rejects(manager.connection('fixture'), /connection refused/)
	assert.equal(manager.acquiring.size, 0)
	const conn = { state: 'connected' }
	manager.openConnection = async () => conn
	assert.equal(await manager.connection('fixture'), conn)
	manager.closeAll()
})

test('shutdown closes preparing and live connections and prevents new acquisition', async () => {
	const manager = new RemoteManager()
	let closed = 0
	manager.connecting.add({ close() { closed++ } })
	manager.connections.set('fixture', { close() { closed++ } })
	manager.closeAll()
	assert.equal(closed, 2)
	assert.equal(manager.connecting.size, 0)
	assert.equal(manager.connections.size, 0)
	await assert.rejects(manager.connection('fixture'), /disposed/)
	await assert.rejects(manager.require('fixture'), /disposed/)
	manager.closeAll()
	assert.equal(closed, 2)
})

test('cancelling during credential lookup prevents connection creation', async () => {
	const manager = new RemoteManager()
	const lookup = deferred()
	manager.resolveSecrets = () => lookup.promise
	const controller = new AbortController()
	const work = manager.openConnection({ id: 'fixture' }, { signal: controller.signal })
	controller.abort(new Error('credential lookup cancelled'))
	lookup.resolve({})
	await assert.rejects(work, /credential lookup cancelled/)
	assert.equal(manager.connecting.size, 0)
	assert.equal(manager.connections.size, 0)
	manager.closeAll()
})

test('cancelled shared waiter still consumes a late provider rejection', async () => {
	const work = deferred()
	const controller = new AbortController()
	const waiting = waitForSignal(work.promise, controller.signal)
	controller.abort(new Error('stopped'))
	await assert.rejects(waiting, /stopped/)
	work.reject(new Error('late failure'))
	await new Promise(resolve => setImmediate(resolve))
})

function delayedConnections() {
	const instances = []
	class Connection {
		constructor() { this.gate = deferred(); this.state = 'connecting'; this.closed = 0; this.fingerprint = 'SHA256:test'; instances.push(this) }
		connect() { return this.gate.promise.then(() => { this.state = 'connected' }) }
		close() { this.closed++; this.state = 'closed' }
	}
	return { Connection, instances }
}
const fixtureProfile = () => ({ id: 'late-fixture', name: 'Late fixture', host: 'unused.invalid', port: 22, user: 'test', auth: 'password' })

test('public connect, ad-hoc connect and browse register ownership before their first await', async () => {
	for (const method of ['connect', 'connectAdhoc', 'browse']) {
		const { Connection, instances } = delayedConnections()
		const manager = new RemoteManager({ Connection })
		const profile = await manager.saveProfile(fixtureProfile())
		const work = method === 'connect' ? manager.connect(profile.id)
			: method === 'connectAdhoc' ? manager.connectAdhoc({ profile: profile.id })
				: manager.browse({ id: profile.id })
		manager.disconnect(profile.id)
		await assert.rejects(work, /disconnected/)
		assert.equal(instances.length, 0, method + ' must not allocate after disconnect')
		assert.equal(manager.connections.size, 0)
		manager.closeAll()
	}
})

test('disconnect invalidates pending handshakes before they can publish', async () => {
	const { Connection, instances } = delayedConnections()
	const manager = new RemoteManager({ Connection })
	const work = manager.openConnection(fixtureProfile())
	await new Promise(resolve => setImmediate(resolve))
	await manager.disconnect('late-fixture')
	await assert.rejects(work, /disconnected/)
	instances[0].gate.resolve()
	await new Promise(resolve => setImmediate(resolve))
	assert.equal(manager.connections.has('late-fixture'), false)
	assert.equal(instances[0].closed, 1)
	manager.closeAll()
})

test('deleting an unpinned profile cannot be undone by a late handshake', async () => {
	const { Connection, instances } = delayedConnections()
	const manager = new RemoteManager({ Connection })
	const profile = await manager.saveProfile(fixtureProfile())
	const work = manager.connection(profile.id)
	await new Promise(resolve => setImmediate(resolve))
	await manager.deleteProfile(profile.id)
	await assert.rejects(work, /disconnected/)
	instances[0].gate.resolve()
	await new Promise(resolve => setImmediate(resolve))
	assert.equal(manager.listProfiles().some(entry => entry.id === profile.id), false)
	assert.equal(manager.connections.has(profile.id), false)
	await assert.rejects(manager.openConnection(fixtureProfile()), /deleted/)
	manager.closeAll()
})

test('a superseded connection never replaces the newer successful one', async () => {
	const { Connection, instances } = delayedConnections()
	const manager = new RemoteManager({ Connection })
	const first = manager.openConnection(fixtureProfile())
	await new Promise(resolve => setImmediate(resolve))
	const firstRejected = assert.rejects(first, /superseded/)
	const second = manager.openConnection(fixtureProfile())
	await new Promise(resolve => setImmediate(resolve))
	await firstRejected
	instances[1].gate.resolve()
	assert.equal(await second, instances[1])
	instances[0].gate.resolve()
	await new Promise(resolve => setImmediate(resolve))
	assert.equal(manager.connections.get('late-fixture'), instances[1])
	assert.equal(instances[0].closed, 1)
	manager.closeAll()
})

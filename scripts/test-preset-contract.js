/**
 * Real installed-host registry/Loader integration without opening a profile,
 * starting an agent loop, contacting SSH, or touching the user's DSH home.
 * Run through scripts/run-host-tests.cjs with DSH_HOST_APP set.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Group, Loader } from '@deepseek-ai/cordis-plugin-loader'
import { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import { createScope, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import { RemoteWorkspaces } from '../packages/remote-ssh/workspaces.js'
import { REALM_SERVICES } from '../packages/remote-ssh/presets.js'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-host-presets-')))
const root = new Context()
root.baseUrl = new URL('../packages/remote-ssh/', import.meta.url).href
const local = Object.fromEntries(REALM_SERVICES.map(name => [name, { local: name }]))
for (const [name, service] of Object.entries(local)) root.provide(name, service)
root.provide('sessionProjections', {
	async register() { return { stateOf() { return null } } },
})
root.provide('agents', { turnBoundaryOf() { return { openTurnStartSeq: null, lastTurn: 0 } } })
// Orientation is registered, but prompt assembly/agent driving never starts.
root.provide('systemPrompt', {
	variable() { return () => {} }, section() { return () => {} },
	context() { return () => {} }, getContextOrder() { return 0 },
})
const loaderFiber = root.plugin(Loader, { baseUrl: root.baseUrl })
await loaderFiber.await()
root.loader.builtins.group = Group
const registryFiber = root.plugin(AgentPresetRegistry, { default: 'test-base' })
await registryFiber.await()
const presets = root.agentPresets
const unregisterBase = await presets.register({ id: 'test-base', name: 'Contract base', plugins: [] })
const manager = {
	statusAll() { return [{ id: 'contract', name: 'test-host', host: 'never-contacted.invalid', user: 'offline', port: 22 }] },
	bind() {},
}
let workspaceFiber
let agentScope
let secondScope
let workspaces
try {
	workspaces = new RemoteWorkspaces({ manager, home: () => home })
	workspaceFiber = root.plugin({ async apply(ctx) { await workspaces.attach(ctx) } })
	await workspaceFiber.await()
	const record = await workspaces.create({ profileId: 'contract', root: '/srv/offline-contract' })
	assert.equal(record.composable, true)
	const resolved = await presets.resolve(record.presetId)
	assert.equal(resolved.broken, undefined, resolved.broken)
	const document = await presets.readDocument(record.presetId)
	assert.ok(document.content.includes('remote-subprocess.js'))
	assert.equal('path' in resolved, false)
	console.log('PASS real host readDocument/register installs generated preset')

	agentScope = createScope(root, {})
	await agentScope.ctx.fiber.await()
	const events = []
	const agent = {
		id: 'offline-contract', ctx: agentScope.ctx,
		session: { header: { cwd: record.anchor }, append(type, data) { events.push({ type, data }) } },
	}
	// The actual serial dispatcher is the same awaited boundary used by the
	// host AgentRegistry. Capture services only after this promise settles.
	await root.serial(scopeTarget(root, scopeOf(agent.ctx)), 'agent/created', { agent, source: 'create' })
	assert.equal(presets.composedPreset(agent.ctx), record.presetId)
	for (const name of REALM_SERVICES) {
		const service = presets.serviceFor(agent, name)
		assert.equal(service?.profileId, 'contract', name)
		assert.equal(service?.root, '/srv/offline-contract', name)
		assert.equal(root.get(name), local[name], name + ' must not leak into the Host realm')
	}
	assert.equal(events.at(-1).data.agentPreset, record.presetId)
	assert.deepEqual(presets.inspectCompositions(agent.ctx)[0].leakedServices, [])
	console.log('PASS real host serial agent/created binds four remote services before tool capture')

	await workspaces.refreshPreset(record)
	assert.equal((await presets.resolve(record.presetId)).broken, undefined)
	await workspaces.remove({ id: record.id })
	await workspaceFiber.dispose()
	workspaceFiber = undefined
	await assert.rejects(presets.resolve(record.presetId), /Unknown agent preset/)
	// Registry disposers retire definitions; an existing scoped agent retains
	// its own generation until its binding is disposed.
	assert.equal(presets.serviceFor(agent, 'fs')?.profileId, 'contract')
	await agentScope.dispose()
	agentScope = undefined

	const restored = new RemoteWorkspaces({ manager, home: () => home })
	workspaceFiber = root.plugin({ async apply(ctx) { await restored.attach(ctx) } })
	await workspaceFiber.await()
	assert.equal(restored.list().length, 0)
	assert.equal((await presets.resolve(record.presetId)).broken, undefined)
	secondScope = createScope(root, {})
	await secondScope.ctx.fiber.await()
	await presets.mount(secondScope.ctx, record.presetId)
	const historical = { id: 'historical-contract', ctx: secondScope.ctx,
		session: { header: { cwd: record.anchor }, append() {} } }
	await root.serial(scopeTarget(root, scopeOf(historical.ctx)), 'agent/created', { agent: historical, source: 'resume' })
	assert.equal(presets.serviceFor(historical, 'subprocess')?.profileId, 'contract')
	console.log('PASS real host teardown/reload registers historical preset and retains leased generations')
} finally {
	await secondScope?.dispose()
	await agentScope?.dispose()
	await workspaceFiber?.dispose()
	await unregisterBase()
	await registryFiber.dispose()
	await loaderFiber.dispose()
	await rm(home, { recursive: true, force: true })
}

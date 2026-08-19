/**
 * Remote-ssh orientation plugin (one row of every generated remote-workspace
 * preset).
 *
 * The session's filesystem and shell already run on the remote machine; this
 * row makes the model's ORIENTATION match. Two registrations, both scoped to
 * the preset's standing mount, so nothing here reaches a local session:
 *
 * - `cwd` prompt variable — shadows the global one (which resolves to the
 *   session header's local anchor directory) with the remote root, so every
 *   `{{cwd}}` reference (the shipped persona uses one) names the directory
 *   the tools actually operate in.
 * - one prompt section naming the machine and the root, telling the model
 *   that paths, commands, and relative-path resolution are remote, and that
 *   the local harness environment is not what it is working on.
 */

const SECTION_ORDER = 120

/** Human-readable one-line description of the remote world. */
function describe(config) {
	const label = config.label || config.profile
	const target = config.target || config.root
	return { label, target }
}

/**
 * Plugin entry: orientation for the remote world of this preset.
 * @param {object} ctx - the preset-row cordis context (agent-scoped).
 * @param {object} config - { profile, root, label, target } baked by the authoring RPC.
 */
export function apply(ctx, config = {}) {
	const root = String(config.root || '')
	const { label, target } = describe(config)
	if (!root) throw new Error('remote-context: config.root is required')

	ctx.inject(['systemPrompt'], (promptCtx) => {
		// The header cwd of a remote session is a local anchor directory the
		// registry needs to group the session; it is never where work happens.
		promptCtx.effect(() => promptCtx.systemPrompt.variable('cwd', () => root))
		promptCtx.effect(() => promptCtx.systemPrompt.section({
			name: 'remote-ssh:world',
			order: SECTION_ORDER,
			text: [
				`# Remote workspace (SSH${label ? ': ' + label : ''})`,
				'',
				`This session runs on a remote machine over SSH. Its working directory is \`${root}\``
				+ (target && target !== root ? ` (\`${target}\`).` : '.'),
				'',
				'- Every file tool (read, write, edit, glob, grep) and every shell command'
				+ ' executes on that machine, in that directory. Relative paths resolve'
				+ ' against it.',
				'- The harness itself runs elsewhere. Do not reason about the local machine,'
				+ ' its paths, its installed toolchain, or its environment variables — inspect'
				+ ' the remote one with the tools instead.',
				'- Long-lived state (installed packages, running servers, background jobs)'
				+ ' belongs to the remote machine and survives between commands there.',
			].join('\n'),
		}))
	})
}

export default { apply }

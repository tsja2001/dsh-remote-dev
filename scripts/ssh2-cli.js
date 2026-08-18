#!/usr/bin/env node
/**
 * Standalone JSON-RPC bridge over the ssh2 transport (used by the dynamic
 * demo plugin through `ctx.shell`, and as a manual testing CLI).
 *
 * usage:
 *   node ssh2-cli.js '<base64 profile json>' exec  '<base64 command>' [timeoutMs]
 *   node ssh2-cli.js '<base64 profile json>' read  '<base64 path>'
 *   node ssh2-cli.js '<base64 profile json>' write '<base64 path>' '<base64 content>'
 *   node ssh2-cli.js '<base64 profile json>' list  '<base64 path>'
 *   node ssh2-cli.js '<base64 profile json>' test
 *
 * Prints one JSON line on stdout: { ok: true, ... } or { ok: false, error }.
 */

import { RemoteConnection } from '../packages/remote-ssh/transport.js'

const [, , b64Profile, op, ...rest] = process.argv

if (!b64Profile || !op) {
  console.log(JSON.stringify({ ok: false, error: 'usage: ssh2-cli.js <b64-profile> <op> [args...]' }))
  process.exit(1)
}

function decode(value) {
  return Buffer.from(value, 'base64').toString('utf8')
}

async function main() {
  const profile = JSON.parse(decode(b64Profile))
  const conn = new RemoteConnection(profile)
  await conn.connect()
  try {
    switch (op) {
      case 'exec': {
        const command = decode(rest[0])
        const timeoutMs = Number(rest[1] || 30000)
        const r = await conn.exec(command, { timeoutMs })
        return { ok: true, code: r.code, signal: r.signal, stdout: r.stdout, stderr: r.stderr, platform: conn.platform }
      }
      case 'read': {
        return { ok: true, content: await conn.readFile(decode(rest[0])) }
      }
      case 'write': {
        await conn.writeFile(decode(rest[0]), decode(rest[1]))
        return { ok: true }
      }
      case 'list': {
        return { ok: true, entries: await conn.listDir(decode(rest[0])) }
      }
      case 'test': {
        const r = await conn.exec('echo dsh-remote-ok', { timeoutMs: 10000 })
        return { ok: r.code === 0, platform: conn.platform, echo: String(r.stdout || '').trim(), code: r.code }
      }
      default:
        return { ok: false, error: `unknown op: ${op}` }
    }
  } finally {
    conn.close()
  }
}

main().then(
  (r) => console.log(JSON.stringify(r)),
  (e) => console.log(JSON.stringify({ ok: false, error: String(e?.message || e) })),
)

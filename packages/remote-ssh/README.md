<h1 align="center">dsh-remote-dev</h1>

<p align="center">
  <strong>AI-native SSH remote development for DeepSeek Harness.</strong><br>
  Add a directory on a remote machine as a workspace and develop in it exactly as you would locally—without a remote agent.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-remote-dev"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-remote-dev?logo=npm&color=CB3837"></a>
  <a href="https://www.npmjs.com/package/dsh-remote-dev"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-remote-dev?logo=npm&color=CB3837"></a>
  <a href="https://github.com/tsja2001/dsh-remote-dev/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2ea44f"></a>
  <img alt="Node.js 18 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=nodedotjs&logoColor=white">
</p>

<p align="center">
  English · <a href="https://github.com/tsja2001/dsh-remote-dev/blob/main/README.zh.md">简体中文</a> ·
  <a href="https://github.com/tsja2001/dsh-remote-dev">GitHub</a> ·
  <a href="https://github.com/tsja2001/dsh-remote-dev/blob/main/CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/tsja2001/dsh-remote-ssh/main/docs/images/remote-connections.png" alt="DeepSeek Harness Remote SSH settings UI" width="100%">
</p>

## Install

This is a [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) bundle. Install it through the `dsh` plugin manager:

~~~sh
dsh plugin --profile web add dsh-remote-dev
dsh --profile web
~~~

Using DeepSeek Harness through `npx`? Prefix both commands with `npx @deepseek-ai/dsh`.

Open **Settings → Remote Connections**, add a password or private-key profile, select **Test connection**, save, and connect.

## Remote workspaces

In the sidebar, choose **Add workspace → Remote machines**, pick a machine, browse to a directory, and confirm.

The directory becomes an ordinary workspace row (`app [SSH: buildbox]`). Every session you start
under it reads, writes, edits, globs, greps and runs commands **inside that directory on that
machine** — with the same tools, the same tool cards, and the same relative paths a local
workspace gives you. Nothing has to be installed on the remote host, and no session-by-session
setup is involved: opening an old remote session restores the same remote world.

<details>
<summary>How it works</summary>

A DeepSeek Harness workspace is a real host directory (the registry canonicalizes it through
`fs.realpath` and groups sessions by their header `cwd`), so a `remote://` path can never be one.
The plugin therefore keeps an empty local **anchor** directory per remote root — the stable
identity the sidebar groups by — and puts the actual work on the remote machine by composing the
session from a generated **agent preset** whose `fs` and `shell` services are this plugin's SSH
implementations, published inside one `isolate` realm.

The preset is derived from your default preset rather than hand-listed, so a remote session keeps
every capability a local one has (persona, instructions, skills, todos, plan mode, compaction,
delegation). Rows that would reach the local machine — the host filesystem, the host shell, the
local pty backend — are disabled inside the realm, and `{{cwd}}` resolves to the remote directory.
Editing your default preset regenerates the remote ones on next use.

Removing a remote workspace removes the sidebar row and keeps the generated preset, so existing
sessions of that workspace still open; **Also delete the generated preset** under
*Settings → Remote Connections* is the full cleanup.
</details>

## Why this plugin?

- **Remote workspaces:** a remote directory in the sidebar; sessions under it run their whole file and shell world over SSH.
- **Seven structured model tools:** connect, disconnect, inspect status, execute commands, and read, write, or list remote files — usable from any session, remote workspace or not.
- **Zero remote installation:** the target only needs an SSH server, SFTP, and a login account.
- **Connection manager UI:** profile editing, pre-save probes, status cards, command testing, and an accessible SFTP directory browser.
- **Linux and Windows aware:** platform detection supplies POSIX or `cmd.exe` context to the model.
- **Resilient by design:** keepalives, bounded reconnects, and concise error classification.
- **Security-conscious defaults:** SHA256 host-key pinning, Harness credential storage, same-origin HTTP protection, and no browser secret echo.
- **English and Chinese:** the UI follows the DeepSeek Harness application language.

## Model tools

| Tool | Purpose |
| --- | --- |
| `remote_status` | List profiles, states, platforms, and recent errors. |
| `remote_connect` | Connect with a saved profile or one-off credentials. |
| `remote_disconnect` | Close a profile's live connection. |
| `remote_exec` | Execute a command and return stdout, stderr, exit status, and platform. |
| `remote_read` | Read a UTF-8 text file over SFTP. |
| `remote_write` | Write a complete UTF-8 text file over SFTP. |
| `remote_list` | List directory entries with type, size, and modification time. |

Try:

> Connect to my staging profile, inspect `/srv/app`, run the tests, and explain the failures before changing anything.

The bundle automatically contributes tool guidance to the DeepSeek Harness system prompt.

## Security notes

- The first successful connection pins the server's OpenSSH-style SHA256 fingerprint (TOFU). Future mismatches fail closed. Verify first-use fingerprints out of band for sensitive systems.
- Passwords and passphrases use `ctx.credentials` in standard Harness compositions. Minimal compositions fall back to `~/.dsh/remote/profiles.json` with `0600` permissions.
- Secret values are never returned to the browser. A blank secret during profile editing preserves the stored value.
- The Web bridge accepts same-origin requests only and caps bodies at 1 MiB.
- Commands have the SSH account's permissions. A bound directory is not a sandbox; use a dedicated account, container, or VM when isolation matters.

## Requirements and limits

- Node.js 18+
- DeepSeek Harness developer preview
- A reachable SSH/SFTP target using password or explicit private-key authentication
- UTF-8 text file reads and writes; binary transfer is not yet exposed as a model tool
- Remote workspaces need a composition with an agent-preset roster (the standard Web/CLI ones have it); without one the plugin degrades to the `remote_*` tools
- Inside a remote workspace, persistent-pty tools (`bash` in a kept-alive terminal) are disabled — the remote shell runs one command per call
- No ProxyJump, port forwarding, LSP, remote terminal, or `known_hosts` integration yet

## Documentation

The [GitHub repository](https://github.com/tsja2001/dsh-remote-dev) contains the complete quick start, Windows guidance, security model, Docker test environment, architecture, publishing guide, and contribution instructions.

This is a community-maintained plugin and is not an official DeepSeek AI product.

## License

[MIT](https://github.com/tsja2001/dsh-remote-dev/blob/main/LICENSE) © 2026 dsh-remote contributors

<h1 align="center">@dsh-remote/remote-ssh</h1>

<p align="center">
  <strong>AI-native SSH remote development for DeepSeek Harness.</strong><br>
  Run commands and read, write, or browse files on any SSH-accessible machine—without a remote agent.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dsh-remote/remote-ssh"><img alt="npm version" src="https://img.shields.io/npm/v/%40dsh-remote%2Fremote-ssh?logo=npm&color=CB3837"></a>
  <a href="https://www.npmjs.com/package/@dsh-remote/remote-ssh"><img alt="npm downloads" src="https://img.shields.io/npm/dm/%40dsh-remote%2Fremote-ssh?logo=npm&color=CB3837"></a>
  <a href="https://github.com/tsja2001/dsh-remote-ssh/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2ea44f"></a>
  <img alt="Node.js 18 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=nodedotjs&logoColor=white">
</p>

<p align="center">
  English · <a href="https://github.com/tsja2001/dsh-remote-ssh/blob/main/README.zh.md">简体中文</a> ·
  <a href="https://github.com/tsja2001/dsh-remote-ssh">GitHub</a> ·
  <a href="https://github.com/tsja2001/dsh-remote-ssh/blob/main/CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/tsja2001/dsh-remote-ssh/main/docs/images/remote-connections.png" alt="DeepSeek Harness Remote SSH settings UI" width="100%">
</p>

## Install

This is a [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) bundle. Install it through the `dsh` plugin manager:

~~~sh
dsh plugin --profile web add @dsh-remote/remote-ssh
dsh --profile web
~~~

Using DeepSeek Harness through `npx`? Prefix both commands with `npx @deepseek-ai/dsh`.

Open **Settings → Remote Connections**, add a password or private-key profile, select **Test connection**, save, and connect.

## Why this plugin?

- **Seven structured model tools:** connect, disconnect, inspect status, execute commands, and read, write, or list remote files.
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
- No ProxyJump, port forwarding, LSP, remote terminal, or `known_hosts` integration yet

## Documentation

The [GitHub repository](https://github.com/tsja2001/dsh-remote-ssh) contains the complete quick start, Windows guidance, security model, Docker test environment, architecture, publishing guide, and contribution instructions.

This is a community-maintained plugin and is not an official DeepSeek AI product.

## License

[MIT](https://github.com/tsja2001/dsh-remote-ssh/blob/main/LICENSE) © 2026 dsh-remote contributors

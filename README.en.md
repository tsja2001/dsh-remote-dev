<h1 align="center">DeepSeek Harness Remote Dev</h1>

<p align="center">
  <strong>Connect to an SSH server and develop as if it were a local environment.</strong><br>
  Browse files, edit code, run commands, and test remote projects from DeepSeek Harness—without installing an agent on the target.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-remote-dev"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-remote-dev?logo=npm&color=CB3837"></a>
  <a href="https://github.com/tsja2001/dsh-remote-dev/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/tsja2001/dsh-remote-dev/ci.yml?label=CI"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2ea44a"></a>
</p>

<p align="center">
  <a href="README.md">简体中文</a> · English ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#remote-workspaces">Remote workspaces</a> ·
  <a href="#security-boundary">Security</a>
</p>

<p align="center">
  <img src="截图1.png" alt="Configuring an SSH remote connection in DeepSeek Harness" width="100%">
</p>

<p align="center">
  <img src="截图2.png" alt="Developing in a remote SSH workspace like a local environment" width="100%">
</p>

## What is it?

DeepSeek Harness Remote Dev is an SSH remote-development plugin: connect to any reachable SSH server and add its remote directory directly to a DeepSeek Harness workspace. Like VS Code Remote Development, Claude Code, or Codex remote workflows, the interface runs locally while files, commands, and tests run on the remote machine.

You do not need to install any service on the remote server. The target only needs an SSH server and a login account; Node.js, DeepSeek Harness, and this plugin run on your local machine.

## Highlights

- **Direct SSH access** for Linux, macOS, WSL, and Windows targets.
- **Local-development experience**: after choosing a remote directory, read, write, edit, glob, grep, and bash operate remotely by default.
- **First-class Web UI** for adding, testing, editing, connecting to, and browsing remote machines.
- **Password or key authentication** with explicit private-key paths and host-key verification.
- **AI-native tools** such as remote_connect, remote_exec, remote_read, remote_write, and remote_list for ad-hoc tasks.

## Quick start

Run these commands from your DeepSeek Harness project root:

~~~sh
# Recommended: install and register the plugin through pnpm
pnpm dsh plugin --profile web add dsh-remote-dev

# If dsh is installed as a global command
dsh plugin --profile web add dsh-remote-dev
~~~

### Connect a machine

1. Open **Settings → Remote Connections**.
2. Enter the host, port, username, and authentication method, then select **Test connection** and save.
3. Choose **Add workspace → Remote machines** and pick a remote directory.

The directory appears as an ordinary workspace in the sidebar. Sessions created under it automatically use the remote filesystem and shell.

## Remote workspaces

Remote workspaces are the main workflow:

- the remote directory appears as a normal sidebar workspace, such as app [SSH: buildbox];
- read, write, edit, glob, and grep operate on remote files through SFTP;
- bash runs over SSH with the remote directory as its default working directory;
- relative paths resolve remotely, so the host path is not exposed to the model;
- personas, AGENTS.md, skills, todos, plans, and subagents remain available.

For a one-off command, use the remote_* tools directly without creating a workspace.

## Model tools

| Tool | Purpose |
| --- | --- |
| remote_status | View saved profiles, state, platform, and recent errors |
| remote_connect | Connect a saved profile or one-off host |
| remote_disconnect | Close a connection |
| remote_exec | Run a command over SSH |
| remote_read / remote_write | Read or write UTF-8 text over SFTP |
| remote_list | Browse a remote directory over SFTP |

## Security boundary

- SSH host fingerprints are recorded on first connect and checked later;
- credentials stay in the DeepSeek Harness credential store and are never echoed to the browser;
- commands run with the permissions of the SSH account;
- a bound directory defines workspace behavior, not an operating-system sandbox;
- use a dedicated account, container, or VM for high-risk work.

## Local development

~~~sh
npm ci
npm run test:offline
npm run check
npm run package:check
~~~

Install the checkout into a Web profile:

~~~sh
dsh plugin --profile web add ./packages/remote-ssh
~~~

More information:

- [Remote development design](docs/remote-development-design.md)
- [npm and GitHub publishing](docs/PUBLISHING.md)
- [Handover notes](docs/HANDOVER.md)
- [Changelog](CHANGELOG.md)
- [MIT License](LICENSE)


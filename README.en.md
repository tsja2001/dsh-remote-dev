<h1 align="center">DeepSeek Harness Remote Dev</h1>

<p align="center">
  <strong>Turn a directory on a remote server into a DeepSeek Harness workspace and develop in it like a local one.</strong><br>
  Straight over SSH: browsing, editing, commands and tests all happen on the remote machine — with nothing installed there.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-remote-dev"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-remote-dev?logo=npm&color=CB3837"></a>
  <a href="https://github.com/tsja2001/dsh-remote-dev/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/tsja2001/dsh-remote-dev/ci.yml?label=CI"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2ea44a"></a>
</p>

<p align="center">
  <a href="README.md">简体中文</a> · English ·
  <a href="#install">Install</a> ·
  <a href="#three-steps-to-start">Three steps to start</a> ·
  <a href="#remote-workspaces">Remote workspaces</a> ·
  <a href="#faq">FAQ</a>
</p>

<p align="center">
  <img src="截图1.png" alt="Configuring an SSH remote connection in DeepSeek Harness" width="100%">
</p>

<p align="center">
  <img src="截图2.png" alt="Developing in a remote SSH workspace like a local environment" width="100%">
</p>

## What is it

An **SSH remote development plugin** for DeepSeek Harness. Connect to any machine you can SSH into and add one of its directories as a workspace — every session you start there runs `read` / `write` / `edit` / `glob` / `grep` / `bash` **inside that directory on that machine**.

The experience matches VS Code Remote Development: the UI and the model run locally, the files and commands run remotely.

The remote machine needs **nothing installed** — just an SSH server and an account you can log in with.

## Install

### Option 1: one command (recommended)

~~~sh
npx dsh-remote-dev@latest setup
~~~

Installs into the `web` profile; add `--profile headless` for another one.

The installer prepares the profile directory, records the pnpm build policy, installs, registers the plugin, and verifies it took effect. It is idempotent — after a failed install, run it again to repair.

### Option 2: install with the dsh command

First add two lines to `~/.dsh/profiles/web/pnpm-workspace.yaml`:

~~~yaml
allowBuilds:
  ssh2: false
  cpu-features: false
~~~

Then install as usual:

~~~sh
pnpm dsh plugin --profile web add dsh-remote-dev
# or, with dsh installed globally:
dsh plugin --profile web add dsh-remote-dev
~~~

**What are those two lines for?** This plugin depends on `ssh2`, which carries two **optional** native build scripts (its own `install`, plus node-gyp for the optional `cpu-features`). pnpm 11 fails the entire install over any build script you have not decided about (`ERR_PNPM_IGNORED_BUILDS`). Neither build is needed — ssh2 is a pure JavaScript client that falls back to Node's own crypto — so denying them is the right answer, and it means no C++ toolchain is required. Option 1 does exactly this.

> Want the native accelerator anyway? `npx dsh-remote-dev@latest setup --allow-native` (needs a C++ toolchain).

## Three steps to start

1. Start DeepSeek Harness (`dsh --profile web`), open **Settings → Remote Connections**, enter host, port, username and authentication, select **Test connection**, and save.
2. In the sidebar choose **Add workspace → Remote machines**, pick the machine, browse to the directory, and confirm.
3. The directory appears as a workspace (`app [SSH: buildbox]`). Start a session under it and begin.

## Remote workspaces

This is the main way to use the plugin. In every session under a remote workspace:

- `read` / `write` / `edit` / `glob` / `grep` operate on remote files over SFTP;
- `bash` runs commands over SSH inside the remote directory;
- relative paths resolve against the remote directory and `{{cwd}}` shows it, so the local path never leaks into the model's reasoning;
- persona, AGENTS.md, skills, todos, plan mode and subagents **all remain** — the remote preset is derived from your default preset, not reduced to a handful of tools;
- reopening an old session returns to the same remote environment.

Local workspaces are untouched.

## What you get

| Capability | Detail |
| --- | --- |
| Remote workspaces | A remote directory as a workspace; files and commands run there |
| Connection manager | Add, test, edit, connect and browse machines from Settings |
| Authentication | Password, private key, key passphrase; host fingerprint pinned on first connect |
| Directory browser | Built-in SFTP browser with breadcrumbs and keyboard support |
| Platforms | Linux, macOS, WSL and Windows SSH servers |

For one-off remote work without creating a workspace, the model can call these tools directly:

| Tool | Purpose |
| --- | --- |
| `remote_status` | List profiles, states, platforms and recent errors |
| `remote_connect` / `remote_disconnect` | Open or close a connection |
| `remote_exec` | Run a command over SSH |
| `remote_read` / `remote_write` | Read and write UTF-8 text over SFTP |
| `remote_list` | Browse a remote directory over SFTP |

## FAQ

### Install fails with `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: cpu-features@0.0.10, ssh2@1.17.0`

pnpm 11 refuses to skip a dependency's build scripts silently and exits with a **failure**, so `dsh` never registers the plugin in `dsh.profile.bundles` — the package is downloaded but never loaded.

Run the installer once to repair it (it turns the pending placeholders pnpm wrote into an explicit `false`, reinstalls, and registers the bundle):

~~~sh
npx dsh-remote-dev@latest setup
~~~

Or set both entries under `allowBuilds` in `~/.dsh/profiles/web/pnpm-workspace.yaml` to `false` by hand and run the install command again.

### After installing this plugin, installing **other** plugins fails the same way

Same cause: pnpm re-evaluates the whole profile's dependency graph on every install, so as long as `ssh2` is in it and undecided, every install fails. Once `allowBuilds` is written, every plugin in that profile installs normally again.

### Installed, but there is no "Remote Connections" in Settings

Check that `dsh.profile.bundles` in `~/.dsh/profiles/<name>/package.json` contains `dsh-remote-dev`. If it does not, the install failed halfway — run the installer again.

### Other checks

~~~sh
npx dsh-remote-dev@latest setup --dry-run   # show the changes without making them
npx dsh-remote-dev@latest setup --help      # all options
~~~

## Security boundary

- The first connection pins and verifies the SSH host fingerprint; a mismatch fails closed.
- Passwords and key passphrases live in the DeepSeek Harness credential store and are never echoed to the browser.
- Remote commands carry the permissions of that SSH account.
- A bound directory is workspace semantics, **not** an OS sandbox.
- For risky work, use a dedicated account, a container, or a VM.

## Local development

~~~sh
npm ci
npm run test:offline     # tests that need no SSH server
npm run check            # syntax check
npm run package:check    # pack and install into a clean consumer
~~~

Install the checkout into a Web profile:

~~~sh
./scripts/install.sh     # same as: setup --package ./packages/remote-ssh
~~~

## More

- [Remote development design](docs/remote-development-design.md)
- [Publishing guide](docs/PUBLISHING.md)
- [Maintainer handover](docs/HANDOVER.md)
- [Changelog](CHANGELOG.md)
- [MIT License](LICENSE)

A community-maintained plugin, not an official DeepSeek AI product.

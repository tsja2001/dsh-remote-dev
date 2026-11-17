# DSH 0.2.2-rc.3 compatibility

This change targets the published and Desktop-bundled DSH interfaces at exactly `0.2.2-rc.3`. It does not publish a new npm version or install the plugin into an existing Desktop profile.

## Installation and core identity

Host APIs are optional peers rather than production dependencies. This prevents npm/pnpm from automatically installing obsolete core packages alongside the plugin. Development dependencies pin matching interfaces. `engines.dsh` lets the host reject unsupported runtime versions before enabling the bundle.

`package:check` installs the packed tarball into a fresh consumer, asserts no host core peers were auto-installed, supplies the exact supported host interfaces, reinstalls the tarball and verifies those interfaces were not replaced. `test:installed-profile` additionally creates a fresh profile, installs the tarball and uses the installed Desktop application's actual `ProfileRuntimeResolution` / `PluginPackages` resolver. It verifies the filesystem provider's errors share the host's `FsError` identity; it does not use the forced-module hooks from the unit-contract runner.

## Runtime changes

- The seven standalone tool names are `remote_dev_connect`, `remote_dev_disconnect`, `remote_dev_status`, `remote_dev_exec`, `remote_dev_read`, `remote_dev_write` and `remote_dev_list`. No generic `remote_*` aliases are registered: other remote plugins already own some of those names, and global duplicates abort their startup. Coexistence is tested using the actual host registry in both load orders.

- Tool definitions retain the current property-local `required` DSL. Results are normalized to the strict lossless-JSON schema, including nullable status/exit fields. Tool cancellation is forwarded through acquisition and SSH/SFTP operations.
- Remote filesystem implements range reads, patches, deletes and moves with the current guard contracts. Streaming preserves newlines and UTF-8 boundaries. Bounded byte reads fail on overflow instead of returning a truncated file. Whole-text reads match the current full-file API; callers should stream large text.
- SFTP writes stage exclusively and check guards before publication. They never unlink a destination to retry rename. Cancellation before publication cleans confirmed-owned staging files. Once rename is dispatched, the operation awaits its acknowledgement and reports committed success or the actual publication error, rather than misreporting cancellation after changing the target.
- Shell execution implements `execute()` / `result()`, byte-offset observers, bounded output, expiry policy and awaited disposal. Shared connections survive cancellation of individual operations.
- POSIX subprocess and remote working-directory services route standard search to remote ripgrep, preserve argument boundaries, and maintain durable remote directory changes. Host packaged ripgrep paths are translated only when recognized; arbitrary remote executable paths remain unchanged.
- Presets are registered through the runtime registry and restored during startup. Agent creation awaits remote composition and validates all four execution-world bindings before model/tool work. Failed composition does not continue with local tools. Older kept presets are regenerated through the current declaration API.
- Connection attempts are owned per profile. Disconnect/delete invalidates pending credential lookup and handshakes, and a late result cannot republish a connection or recreate a deleted profile.

## Validation commands

```sh
npm ci --ignore-scripts
npm run check
npm run test:offline
npm run package:check

# Optional gates against an installed macOS Desktop application:
DSH_HOST_APP='/Applications/DeepSeek Harness.app' npm run test:host
DSH_HOST_APP='/Applications/DeepSeek Harness.app' npm run test:installed-profile
```

`npm test` adds the existing SSH transport, manager and filesystem/shell integration suites. Use the documented disposable SSH server, or supply `DSH_TEST_HOST`, `DSH_TEST_PORT`, `DSH_TEST_USER`, `DSH_TEST_KEY` and, for key-only servers, `DSH_TEST_NO_PASSWORD=1`. `DSH_TEST_FILE` selects the transport/manager scratch file; `DSH_TEST_ROOT` selects the world-test directory. The world suite creates/removes files under its root and is intended for a disposable fixture.

The optional `scripts/test-subprocess-ssh.js` gate runs the actual installed-host `runRipgrep` execution helper over real SSH. Run it through `scripts/run-host-tests.cjs`, supply an explicit test key/root, and optionally set `DSH_TEST_REMOTE_PATH` to the remote executable PATH used only by that fixture.

Local validation used macOS arm64, Node 24, Desktop `0.2.2-rc.3`, a separate loopback-only OpenSSH server and generated fixture keys. Successful password authentication was not exercised on that key-only fixture; password rejection was exercised. No personal SSH profile or production server was used, and no model request was sent.

## Limits

- Full workspace process/search support targets POSIX servers; remote `rg` must already be installed. Windows still supports standalone remote tools and SFTP. Windows argv execution, PTYs, separate control channels and raw-output spill are explicitly unsupported.
- Cancellation observes SSH channel closure. It cannot prove that every descendant process on the server has terminated. A lost transport reports unknown remote process state rather than successful quiescence.
- SFTP v3 metadata precision limits detection of external equal-size edits within one timestamp interval. Provider-local revisions distinguish same-connection mutations, but no external compare-and-swap guarantee is claimed.
- Unresolved relative preset declarations/includes are rejected when the registry does not supply their source directory. Unsupported compositions fail explicitly instead of guessing a local execution context.
- Installed-host unit hooks deliberately share host API classes; the separate installed-profile gate verifies the production resolver on a clean profile. It does not claim to repair competing core copies introduced by unrelated plugins.

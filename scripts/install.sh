#!/usr/bin/env bash
# One-command installer for dsh-remote-dev (repo copy).
#
# Published users do not need this file — they run:
#   npx dsh-remote-dev@latest setup
#
# This wrapper installs THIS working copy into a profile, which is what you
# want while developing the plugin.
#
# Usage:
#   ./scripts/install.sh                       # install ./packages/remote-ssh
#   ./scripts/install.sh dsh-remote-dev        # install the published package
#   DSH_PROFILE=headless ./scripts/install.sh  # a different profile
#
# Env: DSH_PROFILE (default web), DSH_HOME (default ~/.dsh), DSH_BIN (dsh command)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pkg="${1:-$here/packages/remote-ssh}"
profile="${DSH_PROFILE:-web}"

# setup.js does the whole job: it records the pnpm build decision the profile
# needs (ssh2 ships an optional native build that pnpm 11 refuses to ignore
# silently), runs `dsh plugin add`, and verifies the bundle is registered.
exec node "$here/packages/remote-ssh/setup.js" setup --profile "$profile" --package "$pkg" "${@:2}"

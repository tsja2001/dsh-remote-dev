#!/usr/bin/env bash
# One-command installer for dsh-remote-ssh.
#
# Usage:
#   ./scripts/install.sh                          # local repo bundle (default)
#   ./scripts/install.sh @tsja/dsh-remote-ssh   # npm-published package
#
# Env: DSH_PROFILE (default web), DSH_HOME (default ~/.dsh)
set -euo pipefail

PKG="${1:-./packages/remote-ssh}"
PROFILE="${DSH_PROFILE:-web}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

echo "== 1/2 installing bundle '$PKG' into profile '$PROFILE'"
dsh plugin --profile "$PROFILE" add "$PKG"

echo "== 2/2 installing agent preset"
mkdir -p "$DSH_HOME/.agent-presets"
cp -r presets/remote-dev "$DSH_HOME/.agent-presets/"

echo
echo "done. Restart the web GUI (or open Settings → Remote Connections)."
echo "The preset will be picked up automatically by the roster on next session creation."

#!/usr/bin/env bash
# Build the distributable plugin zip with the team invite code injected.
# The committed sources carry the current team invite; pass another one here to
# ship a zip bound to a rotated code.
#
#   ./build-plugin.sh <invite-code>
set -euo pipefail

export INVITE="${1:?usage: ./build-plugin.sh <invite-code>}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -R "$ROOT/plugin" "$STAGE/plugin"
cp -R "$ROOT/skills" "$STAGE/skills"
perl -pi -e 's{const INVITE_CODE = "[^"]*";}{const INVITE_CODE = "$ENV{INVITE}";}' "$STAGE/plugin/ui.html"

grep -q "$INVITE" "$STAGE/plugin/ui.html" || { echo "invite injection failed" >&2; exit 1; }

# One version for the build, stamped with the day it was cut: manifest.json is
# where it lives, ui.html only carries a copy so the bridge can announce it.
export PLUGIN_VERSION="1.1.$(date +%Y%m%d)"
perl -pi -e 's{"version": "[^"]*"}{"version": "$ENV{PLUGIN_VERSION}"}' "$STAGE/plugin/manifest.json"
perl -pi -e 's{const PLUGIN_VERSION = "[^"]*";}{const PLUGIN_VERSION = "$ENV{PLUGIN_VERSION}";}' "$STAGE/plugin/ui.html"
perl -pi -e 's{const BUILD_VERSION = "[^"]*";}{const BUILD_VERSION = "$ENV{PLUGIN_VERSION}";}' "$STAGE/plugin/code.js"

grep -q "$PLUGIN_VERSION" "$STAGE/plugin/manifest.json" || { echo "version injection failed (manifest)" >&2; exit 1; }
grep -q "$PLUGIN_VERSION" "$STAGE/plugin/ui.html" || { echo "version injection failed (ui)" >&2; exit 1; }
grep -q "$PLUGIN_VERSION" "$STAGE/plugin/code.js" || { echo "version injection failed (code)" >&2; exit 1; }

(cd "$STAGE" && zip -qr figmate-plugin.zip plugin skills -x "*.DS_Store")
mv "$STAGE/figmate-plugin.zip" "$ROOT/figmate-plugin.zip"
echo "figmate-plugin.zip built (invite injected — the zip itself is gitignored)"

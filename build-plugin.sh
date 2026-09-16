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

# One version for the build, stamped with the day it was cut. It cannot live in
# manifest.json — Figma rejects any key it does not know — so code.js holds it
# and hands it to the UI with the config message.
# BUILD_NO counts builds cut on the same day; pass it when reshipping today.
export PLUGIN_VERSION="1.1.$(date +%Y%m%d).${BUILD_NO:-1}"
perl -pi -e 's{const BUILD_VERSION = "[^"]*";}{const BUILD_VERSION = "$ENV{PLUGIN_VERSION}";}' "$STAGE/plugin/code.js"

grep -q "$PLUGIN_VERSION" "$STAGE/plugin/code.js" || { echo "version injection failed (code)" >&2; exit 1; }

(cd "$STAGE" && zip -qr figmate-plugin.zip plugin skills -x "*.DS_Store")
mv "$STAGE/figmate-plugin.zip" "$ROOT/figmate-plugin.zip"
echo "figmate-plugin.zip built (invite injected — the zip itself is gitignored)"

#!/usr/bin/env bash
#
# Notarise and staple the StreetSignal DMG.
#
# `npm run build:dmg` produces a DMG that is SIGNED (Developer ID Application:
# Inayat Panda (G3RVS73AU3), hardened runtime on) but NOT notarised. Signing
# alone is no longer enough: on macOS 10.15+, Gatekeeper refuses a downloaded
# app whose ticket Apple has never issued, and the user is shown the malware
# wording rather than an "unidentified developer" prompt with a way through.
# So a DMG that leaves this machine for anyone else's must go through here.
#
# ── ONE-TIME SETUP, which only the owner can do ───────────────────────────────
# This script deliberately holds no credentials. It reads them from a keychain
# profile that must be created once, on each Mac that will notarise:
#
#   xcrun notarytool store-credentials streetsignal-notary \
#     --apple-id "<the Apple ID on the Developer Program account>" \
#     --team-id G3RVS73AU3 \
#     --password "<an app-specific password from appleid.apple.com>"
#
# The password is an APP-SPECIFIC password (appleid.apple.com → Sign-In and
# Security → App-Specific Passwords), never the Apple ID password itself. The
# profile is stored in the login keychain; it is not in this repo and must not
# be. `xcrun notarytool history --keychain-profile streetsignal-notary` is the
# quickest way to confirm the profile exists and works.
#
# As of the wave that added this file, no such profile exists on this Mac —
# which is exactly why notarisation is wired up here and left unrun.
#
# ── USING IT ─────────────────────────────────────────────────────────────────
#   scripts/notarize-dmg.sh                       # newest DMG in the bundle dir
#   scripts/notarize-dmg.sh path/to/StreetSignal.dmg
#
# `--wait` blocks until Apple answers (typically a few minutes). On rejection,
# notarytool prints a submission id; `xcrun notarytool log <id>
# --keychain-profile streetsignal-notary` returns the machine-readable reason —
# almost always a binary in the bundle that is unsigned or lacks the hardened
# runtime, so check `codesign -dv --verbose=2` on the .app first.
#
# Stapling is what makes the result work OFFLINE: it writes Apple's ticket into
# the DMG, so a first launch on a machine with no network still passes.

set -euo pipefail

PROFILE="${NOTARY_PROFILE:-streetsignal-notary}"
BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/target/release/bundle/dmg"

DMG="${1:-}"
if [ -z "$DMG" ]; then
  # newest .dmg in the bundle dir — the one `npm run build:dmg` just made
  DMG="$(ls -t "$BUNDLE_DIR"/*.dmg 2>/dev/null | head -1 || true)"
fi

if [ -z "$DMG" ] || [ ! -f "$DMG" ]; then
  echo "no DMG found — run 'npm run build:dmg' first (looked in $BUNDLE_DIR)" >&2
  exit 1
fi

if ! xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  echo "keychain profile '$PROFILE' not found — see the store-credentials block at the top of this script" >&2
  exit 1
fi

echo "notarising $DMG"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait

echo "stapling the ticket into the DMG"
xcrun stapler staple "$DMG"

echo
echo "done. Verifying what a first-time user's Mac will see:"
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature -vv "$DMG"

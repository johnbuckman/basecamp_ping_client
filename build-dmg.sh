#!/bin/bash
# Builds bping.dmg. If a Developer ID Application cert is in the keychain AND
# a matching `notarytool` keychain profile exists, the bundle + DMG are signed
# with hardened runtime, notarized, and stapled. Otherwise we fall back to
# ad-hoc signing (recipient sees "developer cannot be verified" → right-click→Open).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/dist/bping-darwin-arm64/bping.app"
DMG="$ROOT/dist/bping.dmg"
ENT="$ROOT/entitlements.plist"

# Overridable via env, e.g.  BPING_SIGN_ID="Developer ID Application: ..." ./build-dmg.sh
ID="${BPING_SIGN_ID:-Developer ID Application: Vid Tadel (XLS3XF57J8)}"
NOTARY_PROFILE="${BPING_NOTARY_PROFILE:-bping-notary}"

[ -d "$APP" ] || { echo "Missing $APP — run: npm run package"; exit 1; }

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$ID"; then
  MODE="developerid"
  [ -f "$ENT" ] || { echo "Missing $ENT"; exit 1; }
  echo "==> Signing with: $ID"
else
  MODE="adhoc"
  echo "==> '$ID' not in keychain — using ad-hoc signing (no notarization)."
fi

if [ "$MODE" = "developerid" ]; then
  # Sign EVERY Mach-O binary anywhere in the bundle (Electron buries some deep:
  # chrome_crashpad_handler inside Electron Framework's Helpers/, ShipIt inside
  # Squirrel.framework's Resources/, etc.). Path-pattern globs miss these.
  echo "==> Codesigning every nested Mach-O binary"
  while IFS= read -r -d '' f; do
    if file -b "$f" 2>/dev/null | grep -q "Mach-O"; then
      codesign --force --options runtime --timestamp \
        --entitlements "$ENT" --sign "$ID" "$f" >/dev/null
    fi
  done < <(find "$APP" -type f -print0)

  for h in "$APP/Contents/Frameworks"/*.app; do
    [ -d "$h" ] || continue
    codesign --force --options runtime --timestamp \
      --entitlements "$ENT" --sign "$ID" "$h" >/dev/null
  done

  for fw in "$APP/Contents/Frameworks"/*.framework; do
    [ -d "$fw" ] || continue
    codesign --force --options runtime --timestamp --sign "$ID" "$fw" >/dev/null
  done

  codesign --force --options runtime --timestamp \
    --entitlements "$ENT" --sign "$ID" "$APP" >/dev/null
  codesign --verify --deep --strict "$APP"
  echo "==> Signed."

  # notarytool requires a .zip/.pkg/.dmg for upload; we zip just for transport,
  # then staple the original .app (the ticket attaches to the bundle, not the zip).
  echo "==> Notarizing $APP (Apple notary queue — typically 1–3 min)…"
  ZIP="$ROOT/dist/bping-for-notary.zip"
  rm -f "$ZIP"
  ditto -c -k --keepParent "$APP" "$ZIP"
  OUT="$(xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait 2>&1)"
  echo "$OUT"
  rm -f "$ZIP"
  echo "$OUT" | grep -q "status: Accepted" || { echo "Notarization NOT accepted — fetch log: xcrun notarytool log <submission-id> --keychain-profile $NOTARY_PROFILE"; exit 1; }
  xcrun stapler staple "$APP"
  echo "==> Stapled."
else
  codesign --force --deep --sign - --timestamp=none "$APP" >/dev/null
  codesign --verify --deep --strict "$APP" || { echo "ad-hoc verify failed"; exit 1; }
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

rm -f "$DMG"
hdiutil create -volname "bping" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null

if [ "$MODE" = "developerid" ]; then
  echo "==> Signing + notarizing $DMG"
  codesign --force --timestamp --sign "$ID" "$DMG"
  OUT="$(xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait 2>&1)"
  echo "$OUT"
  echo "$OUT" | grep -q "status: Accepted" || { echo "DMG notarization NOT accepted"; exit 1; }
  xcrun stapler staple "$DMG"
  echo "==> DMG stapled — recipients can double-click with no Gatekeeper warning."
fi

echo "built: $DMG ($(du -h "$DMG" | awk '{print $1}'))"

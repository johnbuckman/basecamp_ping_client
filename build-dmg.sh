#!/bin/bash
# Builds bping into a notarized DMG, named bping-v<version>.dmg.
#
# - Bumps the patch component of package.json's version before each build.
# - Runs electron-packager so the new version is baked into the .app's Info.plist.
# - If a Developer ID Application cert is in the keychain, signs the .app and
#   DMG with hardened runtime. Otherwise falls back to ad-hoc signing
#   (recipient sees "developer cannot be verified" → right-click→Open).
# - Notarization is OPT-IN: set BPING_NOTARIZE=1 to submit to Apple's notary
#   service + staple. Without it, the build is signed-but-not-notarized
#   (Gatekeeper will warn on first launch; right-click→Open dismisses).
# - Removes any prior bping-v*.dmg (and any unversioned legacy bping.dmg) from
#   the build dir and deploy targets, so only one DMG of each kind is kept.
# - Deploys app + new DMG to ~/Documents/bping-apps/ and ~/Desktop/.
# - Quits any running bping, installs the new .app into /Applications, and
#   relaunches it (so the running version always matches the latest build).
#
# Env overrides:
#   BPING_SIGN_ID         — codesign identity (default: Developer ID Application: Vid Tadel ...)
#   BPING_NOTARY_PROFILE  — notarytool keychain profile name (default: bping-notary)
#   BPING_NOTARIZE=1      — submit to Apple notary + staple (default: skip)
#   BPING_SKIP_BUMP=1     — don't bump the version (rebuild current version)
#   BPING_SKIP_INSTALL=1  — don't quit/install/relaunch into /Applications
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST="$ROOT/dist"
ENT="$ROOT/entitlements.plist"
PKG="$ROOT/package.json"

ID="${BPING_SIGN_ID:-Developer ID Application: Vid Tadel (XLS3XF57J8)}"
NOTARY_PROFILE="${BPING_NOTARY_PROFILE:-bping-notary}"

# --- Bump patch version in package.json -------------------------------------
OLD_VER="$(node -e "console.log(require('$PKG').version)")"
if [ "${BPING_SKIP_BUMP:-0}" = "1" ]; then
  NEW_VER="$OLD_VER"
  echo "==> Version unchanged (BPING_SKIP_BUMP): $NEW_VER"
else
  IFS='.' read -r MA MI PA <<<"$OLD_VER"
  NEW_VER="$MA.$MI.$((PA + 1))"
  node -e "var p=require('$PKG'); p.version='$NEW_VER'; require('fs').writeFileSync('$PKG', JSON.stringify(p,null,2)+'\n');"
  echo "==> Version bumped: $OLD_VER → $NEW_VER"
fi

# --- Package the .app (electron-packager) -----------------------------------
echo "==> Packaging bping.app (version $NEW_VER)"
( cd "$ROOT" && ./node_modules/.bin/electron-packager . bping \
    --platform=darwin --arch=arm64 --overwrite --out=dist --icon=icon.icns \
    --app-bundle-id=com.decent.bping \
    --app-category-type=public.app-category.productivity >/dev/null )
APP="$DIST/bping-darwin-arm64/bping.app"
[ -d "$APP" ] || { echo "Build failed: $APP missing"; exit 1; }

DMG="$DIST/bping-v$NEW_VER.dmg"

# --- Detect signing mode ----------------------------------------------------
if security find-identity -v -p codesigning 2>/dev/null | grep -q "$ID"; then
  MODE="developerid"
  [ -f "$ENT" ] || { echo "Missing $ENT"; exit 1; }
  echo "==> Signing with: $ID"
else
  MODE="adhoc"
  echo "==> '$ID' not in keychain — ad-hoc signing (no notarization)."
fi

# --- Sign the .app ----------------------------------------------------------
if [ "$MODE" = "developerid" ]; then
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

  if [ "${BPING_NOTARIZE:-0}" = "1" ]; then
    echo "==> Notarizing $APP (Apple notary queue — typically 1–3 min)…"
    ZIP="$DIST/bping-for-notary.zip"
    rm -f "$ZIP"
    ditto -c -k --keepParent "$APP" "$ZIP"
    OUT="$(xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait 2>&1)"
    echo "$OUT"
    rm -f "$ZIP"
    echo "$OUT" | grep -q "status: Accepted" || { echo "Notarization NOT accepted"; exit 1; }
    xcrun stapler staple "$APP"
    echo "==> Stapled."
  else
    echo "==> Skipping notarization (set BPING_NOTARIZE=1 to enable)."
  fi
else
  codesign --force --deep --sign - --timestamp=none "$APP" >/dev/null
  codesign --verify --deep --strict "$APP" || { echo "ad-hoc verify failed"; exit 1; }
fi

# --- Build the DMG ----------------------------------------------------------
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

rm -f "$DMG"
hdiutil create -volname "bping" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null

if [ "$MODE" = "developerid" ]; then
  echo "==> Signing $DMG"
  codesign --force --timestamp --sign "$ID" "$DMG"
  if [ "${BPING_NOTARIZE:-0}" = "1" ]; then
    echo "==> Notarizing $DMG"
    OUT="$(xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait 2>&1)"
    echo "$OUT"
    echo "$OUT" | grep -q "status: Accepted" || { echo "DMG notarization NOT accepted"; exit 1; }
    xcrun stapler staple "$DMG"
    echo "==> DMG stapled — recipients double-click without Gatekeeper warnings."
  else
    echo "==> DMG signed but not notarized (set BPING_NOTARIZE=1 to enable)."
  fi
fi

# --- Remove ALL prior DMGs (versioned + legacy unversioned) ----------------
echo "==> Removing older bping DMGs"
NEW_BASENAME="$(basename "$DMG")"
for d in "$DIST" "$HOME/Documents/bping-apps" "$HOME/Desktop"; do
  [ -d "$d" ] || continue
  find "$d" -maxdepth 1 -name 'bping-v*.dmg' ! -name "$NEW_BASENAME" -print -delete 2>/dev/null || true
  # Also wipe the legacy unversioned name from earlier builds.
  [ -f "$d/bping.dmg" ] && { echo "$d/bping.dmg"; rm -f "$d/bping.dmg"; }
done

# --- Deploy app + new DMG ---------------------------------------------------
for DEST in "$HOME/Documents/bping-apps" "$HOME/Desktop"; do
  [ -d "$DEST" ] || mkdir -p "$DEST"
  rm -rf "$DEST/bping.app"
  cp -R "$APP" "$DEST/"
  touch "$DEST/bping.app"
  cp "$DMG" "$DEST/"
done

echo "==> built: $NEW_BASENAME ($(du -h "$DMG" | awk '{print $1}'))"
echo "==> version: $NEW_VER"
echo "==> deployed to: ~/Documents/bping-apps/ and ~/Desktop/"

# --- Install to /Applications + relaunch -----------------------------------
# Always replace the running instance so the user sees the new build immediately.
# Skip with BPING_SKIP_INSTALL=1 if you want to test from a DMG copy first.
if [ "${BPING_SKIP_INSTALL:-0}" = "1" ]; then
  echo "==> Skipping /Applications install (BPING_SKIP_INSTALL=1)."
else
  WAS_RUNNING=0
  if pgrep -x bping >/dev/null 2>&1; then
    WAS_RUNNING=1
    echo "==> Quitting running bping"
    osascript -e 'tell application "bping" to quit' >/dev/null 2>&1 || true
    # Give it up to 4 seconds to quit cleanly, then force.
    for i in 1 2 3 4; do
      pgrep -x bping >/dev/null 2>&1 || break
      sleep 1
    done
    if pgrep -x bping >/dev/null 2>&1; then
      echo "==> Forcing bping quit"
      killall -9 bping 2>/dev/null || true
      sleep 1
    fi
  fi
  echo "==> Installing to /Applications/Basecamp/bping.app"
  mkdir -p /Applications/Basecamp
  rm -rf /Applications/Basecamp/bping.app
  cp -R "$APP" /Applications/Basecamp/
  touch /Applications/Basecamp/bping.app
  echo "==> Relaunching /Applications/Basecamp/bping.app"
  open /Applications/Basecamp/bping.app
  if [ "$WAS_RUNNING" = "1" ]; then
    echo "==> Replaced the running instance — new build is live."
  else
    echo "==> Launched new build (no prior instance was running)."
  fi
fi

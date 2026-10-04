#!/bin/bash
# Explicit release action; does not run during local builds or upload a release.
set -euo pipefail
: "${APPLE_SIGNING_IDENTITY:?Set Developer ID Application identity}"
: "${APPLE_NOTARY_PROFILE:?Set a notarytool Keychain profile}"
APP_PATH="${1:?Pass the built PractiQ.app path}"
DMG_PATH="${2:-}"
if [ -n "$DMG_PATH" ] && [ -e "$DMG_PATH" ]; then
  printf '%s\n' 'Use a fresh DMG path; existing artifacts must not be overwritten.' >&2
  exit 1
fi
ENTITLEMENTS="$(dirname "$0")/desktop-entitlements.plist"
# Sign nested Mach-O files from the inside out, including the desktop WebView runtime.
while IFS= read -r -d '' BINARY_PATH; do
  if file -b "$BINARY_PATH" | /usr/bin/grep -q 'Mach-O'; then
    codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$APPLE_SIGNING_IDENTITY" "$BINARY_PATH"
  fi
done < <(find "$APP_PATH/Contents" -type f -print0)
while IFS= read -r -d '' BUNDLE_PATH; do
  codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$APPLE_SIGNING_IDENTITY" "$BUNDLE_PATH"
done < <(find "$APP_PATH/Contents" -depth -type d \( -name '*.framework' -o -name '*.app' \) -print0)
codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
RELEASE_ZIP="${APP_PATH%.app}-signed.zip"
ditto -c -k --keepParent "$APP_PATH" "$RELEASE_ZIP"
xcrun notarytool submit "$RELEASE_ZIP" --keychain-profile "$APPLE_NOTARY_PROFILE" --wait
xcrun stapler staple "$APP_PATH"
xcrun stapler validate "$APP_PATH"
spctl --assess --type execute --verbose=2 "$APP_PATH"
# Recreate the ZIP after stapling. This script does not publish either artifact.
ditto -c -k --keepParent "$APP_PATH" "$RELEASE_ZIP"
if [ -n "$DMG_PATH" ]; then
  # The previous build's DMG still contains the unsigned app. Package the stapled app again.
  DMG_STAGE=$(mktemp -d)
  trap 'rm -rf "$DMG_STAGE"' EXIT
  ditto "$APP_PATH" "$DMG_STAGE/PractiQ.app"
  ln -s /Applications "$DMG_STAGE/Applications"
  hdiutil create -volname PractiQ -srcfolder "$DMG_STAGE" -format UDZO "$DMG_PATH"
  codesign --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$DMG_PATH"
  codesign --verify --strict "$DMG_PATH"
  xcrun notarytool submit "$DMG_PATH" --keychain-profile "$APPLE_NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG_PATH"
  xcrun stapler validate "$DMG_PATH"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG_PATH"
fi

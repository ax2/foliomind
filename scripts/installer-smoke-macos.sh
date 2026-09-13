#!/usr/bin/env bash
set -euo pipefail

dmg="$(find src-tauri/target/release/bundle/dmg -maxdepth 1 -type f -name '*.dmg' -print -quit)"
test -n "$dmg" || { echo "No macOS DMG found" >&2; exit 1; }

mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/foliomind-dmg.XXXXXX")"
copied_app="$(mktemp -d "${TMPDIR:-/tmp}/foliomind-app.XXXXXX")/FolioMind.app"
mounted=false

cleanup() {
  if [ "$mounted" = true ]; then
    hdiutil detach "$mount_dir" -force >/dev/null 2>&1 || true
  fi
  rm -rf "$mount_dir" "$(dirname "$copied_app")"
}
trap cleanup EXIT

hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount_dir" >/dev/null
mounted=true
app="$(find "$mount_dir" -maxdepth 1 -type d -name '*.app' -print -quit)"
test -n "$app" || { echo "No .app bundle found in $dmg" >&2; exit 1; }

ditto "$app" "$copied_app"
hdiutil detach "$mount_dir" -force >/dev/null
mounted=false

bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$copied_app/Contents/Info.plist")"
binary_name="$(plutil -extract CFBundleExecutable raw -o - "$copied_app/Contents/Info.plist")"
test "$bundle_id" = "app.foliomind.desktop" || {
  echo "Unexpected bundle identifier: $bundle_id" >&2
  exit 1
}
test -n "$binary_name" && test -x "$copied_app/Contents/MacOS/$binary_name" || {
  echo "Copied app bundle has no executable payload" >&2
  exit 1
}

echo "Installer smoke passed: macOS DMG mount, copy, and unmount"

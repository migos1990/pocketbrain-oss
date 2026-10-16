#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Builds PocketBrain.app (menu-bar only, no Dock icon) from the Swift package next to this file.
# Needs the Xcode command-line tools (xcode-select --install); no Xcode project, no signing.
#   macos/PocketBrainBar/build.sh            -> macos/PocketBrainBar/build/PocketBrain.app
#   macos/PocketBrainBar/build.sh --install  -> also copies it to ~/Applications
set -eu
cd "$(dirname "$0")"
swift build -c release
BIN="$(swift build -c release --show-bin-path)/PocketBrainBar"
APP=build/PocketBrain.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/PocketBrainBar"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.pocketbrain.bar</string>
  <key>CFBundleName</key><string>PocketBrain</string>
  <key>CFBundleExecutable</key><string>PocketBrainBar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>PocketBrainApp</key><string>__APP__</string>
</dict>
</plist>
PLIST
# The app runs only the pocketBrain folder it was built from (Runner.swift), never one from a setting.
APPDIR="$(cd ../.. && pwd -P)"
case "$APPDIR" in *'<'*|*'&'*|*'|'*) echo "build.sh: odd characters in $APPDIR" >&2; exit 1;; esac
sed -i '' "s|__APP__|$APPDIR|" "$APP/Contents/Info.plist"
# Ad-hoc signature so Gatekeeper runs a locally built copy; a Developer ID comes with the launch.
codesign --force --sign - "$APP"
echo "built $(pwd)/$APP"
if [ "${1:-}" = "--install" ]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/PocketBrain.app"
  cp -R "$APP" "$HOME/Applications/"
  echo "installed $HOME/Applications/PocketBrain.app"
fi

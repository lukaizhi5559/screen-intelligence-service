#!/bin/bash
# build.sh — compile + bundle td-ui-parse daemon (mirrors td-screen-helper pattern).
set -euo pipefail
cd "$(dirname "$0")"

APP=bin/td-ui-parse.app
BIN=$APP/Contents/MacOS/td-ui-parse

echo "==> swiftc -O td-ui-parse.swift"
swiftc -O td-ui-parse.swift -o bin/td-ui-parse

echo "==> bundle $APP"
mkdir -p "$APP/Contents/MacOS"
cp bin/td-ui-parse "$BIN"
cp Info-ui-parse.plist "$APP/Contents/Info.plist"

echo "==> codesign (ad-hoc)"
codesign -s - --force --deep "$APP"

echo "==> done: $BIN"
echo "    model expected at: $(pwd)/models/icon_detect_v8.mlpackage (or \$TD_UI_MODEL)"

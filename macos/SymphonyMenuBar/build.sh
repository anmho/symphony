#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

swift build -c release

APP="$ROOT/SymphonyMenuBar.app"
BIN="$ROOT/.build/release/SymphonyMenuBar"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/SymphonyMenuBar"
cp "$ROOT/Info.plist" "$APP/Contents/Info.plist"

echo "Built $APP"
echo "Install: cp -R \"$APP\" /Applications/"

#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

VERSION="${1:-0.1.0}"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) ARCH_LABEL="aarch64" ;;
  x86_64) ARCH_LABEL="x64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

swift build -c release

APP="$ROOT/SymphonyMenuBar.app"
BIN="$ROOT/.build/release/SymphonyMenuBar"
PLIST="$ROOT/Info.plist"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/SymphonyMenuBar"
cp "$PLIST" "$APP/Contents/Info.plist"

/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${VERSION}" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${VERSION}" "$APP/Contents/Info.plist"

# Ad-hoc sign so macOS treats the bundle consistently (not notarized).
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

echo "Built $APP ($VERSION, $ARCH_LABEL)"

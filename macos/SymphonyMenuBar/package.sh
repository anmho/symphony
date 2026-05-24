#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

VERSION="${1:-0.1.0}"
DIST="$ROOT/dist"
mkdir -p "$DIST"

./build.sh "$VERSION"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) ARCH_LABEL="aarch64" ;;
  x86_64) ARCH_LABEL="x64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

APP_TAR="$DIST/SymphonyMenuBar_${VERSION}_${ARCH_LABEL}.app.tar.gz"
DMG="$DIST/SymphonyMenuBar_${VERSION}_${ARCH_LABEL}.dmg"

tar -czf "$APP_TAR" -C "$ROOT" SymphonyMenuBar.app
shasum -a 256 "$APP_TAR" | tee "$APP_TAR.sha256"

hdiutil create \
  -volname "Symphony Menu Bar" \
  -srcfolder "$ROOT/SymphonyMenuBar.app" \
  -ov \
  -format UDZO \
  "$DMG" >/dev/null

shasum -a 256 "$DMG" | tee "$DMG.sha256"

echo "Packaged:"
echo "  $APP_TAR"
echo "  $DMG"

#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

VERSION="${1:-$(tr -d '[:space:]' < "$ROOT/VERSION")}"
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
CHECKSUMS="$DIST/checksums-${VERSION}.txt"

tar -czf "$APP_TAR" -C "$ROOT" SymphonyMenuBar.app
shasum -a 256 "$APP_TAR" > "$APP_TAR.sha256"

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
cp -R "$ROOT/SymphonyMenuBar.app" "$staging/"
ln -s /Applications "$staging/Applications"

hdiutil create \
  -volname "Symphony Menu Bar" \
  -srcfolder "$staging" \
  -ov \
  -format UDZO \
  "$DMG" >/dev/null

shasum -a 256 "$DMG" > "$DMG.sha256"

{
  cat "$APP_TAR.sha256"
  cat "$DMG.sha256"
} > "$CHECKSUMS"

echo "Packaged:"
echo "  $APP_TAR"
echo "  $DMG"
echo "  $CHECKSUMS"

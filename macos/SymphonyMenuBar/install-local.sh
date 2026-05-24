#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${SYMPHONY_INSTALL_DIR:-/Applications}"
APP_NAME="Symphony.app"
LEGACY_APP_NAME="SymphonyMenuBar.app"

./build.sh

SOURCE="$ROOT/dist/$APP_NAME"
if [[ ! -d "$SOURCE" ]]; then
  echo "error: build did not produce $SOURCE" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
rm -rf "$INSTALL_DIR/$APP_NAME" "$INSTALL_DIR/$LEGACY_APP_NAME"
cp -R "$SOURCE" "$INSTALL_DIR/$APP_NAME"

while IFS= read -r -d '' path; do
  xattr -d com.apple.quarantine "$path" 2>/dev/null || true
done < <(find "$INSTALL_DIR/$APP_NAME" -print0)

echo "Installed $INSTALL_DIR/$APP_NAME"
echo "Launch: open -a Symphony"

#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

VERSION="${1:-$(tr -d '[:space:]' < "$ROOT/VERSION")}"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) ARCH_LABEL="aarch64" ;;
  x86_64) ARCH_LABEL="x64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

if [[ ! -f "$ROOT/Resources/AppIcon.icns" ]]; then
  chmod +x "$ROOT/scripts/generate-icon.swift"
  swift "$ROOT/scripts/generate-icon.swift"
fi
swift build -c release

mkdir -p "$ROOT/dist"
APP="$ROOT/dist/Symphony.app"
BIN="$ROOT/.build/release/SymphonyMenuBar"
PLIST="$ROOT/Info.plist"

rm -rf "$APP" "$ROOT/Symphony.app" "$ROOT/SymphonyMenuBar.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Symphony"
chmod +x "$APP/Contents/MacOS/Symphony"
cp "$PLIST" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

if [[ -f "$ROOT/Resources/AppIcon.icns" ]]; then
  cp "$ROOT/Resources/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
  /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string AppIcon" "$APP/Contents/Info.plist" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Set :CFBundleIconFile AppIcon" "$APP/Contents/Info.plist"
fi

/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${VERSION}" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${VERSION}" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable Symphony" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Symphony" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Symphony" "$APP/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Symphony" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :NSHumanReadableCopyright string Copyright © Anmho" "$APP/Contents/Info.plist" 2>/dev/null \
  || true

# Keep local build artifacts out of Spotlight when developing in the repo checkout.
touch "$APP/.metadata_never_index"

# Ad-hoc sign so macOS treats the bundle consistently (not notarized).
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

echo "Built $APP ($VERSION, $ARCH_LABEL)"

#!/usr/bin/env bash
set -euo pipefail

REPO="${SYMPHONY_MENUBAR_REPO:-anmho/symphony}"
INSTALL_DIR="${SYMPHONY_MENUBAR_INSTALL_DIR:-/Applications}"
APP_NAME="SymphonyMenuBar.app"

log() {
  printf '==> %s\n' "$*"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

detect_arch() {
  case "$(uname -m)" in
    arm64) echo "aarch64" ;;
    x86_64) echo "x64" ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
}

resolve_version() {
  if [[ -n "${SYMPHONY_MENUBAR_VERSION:-}" ]]; then
    echo "$SYMPHONY_MENUBAR_VERSION"
    return
  fi

  python3 - <<'PY'
import json
import urllib.request

repo = __import__("os").environ.get("SYMPHONY_MENUBAR_REPO", "anmho/symphony")
manifest_url = f"https://github.com/{repo}/releases/latest/download/latest-menubar.json"
try:
    request = urllib.request.Request(manifest_url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request) as response:
        manifest = json.load(response)
    print(manifest["version"])
except Exception:
    releases_url = f"https://api.github.com/repos/{repo}/releases"
    request = urllib.request.Request(releases_url, headers={"Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(request) as response:
        releases = json.load(response)
    for release in releases:
        tag = release.get("tag_name", "")
        if tag.startswith("menubar-v"):
            print(tag.removeprefix("menubar-v"))
            break
    else:
        raise SystemExit("no menubar release found")
PY
}

verify_checksum() {
  local file="$1"
  local checksum_file="${file}.sha256"
  if [[ ! -f "$checksum_file" ]]; then
    return 0
  fi
  local expected actual
  expected="$(awk '{print $1}' "$checksum_file")"
  actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  [[ "$expected" == "$actual" ]] || die "checksum mismatch for $(basename "$file")"
}

main() {
  require_cmd curl
  require_cmd tar
  require_cmd shasum

  if [[ "$(uname -s)" != "Darwin" ]]; then
    die "Symphony Menu Bar requires macOS"
  fi

  local version arch asset checksum_asset url tmpdir app_path
  version="$(resolve_version)"
  arch="$(detect_arch)"
  asset="SymphonyMenuBar_${version}_${arch}.app.tar.gz"
  checksum_asset="${asset}.sha256"
  url="https://github.com/${REPO}/releases/download/menubar-v${version}/${asset}"

  log "Installing Symphony Menu Bar ${version} (${arch})"
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT

  curl -fsSL "$url" -o "$tmpdir/$asset"
  curl -fsSL "${url}.sha256" -o "$tmpdir/$checksum_asset" 2>/dev/null || true
  verify_checksum "$tmpdir/$asset"
  tar -xzf "$tmpdir/$asset" -C "$tmpdir"

  app_path="$tmpdir/$APP_NAME"
  [[ -d "$app_path" ]] || die "archive did not contain $APP_NAME"

  mkdir -p "$INSTALL_DIR"
  rm -rf "$INSTALL_DIR/$APP_NAME"
  cp -R "$app_path" "$INSTALL_DIR/$APP_NAME"
  xattr -dr com.apple.quarantine "$INSTALL_DIR/$APP_NAME" 2>/dev/null || true

  log "Installed to $INSTALL_DIR/$APP_NAME"
  log "Launch: open -a SymphonyMenuBar"
}

main "$@"

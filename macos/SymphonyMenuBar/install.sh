#!/usr/bin/env bash
set -euo pipefail

REPO="${SYMPHONY_MENUBAR_REPO:-anmho/symphony}"
INSTALL_DIR="${SYMPHONY_MENUBAR_INSTALL_DIR:-/Applications}"
APP_NAME="Symphony.app"
LEGACY_APP_NAME="SymphonyMenuBar.app"

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

clear_quarantine() {
  local target="$1"
  while IFS= read -r -d '' path; do
    xattr -d com.apple.quarantine "$path" 2>/dev/null || true
  done < <(find "$target" -print0)
}

WORKDIR=""

cleanup() {
  [[ -n "$WORKDIR" ]] && rm -rf "$WORKDIR"
}

main() {
  require_cmd curl
  require_cmd tar
  require_cmd shasum

  if [[ "$(uname -s)" != "Darwin" ]]; then
    die "Symphony requires macOS"
  fi

  local version arch asset legacy_asset checksum_asset url app_path
  version="$(resolve_version)"
  arch="$(detect_arch)"
  asset="Symphony_${version}_${arch}.app.tar.gz"
  legacy_asset="SymphonyMenuBar_${version}_${arch}.app.tar.gz"
  checksum_asset="${asset}.sha256"
  url="https://github.com/${REPO}/releases/download/menubar-v${version}/${asset}"

  log "Installing Symphony ${version} (${arch})"
  WORKDIR="$(mktemp -d)"
  trap cleanup EXIT

  if ! curl -fsSL "$url" -o "$WORKDIR/$asset"; then
    url="https://github.com/${REPO}/releases/download/menubar-v${version}/${legacy_asset}"
    asset="$legacy_asset"
    curl -fsSL "$url" -o "$WORKDIR/$asset"
  fi
  curl -fsSL "${url}.sha256" -o "$WORKDIR/$checksum_asset" 2>/dev/null || true
  verify_checksum "$WORKDIR/$asset"
  tar -xzf "$WORKDIR/$asset" -C "$WORKDIR"

  app_path="$WORKDIR/$APP_NAME"
  if [[ ! -d "$app_path" ]]; then
    app_path="$WORKDIR/$LEGACY_APP_NAME"
  fi
  [[ -d "$app_path" ]] || die "archive did not contain $APP_NAME"

  mkdir -p "$INSTALL_DIR"
  rm -rf "$INSTALL_DIR/$APP_NAME" "$INSTALL_DIR/$LEGACY_APP_NAME"
  cp -R "$app_path" "$INSTALL_DIR/$APP_NAME"
  clear_quarantine "$INSTALL_DIR/$APP_NAME"

  log "Installed to $INSTALL_DIR/$APP_NAME"
  log "Launch: open -a Symphony"
}

main "$@"

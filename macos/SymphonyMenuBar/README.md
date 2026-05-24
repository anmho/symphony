# Symphony

Native macOS menu bar app for monitoring local Symphony agents, opening Linear tickets, and controlling the Symphony CLI.

## Stack

**Swift + SwiftUI** native app using `MenuBarExtra`. Not Electron, not Tauri — a small signed `.app` bundle distributed as DMG and tarball releases.

Source lives here in the symphony repo; **users install the packaged release**, not the source tree.

## Features

- Native menu bar dropdown with agent ticket links, Start/Stop, Watch, and Refresh
- Status panel with running/retry/parked rows and Linear links
- Live status from Symphony `GET /status`
- CLI controls via `symphony start`, `stop`, `watch`, and HTTP resume/steer endpoints
- **Watch** opens `symphony watch`; errors surface if the CLI is missing from PATH

## Install (recommended)

### One-line install

```bash
curl -fsSL https://github.com/anmho/symphony/releases/latest/download/install.sh | bash
```

Installs to `/Applications/Symphony.app` and removes the legacy `/Applications/SymphonyMenuBar.app` if present.

### Download DMG

1. Open [GitHub Releases](https://github.com/anmho/symphony/releases) and find the latest `menubar-v*` release.
2. Download `Symphony_<version>_aarch64.dmg` (Apple Silicon) or `_x64.dmg` (Intel).
3. Open the DMG, drag **Symphony** to **Applications**.
4. First launch: right-click → **Open** if macOS warns the app is unsigned.

### Homebrew cask

After publishing to a tap:

```bash
brew install --cask symphony-menubar
```

Cask definition: [`Casks/symphony-menubar.rb`](Casks/symphony-menubar.rb)

## What gets published

Each `menubar-v*` release includes:

| Asset | Purpose |
|-------|---------|
| `Symphony_<ver>_aarch64.dmg` | Drag-to-Applications installer (Apple Silicon) |
| `Symphony_<ver>_x64.dmg` | Drag-to-Applications installer (Intel) |
| `Symphony_<ver>_*.app.tar.gz` | CLI/install.sh payload |
| `*.sha256` | Checksum sidecars |
| `latest-menubar.json` | Version manifest for install script |
| `install.sh` | One-line installer (served from release, not raw GitHub CDN) |

CI builds on tag push via [`.github/workflows/release-menubar.yml`](../../.github/workflows/release-menubar.yml).

## Build from source (maintainers)

```bash
cd macos/SymphonyMenuBar
chmod +x install-local.sh
./install-local.sh
open -a Symphony
```

Build artifacts land in `dist/Symphony.app` only. The repo root is not used for `.app` bundles, and `dist/` is gitignored so Spotlight does not pick up a second copy while developing.

Open in Xcode: `open Package.swift`

Regenerate the app icon:

```bash
swift scripts/generate-icon.swift
```

## Settings

Gear icon in the status panel:

- **Status port** — default `3979`
- **Linear org slug** — default `anmho`
- **Poll interval** — default `5s`

## Requirements

- macOS 13+
- Symphony running locally (`symphony start`)
- `symphony` on PATH for Watch and daemon controls

## Troubleshooting

Symphony is a **menu bar only** app (`LSUIElement`). It does not appear in the Dock and has no main window after onboarding.

If you do not see the icon:

1. Look on the **right side of the menu bar** for a blue waveform icon.
2. On macOS 15+, check the **menu bar overflow** (Control Center chevron) — new items may be hidden until you enable them in **System Settings → Menu Bar → Symphony → Show in Menu Bar**.
3. Quit duplicate copies: `pkill -x Symphony; pkill -x SymphonyMenuBar`, then run `open -a Symphony` once.
4. Re-run the installer if Gatekeeper blocked launch.

### Duplicate Spotlight entries

If Spotlight shows two Symphony apps, you likely have both an installed copy and a local build artifact indexed. Keep only `/Applications/Symphony.app`:

```bash
rm -rf /Applications/SymphonyMenuBar.app
rm -rf ~/repos/projects/symphony/macos/SymphonyMenuBar/SymphonyMenuBar.app
rm -rf ~/repos/projects/symphony/macos/SymphonyMenuBar/Symphony.app
```

Then reinstall with `./install-local.sh` or the release installer.

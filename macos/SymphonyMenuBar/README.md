# Symphony Menu Bar

Native macOS menu bar app for monitoring local Symphony agents, opening Linear tickets, and following logs.

## Stack

**Swift + SwiftUI** native app using `MenuBarExtra`. Not Electron, not Tauri — a small signed `.app` bundle distributed as DMG and tarball releases.

Source lives here in the symphony repo; **users install the packaged release**, not the source tree.

## Features

- Live status from Symphony `GET /status`
- Agent rows show turn, event, and latest Codex message summary
- Click a row to open the Linear issue; right-click for **Follow Logs**
- **Watch** opens `symphony watch`; errors surface if the CLI is missing from PATH

## Install (recommended)

### One-line install

```bash
curl -fsSL https://github.com/anmho/symphony/releases/latest/download/install.sh | bash
```

### Download DMG

1. Open [GitHub Releases](https://github.com/anmho/symphony/releases) and find the latest `menubar-v*` release.
2. Download `SymphonyMenuBar_<version>_aarch64.dmg` (Apple Silicon) or `_x64.dmg` (Intel).
3. Open the DMG, drag **SymphonyMenuBar** to **Applications**.
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
| `SymphonyMenuBar_<ver>_aarch64.dmg` | Drag-to-Applications installer (Apple Silicon) |
| `SymphonyMenuBar_<ver>_x64.dmg` | Drag-to-Applications installer (Intel) |
| `SymphonyMenuBar_<ver>_*.app.tar.gz` | CLI/install.sh payload |
| `*.sha256` | Checksum sidecars |
| `latest-menubar.json` | Version manifest for install script |
| `install.sh` | One-line installer (served from release, not raw GitHub CDN) |

CI builds on tag push via [`.github/workflows/release-menubar.yml`](../../.github/workflows/release-menubar.yml).

## Build from source (maintainers)

```bash
cd macos/SymphonyMenuBar
./package.sh 0.1.2
open dist/SymphonyMenuBar_0.1.2_aarch64.dmg
```

Open in Xcode: `open Package.swift`

Regenerate the app icon:

```bash
swift scripts/generate-icon.swift
```

## Settings

Gear icon in the popover:

- **Status port** — default `3979`
- **Linear org slug** — default `anmho`
- **Poll interval** — default `5s`

## Requirements

- macOS 13+
- Symphony running locally (`symphony start`)
- `symphony` on PATH for the Watch button

## Troubleshooting

Symphony Menu Bar is a **menu bar only** app (`LSUIElement`). It does not appear in the Dock and has no main window after onboarding.

If you do not see the icon:

1. Look on the **right side of the menu bar** for a blue waveform icon.
2. On macOS 15+, check the **menu bar overflow** (Control Center chevron) — new items may be hidden until you enable them in **System Settings → Menu Bar → Symphony → Show in Menu Bar**.
3. Quit duplicate copies: `pkill SymphonyMenuBar`, then run `open -a SymphonyMenuBar` once.
4. Re-run the installer if Gatekeeper blocked launch.

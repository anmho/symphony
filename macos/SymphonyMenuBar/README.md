# Symphony Menu Bar

Native macOS menu bar app for monitoring local Symphony agents and opening Linear tickets.

## Stack

**Not Electron.** This app is built with **Swift + SwiftUI** using Apple's `MenuBarExtra` API. It is a small native binary (~1–2 MB) with no embedded browser runtime.

For comparison, [OpenUsage](https://github.com/robinebers/openusage) uses **Tauri** (Rust + web UI). Symphony Menu Bar intentionally stays native to keep startup instant and memory use minimal.

## Install

### One-line install (recommended)

Requires GitHub CLI (`gh`) for version discovery, or set `SYMPHONY_MENUBAR_VERSION`:

```bash
curl -fsSL https://raw.githubusercontent.com/anmho/symphony/main/macos/SymphonyMenuBar/install.sh | bash
```

Or from a checkout:

```bash
cd macos/SymphonyMenuBar
chmod +x install.sh
./install.sh
```

Pin a version:

```bash
SYMPHONY_MENUBAR_VERSION=0.1.0 ./install.sh
```

### Download release

Grab the latest `.dmg` or `.app.tar.gz` from [GitHub Releases](https://github.com/anmho/symphony/releases) (tags `menubar-v*`).

- Apple Silicon: `SymphonyMenuBar_<version>_aarch64.dmg`
- Intel: `SymphonyMenuBar_<version>_x64.dmg`

Drag **SymphonyMenuBar.app** to Applications. On first launch macOS may warn the app is unsigned — use **Open** from the context menu once, or allow in **System Settings → Privacy & Security**.

### Homebrew (tap)

A cask definition lives in [`Casks/symphony-menubar.rb`](Casks/symphony-menubar.rb). After the cask is published to a tap:

```bash
brew install --cask symphony-menubar
```

### Build from source

Requires macOS 13+ and Xcode command line tools.

```bash
cd macos/SymphonyMenuBar
chmod +x build.sh package.sh
./package.sh 0.1.0
open dist/SymphonyMenuBar_0.1.0_$(uname -m | sed 's/arm64/aarch64/;s/x86_64/x64/').dmg
```

## Features

- Polls `http://127.0.0.1:3979/status` (configurable)
- Shows running, retry/parked, and completed agents
- Click an agent row to open its Linear issue in the browser
- Launch `symphony watch` from the footer
- Menu bar label shows live running/retry counts

## Settings

Use the gear icon in the popover to configure:

- **Status port** — Symphony daemon port (default `3979`)
- **Linear org slug** — builds `https://linear.app/{org}/issue/{IDENTIFIER}` (default `anmho`)
- **Poll interval** — refresh cadence in seconds (default `5`)

## Requirements

- Symphony must be running locally (`symphony start` or `symphony run`)
- `symphony watch` must be on your PATH for the Watch button

## Release

Maintainers cut menu bar releases with tags like `menubar-v0.1.0`. CI builds arm64 + x64 DMG/tarball artifacts via [`.github/workflows/release-menubar.yml`](../../.github/workflows/release-menubar.yml).

Auto-update (Sparkle) and Apple notarization are not wired yet — install once per release for now, similar to early OpenUsage builds before signing.

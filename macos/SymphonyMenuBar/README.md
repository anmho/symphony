# Symphony Menu Bar

Native macOS menu bar app for monitoring local Symphony agents and opening Linear tickets.

## Features

- Polls `http://127.0.0.1:3979/status` (configurable)
- Shows running, retry/parked, and completed agents
- Click an agent row to open its Linear issue in the browser
- Launch `symphony watch` from the footer
- Menu bar label shows live running/retry counts

## Build

Requires macOS 13+ and Xcode command line tools.

```bash
cd macos/SymphonyMenuBar
chmod +x build.sh
./build.sh
open SymphonyMenuBar.app
```

Install system-wide:

```bash
cp -R SymphonyMenuBar.app /Applications/
```

## Settings

Use the gear icon in the popover to configure:

- **Status port** — Symphony daemon port (default `3979`)
- **Linear org slug** — used to build `https://linear.app/{org}/issue/{IDENTIFIER}` (default `anmho`)
- **Poll interval** — refresh cadence in seconds (default `5`)

## Requirements

- Symphony must be running locally (`symphony start` or `symphony run`)
- `symphony watch` must be on your PATH for the Watch button

# Symphony Logo Design Note

## Direction (current)

**Emotive point** — calm control-plane mark with a quiet musical undertone. The scheme
should read as research tooling first; the name *Symphony* supplies a secondary, tasteful
music association without staff lines or literal instruments.

### Dual reading (intentional)

| Layer | Reads as | In the mark |
|-------|----------|-------------|
| **Primary** | Agent orchestration | Point = cursor / cue; ring = cycle or coordinated field |
| **Secondary** | Musical harmony | Orbit suggests phrase or measure; single accent note on the field |
| **Product** | Local runner | Charcoal stage, lots of rest (negative space), one clear tone |

That is why the palette stays muted and circular rather than lane-heavy: it evokes
*ensemble coordination* and *one clear downbeat*, not a music app.

### Geometry

- **Primary motif:** muted blue-gray point (`#7B8FA3`), r=24 on the 256 grid.
- **Secondary motif:** centered orbit ring (r=80, 1.5px stroke @ 17% opacity).
- **Layout:** 8px grid — ring at (128,128); point at (136,120) on an 8px diagonal
  (45° optical shift).
- **Surface:** Control Charcoal (`#18201F`) with generous negative space.

This replaces the earlier **Conductor Rail** lanes (three bars + rail), which read busy
and mechanical at menu-bar scale. Literal staff notation was rejected; the current
mark keeps the music hint abstract.

## Stitch exploration (historical)

```text
Design three restrained logo concepts for Symphony, a local Linear-to-Codex
orchestrator for AFK agent work. Calm control-plane software: precise, operational,
high-trust. Suitable for macOS menu bar, README, and npm mark.

Avoid: sparkles, chat bubbles, robot heads, purple/blue neon gradients, glowing blobs,
emojis, circuit-board clichés. Neutral base, at most one muted accent. Legible at 16px.
```

### Concepts explored

1. **Conductor Rail** — three lanes + vertical rail. Rejected as primary: too dense.
2. **Score Stack** — musical staff. Rejected: wrong product metaphor.
3. **Worktree Orbit** — node constellation. Rejected: generic network branding.
4. **Emotive point** (chosen) — dot + soft orbit; spacious, legible, research-lab tone.

## Palette

| Name | Hex | Role |
|------|-----|------|
| Control Charcoal | `#18201F` | Stage / app background — dark, concert-hall calm |
| Panel White | `#E8ECE4` | Orbit ring, high-contrast structure on dark |
| Cadence Blue-Gray | `#7B8FA3` | Accent point — the active tone (cue, note, cursor) |
| Status Steel | `#64706A` | Secondary copy, metadata, subdued UI chrome |

Use **at most one accent** in UI surfaces; keep charcoal + off-white structure dominant so
the music hint stays atmospheric, not decorative.

## Rejected

- Purple/blue neon gradients, sparkles, robot heads, emoji marks
- GPT / MCP raster icon generation (over-rendered, reverted)
- Stitch MCP design-system upload (reverted; repo keeps vector sources only)
- Busy multi-lane “dashboard chart” marks at 16px

## Assets

- `assets/brand/symphony-mark.svg` — app / npm mark
- `assets/brand/symphony-logo.svg` — README lockup
- `macos/SymphonyMenuBar/Resources/AppIcon.icns` — from `swift scripts/generate-icon.swift`

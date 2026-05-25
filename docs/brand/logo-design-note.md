# Symphony Logo Design Note

## Direction (current)

**Emotive point** — inspired by restrained research-tool identity (single dot, circular
field, open space), not OpenAI branding and not generic AI chrome.

- **Primary motif:** one muted blue-gray point (`#7B8FA3`), slightly off-center for
  humanized precision.
- **Secondary motif:** thin circular orbit at low contrast (`#E8ECE4` @ 14% opacity).
- **Surface:** Control Charcoal (`#18201F`) with generous negative space.
- **Posture:** Symphony mark first; no third-party logos or endorsement cues.

This replaces the earlier **Conductor Rail** lanes (three bars + rail), which read busy
and mechanical at menu-bar scale.

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
| Control Charcoal | `#18201F` | Icon background, wordmark ink |
| Panel White | `#E8ECE4` | Low-contrast orbit ring |
| Muted Blue-Gray | `#7B8FA3` | Accent point (cursor / control primitive) |
| Status Steel | `#64706A` | Secondary lockup text |

## Rejected

- Purple/blue neon gradients, sparkles, robot heads, emoji marks
- GPT / MCP raster icon generation (over-rendered, reverted)
- Stitch MCP design-system upload (reverted; repo keeps vector sources only)
- Busy multi-lane “dashboard chart” marks at 16px

## Assets

- `assets/brand/symphony-mark.svg` — app / npm mark
- `assets/brand/symphony-logo.svg` — README lockup
- `macos/SymphonyMenuBar/Resources/AppIcon.icns` — from `swift scripts/generate-icon.swift`

# Symphony Logo Design Note

## Direction (current)

**Restore the main-branch mark** — the logo already on `main` before ANM-328 experiments.
Users preferred this over PR variants (conductor rail, GPT raster, point-and-orbit).

### What it is

- **Midnight stage** (`#141A2E`) — dark blue charcoal, not green-gray.
- **Symphony wave** (`#59B8FF`) — three linked curves, reads as sound / ensemble motion.
- **Quarter note** — stem + flag + note head, same accent; clear musical cue without clutter.

### Dual reading

| Layer | Reads as |
|-------|----------|
| **Primary** | Local agent orchestration (Symphony runner) |
| **Secondary** | Musical harmony — name + wave + note, “terminal meets score” |

PR explorations are **rejected** for the product mark: conductor lanes, emotive point, Stitch
uploads, and MCP-generated rasters.

## Palette (main)

| Name | Hex | Role |
|------|-----|------|
| Midnight Stage | `#141A2E` | Icon background |
| Symphony Sky | `#59B8FF` | Wave + note accent |
| Status Steel | `#64706A` | README tagline |

## Assets

| File | Source |
|------|--------|
| `macos/SymphonyMenuBar/scripts/generate-icon.swift` | Same as `main` |
| `macos/SymphonyMenuBar/Resources/AppIcon.icns` | Regenerated from script |
| `assets/brand/symphony-mark.svg` | Vector companion (README / npm) |
| `assets/brand/symphony-logo.svg` | README lockup |

Regenerate the macOS icon:

```sh
swift macos/SymphonyMenuBar/scripts/generate-icon.swift
```

## ANM-328 PR history (rejected marks)

1. Conductor Rail — lanes + rail (too mechanical)
2. GPT / MCP raster — over-rendered
3. Point-and-orbit — not the shipped main identity

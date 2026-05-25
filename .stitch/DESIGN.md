---
name: Symphony Control Plane
colors:
  background: '#18201F'
  on-background: '#E8ECE4'
  surface: '#1F2826'
  on-surface: '#E8ECE4'
  surface-variant: '#2A3431'
  on-surface-variant: '#64706A'
  primary: '#9FB38D'
  on-primary: '#18201F'
  primary-container: '#3D4A38'
  on-primary-container: '#D8E6CC'
  secondary: '#64706A'
  on-secondary: '#E8ECE4'
  outline: '#3A4542'
  outline-variant: '#2A3431'
  error: '#C45C5C'
  on-error: '#FFFFFF'
typography:
  display-lg:
    fontFamily: Satoshi
    fontSize: 40px
    fontWeight: '650'
    lineHeight: '1.1'
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Satoshi
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.25'
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Satoshi
    fontSize: 20px
    fontWeight: '600'
    lineHeight: '1.3'
    letterSpacing: -0.01em
  body-md:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.55'
    letterSpacing: '0'
  label-md:
    fontFamily: 'Geist Mono'
    fontSize: 11px
    fontWeight: '500'
    lineHeight: '1'
    letterSpacing: 0.08em
  button:
    fontFamily: Geist
    fontSize: 13px
    fontWeight: '500'
    lineHeight: '1'
    letterSpacing: '0'
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.625rem
  lg: 0.75rem
  xl: 1rem
  full: 9999px
spacing:
  unit: 4px
  container-max-width: 1200px
  gutter: 20px
  margin-mobile: 16px
  margin-desktop: 32px
  stack-sm: 8px
  stack-md: 16px
  stack-lg: 28px
---

# Design System: Symphony

**Project ID:** `16155015830023786079` (Stitch project **Symphony**)

## 1. Visual Theme & Atmosphere

Symphony is a **calm operator control plane** for local Linear-to-Codex orchestration. The
interface should feel precise, high-trust, and quietly busy — like a well-run dispatch desk,
not a marketing site or generic AI product.

- **Density:** Daily-app balanced (5/10) — information-rich panels without cockpit clutter.
- **Variance:** Predictable symmetric layouts (3/10) for dashboards; asymmetric only in
  marketing-adjacent README surfaces.
- **Motion:** Fluid but restrained (5/10) — spring transitions on state changes, no
  decorative loops on data tables.

Banned atmosphere: neon glow, purple gradients, sparkles, chat bubbles, robot mascots,
emoji, circuit-board clichés.

## 2. Color Palette & Roles

| Name | Hex | Role |
|------|-----|------|
| **Control Charcoal** | `#18201F` | App icon background, primary ink, dark surfaces |
| **Panel White** | `#E8ECE4` | Primary text on dark, lane strokes in the mark |
| **Sage Signal** | `#9FB38D` | Single accent — active rail, focus rings, primary actions |
| **Status Steel** | `#64706A` | Secondary labels, metadata, subdued UI chrome |
| **Deep Panel** | `#1F2826` | Cards, sidebars, elevated panels on dark base |
| **Divider Moss** | `#3A4542` | Borders, separators, inactive track strokes |

No second accent. No purple/blue neon. No pure black (`#000000`).

## 3. Typography Rules

- **Display / wordmark:** Satoshi SemiBold — tight tracking, controlled scale; never Inter.
- **UI body:** Geist Regular 14px — relaxed leading for docs and settings copy.
- **Metadata / IDs / ports:** Geist Mono 11px — issue keys, timestamps, CLI hints.
- **Banned:** Inter, generic serif stacks, oversized marketing headlines inside the app.

## 4. Logo & Mark

**Conductor Rail** (committed repo assets):

- Three horizontal **agent lanes** (Panel White) at staggered lengths.
- One vertical **conductor rail** (Sage Signal) with three nodes — scheduling control.
- macOS menu-bar master: `assets/brand/symphony-app-icon-1024.png` (raster).
- Vector marks: `assets/brand/symphony-mark.svg`, `assets/brand/symphony-logo.svg`.

Legibility target: **16px menu bar** — broad strokes, no fine interior detail.

## 5. Component Stylings

* **Buttons:** Flat fills; primary = Sage Signal on Charcoal text; ghost uses Divider Moss
  border. Active state: 1px translate, no outer glow.
* **Cards:** Subtly rounded (8px). Background Deep Panel on Control Charcoal. Shadow only
  when separating layers; prefer 1px borders for dense tables.
* **Inputs:** Label above field; mono font for ports/paths. Focus ring Sage Signal 2px.
* **Status chips:** Muted steel idle; sage for running; amber/red only for rate-limit/error.
* **Loaders:** Skeleton rows matching table geometry — no spinners in data grids.

## 6. Layout Principles

- Max content width **1200px** for monitor/settings layouts.
- Sidebar + detail pane (OpenUsage-style) for macOS menu bar companion UI references.
- Single-column collapse below **768px**.
- No nested card-in-card stacks; use section bands and dividers.
- No centered hero blocks in operational views.

## 7. Motion & Interaction

- Spring defaults: stiffness 100, damping 20.
- Stagger list reveals on agent status changes only — not on every navigation.
- Animate `transform` and `opacity` only.
- No perpetual shimmer on static chrome.

## 8. Anti-Patterns (Banned)

- Emojis, sparkles, chat bubbles, robot heads, purple/blue neon gradients
- Inter font, generic 3-column feature grids, pure black backgrounds
- Marketing filler ("Scroll to explore", "Unleash", "Next-Gen")
- Low-trust AI circuit-board decoration
- Musical notation as primary product metaphor (Symphony = orchestration, not music)

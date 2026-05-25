# Symphony Logo Design Note

## Stitch Direction

Prepared with the local Stitch design taste guidance for a calm, operator-grade
control-plane identity rather than a generic AI mark.

Stitch prompt:

```text
Design three restrained logo concepts for Symphony, a local Linear-to-Codex
orchestrator for AFK agent work. The mark must feel like calm control-plane
software: precise, operational, high-trust, and suitable for a macOS menu bar
icon, README header, and npm package mark.

Avoid generic AI tropes: no sparkles, chat bubbles, robot heads, purple/blue
neon gradients, glowing blobs, emojis, or fake circuit-board cliches. Use a
neutral foundation with one muted accent. Explore simple orchestration imagery:
agent lanes, conductor rails, work queues, status rows, and controlled motion.
Keep each concept legible at 16px.
```

## Concepts Explored

1. **Conductor Rail**: three horizontal agent lanes terminate at a vertical
   control rail. This reads as orchestration, scheduling, and operator control
   without relying on AI symbolism.
2. **Score Stack**: a compact stack of musical staff lines with a subtle
   conductor baton. It connected to the Symphony name, but became too musical
   and less product-specific at small sizes.
3. **Worktree Orbit**: issue/worktree nodes moving around a central command
   point. It suggested agents in motion, but the node constellation drifted
   toward generic network/circuit branding.

## Chosen Concept

The committed logo uses **Conductor Rail**. It is built from three stable lanes
and one vertical accent rail, matching Symphony's role as a local runner that
keeps multiple issue agents coordinated. The geometry stays readable in the
macOS app icon context because the smallest version depends on broad strokes,
large nodes, and high contrast instead of fine detail.

## Palette

- **Control Charcoal** (`#18201F`): primary app-icon background and wordmark ink.
- **Panel White** (`#E8ECE4`): high-contrast lane strokes inside the dark mark.
- **Sage Signal** (`#9FB38D`): single muted accent for the conductor rail and
  active nodes.
- **Status Steel** (`#64706A`): secondary lockup text.

## Rejected Directions

- Purple or blue neon gradients were rejected because they read as generic AI
  branding and conflict with the issue direction.
- Sparkles, chat bubbles, robot heads, and emoji-like marks were rejected as
  low-trust shortcuts.
- Highly musical symbols were rejected because Symphony is an orchestration
  tool, not a music product.
- **GPT / MCP image generation** was tried for the macOS icon and reverted: output
  looked over-rendered and off-brand. Icons stay vector + `generate-icon.swift`.

## Geometry refresh

The mark was re-centered and de-cluttered (smaller nodes, staggered lane lengths,
shared coordinates between SVG and Swift) so the menu-bar icon is less cramped on
the right edge.

---
type: reference
title: "Citegeist pane composition language"
description: The composition rules — spacing rhythm, hierarchy tiers, block/elevation model, restraint — that sit on top of the --cg-* tokens and govern how the item-pane surface is laid out.
tags: [citegeist, design-system, ui, pane, composition]
date: 2026-07-17
---

# Citegeist pane composition language

The `--cg-*` tokens (`src/modules/ui/tokens.ts`) and primitives
(`src/modules/ui/components.ts`, gallery `citegeist-primitives.html`) define the
_materials_ — colours, spacing steps, type ramp, the `.cg-*` components. This
document defines the _composition_: how those materials are arranged into a
surface that reads as Cursor/Notion/Linear-grade rather than ad-hoc. When a
layout choice is in question, this is the rubric.

Scope: the embedded item-pane surface (`#citegeist-pane-root`, ~320px, native
Zotero chrome, light/dark). The modal network dialog owns its own denser
composition; these rules are the pane's.

## The six rules

1. **Near-cardless.** A border, tint, or box is _earned_ only by (a) an
   interaction target — something you click, select, or drag — or (b) a
   genuinely distinct object. Metrics are never boxed. If removing the box
   wouldn't hurt comprehension, it isn't a box. (This is the rule the old
   three-tile metric grid broke — three tiles that weren't interactions.)

2. **One hero.** The single most important number (paper citation count) is the
   largest element on the surface (`--cg-size-display`/28px, `--cg-weight-bold`,
   `-0.025em` tracking, tabular). Everything else is smaller and quieter. Never
   two competing heroes — in particular the explore actions are peer *tinted*
   buttons, not a filled primary that would compete with the number.

3. **8pt rhythm — no off-grid values.** Every gap is a `--cg-space-*` step:
   `12` pane padding (Zotero adds its own around the section) · `16` between every
   major region (metric line → actions → hairline → authors) · `8`
   hero→supporting-metric line · `4` eyebrow→first row and inside rows.
   Separators (` · `) get `8` on both sides — never ragged `&nbsp;`. No value
   off the 4pt grid (the `.cg-btn`'s own 14px padding is control-internal, not a
   layout gap).

4. **Three type tiers.** Hero (26/bold) → body-data (`--cg-size-subhead`/13,
   `--cg-text-secondary`) → meta (`--cg-size-caption`/10–11, uppercase eyebrow,
   `--cg-text-tertiary`). Region labels are eyebrows, not headers. Numbers are
   always `font-variant-numeric: tabular-nums`.

5. **Restraint — one accent.** Sage (`--cg-sage-accent`) is the only accent:
   links, the primary action, interactive affordances. Amber
   (`--cg-amber-*`) is _evidence only_ — top-percentile, a warning state — never
   decoration. Everything else is neutral (inherits Zotero's `--fill-*`). No
   shadows on the pane; no decorative fills.

6. **Dividers over boxes.** Separate regions with a single full-bleed hairline
   (`--cg-hairline`, `margin: 16px -16px 0`) or whitespace — not nested boxes.
   One separation cue, not two.

## Reference layout (the unified pane)

The locked composition, top to bottom, at 16px padding:

```
2,481  citations                         [Top 5%]   ← hero row: number+label share a
                                                       baseline; chip optically centered,
                                                       right-aligned
FWCI 3.42 · 95th percentile · ↗ +18% 2024           ← one supporting-metric line (8 below)
[Citing works →]  [References →]                     ← action row (16 below): two peer
                                                       explore buttons — tinted, equal width
────────────────────────────────────────            ← full-bleed hairline (16 below)
AUTHORS                                              ← eyebrow (16 below the rule)
Baumeister, R. F.        h 164        ›              ← author link rows (fixed columns:
Vohs, K. D.              h 98         ›                name flex · h-index right · chevron);
Tice, D. M.                           ›                name → the author-works dialog
```

Author rows are **links, not curation** — tap a name to open that author's works
in the citation-network browser (author mode). No confirm/override, no state
pills: the automatic OpenAlex link + the synced relation happen invisibly. The
row is a clickable unit, so a hover tint is earned; a border is not.

## Applying it

- New surface? Start from the reference layout, not from components. Compose
  with hierarchy + rhythm first; add a `.cg-*` primitive only where the rule
  earns it.
- Adding a metric/row/action? Place it on the grid (rule 3), assign it a type
  tier (rule 4), and ask whether it needs a box (rule 1) — usually not.
- The guard test `test/ui-primitives.test.ts` enforces the _materials_ (tokens
  are XML-safe, primitives documented). This document is the _composition_ side;
  review a pane change against the six rules the way the gallery is reviewed
  against the code.

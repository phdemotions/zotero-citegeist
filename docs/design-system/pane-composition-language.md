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

1. **Grouped cards, cardless inside.** The pane's top-level regions (Impact,
   Authors) are titled cards — a bordered, tinted surface that makes each group
   an object you can point at. _Inside_ a card nothing else gets a box: metrics
   are never boxed, and a border or tint is otherwise _earned_ only by an
   interaction target (something you click, select, or drag). If removing an
   inner box wouldn't hurt comprehension, it isn't a box. (Superseded the
   original "near-cardless — no top-level cards at all" on 2026-07-18: cardless
   read as unstructured floating text with arbitrary whitespace. The card is the
   grouping cue now. The old three-tile *metric* grid is still wrong — those
   tiles were neither interactions nor groups.) Note the pane overrides
   `.cg-card`'s background to `--cg-surface-sunken`: the shared primitive's
   `--cg-surface-elevated` is `#FFFFFF`, identical to Zotero's own item-pane
   background in light mode, which would render the box invisible.

2. **One hero.** The single most important number (paper citation count) is the
   largest element on the surface (`--cg-size-display`/28px, `--cg-weight-bold`,
   `-0.025em` tracking, tabular). Everything else is smaller and quieter. Never
   two competing heroes — in particular the explore actions are peer *tinted*
   buttons, not a filled primary that would compete with the number.

3. **8pt rhythm — no off-grid values.** Every gap is a `--cg-space-*` step:
   `12` pane padding (Zotero adds its own around the section) · `12` card padding ·
   `12` between cards — supplied by the content column's flex `gap`, never
   per-element margins, which silently double against it · `12` metric line →
   action row · `8` hero→supporting-metric line · `8` card title→content ·
   `4` inside rows.
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

6. **One separation cue.** A region is separated by its card boundary OR a
   hairline OR whitespace — never two at once. Since the top-level regions are
   cards, the card carries the separation: no hairline between cards, and no
   nested boxes inside one.

## Reference layout (the unified pane)

The locked composition, top to bottom: two titled cards in a flex column with a
12px gap, each card 12px padded.

```
IMPACT                                    ← card title (eyebrow), 8 above content
2,481 citations [Top 5%]                  ← hero: number + label + chip LEFT-grouped as
                                             one unit (a right-pinned chip drifts far
                                             from its number in a dragged-wide pane)
FWCI 3.42 · 95th percentile · +18% 2024   ← one supporting-metric line (8 below hero)
[Citing works →]      [References →]      ← action row (12 below): two peer explore
                                             buttons — tinted, equal width
- - - - - - - - - - - - - - - - - - - -      (card boundary, 12 gap)
AUTHORS                                   ← card title
Baumeister, R. F.   h 164   ›             ← author link rows; the list reflows into
Vohs, K. D.         h 98    ›                columns as the pane widens
```

The pane has **no max-width**: the cards are meant to fill a dragged-wide pane,
and the author list reflows (`repeat(auto-fit, minmax(190px, 1fr))`) so extra
width becomes another column instead of dead space on the right.

Author rows are **links, not curation** — tap a name to open that author's works
in the citation-network browser (author mode). No confirm/override, no state
pills: the automatic OpenAlex link + the synced relation happen invisibly. The
row is a clickable unit, so a hover tint is earned; a border is not.

## Applying it

- New surface? Start from the reference layout, not from components. Compose
  with hierarchy + rhythm first; add a `.cg-*` primitive only where the rule
  earns it.
- Adding a metric/row/action? Place it on the grid (rule 3), assign it a type
  tier (rule 4), and ask whether it belongs inside an existing card rather than
  in a new box (rule 1) — a new top-level card must earn itself as a genuinely
  distinct group.
- The guard test `test/ui-primitives.test.ts` enforces the _materials_ (tokens
  are XML-safe, primitives documented). This document is the _composition_ side;
  review a pane change against the six rules the way the gallery is reviewed
  against the code.

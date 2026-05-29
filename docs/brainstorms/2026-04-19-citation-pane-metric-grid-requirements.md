---
date: 2026-04-19
topic: citation-pane-metric-grid
---

# Citation Pane: Equal-Weight Metric Grid

## Problem Frame

The current pane renders citation count at 24px / font-weight 800 while FWCI and percentile are small subordinate inline text. This creates a false visual hierarchy: FWCI is typically the more analytically meaningful number, but the design teaches researchers that raw citation count is what matters. The pane does not look like an analytics dashboard — it looks like a developer widget.

## Requirements

**Metric grid layout**
- R1. Replace the `.cg-headline` flex row with a 3-tile equal-weight grid: Citations | FWCI | Percentile.
- R2. All three tiles must have identical visual weight. No tile's value may be rendered at a larger font size, heavier weight, or more prominent color than the others.
- R3. Each tile displays its label above the value: label at ~10px, uppercase, muted color (#8A9E95); value at ~20px, semibold (weight 600), primary color (#E7EEE9), tabular-nums.
- R4. Tile labels: "CITATIONS", "FWCI", "PERCENTILE".
- R5. Tile values: citation count as `toLocaleString()`, FWCI as `toFixed(2)`, percentile as an ordinal string (e.g. "92nd", "93rd", "91st") using a proper ordinal helper — not a bare `th` suffix.
- R6. When `fwci` is null (data loaded but field absent), the FWCI tile shows "—".
- R7. When `percentile` is null, the Percentile tile shows "—". The badge is driven by `data.isTop1Percent` / `data.isTop10Percent` (independent booleans from the OpenAlex payload) — it is shown whenever either flag is true, regardless of whether `percentile` is null.

**Badge placement**
- R8. The Top 1% / Top 10% badge moves from inline after the percentile text to below the percentile tile value, as a sub-element of the Percentile tile.
- R9. Badge visual treatment (amber/sage colors, font, padding) is unchanged; only its position changes.

**Tile visual design**
- R10. Tiles have a subtle dark background: `rgba(143,173,159,0.06)` fill, `1px solid rgba(143,173,159,0.12)` border, `6px` border-radius.
- R11. Gap between tiles: 6px. Tile padding: ~10px 10px. Grid uses `align-items: stretch` so all three tiles share equal height when the badge is present. Tile values use `overflow: hidden; white-space: nowrap; text-overflow: ellipsis` to handle large citation counts (5–6 digits).
- R12. All colors are hardcoded — no `var()` CSS custom properties. (Zotero overrides custom properties in its pane context.)

**Unchanged elements**
- R13. Book-with-zero-citations suppression: when `isBook && citedByCount === 0`, show the existing "Citation tracking for books is limited in OpenAlex." note — no metric grid.
- R14. Retraction banner: unchanged.
- R15. Action buttons ("View citing works", "View references"): unchanged.
- R16. Trend line: unchanged.
- R17. Suggestion / title-match rendering paths (`renderSuggestion`): unchanged — the metric grid applies only to `renderPane`. The existing `.cg-headline`, `.cg-headline-count`, `.cg-headline-sep`, and `.cg-headline-detail` CSS rules must be **retained** in the `bodyXHTML` style block; `renderSuggestion` uses them for the speculative-metrics display and will silently break if they are removed.

**Cleanup**
- R18. Remove the `HEADLINE_COUNT_FONT_SIZE_PX` constant from `src/constants.ts`, its import in `src/modules/citationPane.ts`, and the interpolation site `${HEADLINE_COUNT_FONT_SIZE_PX}px` in the `bodyXHTML` CSS template (currently line 112) — all three must be removed together or the build will fail.

## Visual Design

```
┌────────────┬────────────┬────────────┐
│ CITATIONS  │   FWCI     │ PERCENTILE │
│    342     │   2.14     │    92nd    │
│            │            │ [Top 10%]  │
└────────────┴────────────┴────────────┘
```

*Each tile: identical container size, identical type treatment. Badge appears only when earned.*

## Success Criteria

- The three metrics read at equal visual weight — no single metric dominates at a glance.
- The pane looks like a cohesive analytics dashboard, not a developer widget.
- All existing edge-case states (book suppression, retraction, null FWCI/percentile, suggestion path) continue to behave correctly.
- `HEADLINE_COUNT_FONT_SIZE_PX` constant is gone.

## Scope Boundaries

- No changes to the action buttons, trend line, retraction banner, or suggestion rendering paths.
- No new metrics added to the grid. The three existing metrics (citations, FWCI, percentile) are the scope.
- No changes to `renderSuggestion` — the metric grid is only for confirmed-data rendering in `renderPane`.
- `src/constants.ts` change is limited to removing `HEADLINE_COUNT_FONT_SIZE_PX`.

## Key Decisions

- **3 tiles always (when not suppressed):** Rather than dynamically removing tiles for null FWCI/percentile, always show 3 tiles with "—" in null slots. Maintains consistent layout across all items. Null FWCI/percentile is rare in practice.
- **`innerHTML` acceptable for tile content:** Tile content is escaped static data (numbers, short labels) with no interactive elements. The comment at the top of `citationPane.ts` notes `innerHTML` is only problematic for `<button>` elements in the XUL context.
- **Badge stays in Percentile tile, not its own fourth tile:** A fourth tile for the badge alone would be visually unbalanced and add an empty slot for items without a badge.

## Next Steps

→ `/ce-plan` — implementation plan for `src/modules/citationPane.ts` CSS + render changes and `src/constants.ts` cleanup.

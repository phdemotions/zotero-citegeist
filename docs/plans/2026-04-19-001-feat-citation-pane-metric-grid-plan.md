---
title: "feat: Replace citation-pane headline row with equal-weight 3-tile metric grid"
type: feat
status: active
date: 2026-04-19
origin: docs/brainstorms/2026-04-19-citation-pane-metric-grid-requirements.md
---

# feat: Citation Pane — Equal-Weight Metric Grid

## Overview

Replace the `.cg-headline` flex row (24 px / weight-800 citation count with subordinate FWCI and percentile inline text) with a 3-tile equal-weight CSS grid. Citations, FWCI, and Percentile all receive identical visual treatment: uppercase label above, semibold tabular-nums value below. The Top 1 %/Top 10 % badge moves from inline after the percentile text to a sub-element of the Percentile tile. The result is a cohesive analytics dashboard layout rather than a developer widget.

## Problem Frame

The current pane teaches researchers that raw citation count is the most important number because it is rendered at 24 px font-weight-800 while FWCI and percentile are small subordinate inline text. FWCI is typically the more analytically meaningful metric. The design creates a false visual hierarchy and looks incoherent as a dashboard.

Two source files change: `src/modules/citationPane.ts` (CSS block + `renderPane()`) and `src/constants.ts` (remove unused `HEADLINE_COUNT_FONT_SIZE_PX`). `renderSuggestion()` and all other pane code is explicitly out of scope.

## Requirements Trace

- R1–R2: 3-tile grid replaces `.cg-headline`; all tiles at equal visual weight
- R3–R4: Label 10 px uppercase #8A9E95; value 20 px weight-600 #E7EEE9 tabular-nums
- R5: Percentile value as proper ordinal (92nd, 93rd — not bare "th")
- R6: Null `fwci` → FWCI tile shows "—"
- R7: Null `percentile` → Percentile tile shows "—"; badge still shown when `isTop1Percent`/`isTop10Percent` is true
- R8–R9: Badge moves under Percentile tile value; visual treatment unchanged
- R10–R12: Tile visual design (rgba fill/border/radius); hardcoded colors; `align-items: stretch`; overflow handling
- R13: Book suppression branch unchanged
- R14–R17: Retraction banner, buttons, trend line, `renderSuggestion` — all unchanged
- R18: `HEADLINE_COUNT_FONT_SIZE_PX` constant, import, and interpolation site removed

## Scope Boundaries

- No changes to `renderSuggestion()`, action buttons, trend line, or retraction banner
- No new metrics added to the grid
- `src/constants.ts` change is limited to removing `HEADLINE_COUNT_FONT_SIZE_PX`

## Context & Research

### Relevant Code and Patterns

- **`src/modules/citationPane.ts` lines 104–136** — `.cg-headline*` CSS classes being replaced; note `font-size: ${HEADLINE_COUNT_FONT_SIZE_PX}px` interpolation at line 112 must be replaced with literal `24px` (not deleted — `renderSuggestion` needs the CSS rule)
- **`src/modules/citationPane.ts` lines 560–576** — `renderSuggestion()` uses `.cg-headline`, `.cg-headline-count`, `.cg-headline-label`, `.cg-headline-sep`, `.cg-headline-detail`; does **not** use `.cg-badge*`
- **`src/modules/citationPane.ts` lines 656–689** — `renderPane()` headline building block to replace
- **`src/modules/citationPane.ts` lines 137–153** — `.cg-badge`, `.cg-badge-top1`, `.cg-badge-top10` — exact colors unchanged; reuse as-is
- **`src/constants.ts` line 54** — `export const HEADLINE_COUNT_FONT_SIZE_PX = 24;`
- **`src/modules/utils.ts`** — home for `escapeHTML()`, `safeHTML`, other pure helpers; no ordinal helper exists yet
- **`test/utils.test.ts`** — existing test file; use `describe/it/expect` + vitest pattern
- **`src/modules/cache.ts` lines 25–40** — `CachedData` interface: `percentile: number | null` stored 0–100; `isTop1Percent: boolean`; `isTop10Percent: boolean`
- No test file exists for `citationPane.ts` — visual verification must be manual

### Institutional Learnings

- **Zotero CSS var overrides** (project memory): Zotero injects its own stylesheet into every pane. `var(--accent-*)` resolves to Zotero's own value — the fallback never fires. All new tile CSS must use hardcoded hex/rgba. The retained `.cg-headline-count` rule keeps its `var(--fill-primary)` (acceptable — that rule is for `renderSuggestion`, not the new grid).
- **Hover-state specificity** (project memory): Prefix interactive selectors with `#citegeist-pane-root` to outrank Zotero's stylesheet. Tile divs have no hover state, so this does not apply to the grid.
- **`display: grid` is new to this codebase.** All current layout primitives use `display: flex`. This is the first `grid-template-columns` usage.

## Key Technical Decisions

- **`toOrdinal` in `utils.ts`**: Pure formatter with no side effects — consistent with `escapeHTML`, `safeHTML`, other helpers there. Testable in `test/utils.test.ts` without DOM.
- **Replace interpolation with `24px` literal in `.cg-headline-count`**: R18 says remove the constant and interpolation site; but the CSS rule itself must be retained for `renderSuggestion`. Solution: inline `font-size: 24px;` in the rule (see origin: `docs/brainstorms/2026-04-19-citation-pane-metric-grid-requirements.md` R17/R18).
- **`fr` units for equal-width tiles**: `grid-template-columns: repeat(3, 1fr)` is the simplest equal-column spec. If XUL's box model breaks `fr` units, the implementer should fall back to `repeat(3, calc(33.33% - 4px))` — see Risks.
- **`innerHTML` for tile content**: Follows the existing `headline.innerHTML = headlineHTML` pattern already in `renderPane()`. Tile content is escaped numeric/string data; no interactive elements. Per the Key Decisions in the origin doc, this is explicitly accepted.
- **Badge CSS reused unchanged**: `.cg-badge`, `.cg-badge-top1`, `.cg-badge-top10` classes carry over into the tile. Only position changes (now a sub-element of the Percentile tile wrapped in a block-level span).
- **`align-items: stretch` on the grid**: Ensures all three tiles share the same height when the Percentile tile is taller due to the badge. (See origin R11.)

## Open Questions

### Resolved During Planning

- **Which null display for missing FWCI/percentile?** "—" (em dash). Decided in requirements R6/R7.
- **Badge driven by `percentile` value or independent flags?** Independent booleans `isTop1Percent`/`isTop10Percent` from the `CachedData` interface. Confirmed by reading `src/modules/cache.ts`.
- **Does `renderSuggestion` use badge classes?** No — only `.cg-headline`, `.cg-headline-count`, `.cg-headline-label`, `.cg-headline-sep`, `.cg-headline-detail`. Badge CSS can be repositioned without affecting `renderSuggestion`.

### Deferred to Implementation

- **`fr` vs fallback units**: Test `display: grid; grid-template-columns: repeat(3, 1fr)` in Zotero 7 dev install. If tiles collapse, switch to `calc(33.33% - 4px)` widths on each tile. Cannot be verified at plan time.
- **Exact `margin-bottom` on grid container**: Keep `10px` to match `.cg-headline`'s existing bottom margin — confirmed from research. But verify visually that grid-to-actions spacing looks right after dev install.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

HTML shape produced by the updated `renderPane()` (non-suppressed path):

```
<div class="cg-metric-grid">
  <div class="cg-metric-tile">
    <span class="cg-metric-label">CITATIONS</span>
    <span class="cg-metric-value" title="1,342">1,342</span>
  </div>
  <div class="cg-metric-tile">
    <span class="cg-metric-label">FWCI</span>
    <span class="cg-metric-value" title="2.14">2.14</span>    <!-- or "—" when null -->
  </div>
  <div class="cg-metric-tile">
    <span class="cg-metric-label">PERCENTILE</span>
    <span class="cg-metric-value" title="92nd">92nd</span>    <!-- or "—" when null -->
    <!-- badge span only when isTop1Percent or isTop10Percent: -->
    <span class="cg-metric-badge">
      <span class="cg-badge cg-badge-top10">Top 10%</span>
    </span>
  </div>
</div>
```

Null-percentile + badge variant (when `percentile` is null but `isTop1Percent`/`isTop10Percent` is true):

```
<div class="cg-metric-tile">
  <span class="cg-metric-label">PERCENTILE</span>
  <span class="cg-metric-value">—</span>
  <span class="cg-metric-badge">
    <span class="cg-badge cg-badge-top1">Top 1%</span>
  </span>
</div>
```

CSS additions to the `bodyXHTML` style block (directional):

```
.cg-metric-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  align-items: stretch;
  gap: 6px;
  margin-bottom: 10px;
}
.cg-metric-tile {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  background: rgba(143,173,159,0.06);
  border: 1px solid rgba(143,173,159,0.12);
  border-radius: 6px;
  padding: 10px 10px;
  overflow: hidden;
}
.cg-metric-label {
  display: block;
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #8A9E95;
  margin-bottom: 4px;
}
.cg-metric-value {
  display: block;
  font-size: 20px;
  font-weight: 600;
  color: #E7EEE9;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.cg-metric-badge {
  display: block;
  margin-top: 4px;
  margin-left: 0;  /* override inherited margin-left: 4px from .cg-badge in its new block context */
}
```

## Implementation Units

- [ ] **Unit 1: `toOrdinal` utility + tests**

  **Goal:** Add a pure `toOrdinal(n: number): string` formatter to `utils.ts` that produces correct English ordinal strings for all integers including teen exceptions (11th, 12th, 13th).

  **Requirements:** R5

  **Dependencies:** None

  **Files:**
  - Modify: `src/modules/utils.ts`
  - Test: `test/utils.test.ts`

  **Approach:**
  - Export `toOrdinal(n: number): string` from `utils.ts`
  - Standard suffix rule: if `n % 100` is 11, 12, or 13 → "th"; else check `n % 10`: 1 → "st", 2 → "nd", 3 → "rd", else "th"
  - Return `${n}${suffix}`
  - Uses hardcoded English suffixes regardless of Zotero locale — ordinal internationalization is out of scope

  **Patterns to follow:**
  - Existing pure-function exports in `src/modules/utils.ts` (e.g. `escapeHTML`, `normalizeError`)
  - `describe/it/expect` test pattern in `test/utils.test.ts`

  **Test scenarios:**
  - Happy path: `toOrdinal(1)` → "1st", `toOrdinal(2)` → "2nd", `toOrdinal(3)` → "3rd", `toOrdinal(4)` → "4th"
  - Edge (teen exceptions): `toOrdinal(11)` → "11th", `toOrdinal(12)` → "12th", `toOrdinal(13)` → "13th"
  - Happy path (larger values): `toOrdinal(21)` → "21st", `toOrdinal(92)` → "92nd", `toOrdinal(93)` → "93rd", `toOrdinal(100)` → "100th", `toOrdinal(121)` → "121st" (121 % 100 = 21 — NOT a teen exception; suffix is "st" via last-digit rule)
  - Edge (teen exceptions): `toOrdinal(11)` → "11th", `toOrdinal(12)` → "12th", `toOrdinal(13)` → "13th", `toOrdinal(111)` → "111th", `toOrdinal(112)` → "112th"
  - Edge (boundary): `toOrdinal(0)` → "0th"

  **Verification:**
  - `npm test` passes with new `toOrdinal` cases
  - `npm run typecheck` clean

---

- [ ] **Unit 2: Metric-grid CSS + constant cleanup**

  **Goal:** Add the five new `.cg-metric-*` CSS classes to the `bodyXHTML` style block; replace the `HEADLINE_COUNT_FONT_SIZE_PX` interpolation with the literal `24px`; remove the constant from `src/constants.ts` and its import from `citationPane.ts`. No behavioral change — this unit is CSS and dead-code removal only.

  **Requirements:** R3, R10, R11, R12, R18

  **Dependencies:** None (CSS-only; JS behavior unchanged)

  **Files:**
  - Modify: `src/modules/citationPane.ts`
  - Modify: `src/constants.ts`

  **Approach:**
  Apply in this order to avoid compile errors between steps:
  1. In `src/modules/citationPane.ts` CSS block: replace `font-size: ${HEADLINE_COUNT_FONT_SIZE_PX}px;` in `.cg-headline-count` with `font-size: 24px;` — this removes the only usage before the import is touched
  2. In `src/modules/citationPane.ts`: remove `HEADLINE_COUNT_FONT_SIZE_PX` from the named import at the top of the file (if it is the only constant imported from `src/constants.ts`, remove the entire import statement; if shared, remove only this token)
  3. In `src/constants.ts`: delete the `export const HEADLINE_COUNT_FONT_SIZE_PX = 24;` line from the `// ── Pane ──` section
  - Add new CSS classes after the existing `.cg-badge-top10` rule: `.cg-metric-grid`, `.cg-metric-tile`, `.cg-metric-label`, `.cg-metric-value`, `.cg-metric-badge` — see High-Level Technical Design for reference values. All colors must be hardcoded hex/rgba (no `var()`)

  **Patterns to follow:**
  - Existing hardcoded badge CSS (`.cg-badge-top1`, `.cg-badge-top10`) for color and radius conventions
  - No `var()` for palette colors — Zotero overrides custom properties silently

  **Test scenarios:**
  - Test expectation: none — this unit contains no behavioral logic, only CSS additions and constant removal

  **Verification:**
  - `npm run typecheck` passes with no `Cannot find name 'HEADLINE_COUNT_FONT_SIZE_PX'` error
  - `npm run build:dev` succeeds
  - Existing pane display is unchanged at this stage (`.cg-metric-*` classes exist but are not yet used by `renderPane`)

---

- [ ] **Unit 3: `renderPane()` metric grid render**

  **Goal:** Replace the headline div creation block in `renderPane()` with a 3-tile metric grid. Citations tile always shows count; FWCI tile shows formatted value or "—"; Percentile tile shows ordinal or "—" with badge underneath when earned. Book suppression and all other `renderPane` paths are unchanged.

  **Requirements:** R1, R2, R3, R4, R5, R6, R7, R8, R9, R13

  **Dependencies:** Unit 1 (toOrdinal helper), Unit 2 (CSS classes)

  **Files:**
  - Modify: `src/modules/citationPane.ts`

  **Approach:**
  - Locate the `const headline = doc.createElement("div")` block in `renderPane()` (currently lines 656–689) — this is the entire section to replace
  - Create a grid div (`cg-metric-grid`) containing three tile divs (`cg-metric-tile`), each with a label span (`cg-metric-label`) and value span (`cg-metric-value`)
  - Citations tile: label `"CITATIONS"`, value `escapeHTML(data.citedByCount.toLocaleString())`; set `title` attribute to the same formatted string so the full count is recoverable on hover when ellipsis clips it
  - FWCI tile: label `"FWCI"`, value `data.fwci !== null ? escapeHTML(data.fwci.toFixed(2)) : "—"`; set `title` to the formatted value (or "—")
  - Percentile tile: label `"PERCENTILE"`, value `data.percentile !== null ? escapeHTML(toOrdinal(Math.round(data.percentile))) : "—"`; set `title` to the ordinal string (or "—"); followed by a `.cg-metric-badge` span containing the badge HTML when `data.isTop1Percent` or `data.isTop10Percent` is true
  - Badge HTML inside `.cg-metric-badge`: reuse existing badge markup — `<span class="cg-badge cg-badge-top1">Top 1%</span>` or `<span class="cg-badge cg-badge-top10">Top 10%</span>` (same `if/else if` logic as the current code)
  - Assign tile HTML via `tile.innerHTML = tileHTML` consistent with existing `headline.innerHTML` pattern; use `escapeHTML()` on all interpolated values
  - The book-suppression branch (`if (isBook && data.citedByCount === 0)`) is above this block — leave it entirely unchanged
  - Do **not** touch `renderSuggestion()` — it continues using the retained `.cg-headline*` CSS

  **Patterns to follow:**
  - Existing `renderPane()` createElement + innerHTML pattern (lines 656–689)
  - `escapeHTML()` guards on every interpolated data value
  - `isTop1Percent`/`isTop10Percent` badge if/else if logic (existing logic, just relocated)

  **Test scenarios:**
  - Test expectation: none for the render function itself — no DOM test infrastructure exists for `citationPane.ts`. Verify via manual dev-install inspection in Zotero.
  - **Visual verification checklist (dev install):**
    - Item with citations + fwci + percentile + top-10% badge: 3 equal tiles visible, badge under Percentile tile, no metric dominates visually
    - Item with null fwci: FWCI tile shows "—"; other tiles render normally
    - Item with null percentile but isTop10Percent = true: Percentile tile shows "—" and badge still appears
    - Book with citedByCount = 0: no grid rendered, existing suppression note shown
    - Suggestion candidate (medium/high confidence): `renderSuggestion` speculative display unchanged — headline with `~` prefix still renders
    - Retraction banner: unchanged, appears above grid as before

  **Verification:**
  - `npm run typecheck` clean
  - `npm test` passes (no regressions in existing test suite)
  - `npm run build:dev` succeeds
  - Dev install in Zotero 7/8/9: 3-tile grid renders at equal weight, badge positioned correctly, all edge cases pass visual checklist above

## System-Wide Impact

- **Interaction graph:** `renderPane()` only. No callbacks, event handlers, observers, or middleware involved.
- **Error propagation:** No change — `renderPane` is called from the pane's `renderFn` callback; error handling in the caller is unchanged.
- **State lifecycle risks:** None — the grid is stateless HTML render; no persistent data written.
- **API surface parity:** `renderSuggestion()` uses `.cg-headline*` CSS which is retained. No other surface renders the pane headline.
- **Integration coverage:** The book-suppression branch (`isBook && citedByCount === 0`) is above the replaced code and is untouched — it remains the integration boundary for book handling.
- **Unchanged invariants:** `renderSuggestion()`, action buttons, trend line, retraction banner, and the `CachedData` interface are all unchanged. The new grid is purely additive within the non-suppressed `renderPane` path.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `display: grid` box model behaves unexpectedly in Zotero XUL pane context | First use in the codebase. If tiles collapse, fall back to `display: flex` with `flex: 1` or `calc(33.33% - 4px)` widths per tile |
| `var(--fill-primary)` retained in `.cg-headline-count` may still be overridden | Acceptable per R17 — that CSS is for `renderSuggestion` only; new grid tiles use hardcoded `#E7EEE9` |
| Long citation counts (e.g. "1,234,567") overflowing tile | Addressed in R11 and Unit 2: `overflow: hidden; white-space: nowrap; text-overflow: ellipsis` on `.cg-metric-value` |
| Removing the `HEADLINE_COUNT_FONT_SIZE_PX` import while other constants remain imported | Verify the import clause carefully — remove only the `HEADLINE_COUNT_FONT_SIZE_PX` token; do not accidentally drop other constants |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-19-citation-pane-metric-grid-requirements.md](docs/brainstorms/2026-04-19-citation-pane-metric-grid-requirements.md)
- Related code: `src/modules/citationPane.ts`, `src/constants.ts`, `src/modules/utils.ts`
- Related code: `test/utils.test.ts` — test file for new `toOrdinal` helper

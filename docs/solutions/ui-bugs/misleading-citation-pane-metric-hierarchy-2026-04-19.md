---
title: "Equal-weight metric tile grid for Zotero citation pane"
date: 2026-04-19
category: docs/solutions/ui-bugs
module: citationPane
problem_type: ui_bug
component: frontend_stimulus
severity: medium
symptoms:
  - Citation count rendered at 24px/font-weight-800, dominating the pane visually
  - FWCI and percentile displayed as subordinate inline text despite being the more analytically meaningful metrics
  - Visual hierarchy taught researchers that raw citation count is the primary bibliometric signal
root_cause: logic_error
resolution_type: code_fix
tags:
  - zotero-plugin
  - css-grid
  - bibliometrics
  - visual-hierarchy
  - css-var-override
  - metric-display
  - hardcoded-colors
  - ordinal-formatting
---

# Equal-weight metric tile grid for Zotero citation pane

## Problem

The citation pane rendered metrics with a false visual hierarchy: citation count appeared at 24px / font-weight-800 as a dominant headline, while FWCI (field-weighted citation impact) and percentile rank appeared as small subordinate inline text. FWCI is typically the more analytically meaningful metric for cross-disciplinary comparison, but the design implicitly told researchers the opposite.

## Symptoms

- Citation count dominated the pane at 24px bold — visually, it was "the number that matters"
- FWCI and percentile were rendered as inline companions after a separator dot, easily missed
- Layout was irregular when FWCI or percentile were null (conditional appends produced variable-width rows)
- Badge (Top 1% / Top 10%) floated inline in the headline row rather than anchored to percentile

## What Didn't Work

The original `.cg-headline` flex row design was intentional but wrong. Framing one metric as the "primary" number and subordinating the others is appropriate when there is a universally agreed-upon dominant metric — but for bibliometrics there isn't one. Citation count is field-size-dependent (a chemistry paper with 400 citations and an education paper with 40 are not comparable); FWCI normalizes for this and is often the metric that matters most. The headline design was not a missing feature — it was a wrong default that needed to be replaced entirely.

## Solution

Replaced the `.cg-headline` flex row in `renderPane()` with a 3-tile equal-weight CSS grid. All three metrics — Citations, FWCI, Percentile — receive identical visual treatment.

### CSS (added to `src/modules/citationPane.ts` styles block)

**Critical: all colors are hardcoded hex/rgba. Never use `var()` in Zotero pane CSS** — Zotero injects its own stylesheet that silently resolves CSS custom properties to its own values, overriding any fallback you specify. This applies to every color property.

```css
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
  background: rgba(143,173,159,0.06);
  border: 1px solid rgba(143,173,159,0.12);
  border-radius: 6px;
  padding: 10px;
  overflow: hidden;
}
.cg-metric-label {
  display: block;
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #8A9E95;         /* hardcoded — no var() */
  margin-bottom: 4px;
}
.cg-metric-value {
  display: block;
  font-size: 20px;
  font-weight: 600;
  color: #E7EEE9;         /* hardcoded — no var() */
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.cg-metric-badge {
  display: block;
  margin-top: 4px;
  margin-left: 0;         /* overrides inherited margin-left: 4px from .cg-badge */
}
```

### TypeScript in `renderPane()` (replacing the old headline block)

```typescript
const grid = doc.createElement("div");
grid.className = "cg-metric-grid";

// Citations tile
const citCount = escapeHTML(data.citedByCount.toLocaleString());
const citTile = doc.createElement("div");
citTile.className = "cg-metric-tile";
citTile.innerHTML = `<span class="cg-metric-label">CITATIONS</span><span class="cg-metric-value" title="${citCount}">${citCount}</span>`;
grid.appendChild(citTile);

// FWCI tile
const fwciVal = data.fwci !== null ? escapeHTML(data.fwci.toFixed(2)) : "—";
const fwciTile = doc.createElement("div");
fwciTile.className = "cg-metric-tile";
fwciTile.innerHTML = `<span class="cg-metric-label">FWCI</span><span class="cg-metric-value" title="${fwciVal}">${fwciVal}</span>`;
grid.appendChild(fwciTile);

// Percentile tile (with optional badge)
const pctVal = data.percentile !== null
  ? escapeHTML(toOrdinal(Math.round(data.percentile)))
  : "—";
let pctHTML = `<span class="cg-metric-label">PERCENTILE</span><span class="cg-metric-value" title="${pctVal}">${pctVal}</span>`;
if (data.isTop1Percent) {
  pctHTML += `<span class="cg-metric-badge"><span class="cg-badge cg-badge-top1">Top 1%</span></span>`;
} else if (data.isTop10Percent) {
  pctHTML += `<span class="cg-metric-badge"><span class="cg-badge cg-badge-top10">Top 10%</span></span>`;
}
const pctTile = doc.createElement("div");
pctTile.className = "cg-metric-tile";
pctTile.innerHTML = pctHTML;
grid.appendChild(pctTile);

container.appendChild(grid);
```

### `toOrdinal` utility (added to `src/modules/utils.ts`)

Percentile values should display as proper ordinals (92nd, 93rd, 11th — not bare integers). The 11–13 check handles the irregular English teen cases.

```typescript
export function toOrdinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const mod10 = n % 10;
  if (mod10 === 1) return `${n}st`;
  if (mod10 === 2) return `${n}nd`;
  if (mod10 === 3) return `${n}rd`;
  return `${n}th`;
}
```

## Why This Works

**Equal visual weight lets users decide which metric matters.** Citation count is field-size-dependent; FWCI normalizes for field size. A researcher comparing across disciplines should weight FWCI highest. A researcher tracking their own citation growth over time might care most about raw count. The tile grid makes no claim about which metric wins — it presents all three peers and leaves the judgment to the researcher.

**Stable layout regardless of null data.** With the headline approach, FWCI and percentile were conditionally appended, producing variable-width rows when data was missing. With equal tiles, every tile always renders — missing values display `"—"` and the layout remains stable.

**Zotero CSS constraint.** All new tile colors are hardcoded because `var(--any-token)` resolves to Zotero's own theme values, silently overriding fallbacks. The retained `.cg-headline-count` rule still uses `var(--fill-primary)` — this is acceptable because that rule only applies to `renderSuggestion()`, which is intentionally un-migrated.

## Prevention

- **Never `var()` in Zotero pane CSS.** Hardcode all color values as hex or rgba literals. The only exception is inherited rules that predate this constraint and are not being touched.
- **Use equal-weight tiles for multi-metric displays where no universal primary metric exists.** If there is a genuinely dominant metric for all users, a headline is fine. For bibliometrics (and most research analytics), there isn't one.
- **Null values → show `"—"`, never omit the tile.** Conditional tile removal creates layout instability and visually implies the metric doesn't exist rather than isn't available yet.
- **`title` attribute on `.cg-metric-value`.** Long values (e.g., `1,234,567` citations) will ellipsis-clip on narrow panes. The `title` attribute recovers the full value on hover.
- **`toOrdinal` for any percentile display.** Always import and use `toOrdinal(Math.round(percentile))` — never append a bare "th" suffix, which produces "11th" for 11th but also "21th" for 21st.

## Caution: `.cg-headline*` CSS rules are not dead code

`renderSuggestion()` (the render path for title-matched items lacking a DOI) still uses `.cg-headline`, `.cg-headline-count`, `.cg-headline-label`, `.cg-headline-sep`, and `.cg-headline-detail`. Those CSS class definitions were intentionally retained in the styles block after `renderPane()` was migrated to the tile grid.

Do not remove `.cg-headline*` CSS rules as dead code. Any future migration of `renderSuggestion()` to the tile grid should be a deliberate, tested change.

## Related Issues

- Released in v1.3.0 (2026-04-19)
- `src/modules/citationPane.ts` — CSS block (lines after `.cg-badge-top10`) + `renderPane()` headline block
- `src/modules/utils.ts` — `toOrdinal` export
- `src/constants.ts` — `HEADLINE_COUNT_FONT_SIZE_PX` removed (was only used in the headline CSS; replaced with literal `24px` in the retained `.cg-headline-count` rule)

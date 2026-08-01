---
type: issues
title: Citegeist — open issues
description: Open bugs and feature requests, tracked by priority.
timestamp: 2026-06-10
tags: [citegeist, issues]
---

# Citegeist — Open Issues

> **Last Updated:** 2026-07-20 (DIAG-001 + DEBT-010 closed: diagnostic codes and guards now cover the network dialog; settings pane swapped the dead `mailto` field for the `api_key` field.)
> **Previously:** 2026-07-18 (author-identity layer **v3.0.0 merged to `main`** #75, untagged — see STATUS.md; #72 stray-menu-section fixed in that merge. v2.0.4 released #57; v2.0.3 released #56. Closed issues archived to `docs/archive/issues-closed.jsonl`)

---

## Summary

| Priority     | Open |
| ------------ | ---- |
| P0 (Blocker) | 0    |
| P1 (High)    | 0    |
| P2 (Medium)  | 2    |
| P3 (Low)     | 8    |

---

## P0 — Blockers

_None currently._

---

## P1 — High Priority

_None currently._

---

## P2 — Medium Priority

### JOSS-001: Paper submission not yet filed

**Impact:** JOSS citation credibility + discoverability
**Fix:** Confirm target journal, run final checks on `paper/paper.md`, submit
**Found:** 2026-04-08 — paper.md exists and is complete, submission is the remaining step

### VERIFY-001: v3.0.0 pane needs a real-Zotero visual-verify before release

**Impact:** The v3.0.0 unified pane rebuild + the Zotero 8/9 context-fill sidenav icon are code-verified (451 tests, two review rounds) but not yet eyeballed in a running Zotero. Release gate.
**Fix:** Install `citegeist-3.0.0.xpi`, confirm the composition (hero → metric line → explore buttons → author link rows), the wide-pane cap, and that the sidenav icon renders in the Zotero 8/9 strip; fix any spacing/contrast issue as a follow-up commit to `main`.
**Found:** 2026-07-18 — merged to `main` (#75); pending before tagging v3.0.0.

---

## P3 — Low Priority

### FEAT-003: Export citation metrics (CSV) for tenure packets

**Impact:** Researchers manually copy numbers from Citegeist into spreadsheets
**Fix:** Right-click collection → "Export Citation Report (Citegeist)" → CSV
**Effort:** Medium

### FEAT-004: Collection-level analytics dashboard

**Impact:** No aggregate view of a collection's FWCI/percentile distribution
**Fix:** Aggregate stats pane for selected collection (median FWCI, percentile distribution, top papers)
**Effort:** Medium-High

### VERIFY-002: openalex:author relation handoff — 2-device sync round-trip check

**Impact:** The native `openalex:author` item-relation handoff (Phase B, U5) hasn't been confirmed to survive a real Zotero 2-device sync round-trip; `citegeist.sqlite`-direct read is the documented fallback.
**Fix:** Resolve authors on device A, sync, confirm the relations arrive intact on device B.
**Effort:** Low (manual check)

### DEBT-011: Add-button aria-label interpolates the collection name unescaped

**Impact:** `results.ts` and `actions.ts` build the citation-network "+ Add to _Collection_" button via `safeInnerHTML`, and the visible label escapes the collection name (`escapeHTML(defaultName)`) but the sibling `aria-label` interpolates it raw. A collection named with `<`/`&`/quotes yields a malformed attribute; low XSS risk (attribute context, DOMParser-parsed) but an inconsistency. Pre-existing on `main` (predates this branch) — surfaced by the multi-round review, carved out to keep the review PR single-concern.
**Fix:** wrap the `defaultName` interpolation in the aria-label with `escapeHTML`, both sites.
**Effort:** Trivial.

### DEBT-014: Menu batch-runners duplicate a ~30-line skeleton four ways

**Impact:** `menu.ts` has four near-identical batch handlers — `runFetchSelected`, `runFetchCollection` (pre-existing on `main`) and `runResolveAuthorsSelected`, `runResolveAuthorsCollection` (added this branch) — each repeating the ProgressWindow + ItemProgress setup, empty-eligible alert, try/batch/catch "…failed — see Debug Output", and setProgress(100)+summary+close-timer. A later fix to the boilerplate in one silently misses the other three (the same drift class the "Done — 0 updated" summary fix already had to chase). The branch widened it 2→4.
**Fix:** extract one `runBatchOverItems(win, { gather, headline, itemLabel, run, summarize })` helper and route all four actions through it. Deferred out of the review PR: it also refactors two pre-existing `main` functions, so it belongs in its own single-concern change, not the diagnostics branch.
**Effort:** Small–medium.

### DEBT-013: Preferences update-check status colours are hardcoded hex

**Impact:** `addon/content/preferences.xhtml`'s `showStatus()` sets the update-check status line colour inline (`#c0392b` / `#27ae60` / `#e67e22`) rather than via `--cg-*` tokens, so those three states don't adapt to the Zotero light/dark theme — the same class of issue the component CSS is guarded against. Pre-existing on `main`; the pane is the legacy update-checker, not the diagnostics UI this branch touched. Surfaced by the multi-round review, carved out to keep the review PR single-concern.
**Fix:** route the three states through theme-aware tokens (danger / success / warning) instead of inline hex.
**Effort:** Small.

### DEBT-012: Debounced column repaint can fire after column teardown

**Impact:** `citationColumn.ts` `unregisterCitationColumn` clears `fetchTimer` but not `repaintTimer`, so a repaint debounced within `COLUMN_REPAINT_DEBOUNCE_MS` (150ms) of teardown still fires against a torn-down column. Blast radius is tiny (one `refreshAndMaintainSelection` on an unregistered column, already null-guarded) and it is pre-existing on `main`, so the review verifier ruled it a non-defect — but it is a real stray-timer leak worth tidying. Carved out to keep the review PR single-concern.
**Fix:** clear `repaintTimer` in `unregisterCitationColumn` alongside `fetchTimer`.
**Effort:** Trivial.

### DEBT-009: v3.0.0 review advisory residuals

**Impact:** Minor, non-blocking items surfaced by the v3.0.0 code review (all verified non-defects): a dangling `aria-labelledby="cg-tab-citing"` on the author-mode dialog body, the duplicated 6-row skeleton loop in `dialog.ts`, and `persistProfileMetrics` able to null-overwrite a cached exact metric. (The inline `ProgressWindow` dwell-timer literals noted here previously are now extracted to `constants.ts`.)
**Fix:** Address opportunistically; none affect correctness.
**Effort:** Low

---

## Closed

Closed issues are archived as machine-readable JSONL in [`docs/archive/issues-closed.jsonl`](archive/issues-closed.jsonl) — 16 records as of 2026-06-10. When closing an issue, append a line there (`{"id","title","resolution","date","archived_at"}`) instead of growing a table in this file, so the active tracker stays focused on open work.

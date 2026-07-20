---
type: issues
title: Citegeist — open issues
description: Open bugs and feature requests, tracked by priority.
timestamp: 2026-06-10
tags: [citegeist, issues]
---

# Citegeist — Open Issues

> **Last Updated:** 2026-07-18 (author-identity layer **v3.0.0 merged to `main`** #75, untagged — see STATUS.md; #72 stray-menu-section fixed in that merge. v2.0.4 released #57; v2.0.3 released #56. Closed issues archived to `docs/archive/issues-closed.jsonl`)

---

## Summary

| Priority     | Open |
| ------------ | ---- |
| P0 (Blocker) | 0    |
| P1 (High)    | 0    |
| P2 (Medium)  | 3    |
| P3 (Low)     | 5    |

---

## P0 — Blockers

_None currently._

---

## P1 — High Priority

_None currently._

---

## P2 — Medium Priority

### DIAG-001: extend diagnostic codes to the citation-network dialog

**Impact:** The dialog is the one significant surface not yet emitting coded states — a failure there still shows generic copy, so a user report about the citing/references browser carries no code. Its lifecycle handlers are also the remaining unguarded host callbacks (the pane, columns and menus are done).
**Fix:** Wrap the dialog's lifecycle + action handlers in `guardAsync`, and render `.cg-diag` for network/unexpected failures the same way the pane does. Extend `test/diagnostics-guard-invariants.test.ts` to cover it.
**Effort:** Low-Medium

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

### DEBT-010: settings pane still offers the dead `mailto` pref, and no API-key field

**Impact:** OpenAlex dropped the `mailto` polite pool in July 2026, but the settings pane still asks for an email and promises "faster speeds via their polite pool" — copy that is now simply untrue. Meanwhile the pref that *does* matter under the metered API, `api_key`, has no field at all, so the only way to raise the daily budget is to edit prefs by hand. Surfaced while adding the Troubleshooting section; deliberately not fixed in that change to keep it single-concern.
**Fix:** Remove the mailto row (leave the pref read for back-compat), add an `api_key` password field with a link to OpenAlex's key page, and point `CG-API42`'s copy at it.
**Effort:** Low

### DEBT-009: v3.0.0 review advisory residuals

**Impact:** Minor, non-blocking items surfaced by the v3.0.0 code review (all verified non-defects): a dangling `aria-labelledby="cg-tab-citing"` on the author-mode dialog body, the duplicated 6-row skeleton loop in `dialog.ts`, two inline `ProgressWindow` dwell-timer literals (5000/6000) not in `constants.ts`, and `persistProfileMetrics` able to null-overwrite a cached exact metric.
**Fix:** Address opportunistically; none affect correctness.
**Effort:** Low

---

## Closed

Closed issues are archived as machine-readable JSONL in [`docs/archive/issues-closed.jsonl`](archive/issues-closed.jsonl) — 16 records as of 2026-06-10. When closing an issue, append a line there (`{"id","title","resolution","date","archived_at"}`) instead of growing a table in this file, so the active tracker stays focused on open work.

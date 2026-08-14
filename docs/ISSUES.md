---
type: issues
title: Citegeist — open issues
description: Open bugs, verification gates, and technical debt, tracked by priority.
timestamp: 2026-08-13
tags: [citegeist, issues]
---

# Citegeist — Open Issues

> **Last Updated:** 2026-08-13 (planning unification: FEAT-003/FEAT-004 moved out — feature requests live in `BACKLOG.md` + GitHub `enhancement` issues; this tracker carries bugs, verification gates, and debt only.)
> **Previously:** 2026-08-02 (GitHub-issue reconcile: the right-click-menu bug (#67/#72) is confirmed STILL OPEN on the released v2.0.5 by 3 users — the internal tracker had it marked fixed; added BUG-MENU + BUG-QUIT (#78) + OKF drift #79. **v2.0.5 is the last released version**, 2026-07-09.)
> 2026-07-20 (DIAG-001 + DEBT-010 closed: diagnostic codes and guards now cover the network dialog; settings pane swapped the dead `mailto` field for the `api_key` field). 2026-07-18 (author-identity layer **v3.0.0 merged to `main`** #75, untagged — see STATUS.md). Closed issues archived to `docs/archive/issues-closed.jsonl`.

---

## Summary

| Priority     | Open |
| ------------ | ---- |
| P0 (Blocker) | 0    |
| P1 (High)    | 2    |
| P2 (Medium)  | 2    |
| P3 (Low)     | 7    |

Feature requests are not tracked here — they live in [`BACKLOG.md`](BACKLOG.md) (curated detail) and GitHub `enhancement` issues (public intake).

---

## P0 — Blockers

_None currently._

---

## P1 — High Priority

### BUG-MENU: Right-click menu stops responding after one use on Zotero 8/9 (#67, #72)

**Impact:** On Zotero 8/9, the Citegeist context-menu entries can render without labels, and after using one entry the right-click menu stops opening on **any** item until the plugin is toggled off/on or Zotero restarts. Breaks a core surface for Z8/9 users. **Confirmed STILL BROKEN on the released v2.0.5 by three users** (MattGiulP, bwegge, scolino — latest confirmation 2026-07-23), after two fix attempts (the v2.0.5 hotfix per [#67](https://github.com/phdemotions/zotero-citegeist/issues/67); registration-lifecycle plan `docs/plans/2026-07-06-001-fix-menu-manager-registration-lifecycle-plan.md`). The stray-empty-section half of #72 appears addressed; the "menu dies after use" half is not.
**Status:** `main`/v3.0.0 carries further MenuManager registration + teardown work (the code cites #67/#72), but it is **unverified on a real Zotero 9** and unreleased — so from a user's view it is still open. This is the top item on the `docs/RELEASE-CHECKLIST.md` right-click-menu gate; do not claim fixed until confirmed on a real Z9 install.
**Fix:** Needs a real-Zotero-9 debug session to find why the popup stops responding after the first `onCommand`/`onShowing` (likely a MenuManager `onShowing`/DOM-fallback interaction that corrupts the native popup). Keep #67 and #72 open until users confirm.
**Found:** #67 2026-06-25, #72 2026-07-14.

### BUG-QUIT: Zotero 9.0.6 hangs on quit → force-quit required (#78)

**Impact:** With Citegeist enabled, quitting Zotero 9.0.6 shows a spinning loader and never exits; the user must force-quit. Reported on v2.0.5 / macOS. A hang on every quit is severe.
**Status:** Not yet reproduced or root-caused. `main`/v3.0.0 reworked the shutdown path (bounded cache-drain capped at `CLOSE_CACHE_DRAIN_TIMEOUT_MS`, explicit `chromeHandle.destruct()` on shutdown), which **may** address it, but it is a distinct symptom that needs real-Z9 confirmation. Added to the release-checklist smoke as a "clean quit, no hang" check.
**Fix:** Reproduce on real Z9.0.6; trace `onShutdown` (`hooks.ts`) — an unresolved await in menu/cache teardown, or the `registerChrome`/GC path — as the likely culprit.
**Found:** 2026-07-23.

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

### OKF-DRIFT: Upstream OKF spec has drifted from the pinned commit (#79)

**Impact:** `npm run okf:drift` reports drift — pinned `ee67a5c` vs upstream `3fcbb9f` ([compare](https://github.com/GoogleCloudPlatform/knowledge-catalog/compare/ee67a5ca27044ebe7c38385f5b6cffc2305a9c1a...3fcbb9f828c2f23d109c855ee403c3a4c81f3a96)). Docs-only; no code impact.
**Fix:** The deliberate monthly action — review the `okf/SPEC.md` diff, update conforming docs if needed, then re-pin in `~/developer/docs/standards/okf-adoption.md` (canonical) + `docs/STANDARDS.md`. Never auto-follow `main`.
**Found:** 2026-07-25 (#79).

### VERIFY-002: author-relation purge + sync-safety — 2-device check

**Impact:** The native `openalex:author` item relation was **disabled before release** (it halts Zotero sync — server rejects the custom predicate) and replaced by a direct `citegeist.sqlite` read; a one-time startup purge (`purgeAllAuthorRelations`, pref-guarded) strips any stray relations left by pre-release builds. This hasn't been confirmed on a real 2-device sync — the check is now that the purge runs and library sync stays clean, **not** that a relation round-trips (it no longer should).
**Fix:** On device A that ran a pre-release build (or after resolving authors), confirm library sync completes with no 400 / "Made no progress during upload", and device B syncs clean. Confirm author data is present on B via the pane (SQLite is per-device; not synced — that's expected).
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

# Citegeist — Open Issues

> **Last Updated:** 2026-06-10 (v2.0.3 staged #56: settings shortcut + section-icon fix + light/dark theme fix + shared button primitives; opened DEBT-008 to finish the primitive unification as a follow-up. Earlier: any-identifier browser #50; DEBT-006 + DEBT-007 closed — work-id-keyed dedup/filing; closed issues archived to `docs/archive/issues-closed.jsonl`)

---

## Summary

| Priority     | Open |
| ------------ | ---- |
| P0 (Blocker) | 0    |
| P1 (High)    | 0    |
| P2 (Medium)  | 1    |
| P3 (Low)     | 3    |

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

### DEBT-008: Finish the shared-primitive unification

**Impact:** Primitives are half-migrated — the pane's buttons compose from the shared `.cg-btn` (`src/modules/ui/components.ts`), but badges, chips, cards/banners, and the dialog's `.cg-picker-done` are still bespoke per-surface CSS. Spec (`docs/design-system/citegeist-primitives.html`) and code can drift (already do for button metrics).
**Fix:** (1) lift `.cg-badge`/`.cg-chip`/`.cg-card`/`.cg-banner` base chrome into `components.ts`, surface-specific semantic modifiers stay where their meaning lives; (2) migrate the dialog's `.cg-picker-done` → `.cg-btn--filled` and its badges/chips onto the shared base; (3) generate the gallery HTML from the emitters so spec/code can't drift; (4) add a token-purity test (primitives use `var(--cg-*)`, no raw hex); (5) codify "portaled UI forces `color-scheme`" (a `mountScoped` helper) — only the dialog portals to `doc.body` today, pickers nest inside it. Corrective-not-neutral for the suggestion card (the "smushed" one).
**Effort:** Medium
**Found:** 2026-06-10 — follow-up to #56's button-primitive layer + theme-resolver hoist

---

## Closed

Closed issues are archived as machine-readable JSONL in [`docs/archive/issues-closed.jsonl`](archive/issues-closed.jsonl) — 16 records as of 2026-06-10. When closing an issue, append a line there (`{"id","title","resolution","date","archived_at"}`) instead of growing a table in this file, so the active tracker stays focused on open work.

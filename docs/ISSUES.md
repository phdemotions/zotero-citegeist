# Citegeist — Open Issues

> **Last Updated:** 2026-06-10 (any-identifier citation-network browser shipped #50; DEBT-006 + DEBT-007 closed — work-id-keyed dedup/filing implemented; reconciled stale DEBT-005 + FEAT-TITLE; closed issues archived to `docs/archive/issues-closed.jsonl`)

---

## Summary

| Priority     | Open |
| ------------ | ---- |
| P0 (Blocker) | 0    |
| P1 (High)    | 0    |
| P2 (Medium)  | 1    |
| P3 (Low)     | 2    |

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

---

## Closed

Closed issues are archived as machine-readable JSONL in [`docs/archive/issues-closed.jsonl`](archive/issues-closed.jsonl) — 16 records as of 2026-06-10. When closing an issue, append a line there (`{"id","title","resolution","date","archived_at"}`) instead of growing a table in this file, so the active tracker stays focused on open work.

# Citegeist — Open Issues

> **Last Updated:** 2026-04-08

---

## Summary

| Priority | Open |
|----------|------|
| P0 (Blocker) | 0 |
| P1 (High) | 0 |
| P2 (Medium) | 3 |
| P3 (Low) | 4 |

---

## P0 — Blockers

*None currently.*

---

## P1 — High Priority

*None currently.*

---

## P2 — Medium Priority

### RANK-001: AJG rankings out of date (2021 edition bundled; 2024 available)
**Impact:** Researchers using AJG for tenure/promotion will see stale tier assignments
**Fix:** Source AJG 2024 tier assignments, update `src/data/journalRankings.ts`, rename column "AJG '24"
**Found:** BACKLOG audit 2026-04-08

### RANK-002: ABDC rankings — 2025/2026 edition expected
**Impact:** ABDC is revising their list; current 2022 edition will become stale
**Fix:** Monitor ABDC for official release, then update tiers and column label
**Found:** BACKLOG audit 2026-04-08

### JOSS-001: Paper submission not yet filed
**Impact:** JOSS citation credibility + discoverability
**Fix:** Confirm target journal, run final checks on `paper/paper.md`, submit
**Found:** 2026-04-08 — paper.md exists and is complete, submission is the remaining step

---

## P3 — Low Priority

### FEAT-001: Non-DOI identifier fallback (PMID, arXiv)
**Impact:** Preprints and older biomedical papers without DOIs show blank columns
**Fix:** Fall back to `works/pmid:` and `works/arxiv:` identifiers when no DOI present
**Effort:** Low — OpenAlex supports both endpoints

### FEAT-002: Sort citation network results by FWCI
**Impact:** Users can only sort by citation count, year, title — not field-normalized impact
**Fix:** Wire FWCI into the sort controls in `citationNetwork/results.ts`
**Effort:** Low — data already in OpenAlex response

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

| ID | Title | Resolution | Date |
|----|-------|------------|------|
| CI-001 | `npm ci` fails with EBADPLATFORM on openharmony optional dep | Switched workflows to `npm install` | 2026-04-08 |
| CODE-001 | Inner function declaration in `collectionPicker.ts` (ESLint error) | Converted to arrow function const | 2026-04-08 |
| CODE-002 | `normalizeError(undefined)` returned `undefined` despite `: string` return type | Added explicit null/undefined guards | 2026-04-08 |
| TOOL-001 | No ESLint/Prettier config | Added `.eslintrc.json`, `.prettierrc.json` | 2026-04-08 |

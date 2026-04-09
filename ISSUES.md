# Citegeist — Open Issues

> **Last Updated:** 2026-04-09 (v1.0.3)

---

## Summary

| Priority | Open |
|----------|------|
| P0 (Blocker) | 0 |
| P1 (High) | 0 |
| P2 (Medium) | 1 |
| P3 (Low) | 2 |

---

## P0 — Blockers

*None currently.*

---

## P1 — High Priority

*None currently.*

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

| ID | Title | Resolution | Date |
|----|-------|------------|------|
| CI-001 | `npm ci` fails with EBADPLATFORM on openharmony optional dep | Switched workflows to `npm install` | 2026-04-08 |
| CODE-001 | Inner function declaration in `collectionPicker.ts` (ESLint error) | Converted to arrow function const | 2026-04-08 |
| CODE-002 | `normalizeError(undefined)` returned `undefined` despite `: string` return type | Added explicit null/undefined guards | 2026-04-08 |
| TOOL-001 | No ESLint/Prettier config | Added `.eslintrc.json`, `.prettierrc.json` | 2026-04-08 |
| FEAT-002 | Sort citation network by FWCI | Added FWCI + percentile sort; `fwci`/`citation_normalized_percentile` added to `LIST_SELECT` | 2026-04-08 |
| FEAT-001 | Non-DOI identifier fallback (PMID, arXiv) | Full identifier chain: DOI → PMID → arXiv (Extra/archiveID/URL) → ISBN; `extractIdentifier()` shared across all layers | 2026-04-09 |
| FEAT-ISBN | ISBN support for books | `getWorkByISBN` added; zero-citation suppression in columns and pane; book/bookSection handled gracefully | 2026-04-09 |
| RANK-001 | AJG rankings out of date (2021 edition) | Rebuilt from master-journals.csv: 3177 journals, AJG 2024 edition, column renamed "AJG '24" | 2026-04-09 |
| RANK-002 | ABDC rankings — 2025/2026 edition expected | ABDC 2025 edition now bundled (2684 journals); column renamed "ABDC '25" | 2026-04-09 |

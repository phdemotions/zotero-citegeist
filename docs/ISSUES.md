# Citegeist — Open Issues

> **Last Updated:** 2026-06-10 (any-identifier citation-network browser shipped #50; DEBT-006 dialog-gate closed; reconciled stale issues DEBT-005 + FEAT-TITLE as already-done; opened DEBT-007 for the carved-out work-id-keying follow-up)

---

## Summary

| Priority     | Open |
| ------------ | ---- |
| P0 (Blocker) | 0    |
| P1 (High)    | 0    |
| P2 (Medium)  | 2    |
| P3 (Low)     | 2    |

---

## P0 — Blockers

_None currently._

---

## P1 — High Priority

_None currently._

---

## P2 — Medium Priority

### DEBT-007: Citation-network membership + collection filing keyed on DOI, not work id

**Impact:** The network browser detects "already in library" and files results into collections by DOI. For DOI-less works (common in ISBN-resolved book networks and preprints) a prior-session library item renders as "+ Add" — clicking it creates a silent duplicate — and the "File" button on a DOI-less just-added item silently no-ops. Pre-existing; widened by the any-identifier browser (#50) now letting books reach the dialog.
**Fix:** Re-key membership/dedup on the OpenAlex work id (new `getAllCachedOpenAlexIds()` cache helper + `existingWorkIds` in `NetworkState`); locate items for filing via `state.createdItemIds`/work id rather than a DOI search. Design tradeoff: a cache-sourced work-id set can carry a rare orphan false-positive (strictly less bad than today's silent duplicate, and self-heals on GC).
**Found:** ce-review adversarial pass 2026-06-10 — carved out of PR #50 to keep that PR single-concern. Spawned as a follow-up task.

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

| ID         | Title                                                                           | Resolution                                                                                                                                                                                                                                                                                                      | Date       |
| ---------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| CI-001     | `npm ci` fails with EBADPLATFORM on openharmony optional dep                    | Switched workflows to `npm install`                                                                                                                                                                                                                                                                             | 2026-04-08 |
| CODE-001   | Inner function declaration in `collectionPicker.ts` (ESLint error)              | Converted to arrow function const                                                                                                                                                                                                                                                                               | 2026-04-08 |
| CODE-002   | `normalizeError(undefined)` returned `undefined` despite `: string` return type | Added explicit null/undefined guards                                                                                                                                                                                                                                                                            | 2026-04-08 |
| TOOL-001   | No ESLint/Prettier config                                                       | Added `.eslintrc.json`, `.prettierrc.json`                                                                                                                                                                                                                                                                      | 2026-04-08 |
| FEAT-002   | Sort citation network by FWCI                                                   | Added FWCI + percentile sort; `fwci`/`citation_normalized_percentile` added to `LIST_SELECT`                                                                                                                                                                                                                    | 2026-04-08 |
| FEAT-001   | Non-DOI identifier fallback (PMID, arXiv)                                       | Full identifier chain: DOI → PMID → arXiv (Extra/archiveID/URL) → ISBN; `extractIdentifier()` shared across all layers                                                                                                                                                                                          | 2026-04-09 |
| FEAT-ISBN  | ISBN support for books                                                          | `getWorkByISBN` added; zero-citation suppression in columns and pane; book/bookSection handled gracefully                                                                                                                                                                                                       | 2026-04-09 |
| RANK-001   | AJG rankings out of date (2021 edition)                                         | Rebuilt from master-journals.csv: 3177 journals, AJG 2024 edition, column renamed "AJG '24"                                                                                                                                                                                                                     | 2026-04-09 |
| RANK-002   | ABDC rankings — 2025/2026 edition expected                                      | ABDC 2025 edition now bundled (2684 journals); column renamed "ABDC '25"                                                                                                                                                                                                                                        | 2026-04-09 |
| DEBT-001   | Pane "no identifier" message missing ISBN                                       | Copy updated; `cg-no-doi` → `cg-no-identifier`                                                                                                                                                                                                                                                                  | 2026-04-09 |
| DEBT-002   | `menu.ts` right-click guards check DOI only                                     | Both guards replaced with `extractIdentifier(item) !== null`                                                                                                                                                                                                                                                    | 2026-04-09 |
| DEBT-003   | `bumpp` v9.x carries high-severity CVEs in `tar`                                | Upgraded to bumpp@10.4.1 + esbuild@0.28.0                                                                                                                                                                                                                                                                       | 2026-04-09 |
| DEBT-004   | `isBookType` duplicated in two modules                                          | Extracted to `utils.ts`; `citationColumn.ts` + `citationPane.ts` both import it (confirmed deduped 2026-06-08)                                                                                                                                                                                                  | 2026-06-08 |
| DEBT-006   | Citation network dialog hard-gated on DOI despite multi-identifier resolver     | Dialog + menu now share `canResolveWork`/`resolveWorkForItem`; browser opens for PMID/arXiv/ISBN/confirmed-match items. Citing/reference queries already ran off the OpenAlex work id, not a DOI — the gate was an unnecessary limitation (the 2026-04-09 audit's "genuinely needs a DOI" assumption was wrong) | 2026-06-10 |
| DEBT-005   | `FetchResult` is not a proper discriminated union                               | Now a status-tagged union (`{ status: "ok" \| "cached" \| "error" \| "suggestion" }`) in `citationService.ts`; callers narrow on `status`. Landed with the title-match suggestion branch (v2.0.1)                                                                                                               | 2026-06-08 |
| FEAT-TITLE | Metadata-based matching for items without a recognized identifier               | Title+year search (`searchByMetadata`/`attemptTitleSearch`) with confidence-tiered confirm/dismiss card and DOI graduation on confirm; redesigned card shipped v2.0.1 (#36)                                                                                                                                     | 2026-06-08 |

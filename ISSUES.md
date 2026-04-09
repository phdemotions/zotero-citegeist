# Citegeist — Open Issues

> **Last Updated:** 2026-04-09 (v1.0.3)

---

## Summary

| Priority | Open |
|----------|------|
| P0 (Blocker) | 0 |
| P1 (High) | 3 |
| P2 (Medium) | 4 |
| P3 (Low) | 2 |

---

## P0 — Blockers

*None currently.*

---

## P1 — High Priority

### DEBT-001: Pane "no identifier" message missing ISBN
**Impact:** A researcher with a book and no ISBN sees "No DOI, PubMed ID, or arXiv ID found" — the message implies ISBN won't help, but it would. Actively misleads the book-focused users v1.1.0 was built to serve.
**Fix:** `citationPane.ts:209` — update copy to "No recognized identifier found. Add a DOI, PMID, arXiv ID, or ISBN to enable citation data." Also rename `cg-no-doi` CSS class → `cg-no-identifier`.
**Found:** Session audit 2026-04-09 (/cdo 🔴)

### DEBT-002: `menu.ts` right-click guards check DOI only — breaks non-DOI items
**Impact:** "View Citing Works" and "View References" are hidden for any item resolved via PMID/arXiv/ISBN, even when citation data is visible in the pane. A researcher sees citation counts but can't open the network browser from the same item — looks like a bug.
**Fix:** Replace DOI field checks in `menu.ts:48` and `menu.ts:101` with `extractIdentifier(item) !== null`.
**Found:** Session audit 2026-04-09 (/ux 🟠)

### DEBT-003: `bumpp` v9.11.1 carries four high-severity CVEs in `tar` dependency
**Impact:** Path traversal, symlink poisoning, and arbitrary file overwrite via hardlink — fires during every `npm run release`.
**Fix:** `npm install bumpp@^10 esbuild@^0.28.0` (esbuild also behind 3 minor versions; batch together). Update ranges in `package.json`.
**Found:** Session audit 2026-04-09 (/freshen 🔴)

---

## P2 — Medium Priority

### DEBT-004: `isBookType` duplicated in `citationColumn.ts` and `citationPane.ts`
**Impact:** When book item types expand (bookChapter, encyclopediaArticle), whoever updates one file will miss the other and the suppression logic silently drifts.
**Fix:** Extract to `src/modules/utils.ts` as `export function isBookType(item: _ZoteroTypes.Item): boolean`. Both modules already import from utils.
**Found:** Session audit 2026-04-09 (/wiring 🟠)

### DEBT-005: `FetchResult` is not a proper discriminated union
**Impact:** TypeScript can't narrow `work` to non-null via `success === true` check alone. Callers need redundant null checks. The planned `success: "suggestion"` branch for v1.2.0 breaks every `if (result.success)` since `"suggestion"` is truthy.
**Fix:** Before implementing v1.2.0, convert to status-tagged union: `{ status: "ok" | "cached" | "error" | "suggestion"; ... }`. Two-branch migration now (~30 min) means the suggestion branch is additive in v1.2.0.
**Found:** Session audit 2026-04-09 (/wiring 🟠, /zeitgeist 🟠)

### FEAT-TITLE: Metadata-based matching for items without a recognized identifier
**Impact:** Blank columns for all items without DOI/PMID/arXiv/ISBN — common for conference papers, working papers, grey literature
**Fix:** Title + year search against OpenAlex when direct lookup fails; confidence-tiered suggestion UX with Confirm/Dismiss; DOI population bonus on confirm
**Design:** Fully specced in DESIGN.md — see "Metadata-Based Matching" section
**Target:** v1.2.0

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

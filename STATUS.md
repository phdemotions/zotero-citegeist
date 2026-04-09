# Citegeist — Status

> **Last Updated:** 2026-04-09
> **Phase:** Post-v1.0.3 — Identifier Coverage & Rankings Refresh
> **Build:** Clean

---

## Current State

| Attribute | Value |
|-----------|-------|
| **Version** | 1.0.3 |
| **Build Status** | Clean (159 tests passing, typecheck clean, XPI 66.9 KB) |
| **Open Issues** | P0: 0, P1: 0, P2: 1, P3: 2 |
| **Stack** | TypeScript, esbuild, vitest, Zotero 7/8 bootstrap API |
| **Data Source** | OpenAlex (free, unauthenticated, CC0) |
| **Distribution** | GitHub Releases → auto-update via `release` floating tag |

---

## In Progress

*None currently.*

---

## What's Done (v1.0.3 — 2026-04-09)

### Non-DOI identifiers, ISBN support, and full rankings refresh

**Identifier resolution (`openalex.ts`, `citationService.ts`):**
- `extractIdentifier(item)` — priority-ordered resolver: DOI → PMID (Extra field) → arXiv (Extra / archiveID / URL) → ISBN
- `normalizePMID`, `normalizeArxivId`, `normalizeISBN` added alongside existing `normalizeDOI`
- `getWorkByPMID`, `getWorkByArxivId`, `getWorkByISBN` — three new OpenAlex lookup functions
- `FetchError` renamed from `"no-doi"` to `"no-identifier"`; all UI layers updated
- `extractIdentifier` is the single source of truth — shared by service, pane, and columns

**ISBN / book support (`citationColumn.ts`, `citationPane.ts`):**
- Books and book sections resolve via `works/isbn:` endpoint
- Zero citation counts suppressed in all three columns (blank cell) for book types with 0 citations
- Pane shows "Citation tracking for books is limited in OpenAlex." when count is 0; non-zero counts display normally

**Journal rankings (`journalRankings.ts`):**
- Rebuilt from master-journals.csv (single source of truth): 3177 primary entries + 2398 e-ISSN aliases
- AJG updated from 2021 → **2024** edition (1885 journals); column label → "AJG '24"
- ABDC updated from 2022 → **2025** edition (2684 journals); column label → "ABDC '25"
- UTD24 and FT50 flags preserved; `RANKING_VERSIONS = { utd24: "2024", ft50: "2024", abdc: "2025", ajg: "2024" }`
- `ISSN_ALIASES` table enables lookup by either print or electronic ISSN

**Tests:**
- 113 → 159 tests: `normalizePMID` (6), `normalizeArxivId` (10), `normalizeISBN` (9), `extractIdentifier` (15), `fetchAndCacheItem` coverage extended for all 4 identifier types
- `journalRankings.test.ts` updated to reflect new data (Journal of Finance, MIS Quarterly fixtures; AJG 2024 tiers; version strings)

---

## What's Done (v1.0.2 — 2026-04-08)

### Design polish + FWCI/percentile sort

Applied Opus Vita family design language (sage accent, ink-ramp neutrals, Slate dark palette) across the citation pane and network dialog. Added FWCI and percentile sort to the network browser.

**Design (`styles.ts`, `citationPane.ts`):**
- Sage accent (`#8FAD9F`) replaces blue throughout; ink-ramp neutrals replace macOS grey system colours
- Dialog background is now `#141D18` (family Slate palette), distinct from Zotero's chrome
- Citation pane buttons redesigned as equal-width ghost/outline buttons with sage accent
- All button hover/badge colours hardcoded to defeat Zotero CSS variable overrides (`--accent-blue` etc.)
- Open Access badge contrast bumped to WCAG AA; tab hit targets meet WCAG 2.5.8

**Features (`openalex.ts`, `dialog.ts`, `results.ts`):**
- `fwci` and `citation_normalized_percentile` added to `LIST_SELECT`
- Sort dropdown: "Highest FWCI" and "Top percentile" options added
- Nulls sort last in both new sort modes

---

## What's Done (v1.0.1 — 2026-04-08)

### Quality pass — error handling, tooling, tests, docs

Audit-driven hardening pass across the full codebase. No new user-facing features except a distinct "OpenAlex is currently unavailable" error message.

**Code:**
- `src/constants.ts` — all magic numbers centralized
- `src/modules/utils.ts` — `normalizeError`, `logError`, `OpenAlexNetworkError`, `safeHTML` tagged template, `rawHTML`
- `src/modules/openalex.ts` — `normalizeDOI` handles 6 URL forms; `reconstructAbstract` validates types/bounds/caps; `fetchJson` retries on 5xx; network errors propagate as `OpenAlexNetworkError`
- `src/modules/citationService.ts` — `FetchError` union type; graceful network vs. 404 distinction
- `src/modules/citationPane.ts` — real `<button>` elements with `:focus-visible`; graceful degradation messages
- `src/modules/citationNetwork/dialog.ts` — explicit `DialogPhase` state machine prevents close-mid-fetch races
- All caught errors now flow through `normalizeError`/`logError`

**Tests:** 86 → 113 (added `normalizeError`, `normalizeDOI`, `reconstructAbstract` hardening, `safeHTML`)

**Tooling:**
- ESLint + Prettier configured (`.eslintrc.json`, `.prettierrc.json`, `.prettierignore`)
- `lint`, `lint:fix`, `format`, `format:check` scripts added to `package.json`
- Dependabot weekly npm + monthly GitHub Actions updates
- Node 22 added to CI matrix
- CI/release workflows switched from `npm ci` to `npm install` (EBADPLATFORM workaround for openharmony optional dep)

**Docs:**
- `README.md` — intro rewritten in plain researcher language; comprehensive troubleshooting section added
- `CONTRIBUTING.md` — full developer setup, command reference, pre-PR checklist, architecture overview
- `BACKLOG.md` — created from ROADMAP_ISSUES.md (9 curated enhancement ideas)
- GitHub issue forms (bug report, feature request), PR template

**Infrastructure:**
- `CITATION.cff` version bumped to 1.0.1

---

## What's Done (v1.0.0 — 2026-04-05)

Initial public release. See `CHANGELOG.md` for full feature list.

---

## Blockers

*None currently.*

---

## Upcoming

| Task | Priority | Notes |
|------|----------|-------|
| JOSS paper submission | P2 | `paper/paper.md` exists; needs journal confirmation |
| Export citation metrics (CSV) | P3 | Right-click collection → export for tenure packets |
| Collection-level analytics | P3 | Aggregate FWCI/percentile for a folder |

See `BACKLOG.md` for full details.

---

## Release History

| Version | Date | Summary |
|---------|------|---------|
| 1.0.3 | 2026-04-09 | Non-DOI identifiers (PMID/arXiv/ISBN), rankings refresh (ABDC '25, AJG '24) |
| 1.0.2 | 2026-04-08 | Family design language, FWCI/percentile sort |
| 1.0.1 | 2026-04-08 | Quality pass: error handling, tooling, tests, docs |
| 1.0.0 | 2026-04-05 | Initial public release |

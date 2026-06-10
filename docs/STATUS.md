# Citegeist — Status

> **Last Updated:** 2026-06-10
> **Phase:** v2.0.2 released; `main` ahead with the any-identifier citation-network browser (#50) in [Unreleased], awaiting the next tagged release
> **Build:** Clean

---

## Current State

| Attribute        | Value                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------- |
| **Version**      | 2.0.2 (released 2026-06-08 — Zenodo concept DOI 10.5281/zenodo.19433716)                |
| **Build Status** | Clean (354 tests passing, typecheck clean, lint clean, XPI ~92 KB)                      |
| **Open Issues**  | P0: 0, P1: 0, P2: 1, P3: 2 (see ISSUES.md)                                              |
| **Stack**        | TypeScript 6, esbuild, vitest 4.1, ESLint 10, Zotero 7.0.10–9, SQLite, Node 22          |
| **Data Source**  | OpenAlex (free, unauthenticated, CC0)                                                   |
| **Distribution** | GitHub Releases → auto-update via `release` Release (self-maintaining); Zenodo-archived |

---

## In Progress

_None — working tree clean on `main`; PR #50 merged. The next tagged release will publish the [Unreleased] CHANGELOG entry to users._

**Merged to `main` 2026-06-10 (in [Unreleased], not yet tagged):** the citation-network browser now opens for **any** resolved identifier — DOI → PMID → arXiv → ISBN → confirmed title match — not just DOI, so "View Citing Works"/"View References" no longer dead-end on a "requires a DOI" alert (#50). The browser always queried OpenAlex by work id, so the DOI gate was an unnecessary limitation (an old audit's "genuinely needs a DOI" assumption was wrong). Resolution centralized in `canResolveWork`/`resolveWorkForItem`/`fetchWorkByIdentifier`; menu gating unified on `canResolveWork`. Hardened across four `ce-review` passes (correctness · adversarial · maintainability/perf/standards · security/api-contract) — zero P0–P2; added book-aware empty-state copy, menu/`getRow` hot-path perf, item-scoped resolve-error logging. Earlier the same session: static license badge + full README claim audit (#49 — fixed the stale device-sync FAQ, default-collection picker location, migration-backup path/retention).

**Merged to `main` 2026-06-10 (DEBT-007, follow-up to #50):** keyed citation-network library-membership and collection filing on the OpenAlex work id instead of DOI (#52). Fixes two pre-existing bugs for DOI-less works (books, preprints): a prior-session library item no longer renders as "+ Add" → silent duplicate, and the "File" button no longer no-ops. New `getAllCachedOpenAlexIds()` + `existingWorkIds` for dedup; `resolveLibraryItem()` (createdItemIds → cached-work-id reverse lookup → DOI search) for filing.

Also this session: closed issues moved to a machine-readable archive `docs/archive/issues-closed.jsonl` (#51).

**Shipped 2026-06-08 (v2.0.2):** dark-mode citation-network tint fix — the dialog's sage-tint scale had a self-referential dark-theme arm (`light-dark(…, var(--cg-sage-tint-NN))`), invalid at computed-value time, so every dark-mode tint collapsed to transparent; now defined correctly. Design tokens (spacing, radii, type, motion, color ramps) consolidated into a canonical module `src/modules/ui/tokens.ts` that both the item pane and the network dialog consume; `docs/design-system/citegeist-primitives.html` added as the design reference (#45). Pane visually unchanged.

**Shipped 2026-06-08 (v2.0.1):** batch/collection/library column repaint fix (#35), redesigned title-match confirm/discard card (#36), citation network browser improvements — new sort modes (first author, not-in-library) + hide-in-library filter + source-metadata header (#32), Zotero 8+ MenuManager with DOM fallback (#33), Zenodo DOI surfacing (#34), TS6/ESLint10/action-gh-release-v3 deps (#37). v2.0.0 (SQLite cache migration) shipped 2026-06-08 (#30).

**Possible next:** show the candidate's _authors_ in the title-match card — deferred because it needs a new `pending_authors` cache column + a schema migration (the cache uses plain `CREATE TABLE IF NOT EXISTS`, no column-add path). See BACKLOG.

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

_None currently._

---

## Upcoming

| Task                                                    | Priority | Notes                                                                                             |
| ------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| Fix pane copy + menu.ts DOI guards (DEBT-001, DEBT-002) | P1       | Quick fixes; complete the identifier chain end-to-end                                             |
| Upgrade bumpp→v10, esbuild→^0.28.0 (DEBT-003)           | P1       | 4 high-severity CVEs in bumpp; batch with esbuild update                                          |
| Extract isBookType to utils.ts (DEBT-004)               | P2       | 5-min fix before book type list grows                                                             |
| Migrate FetchResult to discriminated union (DEBT-005)   | P2       | Required before v1.2.0 suggestion branch                                                          |
| Metadata-based matching (v1.2.0)                        | P2       | Title+year search fallback; Confirm/Dismiss UX; DOI population bonus — fully specced in DESIGN.md |
| JOSS paper submission                                   | P2       | `paper/paper.md` exists; needs journal confirmation                                               |
| Export citation metrics (CSV)                           | P3       | Right-click collection → export for tenure packets                                                |
| Collection-level analytics                              | P3       | Aggregate FWCI/percentile for a folder                                                            |

See `BACKLOG.md` for full details.

---

## Release History

| Version | Date       | Summary                                                                      |
| ------- | ---------- | ---------------------------------------------------------------------------- |
| 2.0.2   | 2026-06-08 | Dark-mode dialog tint fix; canonical design-token module (both surfaces)     |
| 2.0.1   | 2026-06-08 | Column repaint fix, redesigned title-match card, network browser sort/filter |
| 2.0.0   | 2026-06-08 | SQLite-backed cache (migrated from Extra-field storage)                      |
| 1.0.3   | 2026-04-09 | Non-DOI identifiers (PMID/arXiv/ISBN), rankings refresh (ABDC '25, AJG '24)  |
| 1.0.2   | 2026-04-08 | Family design language, FWCI/percentile sort                                 |
| 1.0.1   | 2026-04-08 | Quality pass: error handling, tooling, tests, docs                           |
| 1.0.0   | 2026-04-05 | Initial public release                                                       |

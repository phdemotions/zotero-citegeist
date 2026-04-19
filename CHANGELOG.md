# Changelog

All notable changes to Citegeist will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] — 2026-04-19

### Changed

- **Citation pane redesign** — replaced the single headline row (large citation count + subordinate FWCI/percentile text) with an equal-weight 3-tile metric grid. Citations, FWCI, and Percentile each get an uppercase label and a semibold tabular-nums value at the same visual scale. The Top 1% / Top 10% badge moves to a sub-element of the Percentile tile. Null FWCI or percentile show "—" rather than being omitted. Percentile values are now rendered as proper ordinals (92nd, 93rd, 11th — not bare numbers).

### Added

- `toOrdinal(n)` utility in `utils.ts` — pure English ordinal formatter with correct teen exceptions (11th, 12th, 13th, 111th, …)

## [1.2.1] — 2026-04-19

### Fixed

- Zotero 9 compatibility: bumped `strict_max_version` from `8.*` to `9.*` so the plugin installs on Zotero 9. Full Zotero 9 API verification (pane, columns, menus) is ongoing.

## [1.2.0] — 2026-04-09

### Added

- **Metadata-based matching** — items with no recognized identifier (DOI, PMID, arXiv ID, or ISBN) are now matched to OpenAlex works by title, publication year, and author overlap. Scoring uses a weighted Dice coefficient (title 60%, year 25%, authors 15%). High-confidence matches (≥ 0.92) show speculative metrics with a `~` prefix and a confirmation banner in the citation pane; medium-confidence matches (≥ 0.72) show a candidate card for researcher review.
- **Confirm / Dismiss flow** — researchers can confirm or dismiss a suggested match from the citation pane. Confirming stores the OpenAlex work ID so future refreshes bypass title search entirely (direct ID lookup). Dismissing suppresses re-search for 30 days.
- **DOI population bonus** — after confirming a title match, if the matched work has a DOI and the Zotero item doesn't, Citegeist offers to add the DOI to the item field. Accepting permanently graduates the item out of the title-search pipeline.
- `searchByMetadata` in `titleSearch.ts` — standalone scoring module with exported `normalizeTitle`, `normalizeTitleTokens`, and `diceSimilarity` helpers (20 new unit tests)
- `searchWorksByTitle` in `openalex.ts` — OpenAlex title search endpoint with year filter
- `writePendingSuggestion`, `getPendingSuggestion`, `clearPendingSuggestion`, `confirmTitleMatch`, `writeNoMatch`, `isNoMatchSuppressed` — new cache primitives for the suggestion lifecycle
- `FetchResult` union extended with `{ status: "suggestion"; candidate; tier; confidence }` branch
- `FetchError` extended with `"no-match"` for items where title search found nothing

### Fixed

- Cache injection guard: all OpenAlex string values (`sourceId`, `issnL`, `sourceISSNs`, suggestion title/DOI/ID) are now stripped of `\r`/`\n` before writing to the Extra field
- `PendingSuggestion.year` typed as `number | null`; year display in the medium-confidence card is omitted when year is unavailable
- `isMatchTier` and `isMatchMethod` guard functions added; all `as MatchTier` / `as MatchMethod` casts replaced with runtime-checked alternatives
- DOI written to item field via `normalizeDOI()` normalization to ensure canonical format
- `processFetchQueue` now calls `invalidateColumnCache` immediately on `"suggestion"` result so column indicators update without waiting for the full batch refresh
- `getMetricsAndMaybeQueue` skips the fetch queue for items with no title and for items whose no-match suppression window has not expired, eliminating redundant API calls
- `STOP_WORDS` set moved to module scope in `titleSearch.ts` (was re-allocated on every `normalizeTitleTokens` call)

## [1.1.2] — 2026-04-09

### Added

- Settings pane now shows the installed version and a **Check for Updates** button — fetches `update.json` from GitHub and reports whether you're up to date, an update is available, or the check failed

## [1.1.1] — 2026-04-09

### Fixed

- Pane "no identifier" message now lists all four accepted identifiers: DOI, PMID, arXiv ID, and ISBN (previously omitted ISBN)
- Right-click "View Citing Works" and "View References" now visible for items resolved via PMID, arXiv ID, or ISBN — not just DOI
- Collection "Fetch All" and item "Fetch Citation Counts" now include items with PMID, arXiv, or ISBN identifiers
- `isBookType` extracted from `citationColumn` and `citationPane` into `utils.ts` (single source of truth)
- `FetchResult` converted to a proper TypeScript discriminated union (`status: "ok" | "cached" | "error"`) for correct compiler narrowing

### Changed

- `bumpp` upgraded from `^9.9.0` to `^10.0.0` (clears four high-severity CVEs in transitive `tar` dependency)
- `esbuild` upgraded from `^0.24.0` to `^0.28.0` (three minor versions, TypeScript 5.x correctness fixes)

## [1.1.0] — 2026-04-09

### Added

- **Non-DOI identifier support** — Citegeist now resolves citation data via PubMed ID (PMID), arXiv ID, and ISBN in addition to DOI. Priority order: DOI → PMID (Extra field) → arXiv (Extra field, Archive ID field, or arxiv.org URL) → ISBN. `extractIdentifier()` is the single shared resolver across the service, columns, and pane layers.
- `normalizePMID`, `normalizeArxivId`, `normalizeISBN` normalization functions alongside existing `normalizeDOI`
- `getWorkByPMID`, `getWorkByArxivId`, `getWorkByISBN` — three new OpenAlex lookup functions using `works/pmid:`, `works/arxiv:`, and `works/isbn:` endpoints
- **Book and book section support** — ISBN resolves to OpenAlex data; zero citation counts for books are suppressed in columns and the pane (replaced by "Citation tracking for books is limited in OpenAlex.")

### Changed

- `FetchError` value `"no-doi"` renamed to `"no-identifier"` — all UI layers updated
- Journal rankings rebuilt from comprehensive master list: **3,177 journals** (up from ~70 hand-curated entries), with an e-ISSN alias table so lookup works with either print or electronic ISSN
- **ABDC Quality List updated to 2025 edition** (2,684 journals); column label changed to "ABDC '25"
- **AJG Academic Journal Guide updated to 2024 edition** (1,885 journals); column label changed to "AJG '24"
- README "no DOI" FAQ rewritten to document the full identifier fallback chain
- JOSS paper updated: identifier chain, 3,177-journal coverage, ABDC 2025 / AJG 2024, comparison table row added for non-DOI identifiers

## [1.0.3] — 2026-04-08

### Fixed

- Citation pane action buttons now use `display: flex; align-items: center; justify-content: center;` so text is correctly centered in Zotero's XUL pane context (previously `text-align: center` was silently ignored)
- Increased button vertical padding from 12px to 14px for better visual weight

## [1.0.2] — 2026-04-08

### Added

- Citation network dialog now supports sorting by **Highest FWCI** and **Top percentile**, in addition to Most cited, Newest, and Oldest
- `fwci` and `citation_normalized_percentile` fields added to the OpenAlex list select, making them available for all works in the network browser

### Changed

- Opus Vita family design language applied throughout: sage accent (`#8FAD9F`) replaces blue, ink-ramp neutrals replace macOS grey system colours, Inter added to font stack
- Dialog background now uses the family's Slate palette (`#141D18`) — green-undertoned dark distinct from Zotero's chrome
- Citation pane buttons redesigned as equal-width ghost/outline buttons with sage accent; hover states now scoped to `#citegeist-pane-root` to prevent Zotero variable overrides
- `Top 10%` and `Top 1%` pane badges now use hardcoded sage/amber colours (previously overridden by Zotero's `--accent-blue` CSS variable)
- Open Access badge text bumped to sage-400 for WCAG AA contrast compliance
- Tab hit targets increased to meet WCAG 2.5.8 24px minimum
- Unreleased tooling changes from [Unreleased]: ESLint v9 flat config, `eslint-config-prettier` v10, `actions/setup-node` v6, Node 22 CI/release, `moduleDetection: "force"` in tsconfig

## [1.0.1] — 2026-04-07

### Added

- Graceful network-error handling: UI now distinguishes "OpenAlex is currently unavailable" from "work not found on OpenAlex", so transient outages no longer look like permanent missing data
- `src/constants.ts` — every tunable (rate limit, cache lifetimes, timeouts, page sizes, abstract safety caps) is now declared in one place
- ESLint + Prettier configuration with `lint`, `lint:fix`, `format`, and `format:check` scripts
- Dependabot config for weekly npm and monthly GitHub Actions updates
- GitHub issue forms (bug report, feature request) and a pull-request template
- Node 22 added to the CI matrix (in addition to Node 20)
- `BACKLOG.md` — curated roadmap of planned enhancements
- Expanded test coverage: `normalizeError`, `normalizeDOI`, hardened `reconstructAbstract` (malformed input, absurd positions, length cap), and the `safeHTML` tagged template

### Changed

- Citation pane buttons are now real `<button>` elements with `:focus-visible` outlines, replacing div-based click targets
- `reconstructAbstract` validates the OpenAlex inverted index more strictly: skips empty keys, non-array positions, non-integer and out-of-range offsets, and caps final abstract length
- `normalizeDOI` now handles `http://`, `https://`, `dx.doi.org`, `doi:` scheme, `%2F` encoding, and trailing slashes
- `citationNetwork` dialog uses an explicit phase state machine (`loading-skeleton` → `loading-data` → `ready` → `closed`) to eliminate races when the user closes the dialog mid-fetch
- All caught errors now flow through `normalizeError()` / `logError()` so stack traces survive in Zotero's debug output
- README intro rewritten in plain researcher language
- CONTRIBUTING.md expanded with dev-install instructions, full command reference, pre-PR checklist, and architecture overview

### Fixed

- `normalizeError(undefined)` previously returned `undefined` despite its `string` return type — now returns `"undefined"`
- OpenAlex 5xx responses are now retried instead of surfacing immediately as hard errors

## [1.0.0] — 2026-04-05

### Added

- **Nine sortable columns** in the Zotero item list:
  - Article metrics: Citations, FWCI, Percentile
  - Journal metrics: 2-year Mean Citedness, Journal H-Index
  - Journal rankings: UTD24 (2024), FT50 (2024), ABDC (2022), AJG (2021)
- **Citation Intelligence pane** in the item sidebar showing citation count, FWCI with plain-language explanation, percentile ranking, top 1%/10% badges, and year-over-year citation trend
- **Citation network browser** for forward and backward citation chaining, with sortable results, expandable abstracts, open-access and retraction badges
- **One-click import** from the citation browser with full metadata, default collection filing, and per-item collection picker
- **Right-click context menus** for fetching citations on individual items, multi-selections, and entire collections (including subcollections)
- **Settings panel** with configurable OpenAlex polite-pool email, auto-fetch toggle, cache lifetime, and results per page
- Centralized rate limiter (8 req/s with exponential backoff on 429s)
- Bundled ISSN ranking table (~180 journals) with 3-tier ISSN matching (item ISSN, cached OpenAlex ISSNs, in-memory source cache)
- Namespaced Extra field caching that syncs across devices via Zotero Sync
- Automatic update checking via GitHub Releases
- Retraction detection and open-access badges in the network browser
- Duplicate detection — papers already in your library are flagged and cannot be re-added
- Zotero 7 and Zotero 8 compatibility
- Test suite covering utilities, OpenAlex parsing, cache logic, journal rankings, and service orchestration
- CI pipeline with build, typecheck, and test stages
- JOSS paper, DESIGN.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md

[1.3.0]: https://github.com/phdemotions/zotero-citegeist/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/phdemotions/zotero-citegeist/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/phdemotions/zotero-citegeist/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/phdemotions/zotero-citegeist/releases/tag/v1.1.2
[1.1.1]: https://github.com/phdemotions/zotero-citegeist/releases/tag/v1.1.1
[1.1.0]: https://github.com/phdemotions/zotero-citegeist/releases/tag/v1.1.0
[1.0.3]: https://github.com/phdemotions/zotero-citegeist/releases/tag/v1.0.3
[1.0.2]: https://github.com/phdemotions/zotero-citegeist/releases/tag/v1.0.2
[1.0.1]: https://github.com/phdemotions/zotero-citegeist/releases/tag/v1.0.1
[1.0.0]: https://github.com/phdemotions/zotero-citegeist/releases/tag/v1.0.0

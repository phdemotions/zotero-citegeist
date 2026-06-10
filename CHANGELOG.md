# Changelog

All notable changes to Citegeist will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.3] — 2026-06-10

### Added

- **A settings shortcut (gear) in the Citation Intelligence pane header** opens
  Zotero → Settings → Citegeist directly — where the OpenAlex email and cache
  settings live. Zotero hosts plugin settings in its Settings dialog, not the
  Add-ons window, so this makes them easier to find.

### Changed

- **The citation network browser now opens for any item Citegeist can identify,
  not just items with a DOI.** "View Citing Works" and "View References"
  previously opened and then stopped with a "requires a DOI" message for papers
  found via PubMed ID, arXiv ID, or ISBN, or via a confirmed title match.
  Citegeist now resolves the work from whichever identifier the item has and
  loads its citation network directly. The right-click menu entries are enabled
  on the same basis, so they no longer dead-end on an alert.

### Fixed

- **The Citegeist icon now appears in the item pane's section header and
  sidenav.** It was blank because the icon relied on Zotero supplying a paint
  color (`context-fill`), which Zotero 7 doesn't do for full-color item-pane
  section icons; it now uses the self-colored mark.
- **No more duplicate library items when adding a result without a DOI.** In the
  citation network browser, a result already in your library but lacking a DOI
  (common for books and preprints) used to show "+ Add" and create a second
  copy when clicked. "Already in library" is now detected by the work's OpenAlex
  id, not just its DOI.
- **The "File" button now works for items added without a DOI.** Filing a
  DOI-less result into collections previously did nothing; it now finds the
  item by the id tracked when it was added (or its cached OpenAlex id) instead
  of a DOI lookup.

## [2.0.2] — 2026-06-08

### Fixed

- **Dark-mode tints in the citation network browser now render.** The dialog's
  sage tint scale (used for panel backgrounds, hover states, borders, tab fills,
  and badges) had a self-referential definition in its dark-theme branch, which
  CSS treats as invalid — so those tints silently fell back to transparent.
  They're defined correctly now, restoring the intended structure and depth in
  dark mode.

### Internal

- Design tokens (spacing, radii, type scale, motion, the sage/amber/danger
  color ramps) are consolidated into a single canonical module,
  `src/modules/ui/tokens.ts`, that both the item pane and the network dialog
  consume. Previously each surface defined its own near-duplicate set under
  different names. Values mirror the design reference at
  `docs/design-system/citegeist-primitives.html`. No visual change to the item
  pane; the dialog change is the dark-mode tint fix above.

## [2.0.1] — 2026-06-08

### Fixed

- **Citation columns now refresh after a batch fetch.** Selecting several items
  and running "Fetch Citation Counts", or "Fetch All Citation Counts" on a
  collection or the whole library, fetched and cached the data but didn't repaint
  the columns until you next sorted or scrolled. Rows now fill in as each item's
  data lands.

### Changed

- **The "possible match" card is redesigned.** When an item has no DOI, PMID,
  arXiv ID, or ISBN and Citegeist matches it by title, the confirmation card now
  shows the candidate's title, year, and estimated metrics together with a
  confidence label ("Strong" / "Possible") and a "View on OpenAlex" link — so you
  can see what you're confirming before you commit. (The high-confidence case
  previously showed metrics with no title at all.) Confirming now reads as a
  success even if the metrics take a moment to load, and it offers to add the
  matched DOI either way.
- **Citation network browser.** New ways to sort the citing/cited works — by
  first author, and "not in my library first" to surface works you haven't added
  yet — plus a "hide works already in my library" filter, and a header that shows
  the source paper's authors, venue, year, and citation count.
- Right-click menus register through Zotero 8+'s official MenuManager API where
  available (Zotero 8 and 9), with the existing direct-DOM approach as the
  fallback on Zotero 7.0.x. Same menus on every supported version.

### Internal

- Citegeist is archived on Zenodo with a citable DOI (concept DOI
  `10.5281/zenodo.19433716`); added the badge and CITATION.cff metadata.
- Toolchain moved to TypeScript 6 and ESLint 10; the release workflow now
  self-maintains the auto-update channel and uses action-gh-release v3.

## [2.0.0] — 2026-06-07

> **Major version bump.** v2.0.0 completely revamps how Citegeist stores
> cached citation data. The storage format moves from per-item Zotero
> `Extra` fields to a plugin-owned SQLite database, the minimum Zotero
> version goes up, and the upgrade requires a one-time migration of
> every item with previously-cached data. SemVer says that's a major
> bump — hence `2.0.0`, not `1.4.0`.
>
> See [`docs/MIGRATION-v2.0.0.md`](docs/MIGRATION-v2.0.0.md) for the
> full upgrade guide + recovery paths if anything goes wrong.

### Safety net (automatic, before any Extra field is touched)

- **Pre-migration JSON snapshot.** Before the migration mutates a single
  item, Citegeist writes a verbatim copy of every Extra field it's
  about to modify to `<dataDir>/citegeist-migration-backup-<timestamp>.json`
  keyed by `library_id` + `item_key`. The file is plain JSON and stays
  on disk indefinitely — open it in any text editor to restore an
  item's original Extra value by hand if anything looks wrong.
- **Post-migration alert** tells you the exact backup-file path on first
  successful migration, so the location is never lost.
- **Strict allowlist** for legacy `Citegeist.*` field names. Lines whose
  key isn't in the known v1.3.x field set (e.g. a user-typed
  `Citegeist.note: still useful`) are preserved verbatim in Extra,
  never stripped.
- **Round-trip invariant + sorted-multiset comparison** of every
  parsed Extra: if the parser can't perfectly reproduce the input,
  Citegeist writes the SQLite row but leaves the user's Extra
  untouched. Migration refuses to mark itself complete while any items
  remain unresolved, so the next launch retries them.

### Breaking

- **Zotero 7.0.10 or newer is now required.** `addon/manifest.json`'s
  `strict_min_version` is raised from `6.999` to `7.0.10`. Older Zotero
  builds silently ignore the `saveTx({ skipDateModifiedUpdate: true })`
  option Citegeist relies on during migration, which would mark every
  item as locally modified and trigger a full-library re-sync. The
  manifest bump prevents the plugin from loading on builds where the
  migration cannot run safely.
- **Storage format changed.** Cached citation data, FWCI, journal
  metrics, and match metadata now live in `<profile>/citegeist.sqlite`
  instead of each item's Extra field. A one-time migration runs on
  first launch and strips the legacy `Citegeist.*` lines. Plain
  downgrade to v1.x post-migration loses cached data (re-fetchable from
  OpenAlex on first column scan; users can also reinstall a v1.x XPI
  from Releases to read the surviving `Citegeist match ID:` line).

### Your library data is now untouched

Citegeist no longer writes any citation metrics, FWCI values, journal rankings, or
match metadata to the "Extra" field of your Zotero items. All cached data lives in
a plugin-owned SQLite file (`<profile>/citegeist.sqlite`) that doesn't touch your
bibliographic records.

If you uninstall Citegeist, your library is left exactly as it was.

### What this means for you

- **First launch after update**: a one-time migration moves existing Citegeist
  data out of Extra fields and into the new cache. Libraries with more than 500
  Citegeist-tagged items see a progress window; smaller migrations are instant.
  **A Zotero backup before the update is recommended.**
- **Confirmed title matches are preserved across devices.** When you manually
  confirm a title match, the OpenAlex ID is written back to Extra under
  `Citegeist match ID: …` (no leading namespace). This line syncs via Zotero Sync
  so you don't have to re-confirm on every device.
- **Other metrics are local per device.** Citation counts, FWCI, percentile, and
  journal data re-fetch automatically from OpenAlex on first view per machine.
  Expect a brief loading period when you first open Zotero on a new device.
  See README → "Multi-device behavior" for details.

### Interface, accessibility, and reliability polish

The storage rewrite was the bulk of this release, but the citation pane and
network browser got a thorough pass alongside it:

- **Keyboard and screen-reader support.** The Cited By / References tabs follow
  the standard accessible tabs pattern — arrow keys move between them, and the
  active tab, loading state, and match-suggestion changes are now announced to
  screen readers. The dialog's focus trap was rewritten to re-check which
  controls are reachable on every keypress, so it no longer snags on hidden ones.
- **Reduced motion.** Spinners and entrance animations stop moving when the
  system "reduce motion" setting is on. The only exception is the undo countdown
  bar — it stays animated because it's the sole cue for how long you have to undo.
- **No accidental double-actions.** Confirm, dismiss, and add-to-library buttons
  disable themselves the instant you click, so a fast double-click can't fire the
  same request twice or file the same paper into a collection twice. Failed
  imports now explain themselves inline under the row instead of failing quietly.
- **Columns refresh on their own.** Running "Fetch Citations" or a collection's
  "Fetch All Citation Counts" now repaints the citation columns as soon as the
  batch finishes, instead of showing stale values until you next sort or scroll.
- **Fewer redraw races.** Background column refetches and manual pane refreshes no
  longer step on each other, and a slow result for an item you've already clicked
  away from can no longer land in the pane after you've moved on.

### Build and dependencies

- Builds and tests on Node 22 LTS only, matching the `engines` field; `.nvmrc`
  pinned to 22.22.3.
- Added a Renovate config for scheduled dependency updates, with major bumps held
  back for manual review.

### Changed

- Storage layer rewritten from Zotero Extra-field namespace (`Citegeist.*`) to
  plugin-owned SQLite (`citegeist.sqlite`), following the documented Zotero 7+
  pattern used by Better BibTeX.
- `onStartup` now initializes the SQLite cache, runs the one-shot migration, and
  garbage-collects orphan rows before registering the column and pane.
- `clearCache(item)` retains its v1.3.x wide-clear semantics (work data + match
  meta + pending suggestion all cleared in one call).
- `confirmTitleMatch` now also writes a `Citegeist match ID: …` line back to
  Extra so user-curated confirmations survive plugin downgrade and propagate
  across devices via Zotero Sync.

### Hardening

- Composite `(library_id, item_key)` SQLite primary key so two items in
  different libraries with the same Zotero key never overwrite each other.
- OpenAlex IDs validated against `/^W\d+$/` and `/^S\d+$/` before any cache
  write. Defends against malformed or MITM'd responses that could otherwise
  flow through the Extra-field mirror and spoof CSL metadata.
- `Zotero.Sync.Runner.delaySync` wraps migration; post-migration spot check
  verifies stripped Extra fields haven't been resurrected by a sync merge.
- Per-key write serialization prevents mirror/SQLite divergence when a
  background column refetch races with a manual user refresh.
- `closeCache` drains pending writes with a 5-second timeout so a hung
  SQLite write doesn't block Zotero shutdown indefinitely.
- Migration's per-item loop is wrapped in try/catch — one corrupt item no
  longer livelocks all future launches.
- `shouldForceRerun` detects the silent-data-loss state where the
  completion pref is set but SQLite is empty AND legacy data still lives in
  Extra (e.g., antivirus quarantine, partial profile restore). Clears the
  pref and re-runs migration.
- Round-trip-skipped items now salvage their cached values to SQLite even
  when Extra parsing is ambiguous; migration refuses to mark complete while
  any items remain unresolved.
- `MIGRATION_MAX_CANDIDATES = 200_000` caps candidate processing so a
  malicious bulk-import can't wedge the sync engine for hours.

### Added

- `initCache`, `closeCache`, `migrateFromExtraV1`, and
  `garbageCollectOrphans` exports in `cache/index.ts`. `_resetForTesting`
  is exposed only via the deep `cache/db` path so production callers
  cannot accidentally nuke the cache via the public surface.
- In-memory mirror (`Map<itemKey, ItemCacheRow>`) so column `dataProvider` reads
  stay synchronous despite SQLite being async-only.
- Migration progress window (`Zotero.ProgressWindow`) shown for libraries with
  more than 500 legacy-formatted items.
- Crash-safe migration ordering: per-item SQLite write → Extra strip → checkpoint,
  with `INSERT OR REPLACE` and a `migration_progress` table making retries safe.
- Round-trip parse invariant: items whose legacy Extra cannot be parsed and
  reassembled byte-for-byte are skipped (not corrupted) with a debug log.
- Migration wrapped in `Zotero.Sync.Runner.delaySync` to prevent server-side
  merges from resurrecting stripped lines mid-loop.
- TypeScript declarations for `Zotero.DBConnection`, `Zotero.DB`, and
  `Zotero.Sync.Runner` in `typings/zotero.d.ts`.
- Constants `SHOW_PROGRESS_UI_THRESHOLD` and `MIGRATION_PROGRESS_TICK`.

### Removed

- All public writes to per-item Extra fields under the `Citegeist.*` namespace.
  The lone surviving Extra write is `Citegeist match ID: …` (no leading
  namespace), used exclusively for cross-device confirmation continuity.

### Out of scope (deferred to 1.5.x)

- Group library migration. v2.0.0 migrates the user library only; group library
  items lazily refetch from OpenAlex when viewed.
- Export / import of the SQLite cache as JSON.

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

[2.0.3]: https://github.com/phdemotions/zotero-citegeist/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/phdemotions/zotero-citegeist/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/phdemotions/zotero-citegeist/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/phdemotions/zotero-citegeist/compare/v1.3.0...v2.0.0
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

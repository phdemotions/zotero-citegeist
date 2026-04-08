# Design Rationale

This document explains the key architectural decisions behind Citegeist and the trade-offs involved. It is intended for reviewers, contributors, and anyone interested in why the plugin works the way it does.

---

## Why OpenAlex?

Citegeist needed a citation data source that met three constraints: free to use, open to anyone, and requires no authentication. Several options exist:

| Source                  | Free           | No Auth             | Field-Normalized Metrics | Open Data |
| ----------------------- | -------------- | ------------------- | ------------------------ | --------- |
| **OpenAlex**            | Yes            | Yes                 | FWCI + percentile        | Yes (CC0) |
| Crossref                | Yes            | Yes                 | No                       | Yes       |
| Semantic Scholar        | Yes            | API key recommended | No                       | Partial   |
| Scopus / Web of Science | No             | No                  | Yes                      | No        |
| Google Scholar          | Free to browse | No API              | No                       | No        |

OpenAlex is the only source that provides field-weighted citation impact (FWCI) and percentile rankings through a free, unauthenticated API. It indexes over 250 million works, covers journal-level metadata (2-year mean citedness, h-index, ISSNs), and is licensed CC0.

The polite pool (faster rate limits for users who provide an email) is optional, not required. This means Citegeist works out of the box with zero configuration.

**Trade-off:** OpenAlex's FWCI values may differ from Scopus/SciVal because the underlying corpus, field classification, and calculation methodology differ. We present OpenAlex's values as-is without modification, and note this in the JOSS paper.

---

## Why Field-Normalized Metrics Instead of Raw Counts?

Raw citation counts are misleading across disciplines. A paper in consumer psychology with 50 citations may be exceptional; the same count in biomedicine may be unremarkable. Existing Zotero citation plugins (ZoteroCitationCountsManager, zotero-citation-tally, zotero-google-scholar-citation-count) display raw counts without this context, leaving researchers to interpret them on their own.

Citegeist displays three complementary indicators:

- **FWCI** (Field-Weighted Citation Impact): Normalizes against the world average for papers of the same field, year, and document type. An FWCI of 1.0 means exactly average; 2.0 means twice the expected citations.
- **Percentile**: Intuitive ranking (e.g., "85th percentile" = cited more than 85% of comparable papers).
- **Raw count**: Still available for researchers who want it.

Sorting by FWCI surfaces papers that are genuinely influential relative to their field, rather than papers that happen to be in high-citation disciplines. This aligns with the responsible metrics principles advocated by the Leiden Manifesto and DORA.

**Trade-off:** FWCI and percentile are suppressed for papers with zero citations. Displaying "0th percentile" or an FWCI of 0.0 for a paper published last week would be misleading rather than informative.

---

## Why Bundled ISSN Ranking Tables?

Journal ranking lists (UTD24, FT50, ABDC 2022, AJG 2021) are stored as a static TypeScript lookup table keyed by ISSN-L. This was a deliberate choice over fetching rankings from an API:

1. **Instant results.** Ranking lookups are a hash map read with zero network latency. The columns populate immediately, even offline.
2. **No external dependency.** The ranking lists change infrequently (every few years). Bundling them avoids a runtime dependency on a third-party service that could go down, change its API, or start charging.
3. **Deterministic.** Every user sees the same rankings for the same journal. There are no API versioning surprises.
4. **Small footprint.** ~180 journals across business, management, economics, finance, IS, marketing, and psychology fit in a few kilobytes.

Updates happen at plugin release time. When ABDC or AJG publish new editions, we update the table and ship a new version.

**Trade-off:** Disciplines outside business and management are not covered. This is intentional scoping, not a technical limitation. The table is easily extensible, and we welcome contributions for other fields.

---

## Why the Extra Field for Caching?

Zotero items have an `Extra` field that supports arbitrary text. Citegeist stores all cached data there using namespaced keys:

```
Citegeist.citedByCount: 42
Citegeist.fwci: 2.31
Citegeist.percentile: 85.2
Citegeist.lastFetched: 2026-04-04T12:00:00Z
```

This approach was chosen over alternatives (a separate SQLite database, a JSON file, localStorage) for one critical reason: **Zotero Sync compatibility.** The Extra field syncs automatically across devices through Zotero's built-in sync. A researcher who fetches citation data on their office desktop will see it on their laptop at home without any additional configuration.

The cache layer parses and writes only lines prefixed with `Citegeist.`, preserving all other Extra field content (user notes, CSL variables, PMIDs, other plugin data) exactly as-is.

**Trade-off:** The Extra field is plain text, so we store flat key-value pairs rather than structured objects. This limits what we can cache per item, but the fields we need (counts, FWCI, percentile, source ID, journal metrics, timestamps) are all scalar values that serialize naturally.

---

## Why a Centralized Rate Limiter?

OpenAlex's polite pool allows 10 requests per second. Citegeist targets 8 req/s to stay safely below the limit. All API calls go through a single `rateLimitedFetch` function that:

1. Enforces a minimum 125ms interval between requests.
2. Retries on HTTP 429 with exponential backoff (2s, then 4s).

This matters because Citegeist has multiple concurrent callers: the auto-fetch triggered by browsing items, batch operations on entire collections, and the citation network browser paginating through results. Without centralization, each caller would independently track timing, and concurrent operations could easily exceed the rate limit.

A single-queue approach is simpler than a token bucket or sliding window and sufficient for a Zotero plugin where requests are inherently serial (one user, one machine).

**Trade-off:** Strict serialization means a burst of requests (e.g., batch-fetching 200 items) takes longer than if we could parallelize. In practice, 8 req/s processes a 200-item collection in ~25 seconds, which is acceptable for a background operation.

---

## Why This Module Structure?

The plugin is organized into focused modules rather than a single monolithic file:

```
src/modules/
  openalex.ts          → API client (fetch, parse, rate limit)
  cache.ts             → Extra field read/write
  citationService.ts   → Orchestration (fetch + cache + journal stats)
  citationColumn.ts    → Sortable column registration
  citationPane.ts      → Sidebar pane rendering
  menu.ts              → Right-click context menus
  citationNetwork/     → Citation browser (dialog, results, actions, styles, types)
    dialog.ts          → Modal lifecycle
    results.ts         → Result rendering and pagination
    actions.ts         → Add-to-library, undo, collection filing
    collectionPicker.ts → Collection selection UI
    types.ts           → Shared interfaces and constants
    styles.ts          → CSS-in-JS for the dialog
    index.ts           → Public API
src/data/
  journalRankings.ts   → Static ISSN-to-ranking lookup table
```

Each module has a single responsibility and communicates through typed interfaces. The citation network browser was split into six files because it handles dialog lifecycle, result rendering, library import actions, collection picking, and styling, which are distinct concerns that benefit from separation.

`citationService.ts` is the orchestration layer. It is the only module that imports both `openalex.ts` and `cache.ts`, keeping the API client and storage logic decoupled. Columns, panes, and menus all call the service layer rather than reaching into the API or cache directly.

**Trade-off:** More files means more indirection. But for a plugin with ~2,500 lines of TypeScript, the navigation cost is minimal and the testability benefit is significant. Each module can be unit-tested with focused mocks.

---

## Why esbuild?

Zotero 7+ plugins are distributed as `.xpi` files (renamed ZIP archives) containing JavaScript. We use esbuild to bundle all TypeScript modules into a single JS file because:

1. **Speed.** esbuild builds in under 100ms, making the development loop near-instant.
2. **Simplicity.** No Webpack configuration, no Babel plugins, no framework overhead. One build command.
3. **Single output file.** Zotero loads a single bootstrap script. A single-bundle approach means no module loader, no import maps, and no runtime dependency resolution inside Zotero's privileged chrome context.

**Trade-off:** esbuild does not perform type checking. We run `tsc --noEmit` separately for type safety, which is enforced in CI alongside the test suite.

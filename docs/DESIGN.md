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

Journal ranking lists (UTD24 2024, FT50 2024, ABDC 2025, AJG 2024) are stored as a static TypeScript lookup table keyed by ISSN-L, with an alias index for electronic ISSNs. This was a deliberate choice over fetching rankings from an API:

1. **Instant results.** Ranking lookups are a hash map read with zero network latency. The columns populate immediately, even offline.
2. **No external dependency.** The ranking lists change infrequently (every few years). Bundling them avoids a runtime dependency on a third-party service that could go down, change its API, or start charging.
3. **Deterministic.** Every user sees the same rankings for the same journal. There are no API versioning surprises.
4. **Reasonable footprint.** 3,177 journals across business, management, economics, finance, IS, marketing, and psychology fit in ~175 KB of generated TypeScript — a one-time XPI size cost, not a runtime overhead.

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

## Metadata-Based Matching (Title Search Fallback)

> **Status: Planned — v1.2.0**

When a direct identifier lookup fails — either because no identifier exists or because the API returned "not found" — Citegeist falls back to a metadata search using the item's existing Zotero fields. The goal is to surface citation data for as many items as possible while preserving the researcher's trust that the data is attached to the right paper.

### Trigger conditions

The fallback fires in exactly two cases:

1. `extractIdentifier(item)` returns `null` — no DOI, PMID, arXiv ID, or ISBN present
2. An identifier was found but the OpenAlex lookup returned `null` (work not found in the index)

In both cases, the same title search pipeline runs. A prior explicit dismiss (stored in `Citegeist.noMatch: true`) suppresses the search for 30 days, after which it retries automatically. A manual "Fetch Citation Counts" always retries regardless of the suppress flag.

### Search strategy

Citegeist issues a single OpenAlex query combining a title search with a year filter to reduce the candidate pool:

```
GET /works?filter=title.search:"<normalized-title>",publication_year:<year>
         &select=id,doi,display_name,publication_year,authorships,primary_location,
                 cited_by_count,fwci,citation_normalized_percentile,counts_by_year,
                 open_access,type,is_retracted
         &per-page=5
```

The title is normalized before querying: lowercased, punctuation stripped, common subtitle separators (`:`, `—`) removed. The year comes from `item.getField("date")` parsed to a four-digit integer. If the item has no year, the year filter is omitted and the top-5 results are scored by title similarity alone.

Only the top-ranked candidate after local scoring is considered — we never present a list of options or show multiple guesses.

### Confidence scoring

Candidates returned by OpenAlex are scored locally against three signals, weighted by their discriminating power for academic titles:

| Signal                   | Weight | Notes                                                                                 |
| ------------------------ | ------ | ------------------------------------------------------------------------------------- |
| Title similarity         | 60%    | Word-level Dice coefficient on normalized tokens                                      |
| Year match               | 25%    | Exact = 1.0, ±1 = 0.8, ±2 = 0.5, else = 0.0                                           |
| Author last-name overlap | 15%    | Fraction of Zotero authors matched in candidate; neutral (0.5) if item has no authors |

```
score = title_score × 0.60 + year_score × 0.25 + author_score × 0.15
```

Word-level Dice coefficient was chosen over character-level edit distance because academic titles share vocabulary (the, of, a, effects, …) and re-ordering of words is common. Dice on word sets handles this naturally without adding a string-distance dependency.

**Thresholds:**

| Tier                  | Score       | Behaviour                                                                                                           |
| --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| **High confidence**   | ≥ 0.92      | Data displayed immediately with `~` prefix; pane shows "Matched by title" banner with Confirm / Not this paper      |
| **Medium confidence** | 0.72 – 0.92 | No data in columns (`?` badge only); pane shows a suggestion card with full match details, Confirm / Not this paper |
| **No match**          | < 0.72      | Nothing shown; `Citegeist.noMatch: true` written with timestamp                                                     |

The high-confidence threshold (0.92) is conservative by design. A wrong citation count attached to the wrong paper in a tenure packet is worse than a blank cell. Researchers who want more coverage can confirm medium-confidence suggestions themselves.

### New Extra field keys

```
Citegeist.matchMethod: doi | pmid | arxiv | isbn | title-match
Citegeist.matchConfidence: high | medium          (only for title-match)
Citegeist.noMatch: true                           (written when score < 0.72 or user dismisses)
Citegeist.noMatchTimestamp: 2026-04-09T15:00:00Z  (for 30-day retry window)
```

`matchMethod` is written for all successful fetches going forward, giving a permanent audit trail distinguishing direct lookups from inferred ones.

### Updated result type

```typescript
type FetchResult =
  | { success: true; work: OpenAlexWork | null }
  | {
      success: false;
      error: "invalid-item" | "no-identifier" | "not-found" | "network" | "no-match";
    }
  | { success: "suggestion"; candidate: OpenAlexWork; tier: "high" | "medium"; confidence: number };
```

The `"suggestion"` branch is distinct from both `true` and `false` so that callers cannot accidentally treat an unconfirmed match as confirmed data.

### UI states

**Columns (`citationColumn.ts`):**

- Confirmed match: normal display
- High-confidence suggestion: `~42` (tilde prefix on Citations; FWCI and Percentile shown normally)
- Medium-confidence suggestion: `?` in Citations column; FWCI and Percentile blank
- No match / dismissed: blank (same as today's no-identifier)

**Pane (`citationPane.ts`):**

_High-confidence banner_ — sits above the metrics section, styled in amber (caution, not error):

> **Matched by title** — we couldn't find a direct identifier for this item, so we matched it by title, year, and authors. Please confirm this is the right paper.
>
> [Confirm match] [Not this paper]

_Medium-confidence card_ — replaces the metrics section entirely:

> **Possible match found**
> _[Candidate title]_
> [Authors] · [Journal] · [Year]
> 42 citations · FWCI 1.8
>
> [Confirm match] [Not this paper]

### Confirm / Dismiss flow

**On Confirm:**

1. Write all citation fields to Extra as usual
2. Write `Citegeist.matchMethod: title-match` and `Citegeist.matchConfidence: <tier>`
3. Write `Citegeist.openAlexId: W<id>` — future fetches go directly to `/works/W<id>`, bypassing title search entirely
4. If the matched work has a DOI and the Zotero item's DOI field is empty, show an inline prompt: **"Also add DOI to this item?"** (checkbox, default checked). If accepted: `item.setField("DOI", doi)` + `item.saveTx()`. After this, `extractIdentifier` will find the DOI directly on the next refresh — the item graduates out of the title-search pipeline permanently.
5. Re-render the pane in confirmed state; remove tilde from columns

**On "Not this paper":**

1. Write `Citegeist.noMatch: true` + `Citegeist.noMatchTimestamp: <now>`
2. Clear any speculatively displayed data
3. Pane shows: "No match confirmed. You can retry in 30 days or add a DOI manually."

**On automatic no-match (score < 0.72):**

1. Write `Citegeist.noMatch: true` + timestamp (silently — no UI disruption)
2. Columns stay blank; pane shows the existing "no identifier" message with an added note: "We also searched by title and found no confident match."

### New module

The matching logic lives in `src/modules/titleSearch.ts` to keep it decoupled from the service orchestration:

```typescript
// src/modules/titleSearch.ts

export interface TitleMatchResult {
  work: OpenAlexWork;
  confidence: number;
  tier: "high" | "medium";
}

export async function searchByMetadata(item: _ZoteroTypes.Item): Promise<TitleMatchResult | null>;

// Not exported — internal scoring
function scoreCandidate(candidate: OpenAlexWork, item: _ZoteroTypes.Item): number;
function normalizeTitleTokens(title: string): Set<string>;
function diceSimilarity(a: Set<string>, b: Set<string>): number;
function authorOverlap(item: _ZoteroTypes.Item, work: OpenAlexWork): number;
```

`citationService.ts` calls `searchByMetadata` after a failed direct lookup and returns the `"suggestion"` result type. It does not apply the match automatically — the pane and confirm flow handle that.

### New constants (`src/constants.ts`)

```typescript
export const TITLE_MATCH_HIGH_THRESHOLD = 0.92;
export const TITLE_MATCH_MEDIUM_THRESHOLD = 0.72;
export const TITLE_SEARCH_RESULTS = 5; // per-page for candidate query
export const NO_MATCH_RETRY_DAYS = 30;
```

### Trade-offs

**Why not auto-confirm high-confidence matches?** Because "high-confidence" in this context means ≥ 0.92 on a heuristic scoring function — not a ground truth. Authors sometimes publish papers with near-identical titles in different years. A wrong auto-confirmed match in a tenure portfolio or systematic review is a significant error. The one-click Confirm step is minimal friction and preserves researcher authority.

**Why Dice coefficient over Jaro-Winkler or edit distance?** Academic titles are long and word-order matters less than word presence. Dice on word tokens is fast, dependency-free, and naturally handles common reordering patterns (e.g., "Effects of X on Y" vs. "On the effects of X on Y"). Character-level distance is better for short strings with typos; we're matching against OpenAlex's canonical titles, not user-typed queries.

**Why only one candidate?** Presenting a list of options shifts the disambiguation burden to the researcher and risks them picking the wrong one from a list they don't want to read. A single best-guess with explicit Confirm/Dismiss is faster and less error-prone. If the top candidate is wrong, "Not this paper" dismisses it and the researcher can add the identifier manually.

**Why store `openAlexId` on confirm?** Once the researcher confirms a match, there is no reason to repeat the title search on every refresh. The OpenAlex work ID is the most stable handle — future fetches go directly to `/works/W<id>` and bypass the scoring pipeline entirely. This also means the `~` prefix disappears after confirmation.

---

## Why esbuild?

Zotero 7+ plugins are distributed as `.xpi` files (renamed ZIP archives) containing JavaScript. We use esbuild to bundle all TypeScript modules into a single JS file because:

1. **Speed.** esbuild builds in under 100ms, making the development loop near-instant.
2. **Simplicity.** No Webpack configuration, no Babel plugins, no framework overhead. One build command.
3. **Single output file.** Zotero loads a single bootstrap script. A single-bundle approach means no module loader, no import maps, and no runtime dependency resolution inside Zotero's privileged chrome context.

**Trade-off:** esbuild does not perform type checking. We run `tsc --noEmit` separately for type safety, which is enforced in CI alongside the test suite.

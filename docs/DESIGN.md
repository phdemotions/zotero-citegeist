---
type: architecture
title: Citegeist — design rationale
description: Key architectural decisions behind Citegeist and the trade-offs involved.
timestamp: 2026-08-02
tags: [citegeist, architecture, design, openalex, zotero, sqlite, authors, diagnostics]
---

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

OpenAlex became metered in July 2026. Singleton lookups — fetching one work or author by ID — remain free; list-and-filter queries draw on a daily allowance that is generous for anonymous use and larger still with a key. The older "polite pool" email model is gone: there is no email to provide and no faster tier to unlock with one. Citegeist needs neither an account nor a key to run, so it still works out of the box with zero configuration. A researcher who exhausts the anonymous daily allowance can paste a free OpenAlex API key into settings to raise it; the key is opt-in, rides the query string, and is redacted centrally so it never reaches a log or a diagnostic report.

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

## Why a Plugin-Owned SQLite Cache?

Through v1.3.x, Citegeist cached everything it knew about a paper — citation count, FWCI, percentile, journal metrics, confirmed title matches — in that item's `Extra` field, tagged with `Citegeist.` prefixes. That was a mistake, and v2.0.0 undid it. Cached metrics now live in a plugin-owned SQLite database at `<profile>/citegeist.sqlite`, opened via `Zotero.DBConnection` — the documented Zotero 7+ plugin-storage pattern, the same one Better BibTeX uses.

Four problems drove the move off `Extra`:

1. **Tenancy collision.** Better BibTeX, Zutilo, and CSL processors all read and write `Extra`. Sharing that namespace with them was a standing footgun.
2. **CSL template leakage.** Templates can pull from `Extra`, so a misconfigured one could surface bibliometric bookkeeping inside a generated citation.
3. **Orphan data on uninstall.** Removing the plugin left `Citegeist.*` lines in every item forever.
4. **Backup-restore staleness.** Restoring an older library backup silently overwrote fresher cached values.

Owning the store fixes all four: the database is Citegeist's alone, invisible to citation processing, and a researcher's bibliographic records stop carrying the plugin's bookkeeping.

SQLite also resolves a constraint the `Extra` field never had to satisfy. Zotero's column `dataProvider` is **synchronous** — a sortable column must return a value in the same tick it is asked — but SQLite reads are async. Citegeist bridges this with an in-memory mirror: at startup the whole `item_cache` table loads into a `Map` keyed by `(libraryID, itemKey)`, column rendering reads that map with zero SQL per row, and writes go to SQLite first and then update the mirror. The database is the source of truth; the mirror is the sync-read surface over it.

One line still travels back to `Extra`: the user-curated `Citegeist match ID: W…` for an item whose citation data was confirmed by title match. It is the only thing worth preserving outside the plugin's own store — it survives a downgrade to v1.x and rides Zotero Sync to the user's other devices, so a confirmed match never has to be re-confirmed.

**Trade-off:** The cache is now re-derivable local state rather than synced content. On a new device, or after clearing the database, each item re-fetches from OpenAlex the first time it is viewed — a brief "loading" beat on first scroll. Nothing is lost, because every cached value is re-derivable from a free singleton lookup, and the one piece that is _not_ re-derivable (the curated match ID) is exactly the piece kept in `Extra`. Full detail: [`docs/MIGRATION-v2.0.0.md`](MIGRATION-v2.0.0.md).

---

## Why a Separate Author-Identity Store?

Citegeist v3.0.0 added an author-identity layer: it resolves each item's authors to their OpenAlex author identities and, in the item pane, lets a researcher open a Scholar-style view of an author's works. **Identity is not a profile.** Resolving _who_ an author is — a canonical OpenAlex author ID, display name, and ORCID — is separate from fetching that author's aggregate metrics. Identity rides the free background metrics fetch: `resolveAuthorsForItem` re-reads the item's already-cached work through `getWorkById`, a free OpenAlex singleton lookup, so resolving identity across an entire library costs no metered budget. The heavier profile fetch (works count, h-index, i10) only runs when the researcher actually opens an author.

Author identity lives in its own normalized sub-module of the cache — `cache/authors/`, holding two tables: `authors` (one row per OpenAlex author: id, name, ORCID, and the derived metric columns) and `item_authors` (which authors belong to which item). Unlike the item cache, there is no in-memory mirror: author reads are async and happen only in the pane, never in a synchronous column `dataProvider`, so the mirror the columns need would be dead weight here. Writes serialize under the same per-`(libraryID, itemKey)` lock as the item cache, and are column-disjoint (an identity write never clobbers a metrics write) so a background resolve and a user action on the same item can't corrupt each other.

The external handoff is the SQLite file itself. A downstream pipeline reads `citegeist.sqlite` directly, so the `item_authors` table _is_ the interchange format. An earlier design asserted each work's resolved authors as native Zotero item relations under an `openalex:author` predicate, on the theory that a native relation would sync and travel with the item. It was removed before v3.0.0 shipped: Zotero's **sync server rejects the custom predicate** ("Error 400 — Unsupported predicate 'openalex:author'") and, worse, that rejection halts the user's entire library sync. A one-time purge now strips any such relation an earlier build wrote, so a library stuck on the rejected predicate can sync again.

**Trade-off:** Keeping identity out of `Extra` and out of item relations means it does not ride Zotero Sync — a second device re-resolves identity on its own rather than receiving it. That is the price of not breaking sync, and it is cheap: re-resolution runs on free singleton lookups, so the only cost is a background pass, not a re-confirmation or a metered charge. A sync-safe cross-device handoff waits on a predicate or channel Zotero's server will accept.

---

## Why a Centralized Rate Limiter?

OpenAlex is metered rather than gated behind a polite pool, so there is no published per-second ceiling to hug — but a burst of requests is still antisocial and risks a transient throttle. Citegeist targets 8 req/s. All API calls — works and authors alike — go through a single `rateLimitedFetch` function that:

1. Enforces a minimum 125ms interval between requests.
2. Retries transient failures (network errors, a per-second 429, 5xx) with backoff (2s, then 4s). A _budget-exhausted_ 429 — the daily allowance spent, flagged by `X-RateLimit-Remaining: 0` — is **not** retried; it raises a distinct error that prompts the user for an optional API key rather than hammering a quota that won't refill for hours.

This matters because Citegeist has multiple concurrent callers: the auto-fetch triggered by browsing items, batch operations on entire collections, and the citation network browser paginating through results. Without centralization, each caller would independently track timing, and concurrent operations could easily exceed the rate limit.

A single-queue approach is simpler than a token bucket or sliding window and sufficient for a Zotero plugin where requests are inherently serial (one user, one machine).

**Trade-off:** Strict serialization means a burst of requests (e.g., batch-fetching 200 items) takes longer than if we could parallelize. In practice, 8 req/s processes a 200-item collection in ~25 seconds, which is acceptable for a background operation.

---

## Why This Module Structure?

The plugin is organized into focused modules rather than a single monolithic file:

```
src/modules/
  openalex.ts          → Works API client (fetch, parse, rate limit, metered-error mapping)
  openalexAuthors.ts   → Authors API client (shares the works client's rate limiter + URL builder)
  cache/               → Plugin-owned SQLite cache
    db.ts              → Connection, in-memory mirror, lifecycle (init/close)
    read.ts            → Synchronous read API (mirror only)
    write.ts           → Async write API (SQLite first, then mirror)
    migration.ts       → One-shot Extra→SQLite migration + orphan GC
    types.ts           → Public types + internal row shape
    index.ts           → Public surface (re-exports)
    authors/           → Normalized author-identity store (authors + item_authors)
  citationService.ts   → Orchestration (fetch + cache + journal stats + author backfill)
  citationColumn.ts    → Sortable column registration
  citationPane.ts      → Sidebar pane rendering
  menu.ts              → Right-click context menus
  authorProfile.ts     → Author profile + view-model layer (pure logic, unit-tested)
  titleSearch.ts       → Metadata matching (title/year/author scoring)
  diagnostics/         → Quotable error codes, ring buffer, guards, copy-report
  ui/                  → Canonical design system (tokens, components, theme)
  citationNetwork/     → Citation browser + author-works dialog
    dialog.ts          → Modal lifecycle
    results.ts         → Result rendering and pagination
    actions.ts         → Add-to-library, undo, collection filing
    collectionPicker.ts → Collection selection UI
    types.ts           → Shared interfaces and constants
    styles.ts          → CSS-in-JS for the dialog
    index.ts           → Public API
  utils.ts             → Shared: escapeHTML, normalizeError, logError, safeHTML
src/data/
  journalRankings.ts   → Static ISSN-to-ranking lookup table
```

Each module has a single responsibility and communicates through typed interfaces. The citation network browser was split into focused files because it handles dialog lifecycle, result rendering, library import actions, collection picking, and styling — distinct concerns that benefit from separation. The same dialog also drives the author-works view, so its shared row markup lives in one place.

`citationService.ts` is the orchestration layer. It is the module that imports both the API clients and `cache/`, keeping the API clients and storage logic decoupled. Columns, panes, and menus all call the service layer rather than reaching into the API or cache directly.

**Trade-off:** More files means more indirection. But for a plugin of roughly 18,000 lines of TypeScript across several dozen modules, the navigation cost is minimal and the testability benefit is significant. Each module can be unit-tested with focused mocks.

---

## Why Stable, Quotable Diagnostic Codes?

A plugin that runs inside someone else's application, against a metered remote API, on a database that a cloud-sync client might be holding open, will fail in ways the user has no vocabulary for — a blank column, a menu that does nothing, a pane stuck on its spinner. v3.0.0 added a diagnostics layer so that **every distinguishable failure ends with something the user can quote.**

Every failure Citegeist can distinguish carries a **stable `CG-*` code** — `CG-NET01` (can't reach OpenAlex), `CG-API42` (daily budget spent), `CG-DB01` (can't write the local database), and so on. The codes are an **append-only public contract**: a code is a permanent identifier, so it is never renumbered, reused, or repurposed, and one is retired by leaving its entry in place with a note. The registry lives in `src/modules/diagnostics/codes.ts`; its human-facing mirror is [`docs/ERROR-CODES.md`](ERROR-CODES.md). A thrown `CitegeistError` carries its own code from the fetch layer to the UI, so intent is never re-derived by sniffing a message string.

Three mechanisms make the codes trustworthy:

1. **A single funnel.** `logError()` is the only path that records into an in-memory ring buffer of recent problems. Redaction happens inside `normalizeError` on that path, so nothing — no API key, no library content — reaches the buffer unredacted.
2. **Guarded boundaries.** Zotero does nothing useful with an exception thrown from a callback it invoked: a rejected async render hangs the pane on its spinner, a throwing `dataProvider` blanks a column, a throwing menu command does nothing at all. Every callback Zotero invokes is wrapped in `guard`/`guardAsync` at its registration choke point, so a failure becomes a recorded, coded diagnostic instead of a silent dead surface.
3. **A copy-paste report.** _Settings → Citegeist → Troubleshooting → Copy diagnostic report_ produces one plain-text block — build ID, Zotero version, platform, and every problem recorded since startup — that a user can paste into an issue without knowing what any of it means. The redaction net guarantees it carries no titles, DOIs, API key, or username.

**Trade-off:** The codes must be minted and maintained by hand — one code per _distinguishable user situation_, not per throw site — and the append-only rule means the registry only grows. Both the append-only property and the "every host callback is guarded" property are locked by `test/diagnostics-guard-invariants.test.ts`, a hard test/CI gate: if it fails, the fix is the code, never the test.

---

## Metadata-Based Matching (Title Search Fallback)

> **Shipped in v1.2.0** (2026-04-09).

> _Storage note:_ the match-state keys described below (`Citegeist.matchMethod`, `Citegeist.noMatch`, …) were the v1.2.0 design, when Citegeist still cached to `Extra`. Since v2.0.0 they live in the SQLite cache (see [Why a Plugin-Owned SQLite Cache?](#why-a-plugin-owned-sqlite-cache)); the one exception is the curated `Citegeist match ID: W…` line, which is still mirrored to `Extra` for downgrade safety. The matching logic and thresholds below are unchanged.

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

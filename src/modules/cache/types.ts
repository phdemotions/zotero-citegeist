/**
 * Shared types for the cache module.
 *
 * Two layers:
 *   • Public types — exposed to consumers (citationPane, citationColumn,
 *     citationService, citationNetwork). Stable across refactors.
 *   • Internal row type — mirrors the SQLite schema verbatim. snake_case
 *     names keep INSERT/SELECT/UPDATE statements readable.
 */

// ── Public types ───────────────────────────────────────────────────────────

export interface CachedData {
  openAlexId: string;
  citedByCount: number;
  fwci: number | null;
  percentile: number | null;
  isTop1Percent: boolean;
  isTop10Percent: boolean;
  isRetracted: boolean;
  lastFetched: string;
  /** OpenAlex source ID (e.g., "S1234") for journal-level lookups */
  sourceId: string | null;
  /** Journal 2-year mean citedness (OpenAlex's JIF equivalent) */
  citedness2yr: number | null;
  /** Journal h-index */
  journalHIndex: number | null;
}

export interface AllMetrics {
  count: number | null;
  fwci: number | null;
  percentile: number | null;
  isStale: boolean;
  sourceId: string | null;
  citedness2yr: number | null;
  journalHIndex: number | null;
  /** All known ISSNs from OpenAlex (for ranking lookups) */
  sourceISSNs: string[];
  /** Pending unconfirmed title match, if any */
  suggestion: { count: number; fwci: number | null; tier: "high" | "medium" } | null;
}

export type MatchMethod = "doi" | "pmid" | "arxiv" | "isbn" | "title-match";
export type MatchTier = "high" | "medium";

export interface TitleMatchMeta {
  noMatch: boolean;
  noMatchTimestamp: string | null;
  matchMethod: MatchMethod | null;
  matchConfidence: MatchTier | null;
  /** Stored after researcher confirms a title match — bypasses title search on refresh. */
  confirmedOpenAlexId: string | null;
}

export interface PendingSuggestion {
  openAlexId: string;
  title: string;
  citedByCount: number;
  fwci: number | null;
  year: number | null;
  tier: MatchTier;
  confidence: number;
  /** DOI from the matched work — offered to the researcher on confirm to permanently graduate the item. */
  doi: string | null;
}

export function isMatchTier(v: unknown): v is MatchTier {
  return v === "high" || v === "medium";
}

export function isMatchMethod(v: unknown): v is MatchMethod {
  return v === "doi" || v === "pmid" || v === "arxiv" || v === "isbn" || v === "title-match";
}

// ── Internal row + column metadata ─────────────────────────────────────────

/**
 * SQLite-stored boolean: 0, 1, or null. Using a literal union (instead of
 * `number | null` with a comment) lets the compiler catch accidental
 * assignment of arbitrary integers.
 */
export type DbBool = 0 | 1 | null;

/** Internal row type mirroring the `item_cache` schema. */
export interface ItemCacheRow {
  item_key: string;
  // work data
  open_alex_id: string | null;
  cited_by_count: number | null;
  fwci: number | null;
  percentile: number | null;
  is_top_1_percent: DbBool;
  is_top_10_percent: DbBool;
  is_retracted: DbBool;
  last_fetched: string | null;
  source_id: string | null;
  citedness_2yr: number | null;
  journal_h_index: number | null;
  source_issns: string | null;
  issn_l: string | null;
  // match metadata
  no_match: DbBool;
  no_match_timestamp: string | null;
  match_method: string | null;
  match_confidence: string | null;
  confirmed_open_alex_id: string | null;
  // pending suggestion
  pending_open_alex_id: string | null;
  pending_title: string | null;
  pending_cited_by_count: number | null;
  pending_fwci: number | null;
  pending_year: number | null;
  pending_tier: string | null;
  pending_confidence: number | null;
  pending_doi: string | null;
}

export const COLUMNS = [
  "item_key",
  "open_alex_id",
  "cited_by_count",
  "fwci",
  "percentile",
  "is_top_1_percent",
  "is_top_10_percent",
  "is_retracted",
  "last_fetched",
  "source_id",
  "citedness_2yr",
  "journal_h_index",
  "source_issns",
  "issn_l",
  "no_match",
  "no_match_timestamp",
  "match_method",
  "match_confidence",
  "confirmed_open_alex_id",
  "pending_open_alex_id",
  "pending_title",
  "pending_cited_by_count",
  "pending_fwci",
  "pending_year",
  "pending_tier",
  "pending_confidence",
  "pending_doi",
] as const;

export function emptyRow(itemKey: string): ItemCacheRow {
  return {
    item_key: itemKey,
    open_alex_id: null,
    cited_by_count: null,
    fwci: null,
    percentile: null,
    is_top_1_percent: null,
    is_top_10_percent: null,
    is_retracted: null,
    last_fetched: null,
    source_id: null,
    citedness_2yr: null,
    journal_h_index: null,
    source_issns: null,
    issn_l: null,
    no_match: null,
    no_match_timestamp: null,
    match_method: null,
    match_confidence: null,
    confirmed_open_alex_id: null,
    pending_open_alex_id: null,
    pending_title: null,
    pending_cited_by_count: null,
    pending_fwci: null,
    pending_year: null,
    pending_tier: null,
    pending_confidence: null,
    pending_doi: null,
  };
}

export function rowToParams(row: ItemCacheRow): unknown[] {
  return COLUMNS.map((c) => row[c]);
}

/** Marker used to mirror confirmed match IDs back to Extra for downgrade safety. */
export const CONFIRMED_MATCH_EXTRA_PREFIX = "Citegeist match ID";

/** Legacy Extra-field namespace; used only by the one-shot migration. */
export const LEGACY_PREFIX = "Citegeist.";

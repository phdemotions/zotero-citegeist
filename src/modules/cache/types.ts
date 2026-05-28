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
  suggestion: SuggestionPreview | null;
}

/**
 * Lightweight view of a pending suggestion exposed to column rendering.
 * Strict subset of `PendingSuggestion` — uses `count` (derived) instead of
 * `citedByCount` (raw) to match the rest of the `AllMetrics` shape.
 */
export interface SuggestionPreview {
  count: number;
  fwci: number | null;
  tier: MatchTier;
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

/**
 * Composite mirror key. Zotero item keys are 8-character random strings that
 * are unique *within* a library but NOT across libraries. Two items in
 * different libraries can collide; using the library + key tuple eliminates
 * the collision risk in the in-memory mirror and in the SQLite primary key.
 */
export function mirrorKey(libraryID: number, itemKey: string): string {
  return `${libraryID}:${itemKey}`;
}

/** Internal row type mirroring the `item_cache` schema. */
export interface ItemCacheRow {
  library_id: number;
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

export const COLUMNS = Object.freeze([
  "library_id",
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
] as const) as readonly (keyof ItemCacheRow)[];

export function emptyRow(libraryID: number, itemKey: string): ItemCacheRow {
  return {
    library_id: libraryID,
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

// ── Validation regexes for untrusted upstream data ────────────────────────
// OpenAlex IDs follow a strict alphanumeric shape. We reject anything else
// rather than sanitize — a value that doesn't look like a valid OpenAlex ID
// is either corrupt or hostile, and persisting it (e.g., back to a Zotero
// item's Extra field) would let a malicious response inject newlines that
// CSL processors and other plugins interpret as authoritative metadata.

/** OpenAlex work ID: literal `W` followed by digits. */
export const OPEN_ALEX_WORK_ID_RE = /^W\d+$/;

/** OpenAlex source (journal/venue) ID: literal `S` followed by digits. */
export const OPEN_ALEX_SOURCE_ID_RE = /^S\d+$/;

export function isValidWorkId(v: string | null | undefined): v is string {
  return typeof v === "string" && OPEN_ALEX_WORK_ID_RE.test(v);
}

export function isValidSourceId(v: string | null | undefined): v is string {
  return typeof v === "string" && OPEN_ALEX_SOURCE_ID_RE.test(v);
}

// ── Cache-owned input shapes ──────────────────────────────────────────────
// Cache layer must not depend on the OpenAlex module's types — that would
// couple storage to upstream API shapes. Callers pass `OpenAlexWork` /
// `OpenAlexSourceStats`; both are structurally assignable to these inputs.

/** Minimum fields the cache consumes from an OpenAlex work. */
export interface CacheWorkInput {
  id: string;
  cited_by_count: number;
  fwci?: number | null;
  citation_normalized_percentile?: {
    value: number;
    is_in_top_1_percent: boolean;
    is_in_top_10_percent: boolean;
  } | null;
  is_retracted?: boolean | null;
  primary_location?: {
    source?: {
      id?: string;
      issn_l?: string | null;
    } | null;
  } | null;
}

/** Minimum fields the cache consumes from a journal-source stats lookup. */
export interface CacheSourceStatsInput {
  citedness2yr: number;
  hIndex: number;
  issns: readonly string[];
}

/** Minimum fields the cache consumes from a pending title-match candidate. */
export interface CachePendingSuggestionInput {
  id: string;
  display_name: string;
  cited_by_count: number;
  fwci: number | null;
  publication_year: number;
  doi: string | null;
}

/**
 * Structural type for cache reads/writes — narrows from the full Zotero
 * `Item` to just the fields the cache module needs. Real `_ZoteroTypes.Item`
 * is structurally assignable; tests can pass plain object literals.
 */
export interface CacheItemKey {
  libraryID: number;
  key: string;
}

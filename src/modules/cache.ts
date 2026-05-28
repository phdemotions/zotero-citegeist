/**
 * Cache layer for Citegeist.
 *
 * Stores OpenAlex citation data in a plugin-owned SQLite database
 * (`<profile>/citegeist.sqlite`), attached via `new Zotero.DBConnection`.
 *
 * Rationale: writing to Zotero's per-item Extra field collides with
 * Better BibTeX, leaks into CSL templates, and leaves orphan data on
 * uninstall. The plugin-owned SQLite pattern is the documented Zotero 7+
 * approach (https://www.zotero.org/support/dev/sample_plugin).
 *
 * Architecture
 * ────────────
 * • Singleton SQLite connection opened in `initCache` at startup.
 * • In-memory mirror (`Map<itemKey, ItemCacheRow>`) loaded from SQLite at
 *   startup so all read functions can stay synchronous — Zotero's column
 *   `dataProvider` callback returns `string`, not `Promise<string>`.
 * • Writes go to SQLite first, then update the mirror atomically.
 * • Migration from legacy Extra-field storage runs once on first startup
 *   of v1.4.0 (see `migrateFromExtraV1`).
 *
 * IMPORTANT: read functions are sync but they require `initCache()` to
 * have run before they're called. `onStartup` enforces this ordering.
 */

import type { OpenAlexWork, OpenAlexSourceStats } from "./openalex";
import { safeParseInt, safeParseFloat } from "./utils";
import {
  DEFAULT_CACHE_LIFETIME_DAYS,
  MIGRATION_PROGRESS_TICK,
  SHOW_PROGRESS_UI_THRESHOLD,
} from "../constants";

// ────────────────────────────────────────────────────────────────────────────
// Database row shape — internal representation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Internal row type mirroring the `item_cache` schema.
 * Field names use snake_case to match SQLite column names verbatim,
 * which keeps INSERT statements readable.
 */
interface ItemCacheRow {
  item_key: string;
  // work data
  open_alex_id: string | null;
  cited_by_count: number | null;
  fwci: number | null;
  percentile: number | null;
  is_top_1_percent: number | null; // 0 | 1 | null
  is_top_10_percent: number | null;
  is_retracted: number | null;
  last_fetched: string | null;
  source_id: string | null;
  citedness_2yr: number | null;
  journal_h_index: number | null;
  source_issns: string | null;
  issn_l: string | null;
  // match metadata
  no_match: number | null;
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

const COLUMNS = [
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

function emptyRow(itemKey: string): ItemCacheRow {
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

function rowToParams(row: ItemCacheRow): unknown[] {
  return COLUMNS.map((c) => row[c]);
}

// ────────────────────────────────────────────────────────────────────────────
// Connection + mirror lifecycle
// ────────────────────────────────────────────────────────────────────────────

let db: _ZoteroTypes.DBConnection | null = null;
let mirror: Map<string, ItemCacheRow> = new Map();
let initialized = false;

/** Marker used to mirror confirmed match IDs back to Extra for downgrade safety. */
const CONFIRMED_MATCH_EXTRA_PREFIX = "Citegeist match ID";

/** Legacy Extra-field namespace; used only by the one-shot migration. */
const LEGACY_PREFIX = "Citegeist.";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS item_cache (
  item_key                  TEXT PRIMARY KEY,
  open_alex_id              TEXT,
  cited_by_count            INTEGER,
  fwci                      REAL,
  percentile                REAL,
  is_top_1_percent          INTEGER,
  is_top_10_percent         INTEGER,
  is_retracted              INTEGER,
  last_fetched              TEXT,
  source_id                 TEXT,
  citedness_2yr             REAL,
  journal_h_index           INTEGER,
  source_issns              TEXT,
  issn_l                    TEXT,
  no_match                  INTEGER,
  no_match_timestamp        TEXT,
  match_method              TEXT,
  match_confidence          TEXT,
  confirmed_open_alex_id    TEXT,
  pending_open_alex_id      TEXT,
  pending_title             TEXT,
  pending_cited_by_count    INTEGER,
  pending_fwci              REAL,
  pending_year              INTEGER,
  pending_tier              TEXT,
  pending_confidence        REAL,
  pending_doi               TEXT
);
`;

const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS idx_item_cache_last_fetched ON item_cache (last_fetched)`;

const CREATE_PROGRESS_TABLE = `
CREATE TABLE IF NOT EXISTS migration_progress (
  item_key    TEXT PRIMARY KEY,
  migrated_at TEXT NOT NULL
);
`;

/**
 * Initialize the cache: open the DB, ensure schema, load the in-memory mirror.
 * Must be called from `onStartup` before any read function runs.
 *
 * Idempotent — repeated calls are no-ops.
 */
export async function initCache(): Promise<void> {
  if (initialized) return;

  db = new Zotero.DBConnection("citegeist");
  await db.queryAsync(SCHEMA);
  await db.queryAsync(CREATE_INDEX);
  await db.queryAsync(CREATE_PROGRESS_TABLE);

  const rows = await db.queryAsync<ItemCacheRow>(`SELECT * FROM item_cache`);
  mirror = new Map(rows.map((r) => [r.item_key, r]));

  initialized = true;
  Zotero.debug(`[Citegeist] cache initialized: ${mirror.size} rows`);
}

/** Close the DB connection on shutdown. */
export async function closeCache(): Promise<void> {
  if (db) {
    await db.closeDatabase(false);
    db = null;
  }
  mirror = new Map();
  initialized = false;
}

/**
 * Test-only: inject a fake DBConnection and reset the mirror.
 * Not exported via index; callable from tests by importing the module directly.
 */
export function _resetForTesting(fakeDb?: _ZoteroTypes.DBConnection): void {
  db = fakeDb ?? null;
  mirror = new Map();
  initialized = false;
}

function requireInit(): _ZoteroTypes.DBConnection {
  if (!db || !initialized) {
    throw new Error("[Citegeist] cache not initialized — call initCache() first");
  }
  return db;
}

// ────────────────────────────────────────────────────────────────────────────
// Public types — preserved from v1.3.0 API
// ────────────────────────────────────────────────────────────────────────────

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

function isMatchTier(v: unknown): v is MatchTier {
  return v === "high" || v === "medium";
}

function isMatchMethod(v: unknown): v is MatchMethod {
  return v === "doi" || v === "pmid" || v === "arxiv" || v === "isbn" || v === "title-match";
}

// ────────────────────────────────────────────────────────────────────────────
// Mirror access helpers
// ────────────────────────────────────────────────────────────────────────────

function getRow(itemKey: string): ItemCacheRow | undefined {
  return mirror.get(itemKey);
}

async function upsertRow(row: ItemCacheRow): Promise<void> {
  const conn = requireInit();
  const placeholders = COLUMNS.map(() => "?").join(", ");
  const sql = `INSERT OR REPLACE INTO item_cache (${COLUMNS.join(", ")}) VALUES (${placeholders})`;
  await conn.queryAsync(sql, rowToParams(row));
  mirror.set(row.item_key, row);
}

async function deleteRow(itemKey: string): Promise<void> {
  const conn = requireInit();
  await conn.queryAsync(`DELETE FROM item_cache WHERE item_key = ?`, [itemKey]);
  mirror.delete(itemKey);
}

function isLastFetchedStaleRow(row: ItemCacheRow | undefined): boolean {
  if (!row || !row.last_fetched) return true;

  const rawLifetime = Zotero.Prefs.get("extensions.zotero.citegeist.cacheLifetimeDays");
  const lifetimeDays =
    typeof rawLifetime === "number" && Number.isFinite(rawLifetime) && rawLifetime > 0
      ? rawLifetime
      : DEFAULT_CACHE_LIFETIME_DAYS;
  const fetchedTime = new Date(row.last_fetched).getTime();
  if (Number.isNaN(fetchedTime)) return true;
  const ageMs = Date.now() - fetchedTime;
  return ageMs > lifetimeDays * 24 * 60 * 60 * 1000;
}

// ────────────────────────────────────────────────────────────────────────────
// Public read API — all sync, hit the in-memory mirror
// ────────────────────────────────────────────────────────────────────────────

export function getCachedCountAndStaleness(item: _ZoteroTypes.Item): {
  count: number | null;
  isStale: boolean;
} {
  const row = getRow(item.key);
  return { count: row?.cited_by_count ?? null, isStale: isLastFetchedStaleRow(row) };
}

export function getCachedMetrics(item: _ZoteroTypes.Item): AllMetrics {
  const row = getRow(item.key);
  if (!row) {
    return {
      count: null,
      fwci: null,
      percentile: null,
      isStale: true,
      sourceId: null,
      citedness2yr: null,
      journalHIndex: null,
      sourceISSNs: [],
      suggestion: null,
    };
  }

  const count = row.cited_by_count;
  const sourceISSNs = row.source_issns
    ? row.source_issns.split(",").filter(Boolean)
    : row.issn_l
      ? [row.issn_l]
      : [];

  // Pending suggestion surfaces only when no confirmed work data exists yet.
  let suggestion: AllMetrics["suggestion"] = null;
  if (row.pending_open_alex_id && count === null) {
    suggestion = {
      count: row.pending_cited_by_count ?? 0,
      fwci: row.pending_fwci,
      tier: isMatchTier(row.pending_tier) ? row.pending_tier : "medium",
    };
  }

  return {
    count,
    fwci: row.fwci,
    percentile: row.percentile,
    isStale: isLastFetchedStaleRow(row),
    sourceId: row.source_id,
    citedness2yr: row.citedness_2yr,
    journalHIndex: row.journal_h_index,
    sourceISSNs,
    suggestion,
  };
}

export function getCachedCitationCount(item: _ZoteroTypes.Item): number | null {
  return getRow(item.key)?.cited_by_count ?? null;
}

export function getCachedOpenAlexId(item: _ZoteroTypes.Item): string | null {
  return getRow(item.key)?.open_alex_id ?? null;
}

export function getCachedData(item: _ZoteroTypes.Item): CachedData | null {
  const row = getRow(item.key);
  if (!row || !row.open_alex_id) return null;
  return {
    openAlexId: row.open_alex_id,
    citedByCount: row.cited_by_count ?? 0,
    fwci: row.fwci,
    percentile: row.percentile,
    isTop1Percent: row.is_top_1_percent === 1,
    isTop10Percent: row.is_top_10_percent === 1,
    isRetracted: row.is_retracted === 1,
    lastFetched: row.last_fetched ?? "",
    sourceId: row.source_id,
    citedness2yr: row.citedness_2yr,
    journalHIndex: row.journal_h_index,
  };
}

export function isCacheStale(item: _ZoteroTypes.Item): boolean {
  return isLastFetchedStaleRow(getRow(item.key));
}

export function getTitleMatchMeta(item: _ZoteroTypes.Item): TitleMatchMeta {
  const row = getRow(item.key);
  if (!row) {
    return {
      noMatch: false,
      noMatchTimestamp: null,
      matchMethod: null,
      matchConfidence: null,
      confirmedOpenAlexId: null,
    };
  }
  return {
    noMatch: row.no_match === 1,
    noMatchTimestamp: row.no_match_timestamp,
    matchMethod: isMatchMethod(row.match_method) ? row.match_method : null,
    matchConfidence: isMatchTier(row.match_confidence) ? row.match_confidence : null,
    confirmedOpenAlexId: row.confirmed_open_alex_id,
  };
}

export function isNoMatchSuppressed(item: _ZoteroTypes.Item, retryDays: number): boolean {
  const row = getRow(item.key);
  if (!row || row.no_match !== 1) return false;
  if (!row.no_match_timestamp) return true;
  const age = Date.now() - new Date(row.no_match_timestamp).getTime();
  return age < retryDays * 24 * 60 * 60 * 1000;
}

export function getPendingSuggestion(item: _ZoteroTypes.Item): PendingSuggestion | null {
  const row = getRow(item.key);
  if (!row || !row.pending_open_alex_id) return null;
  return {
    openAlexId: row.pending_open_alex_id,
    title: row.pending_title ?? "",
    citedByCount: row.pending_cited_by_count ?? 0,
    fwci: row.pending_fwci,
    year: row.pending_year,
    tier: isMatchTier(row.pending_tier) ? row.pending_tier : "medium",
    confidence: row.pending_confidence ?? 0,
    doi: row.pending_doi,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Public write API — async; SQLite first, mirror second
// ────────────────────────────────────────────────────────────────────────────

export async function cacheWorkData(
  item: _ZoteroTypes.Item,
  work: OpenAlexWork,
  sourceStats?: OpenAlexSourceStats | null,
): Promise<void> {
  const existing = getRow(item.key) ?? emptyRow(item.key);

  const row: ItemCacheRow = {
    ...existing,
    open_alex_id: work.id.replace("https://openalex.org/", ""),
    cited_by_count: work.cited_by_count,
    fwci:
      work.fwci !== null && work.fwci !== undefined && work.cited_by_count > 0 ? work.fwci : null,
    percentile:
      work.citation_normalized_percentile && work.cited_by_count > 0
        ? work.citation_normalized_percentile.value * 100
        : null,
    is_top_1_percent: work.citation_normalized_percentile
      ? work.citation_normalized_percentile.is_in_top_1_percent
        ? 1
        : 0
      : null,
    is_top_10_percent: work.citation_normalized_percentile
      ? work.citation_normalized_percentile.is_in_top_10_percent
        ? 1
        : 0
      : null,
    is_retracted: work.is_retracted ? 1 : 0,
    last_fetched: new Date().toISOString(),
    source_id: work.primary_location?.source?.id?.replace("https://openalex.org/", "") ?? null,
    citedness_2yr: sourceStats ? sourceStats.citedness2yr : existing.citedness_2yr,
    journal_h_index: sourceStats ? sourceStats.hIndex : existing.journal_h_index,
    source_issns:
      sourceStats && sourceStats.issns.length > 0
        ? sourceStats.issns.join(",")
        : existing.source_issns,
    issn_l: work.primary_location?.source?.issn_l ?? existing.issn_l,
  };

  await upsertRow(row);
}

/**
 * Clear all Citegeist-managed data for an item.
 *
 * Wide semantics (preserved from v1.3.0): removes work data, match meta,
 * AND pending suggestion. `citationPane.ts` depends on this — comment at
 * line 447 reads "clearCache already wipes pendingSuggestion fields."
 */
export async function clearCache(item: _ZoteroTypes.Item): Promise<void> {
  await deleteRow(item.key);
}

export async function writeNoMatch(item: _ZoteroTypes.Item): Promise<void> {
  const existing = getRow(item.key) ?? emptyRow(item.key);
  const row: ItemCacheRow = {
    ...existing,
    no_match: 1,
    no_match_timestamp: new Date().toISOString(),
  };
  await upsertRow(row);
}

/**
 * Confirm a title match: mark matchMethod/Confidence and store confirmedOpenAlexId
 * so future fetches go directly to the work by ID, bypassing title search.
 *
 * The confirmed ID is also mirrored to the Zotero Extra field under
 * `Citegeist match ID: W…` (no trailing dot in the prefix) so that:
 *   • The match survives plugin downgrade to v1.3.x.
 *   • Across-device users see their confirmation respected (Extra syncs).
 */
export async function confirmTitleMatch(item: _ZoteroTypes.Item, tier: MatchTier): Promise<void> {
  const existing = getRow(item.key) ?? emptyRow(item.key);
  const pendingId = existing.pending_open_alex_id ?? existing.open_alex_id;

  const row: ItemCacheRow = {
    ...existing,
    no_match: null,
    no_match_timestamp: null,
    match_method: "title-match",
    match_confidence: tier,
    confirmed_open_alex_id: pendingId,
  };

  await upsertRow(row);

  if (pendingId) {
    await writeConfirmedMatchToExtra(item, pendingId);
  }
}

export async function writePendingSuggestion(
  item: _ZoteroTypes.Item,
  work: {
    id: string;
    display_name: string;
    cited_by_count: number;
    fwci: number | null;
    publication_year: number;
    doi: string | null;
  },
  tier: MatchTier,
  confidence: number,
): Promise<void> {
  const existing = getRow(item.key) ?? emptyRow(item.key);
  const row: ItemCacheRow = {
    ...existing,
    pending_open_alex_id: work.id.replace("https://openalex.org/", ""),
    pending_title: sanitizeForDisplay(work.display_name),
    pending_cited_by_count: work.cited_by_count,
    pending_fwci: work.fwci,
    pending_year: work.publication_year,
    pending_tier: tier,
    pending_confidence: confidence,
    pending_doi: work.doi ? sanitizeForDisplay(work.doi) : null,
  };
  await upsertRow(row);
}

export async function clearPendingSuggestion(item: _ZoteroTypes.Item): Promise<void> {
  const existing = getRow(item.key);
  if (!existing) return;
  const row: ItemCacheRow = {
    ...existing,
    pending_open_alex_id: null,
    pending_title: null,
    pending_cited_by_count: null,
    pending_fwci: null,
    pending_year: null,
    pending_tier: null,
    pending_confidence: null,
    pending_doi: null,
  };
  await upsertRow(row);
}

// ────────────────────────────────────────────────────────────────────────────
// Extra-field downgrade mirror
// ────────────────────────────────────────────────────────────────────────────

/**
 * Write the confirmed OpenAlex match ID back to the item's Extra field under
 * a non-`Citegeist.` prefix. This is the one piece of user-curated state we
 * mirror because it's irreplaceable — a re-fetch can't reconstruct a user's
 * manual title-match confirmation.
 *
 * Replaces any existing `Citegeist match ID:` line; preserves all other Extra
 * content byte-for-byte.
 */
async function writeConfirmedMatchToExtra(
  item: _ZoteroTypes.Item,
  openAlexId: string,
): Promise<void> {
  const extra = item.getField("extra") ?? "";
  const lines = extra.split("\n").filter((l) => !l.startsWith(`${CONFIRMED_MATCH_EXTRA_PREFIX}:`));
  lines.push(`${CONFIRMED_MATCH_EXTRA_PREFIX}: ${openAlexId}`);
  const cleaned = lines.join("\n").replace(/\n+$/, "");
  item.setField("extra", cleaned);
  await item.saveTx();
}

/** Strip characters that would render badly in UI strings. */
function sanitizeForDisplay(s: string): string {
  return s.replace(/[\r\n]/g, " ").trim();
}

// ────────────────────────────────────────────────────────────────────────────
// One-shot migration from legacy Extra-field storage (v1.3.x → v1.4.0)
// ────────────────────────────────────────────────────────────────────────────

interface LegacyParse {
  citegeistFields: Map<string, string>;
  otherLines: string[];
}

/**
 * Parse the legacy `Citegeist.*` namespace out of an Extra field.
 * Byte-for-byte compatible with the v1.3.0 parser.
 */
function parseExtraLegacy(extra: string): LegacyParse {
  const citegeistFields = new Map<string, string>();
  const otherLines: string[] = [];
  if (!extra) return { citegeistFields, otherLines };
  for (const line of extra.split("\n")) {
    if (line.startsWith(LEGACY_PREFIX)) {
      const idx = line.indexOf(": ");
      if (idx > 0) {
        citegeistFields.set(line.substring(0, idx), line.substring(idx + 2));
      } else {
        otherLines.push(line);
      }
    } else {
      otherLines.push(line);
    }
  }
  return { citegeistFields, otherLines };
}

/**
 * Round-trip invariant: every line of the original Extra is preserved in
 * the parsed-then-reassembled output. Ordering is allowed to change because
 * the legacy writer always pushed `Citegeist.*` lines to the end. What we
 * defend against is *silent line loss or mutation* — a parser bug that
 * eats user content or transforms it.
 */
function verifyParseRoundTrip(extra: string, parse: LegacyParse): boolean {
  const cgLines: string[] = [];
  for (const [k, v] of parse.citegeistFields) cgLines.push(`${k}: ${v}`);
  const reassembled = new Set([...parse.otherLines, ...cgLines].filter((l) => l !== ""));
  const original = new Set(extra.split("\n").filter((l) => l !== ""));
  if (reassembled.size !== original.size) return false;
  for (const line of original) if (!reassembled.has(line)) return false;
  return true;
}

function buildRowFromLegacy(itemKey: string, fields: Map<string, string>): ItemCacheRow {
  const get = (k: string) => fields.get(`${LEGACY_PREFIX}${k}`);
  const row = emptyRow(itemKey);

  const oid = get("openAlexId");
  if (oid) row.open_alex_id = oid;

  const cbc = get("citedByCount");
  if (cbc !== undefined) row.cited_by_count = safeParseInt(cbc);

  const fwci = get("fwci");
  if (fwci) row.fwci = safeParseFloat(fwci);

  const pct = get("percentile");
  if (pct) row.percentile = safeParseFloat(pct);

  if (get("isTop1Percent") !== undefined)
    row.is_top_1_percent = get("isTop1Percent") === "true" ? 1 : 0;
  if (get("isTop10Percent") !== undefined)
    row.is_top_10_percent = get("isTop10Percent") === "true" ? 1 : 0;
  if (get("isRetracted") !== undefined) row.is_retracted = get("isRetracted") === "true" ? 1 : 0;
  row.last_fetched = get("lastFetched") ?? null;
  row.source_id = get("sourceId") ?? null;
  const c2y = get("citedness2yr");
  if (c2y) row.citedness_2yr = safeParseFloat(c2y);
  const hidx = get("journalHIndex");
  if (hidx) row.journal_h_index = safeParseInt(hidx);
  row.source_issns = get("sourceISSNs") ?? get("issnL") ?? null;
  row.issn_l = get("issnL") ?? null;

  if (get("noMatch") === "true") row.no_match = 1;
  row.no_match_timestamp = get("noMatchTimestamp") ?? null;
  const mm = get("matchMethod");
  if (mm && isMatchMethod(mm)) row.match_method = mm;
  const mc = get("matchConfidence");
  if (mc && isMatchTier(mc)) row.match_confidence = mc;
  row.confirmed_open_alex_id = get("confirmedOpenAlexId") ?? null;

  const psid = get("pendingSuggestionId");
  if (psid) {
    row.pending_open_alex_id = psid;
    row.pending_title = get("pendingSuggestionTitle") ?? null;
    const pcbc = get("pendingSuggestionCount");
    if (pcbc) row.pending_cited_by_count = safeParseInt(pcbc);
    const pfwci = get("pendingSuggestionFwci");
    if (pfwci) row.pending_fwci = safeParseFloat(pfwci);
    const py = get("pendingSuggestionYear");
    if (py) {
      const n = safeParseInt(py);
      row.pending_year = n > 0 ? n : null;
    }
    const pt = get("pendingSuggestionTier");
    if (pt && isMatchTier(pt)) row.pending_tier = pt;
    const pc = get("pendingSuggestionConfidence");
    if (pc) row.pending_confidence = safeParseFloat(pc);
    row.pending_doi = get("pendingSuggestionDoi") ?? null;
  }

  return row;
}

interface MigrationProgressUI {
  update(done: number, total: number): void;
  close(): void;
}

function buildProgressUI(total: number): MigrationProgressUI | null {
  if (total < SHOW_PROGRESS_UI_THRESHOLD) return null;
  let win: _ZoteroTypes.ProgressWindow | null = null;
  let progressItem: _ZoteroTypes.ProgressWindowItem | null = null;
  try {
    win = new Zotero.ProgressWindow({ closeOnClick: false });
    win.changeHeadline("Citegeist: migrating cache (one-time)");
    progressItem = new win.ItemProgress(
      "chrome://citegeist/content/icons/icon-16.svg",
      `0 / ${total}`,
    );
    win.show();
  } catch (e) {
    Zotero.debug(`[Citegeist] migration progress UI unavailable: ${String(e)}`);
    return null;
  }
  return {
    update(done, totalN) {
      if (!progressItem) return;
      progressItem.setProgress((done / totalN) * 100);
      progressItem.setText(`${done} / ${totalN}`);
    },
    close() {
      win?.startCloseTimer(1000);
    },
  };
}

/**
 * Migrate per-item Citegeist data from Extra fields to SQLite.
 *
 * Runs once, gated by the `migrationV1Complete` pref. Idempotent and
 * crash-safe: each item goes through (1) SQLite write → (2) Extra strip
 * → (3) checkpoint write in that order. A crash between any two steps
 * is recovered on the next launch because `INSERT OR REPLACE` is a no-op
 * for completed items and `migration_progress` lets us skip ahead.
 *
 * Wrapped in `Zotero.Sync.Runner.delaySync` to prevent the sync engine
 * from resurrecting stripped lines via a server merge mid-loop.
 */
export async function migrateFromExtraV1(): Promise<void> {
  if (Zotero.Prefs.get("extensions.zotero.citegeist.migrationV1Complete")) return;
  requireInit();

  Zotero.Prefs.set("extensions.zotero.citegeist.migrationV1InProgress", true);

  try {
    await Zotero.Sync.Runner.delaySync(async () => {
      const items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, false);

      // Pre-filter so the UI count reflects actual work, not library size.
      const candidates: _ZoteroTypes.Item[] = [];
      for (const item of items) {
        const extra = item.getField("extra");
        if (extra && extra.includes(LEGACY_PREFIX)) candidates.push(item);
      }

      const total = candidates.length;
      const ui = buildProgressUI(total);
      let done = 0;

      for (const item of candidates) {
        done++;
        if (done % MIGRATION_PROGRESS_TICK === 0) ui?.update(done, total);

        // Skip items we've already migrated (idempotency)
        const conn = requireInit();
        const already = await conn.queryAsync<{ item_key: string }>(
          `SELECT item_key FROM migration_progress WHERE item_key = ?`,
          [item.key],
        );
        if (already.length > 0) continue;

        const extra = item.getField("extra") ?? "";
        const parse = parseExtraLegacy(extra);
        if (parse.citegeistFields.size === 0) continue;

        if (!verifyParseRoundTrip(extra, parse)) {
          Zotero.debug(`[Citegeist] migration: skipping ${item.key} — round-trip parse failed`);
          continue;
        }

        const row = buildRowFromLegacy(item.key, parse.citegeistFields);

        // Step 1: SQLite write
        await upsertRow(row);

        // Step 2: Extra strip (preserves all non-Citegeist content) +
        // re-emit a non-namespaced `Citegeist match ID:` line if the user
        // had a confirmed match (downgrade safety).
        const newLines = parse.otherLines.filter(
          (l) => !l.startsWith(`${CONFIRMED_MATCH_EXTRA_PREFIX}:`),
        );
        if (row.confirmed_open_alex_id) {
          newLines.push(`${CONFIRMED_MATCH_EXTRA_PREFIX}: ${row.confirmed_open_alex_id}`);
        }
        const newExtra = newLines.join("\n").replace(/\n+$/, "");
        item.setField("extra", newExtra);
        await item.saveTx({ skipDateModifiedUpdate: true });

        // Step 3: checkpoint
        await conn.queryAsync(
          `INSERT OR REPLACE INTO migration_progress (item_key, migrated_at) VALUES (?, ?)`,
          [item.key, new Date().toISOString()],
        );
      }

      ui?.close();
      Zotero.debug(`[Citegeist] migration complete: ${total} items processed`);
    });

    Zotero.Prefs.set("extensions.zotero.citegeist.migrationV1Complete", true);
  } finally {
    Zotero.Prefs.set("extensions.zotero.citegeist.migrationV1InProgress", false);
  }
}

/**
 * Remove SQLite rows whose item_key no longer exists in the user library.
 * Defends against backup-restore scenarios where a snapshot from before
 * the plugin was installed leaves orphan rows referencing deleted items.
 */
export async function garbageCollectOrphans(): Promise<void> {
  if (!initialized) return;
  const conn = requireInit();

  const liveItems = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, false);
  const liveKeys = new Set(liveItems.map((i) => i.key));

  const orphans: string[] = [];
  for (const key of mirror.keys()) {
    if (!liveKeys.has(key)) orphans.push(key);
  }
  if (orphans.length === 0) return;

  // Chunked DELETEs to keep the IN-clause within SQLite limits.
  const CHUNK = 200;
  for (let i = 0; i < orphans.length; i += CHUNK) {
    const slice = orphans.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    await conn.queryAsync(`DELETE FROM item_cache WHERE item_key IN (${placeholders})`, slice);
    await conn.queryAsync(
      `DELETE FROM migration_progress WHERE item_key IN (${placeholders})`,
      slice,
    );
    for (const k of slice) mirror.delete(k);
  }
  Zotero.debug(`[Citegeist] orphan GC removed ${orphans.length} rows`);
}

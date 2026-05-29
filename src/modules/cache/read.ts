/**
 * Public read API.
 *
 * All synchronous — reads hit the in-memory mirror only.
 * Zotero's column `dataProvider` calls these from a sync context.
 *
 * Two "missing data" conventions live side by side, deliberately:
 *   • `getCachedMetrics` returns a frozen `EMPTY_METRICS` sentinel when no
 *     row exists. Columns invoke this thousands of times per render tick;
 *     the shared frozen sentinel avoids per-call allocation.
 *   • `getCachedData`, `getCachedCitationCount`, `getCachedOpenAlexId`,
 *     `getPendingSuggestion` all return `null` when no row exists, so
 *     consumers branch explicitly on presence rather than reading sentinel
 *     fields back out.
 */

import { DEFAULT_CACHE_LIFETIME_DAYS, PREF_CACHE_LIFETIME_DAYS } from "../../constants";
import { getRow } from "./db";
import {
  type AllMetrics,
  type CachedData,
  type CacheItemKey,
  isMatchMethod,
  isMatchTier,
  type ItemCacheRow,
  type TitleMatchMeta,
  type PendingSuggestion,
} from "./types";

/**
 * Frozen sentinel returned by `getCachedMetrics` when no row exists. Sharing
 * a single reference is fine because the object is frozen — any caller that
 * tries to mutate it will throw in strict mode (and silently fail otherwise),
 * surfacing the bug instead of cascading the mutation across uncached items.
 */
const EMPTY_METRICS: AllMetrics = Object.freeze({
  count: null,
  fwci: null,
  percentile: null,
  isStale: true,
  sourceId: null,
  citedness2yr: null,
  journalHIndex: null,
  sourceISSNs: Object.freeze<string[]>([]),
  suggestion: null,
});

/**
 * Tiny memoization for the cache-lifetime pref. Column rendering can call
 * `isLastFetchedStaleRow` thousands of times per tick (one per visible row
 * per column); a 1-second TTL collapses that to a single `Zotero.Prefs.get`.
 */
let cachedLifetimeMs = 0;
let cachedLifetimeReadAt = 0;
const LIFETIME_MEMO_TTL_MS = 1000;

function getCacheLifetimeMs(): number {
  const now = Date.now();
  if (now - cachedLifetimeReadAt < LIFETIME_MEMO_TTL_MS && cachedLifetimeMs > 0) {
    return cachedLifetimeMs;
  }
  const rawLifetime = Zotero.Prefs.get(PREF_CACHE_LIFETIME_DAYS);
  const lifetimeDays =
    typeof rawLifetime === "number" && Number.isFinite(rawLifetime) && rawLifetime > 0
      ? rawLifetime
      : DEFAULT_CACHE_LIFETIME_DAYS;
  cachedLifetimeMs = lifetimeDays * 24 * 60 * 60 * 1000;
  cachedLifetimeReadAt = now;
  return cachedLifetimeMs;
}

function isLastFetchedStaleRow(row: ItemCacheRow | undefined): boolean {
  if (!row || !row.last_fetched) return true;
  const fetchedTime = new Date(row.last_fetched).getTime();
  if (Number.isNaN(fetchedTime)) return true;
  return Date.now() - fetchedTime > getCacheLifetimeMs();
}

/**
 * Per-row parsed-ISSN cache. Avoids re-splitting `source_issns` (a comma
 * string in SQLite) on every column render. WeakMap keys on row identity,
 * so when a row is replaced via upsertRow the old entry is GC'd naturally.
 */
const issnCache = new WeakMap<ItemCacheRow, string[]>();

function getSourceISSNs(row: ItemCacheRow): string[] {
  const cached = issnCache.get(row);
  if (cached) return cached;
  const parsed = row.source_issns
    ? row.source_issns.split(",").filter(Boolean)
    : row.issn_l
      ? [row.issn_l]
      : [];
  issnCache.set(row, parsed);
  return parsed;
}

export function getCachedCountAndStaleness(item: CacheItemKey): {
  count: number | null;
  isStale: boolean;
} {
  const row = getRow(item.libraryID, item.key);
  return { count: row?.cited_by_count ?? null, isStale: isLastFetchedStaleRow(row) };
}

export function getCachedMetrics(item: CacheItemKey): AllMetrics {
  const row = getRow(item.libraryID, item.key);
  if (!row) return EMPTY_METRICS;

  const count = row.cited_by_count;

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
    sourceISSNs: getSourceISSNs(row),
    suggestion,
  };
}

export function getCachedCitationCount(item: CacheItemKey): number | null {
  return getRow(item.libraryID, item.key)?.cited_by_count ?? null;
}

export function getCachedOpenAlexId(item: CacheItemKey): string | null {
  return getRow(item.libraryID, item.key)?.open_alex_id ?? null;
}

export function getCachedData(item: CacheItemKey): CachedData | null {
  const row = getRow(item.libraryID, item.key);
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

export function isCacheStale(item: CacheItemKey): boolean {
  return isLastFetchedStaleRow(getRow(item.libraryID, item.key));
}

export function getTitleMatchMeta(item: CacheItemKey): TitleMatchMeta {
  const row = getRow(item.libraryID, item.key);
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

export function isNoMatchSuppressed(item: CacheItemKey, retryDays: number): boolean {
  const row = getRow(item.libraryID, item.key);
  if (!row || row.no_match !== 1) return false;
  if (!row.no_match_timestamp) return true;
  const age = Date.now() - new Date(row.no_match_timestamp).getTime();
  return age < retryDays * 24 * 60 * 60 * 1000;
}

export function getPendingSuggestion(item: CacheItemKey): PendingSuggestion | null {
  const row = getRow(item.libraryID, item.key);
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

/**
 * Public read API.
 *
 * All synchronous — reads hit the in-memory mirror only.
 * Zotero's column `dataProvider` calls these from a sync context.
 */

import { DEFAULT_CACHE_LIFETIME_DAYS } from "../../constants";
import { getRow } from "./db";
import {
  type AllMetrics,
  type CachedData,
  isMatchMethod,
  isMatchTier,
  type ItemCacheRow,
  type TitleMatchMeta,
  type PendingSuggestion,
} from "./types";

const EMPTY_METRICS: AllMetrics = {
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

export function getCachedCountAndStaleness(item: _ZoteroTypes.Item): {
  count: number | null;
  isStale: boolean;
} {
  const row = getRow(item.key);
  return { count: row?.cited_by_count ?? null, isStale: isLastFetchedStaleRow(row) };
}

export function getCachedMetrics(item: _ZoteroTypes.Item): AllMetrics {
  const row = getRow(item.key);
  if (!row) return EMPTY_METRICS;

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

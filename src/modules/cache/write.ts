/**
 * Public write API.
 *
 * All async. Writes go to SQLite first, then update the in-memory mirror.
 * The only side-effect outside the cache file is `writeConfirmedMatchToExtra`,
 * which mirrors a single user-curated field (the OpenAlex ID of a confirmed
 * title match) back to the item's Extra under a non-`Citegeist.` prefix.
 */

import {
  type CacheItemKey,
  type CachePendingSuggestionInput,
  type CacheSourceStatsInput,
  type CacheWorkInput,
  CONFIRMED_MATCH_EXTRA_PREFIX,
  emptyRow,
  type ItemCacheRow,
  type DbBool,
  type MatchTier,
} from "./types";
import { deleteRow, getRow, upsertRow } from "./db";

/**
 * Pure helper deriving the four citation-derived metric fields from an
 * OpenAlex work. Works with zero citations have no metrics — that invariant
 * lives in one place so future writers can't accidentally diverge.
 */
function deriveCitationMetrics(work: CacheWorkInput): {
  fwci: number | null;
  percentile: number | null;
  isTop1Percent: DbBool;
  isTop10Percent: DbBool;
} {
  if (work.cited_by_count <= 0) {
    return { fwci: null, percentile: null, isTop1Percent: null, isTop10Percent: null };
  }
  const cnp = work.citation_normalized_percentile;
  return {
    fwci: work.fwci ?? null,
    percentile: cnp ? cnp.value * 100 : null,
    isTop1Percent: cnp ? (cnp.is_in_top_1_percent ? 1 : 0) : null,
    isTop10Percent: cnp ? (cnp.is_in_top_10_percent ? 1 : 0) : null,
  };
}

export async function cacheWorkData(
  item: CacheItemKey,
  work: CacheWorkInput,
  sourceStats: CacheSourceStatsInput | null,
): Promise<void> {
  const existing = getRow(item.libraryID, item.key) ?? emptyRow(item.libraryID, item.key);
  const metrics = deriveCitationMetrics(work);

  const row: ItemCacheRow = {
    ...existing,
    open_alex_id: work.id.replace("https://openalex.org/", ""),
    cited_by_count: work.cited_by_count,
    fwci: metrics.fwci,
    percentile: metrics.percentile,
    is_top_1_percent: metrics.isTop1Percent,
    is_top_10_percent: metrics.isTop10Percent,
    is_retracted: work.is_retracted == null ? null : work.is_retracted ? 1 : 0,
    last_fetched: new Date().toISOString(),
    source_id: work.primary_location?.source?.id?.replace("https://openalex.org/", "") ?? null,
    citedness_2yr: sourceStats ? sourceStats.citedness2yr : existing.citedness_2yr,
    journal_h_index: sourceStats ? sourceStats.hIndex : existing.journal_h_index,
    source_issns:
      sourceStats && sourceStats.issns.length > 0
        ? [...sourceStats.issns].join(",")
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
export async function clearCache(item: CacheItemKey): Promise<void> {
  await deleteRow(item.libraryID, item.key);
}

export async function writeNoMatch(item: CacheItemKey): Promise<void> {
  const existing = getRow(item.libraryID, item.key) ?? emptyRow(item.libraryID, item.key);
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
 * `Citegeist match ID: W…` so that:
 *   • The match survives plugin downgrade to v1.3.x.
 *   • Across-device users see their confirmation respected (Extra syncs).
 *
 * Caller invariant: there must be either a pending suggestion or an
 * already-cached OpenAlex ID. If neither exists this is a caller bug — we
 * log and no-op rather than persist a malformed row.
 */
export async function confirmTitleMatch(item: _ZoteroTypes.Item, tier: MatchTier): Promise<void> {
  const existing = getRow(item.libraryID, item.key) ?? emptyRow(item.libraryID, item.key);
  const pendingId = existing.pending_open_alex_id ?? existing.open_alex_id;

  if (!pendingId) {
    Zotero.debug(
      `[Citegeist] confirmTitleMatch called on ${item.key} with no pending or existing ID — ignored`,
    );
    return;
  }

  // Atomically promote pending → confirmed AND clear the pending block.
  // The two pieces of state must change in a single transaction so that no
  // concurrent reader can observe a row where pending_* is still populated
  // while confirmed_open_alex_id is already set (which would expose a stale
  // suggestion to the user in the same render tick).
  const row: ItemCacheRow = {
    ...existing,
    no_match: null,
    no_match_timestamp: null,
    match_method: "title-match",
    match_confidence: tier,
    confirmed_open_alex_id: pendingId,
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
  await writeConfirmedMatchToExtra(item, pendingId);
}

export async function writePendingSuggestion(
  item: CacheItemKey,
  work: CachePendingSuggestionInput,
  tier: MatchTier,
  confidence: number,
): Promise<void> {
  const existing = getRow(item.libraryID, item.key) ?? emptyRow(item.libraryID, item.key);
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

export async function clearPendingSuggestion(item: CacheItemKey): Promise<void> {
  const existing = getRow(item.libraryID, item.key);
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

// ── Extra-field downgrade mirror ───────────────────────────────────────────

/**
 * Returns a copy of `lines` with any existing `Citegeist match ID:` line
 * removed and `openAlexId` (if non-null) appended as a fresh entry.
 *
 * Pure — no side effects. Shared by the runtime confirm-match path and the
 * one-shot legacy migration, both of which need the same line-rewrite rule.
 */
export function setExtraConfirmedMatch(lines: string[], openAlexId: string | null): string[] {
  const filtered = lines.filter((l) => !l.startsWith(`${CONFIRMED_MATCH_EXTRA_PREFIX}:`));
  if (openAlexId) filtered.push(`${CONFIRMED_MATCH_EXTRA_PREFIX}: ${openAlexId}`);
  return filtered;
}

/**
 * Write the confirmed OpenAlex match ID back to the item's Extra field.
 * The only piece of user-curated state we mirror; everything else can be
 * reconstructed from OpenAlex on a fresh device.
 */
async function writeConfirmedMatchToExtra(
  item: _ZoteroTypes.Item,
  openAlexId: string,
): Promise<void> {
  const extra = item.getField("extra") ?? "";
  const newLines = setExtraConfirmedMatch(extra.split("\n"), openAlexId);
  const cleaned = newLines.join("\n").replace(/\n+$/, "");
  item.setField("extra", cleaned);
  await item.saveTx();
}

/** Strip characters that would render badly in UI strings. */
function sanitizeForDisplay(s: string): string {
  return s.replace(/[\r\n]/g, " ").trim();
}

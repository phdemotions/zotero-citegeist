/**
 * Orchestrates fetching citation data from OpenAlex and caching it.
 * Used by column, pane, and batch operations.
 */

import { getWorkByDOI, getSourceStats, type OpenAlexWork } from "./openalex";
import { cacheWorkData, isCacheStale, getCachedData } from "./cache";
import { OpenAlexNetworkError, logError } from "./utils";
import { BULK_FETCH_DELAY_MS } from "../constants";

/** Reason a fetch didn't produce a work. */
export type FetchError = "no-doi" | "not-found" | "network" | "invalid-item";

export interface FetchResult {
  success: boolean;
  work: OpenAlexWork | null;
  /** Present when `success` is false — lets UI render a targeted message. */
  error?: FetchError;
}

/**
 * Fetch citation data for a single Zotero item and cache it.
 * Returns the work data on success so callers can use it without a second API call.
 */
export async function fetchAndCacheItem(item: _ZoteroTypes.Item): Promise<FetchResult> {
  if (!item.isRegularItem()) {
    return { success: false, work: null, error: "invalid-item" };
  }

  const doi = item.getField("DOI");
  if (!doi || !doi.trim()) {
    return { success: false, work: null, error: "no-doi" };
  }

  // Skip if cache is fresh
  if (!isCacheStale(item)) return { success: true, work: null };

  let work: OpenAlexWork | null;
  try {
    work = await getWorkByDOI(doi);
  } catch (e) {
    if (e instanceof OpenAlexNetworkError) {
      logError(`fetchAndCacheItem(${item.id})`, e);
      return { success: false, work: null, error: "network" };
    }
    throw e;
  }
  if (!work) return { success: false, work: null, error: "not-found" };

  // Fetch journal-level stats (best-effort — `null` on failure is fine).
  const sourceId = work.primary_location?.source?.id;
  const sourceStats = sourceId ? await getSourceStats(sourceId) : null;

  await cacheWorkData(item, work, sourceStats);
  return { success: true, work };
}

/**
 * Batch fetch citation data for multiple items.
 * Returns count of successfully fetched items.
 */
export async function fetchAndCacheItems(
  items: _ZoteroTypes.Item[],
  onProgress?: (current: number, total: number) => void,
): Promise<number> {
  const eligible = items.filter((item) => item.isRegularItem() && item.getField("DOI")?.trim());

  let fetched = 0;

  for (let i = 0; i < eligible.length; i++) {
    try {
      const result = await fetchAndCacheItem(eligible[i]);
      if (result.success) fetched++;
    } catch (e) {
      logError(`fetchAndCacheItems item ${eligible[i].id}`, e);
    }

    onProgress?.(i + 1, eligible.length);

    if (i < eligible.length - 1) {
      await new Promise((r) => setTimeout(r, BULK_FETCH_DELAY_MS));
    }
  }

  return fetched;
}

export { getCachedData };

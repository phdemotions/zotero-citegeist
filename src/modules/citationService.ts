/**
 * Orchestrates fetching citation data from OpenAlex and caching it.
 * Used by column, pane, and batch operations.
 */

import { getWorkByDOI, type OpenAlexWork } from "./openalex";
import { cacheWorkData, isCacheStale, getCachedData } from "./cache";

export interface FetchResult {
  success: boolean;
  work: OpenAlexWork | null;
}

/**
 * Fetch citation data for a single Zotero item and cache it.
 * Returns the work data on success so callers can use it without a second API call.
 */
export async function fetchAndCacheItem(
  item: _ZoteroTypes.Item,
): Promise<FetchResult> {
  if (!item.isRegularItem()) return { success: false, work: null };

  const doi = item.getField("DOI");
  if (!doi || !doi.trim()) return { success: false, work: null };

  // Skip if cache is fresh
  if (!isCacheStale(item)) return { success: true, work: null };

  const work = await getWorkByDOI(doi);
  if (!work) return { success: false, work: null };

  await cacheWorkData(item, work);
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
  const eligible = items.filter(
    (item) => item.isRegularItem() && item.getField("DOI")?.trim(),
  );

  let fetched = 0;

  for (let i = 0; i < eligible.length; i++) {
    try {
      const result = await fetchAndCacheItem(eligible[i]);
      if (result.success) fetched++;
    } catch (e) {
      Zotero.debug(
        `[Citegeist] Batch fetch error for item ${eligible[i].id}: ${e}`,
      );
    }

    onProgress?.(i + 1, eligible.length);

    // Rate limiting: 100ms delay between requests
    if (i < eligible.length - 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return fetched;
}

export { getCachedData };

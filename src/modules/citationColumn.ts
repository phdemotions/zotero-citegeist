/**
 * Custom column in Zotero's item tree showing citation count.
 *
 * Uses Zotero 7's ItemTreeManager.registerColumn API.
 * Reads cached data from Extra field and triggers background fetches.
 */

import { getCachedCountAndStaleness } from "./cache";
import { fetchAndCacheItem } from "./citationService";

const COLUMN_KEY = "citegeist-citation-count";
const MAX_ATTEMPTED_CACHE = 10000;

let registered = false;
let fetchTimer: ReturnType<typeof setTimeout> | null = null;
let processingQueue = false;
const fetchQueue = new Set<number>();
// Track items already attempted (no DOI, not found, etc.) to avoid re-queuing
const fetchAttempted = new Set<number>();

export async function registerCitationColumn(pluginID: string): Promise<void> {
  if (registered) return;

  await Zotero.ItemTreeManager.registerColumn({
    dataKey: COLUMN_KEY,
    label: "Citations",
    pluginID,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    sortReverse: true,
    dataProvider: (item: _ZoteroTypes.Item, _dataKey: string) => {
      if (!item.isRegularItem()) return "";

      const doi = item.getField("DOI");
      if (!doi || !doi.trim()) return "";

      const { count, isStale } = getCachedCountAndStaleness(item);
      const autoFetch = Zotero.Prefs.get(
        "extensions.zotero.citegeist.autoFetch",
      ) as boolean;

      if (count !== null) {
        if (autoFetch && isStale && !fetchAttempted.has(item.id)) {
          queueFetch(item.id);
        }
        return String(count);
      }

      if (autoFetch && !fetchAttempted.has(item.id)) {
        queueFetch(item.id);
      }
      return count === null && !autoFetch ? "" : "…";
    },
  });

  registered = true;
  Zotero.debug("[Citegeist] Citation count column registered");
}

export function unregisterCitationColumn(): void {
  if (!registered) return;

  if (fetchTimer) {
    clearTimeout(fetchTimer);
    fetchTimer = null;
  }
  fetchQueue.clear();
  fetchAttempted.clear();
  processingQueue = false;
  registered = false;

  // Fire and forget — Zotero manages column lifecycle on plugin removal
  try {
    Zotero.ItemTreeManager.unregisterColumn(COLUMN_KEY);
  } catch {
    // Column may already be removed
  }
}

function queueFetch(itemId: number): void {
  fetchQueue.add(itemId);
  if (!fetchTimer) {
    fetchTimer = setTimeout(processFetchQueue, 500);
  }
}

async function processFetchQueue(): Promise<void> {
  fetchTimer = null;
  if (!registered || processingQueue) return;
  processingQueue = true;

  const ids = Array.from(fetchQueue);
  fetchQueue.clear();

  // Cap the attempted set to prevent unbounded growth
  if (fetchAttempted.size > MAX_ATTEMPTED_CACHE) {
    fetchAttempted.clear();
  }

  // Batch size of 2 with 500ms delay stays well within OpenAlex's
  // polite-pool rate limit (~10 req/s) even with large libraries.
  const BATCH_SIZE = 2;
  const BATCH_DELAY = 500;

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    if (!registered) break;

    const batch = ids.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (id) => {
        fetchAttempted.add(id);
        try {
          const item = Zotero.Items.get(id);
          if (item) {
            await fetchAndCacheItem(item as _ZoteroTypes.Item);
          }
        } catch (e) {
          Zotero.debug(`[Citegeist] Failed to fetch for item ${id}: ${e}`);
        }
      }),
    );

    if (i + BATCH_SIZE < ids.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY));
    }
  }

  processingQueue = false;

  // Notify the item tree to re-render with updated data
  try {
    const zp = Zotero.getActiveZoteroPane() as any;
    if (zp?.itemsView?.refreshAndMaintainSelection) {
      await zp.itemsView.refreshAndMaintainSelection();
    }
  } catch {
    // Non-critical — tree will refresh on next user interaction
  }

  // If new items were queued during processing, schedule another run
  if (fetchQueue.size > 0 && !fetchTimer && registered) {
    fetchTimer = setTimeout(processFetchQueue, 500);
  }
}

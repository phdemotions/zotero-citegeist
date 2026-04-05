/**
 * Custom columns in Zotero's item tree: Citations, FWCI, and Percentile.
 *
 * Uses Zotero 7's ItemTreeManager.registerColumn API.
 * Reads cached data from Extra field and triggers background fetches.
 * All three columns share a single fetch queue to avoid duplicate requests.
 */

import { getCachedMetrics } from "./cache";
import { fetchAndCacheItem } from "./citationService";

const COL_CITATIONS = "citegeist-citation-count";
const COL_FWCI = "citegeist-fwci";
const COL_PERCENTILE = "citegeist-percentile";
const MAX_ATTEMPTED_CACHE = 10000;

let registered = false;
let fetchTimer: ReturnType<typeof setTimeout> | null = null;
let processingQueue = false;
const fetchQueue = new Set<number>();
const fetchAttempted = new Set<number>();

/**
 * Shared logic: check if an item needs fetching and queue it if so.
 * Returns the cached metrics for immediate display.
 */
function getMetricsAndMaybeQueue(item: _ZoteroTypes.Item) {
  if (!item.isRegularItem()) return null;

  const doi = item.getField("DOI");
  if (!doi || !doi.trim()) return null;

  const metrics = getCachedMetrics(item);
  const autoFetch = Zotero.Prefs.get(
    "extensions.zotero.citegeist.autoFetch",
  ) as boolean;

  if (autoFetch && (metrics.count === null || metrics.isStale) && !fetchAttempted.has(item.id)) {
    queueFetch(item.id);
  }

  return metrics;
}

export async function registerCitationColumn(pluginID: string): Promise<void> {
  if (registered) return;

  // Citations column
  await Zotero.ItemTreeManager.registerColumn({
    dataKey: COL_CITATIONS,
    label: "Citations",
    pluginID,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    sortReverse: true,
    dataProvider: (item: _ZoteroTypes.Item, _dataKey: string) => {
      const metrics = getMetricsAndMaybeQueue(item);
      if (!metrics) return "";
      if (metrics.count !== null) return String(metrics.count);
      const autoFetch = Zotero.Prefs.get("extensions.zotero.citegeist.autoFetch") as boolean;
      return autoFetch ? "…" : "";
    },
  });

  // FWCI column
  await Zotero.ItemTreeManager.registerColumn({
    dataKey: COL_FWCI,
    label: "FWCI",
    pluginID,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    sortReverse: true,
    dataProvider: (item: _ZoteroTypes.Item, _dataKey: string) => {
      const metrics = getMetricsAndMaybeQueue(item);
      if (!metrics) return "";
      if (metrics.fwci !== null) return metrics.fwci.toFixed(2);
      if (metrics.count !== null) return "—"; // data fetched but no FWCI available
      const autoFetch = Zotero.Prefs.get("extensions.zotero.citegeist.autoFetch") as boolean;
      return autoFetch ? "…" : "";
    },
  });

  // Percentile column
  await Zotero.ItemTreeManager.registerColumn({
    dataKey: COL_PERCENTILE,
    label: "Percentile",
    pluginID,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    sortReverse: true,
    dataProvider: (item: _ZoteroTypes.Item, _dataKey: string) => {
      const metrics = getMetricsAndMaybeQueue(item);
      if (!metrics) return "";
      if (metrics.percentile !== null) return metrics.percentile.toFixed(1);
      if (metrics.count !== null) return "—";
      const autoFetch = Zotero.Prefs.get("extensions.zotero.citegeist.autoFetch") as boolean;
      return autoFetch ? "…" : "";
    },
  });

  registered = true;
  Zotero.debug("[Citegeist] Citation columns registered (Citations, FWCI, Percentile)");
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

  for (const key of [COL_CITATIONS, COL_FWCI, COL_PERCENTILE]) {
    try {
      Zotero.ItemTreeManager.unregisterColumn(key);
    } catch {
      // Column may already be removed
    }
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

  if (fetchAttempted.size > MAX_ATTEMPTED_CACHE) {
    fetchAttempted.clear();
  }

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

  try {
    const zp = Zotero.getActiveZoteroPane() as any;
    if (zp?.itemsView?.refreshAndMaintainSelection) {
      await zp.itemsView.refreshAndMaintainSelection();
    }
  } catch {
    // Non-critical
  }

  if (fetchQueue.size > 0 && !fetchTimer && registered) {
    fetchTimer = setTimeout(processFetchQueue, 500);
  }
}

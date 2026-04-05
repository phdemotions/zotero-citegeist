/**
 * Custom columns in Zotero's item tree.
 *
 * Article-level:  Citations, FWCI, Percentile
 * Journal-level:  2yr Citedness (JIF equiv), Journal H-Index
 * Rankings:       UTD24, FT50, ABDC (2022), AJG (2021)
 *
 * Uses Zotero 7's ItemTreeManager.registerColumn API.
 * Reads cached data from Extra field and triggers background fetches.
 * All columns share a single fetch queue to avoid duplicate requests.
 * Journal rankings are resolved from a bundled lookup table (zero API calls).
 */

import { getCachedMetrics, type AllMetrics } from "./cache";
import { fetchAndCacheItem } from "./citationService";
import { lookupRanking, RANKING_VERSIONS, type JournalRanking } from "../data/journalRankings";
import { getCachedSourceISSNs } from "./openalex";

// Column data keys
const COL_CITATIONS = "citegeist-citation-count";
const COL_FWCI = "citegeist-fwci";
const COL_PERCENTILE = "citegeist-percentile";
const COL_CITEDNESS = "citegeist-citedness-2yr";
const COL_HINDEX = "citegeist-journal-hindex";
const COL_UTD24 = "citegeist-utd24";
const COL_FT50 = "citegeist-ft50";
const COL_ABDC = "citegeist-abdc";
const COL_AJG = "citegeist-ajg";

const ALL_COLUMNS = [
  COL_CITATIONS, COL_FWCI, COL_PERCENTILE,
  COL_CITEDNESS, COL_HINDEX,
  COL_UTD24, COL_FT50, COL_ABDC, COL_AJG,
];

const MAX_ATTEMPTED_CACHE = 10000;

let registered = false;
let fetchTimer: ReturnType<typeof setTimeout> | null = null;
let processingQueue = false;
const fetchQueue = new Set<number>();
const fetchAttempted = new Set<number>();

/**
 * Per-item metrics cache to avoid re-parsing the Extra field N times
 * (once per column) during a single render cycle.
 */
let metricsCache = new Map<number, AllMetrics | null>();

/**
 * Per-item ranking cache. Resolved from ISSN on the Zotero item
 * against the bundled ranking table. No API calls.
 */
let rankingCache = new Map<number, JournalRanking | null | undefined>();

let autoFetchCached: boolean | null = null;
let autoFetchCacheTime = 0;

function getAutoFetch(): boolean {
  const now = Date.now();
  if (autoFetchCached === null || now - autoFetchCacheTime > 5000) {
    autoFetchCached = Zotero.Prefs.get(
      "extensions.zotero.citegeist.autoFetch",
    ) as boolean;
    autoFetchCacheTime = now;
  }
  return autoFetchCached;
}

/**
 * Shared logic: check if an item needs fetching and queue it if so.
 * Returns the cached metrics for immediate display.
 */
function getMetricsAndMaybeQueue(item: _ZoteroTypes.Item): AllMetrics | null {
  if (!item.isRegularItem()) return null;

  const doi = item.getField("DOI");
  if (!doi || !doi.trim()) return null;

  if (metricsCache.has(item.id)) {
    return metricsCache.get(item.id)!;
  }

  const metrics = getCachedMetrics(item);
  metricsCache.set(item.id, metrics);

  if (getAutoFetch() && (metrics.count === null || metrics.isStale) && !fetchAttempted.has(item.id)) {
    queueFetch(item.id);
  }

  return metrics;
}

/**
 * Get journal ranking for an item. Uses the item's ISSN field
 * to look up against the bundled ranking table.
 */
function getRanking(item: _ZoteroTypes.Item): JournalRanking | null {
  if (!item.isRegularItem()) return null;

  if (rankingCache.has(item.id)) {
    return rankingCache.get(item.id) ?? null;
  }

  // Collect ISSNs from multiple sources for best match coverage
  const issns: string[] = [];

  // 1. Zotero item's ISSN field (may contain print or electronic ISSN)
  try {
    const issn = item.getField("ISSN") as string;
    if (issn?.trim()) {
      for (const part of issn.split(/[,;\s]+/)) {
        if (part.trim()) issns.push(part.trim());
      }
    }
  } catch {
    // Item type may not have ISSN field
  }

  // 2. ISSNs stored in Extra from previous OpenAlex fetch (persists across sessions)
  const metrics = metricsCache.get(item.id);
  if (metrics?.sourceISSNs) {
    for (const stored of metrics.sourceISSNs) {
      if (stored && !issns.some((i) => i.toUpperCase() === stored.toUpperCase())) {
        issns.push(stored);
      }
    }
  }

  // 3. In-memory OpenAlex source cache (current session, best coverage)
  if (metrics?.sourceId) {
    for (const oa of getCachedSourceISSNs(metrics.sourceId)) {
      if (oa && !issns.some((i) => i.toUpperCase() === oa.toUpperCase())) {
        issns.push(oa);
      }
    }
  }

  const ranking = issns.length > 0 ? lookupRanking(issns) : null;
  rankingCache.set(item.id, ranking);
  return ranking;
}

export async function registerCitationColumn(pluginID: string): Promise<void> {
  if (registered) return;

  // ── Article-level columns ──

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
      return getAutoFetch() ? "…" : "";
    },
  });

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
      if (metrics.count !== null) return "—";
      return getAutoFetch() ? "…" : "";
    },
  });

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
      return getAutoFetch() ? "…" : "";
    },
  });

  // ── Journal-level columns (from OpenAlex source stats) ──

  await Zotero.ItemTreeManager.registerColumn({
    dataKey: COL_CITEDNESS,
    label: `Citedness`,
    pluginID,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    sortReverse: true,
    dataProvider: (item: _ZoteroTypes.Item, _dataKey: string) => {
      const metrics = getMetricsAndMaybeQueue(item);
      if (!metrics) return "";
      if (metrics.citedness2yr !== null) return metrics.citedness2yr.toFixed(2);
      if (metrics.count !== null) return "—";
      return getAutoFetch() ? "…" : "";
    },
  });

  await Zotero.ItemTreeManager.registerColumn({
    dataKey: COL_HINDEX,
    label: "J. H-Index",
    pluginID,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    sortReverse: true,
    dataProvider: (item: _ZoteroTypes.Item, _dataKey: string) => {
      const metrics = getMetricsAndMaybeQueue(item);
      if (!metrics) return "";
      if (metrics.journalHIndex !== null) return String(metrics.journalHIndex);
      if (metrics.count !== null) return "—";
      return getAutoFetch() ? "…" : "";
    },
  });

  // ── Ranking columns (bundled lookup, no API calls) ──

  await Zotero.ItemTreeManager.registerColumn({
    dataKey: COL_UTD24,
    label: `UTD24`,
    pluginID,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    sortReverse: true,
    dataProvider: (item: _ZoteroTypes.Item, _dataKey: string) => {
      const r = getRanking(item);
      return r?.utd24 ? "✓" : "";
    },
  });

  await Zotero.ItemTreeManager.registerColumn({
    dataKey: COL_FT50,
    label: `FT50`,
    pluginID,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    sortReverse: true,
    dataProvider: (item: _ZoteroTypes.Item, _dataKey: string) => {
      const r = getRanking(item);
      return r?.ft50 ? "✓" : "";
    },
  });

  await Zotero.ItemTreeManager.registerColumn({
    dataKey: COL_ABDC,
    label: `ABDC '${RANKING_VERSIONS.abdc.slice(2)}`,
    pluginID,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    sortReverse: true,
    dataProvider: (item: _ZoteroTypes.Item, _dataKey: string) => {
      const r = getRanking(item);
      return r?.abdc ?? "";
    },
  });

  await Zotero.ItemTreeManager.registerColumn({
    dataKey: COL_AJG,
    label: `AJG '${RANKING_VERSIONS.ajg.slice(2)}`,
    pluginID,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    sortReverse: true,
    dataProvider: (item: _ZoteroTypes.Item, _dataKey: string) => {
      const r = getRanking(item);
      return r?.ajg ?? "";
    },
  });

  registered = true;
  Zotero.debug("[Citegeist] All columns registered (9 total: article, journal, rankings)");
}

/**
 * Invalidate the per-item metrics cache so columns re-read the Extra field.
 */
export function invalidateColumnCache(itemId?: number): void {
  if (itemId !== undefined) {
    metricsCache.delete(itemId);
    rankingCache.delete(itemId);
  } else {
    metricsCache.clear();
    rankingCache.clear();
  }
  try {
    const zp = Zotero.getActiveZoteroPane();
    if (zp?.itemsView?.refreshAndMaintainSelection) {
      zp.itemsView.refreshAndMaintainSelection();
    }
  } catch {
    // Non-critical
  }
}

export function unregisterCitationColumn(): void {
  if (!registered) return;

  if (fetchTimer) {
    clearTimeout(fetchTimer);
    fetchTimer = null;
  }
  fetchQueue.clear();
  fetchAttempted.clear();
  metricsCache.clear();
  rankingCache.clear();
  autoFetchCached = null;
  processingQueue = false;
  registered = false;

  for (const key of ALL_COLUMNS) {
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
  metricsCache.clear();

  try {
    const zp = Zotero.getActiveZoteroPane();
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

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

import { getCachedMetrics, isNoMatchSuppressed, type AllMetrics } from "./cache";
import { fetchAndCacheItem, extractIdentifier } from "./citationService";
import { lookupRanking, RANKING_VERSIONS, type JournalRanking } from "../data/journalRankings";
import { getCachedSourceISSNs } from "./openalex";
import { logError, isBookType } from "./utils";
import {
  AUTO_FETCH_PREF_TTL_MS,
  FETCH_BATCH_DELAY_MS,
  FETCH_BATCH_SIZE,
  FETCH_QUEUE_DEBOUNCE_MS,
  MAX_ATTEMPTED_FETCH_CACHE,
  NO_MATCH_RETRY_DAYS,
  PREF_AUTO_FETCH,
} from "../constants";

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
  COL_CITATIONS,
  COL_FWCI,
  COL_PERCENTILE,
  COL_CITEDNESS,
  COL_HINDEX,
  COL_UTD24,
  COL_FT50,
  COL_ABDC,
  COL_AJG,
];

let registered = false;
let registeredPluginID: string | null = null;
let fetchTimer: ReturnType<typeof setTimeout> | null = null;
let processingQueue = false;
const fetchQueue = new Set<number>();
const fetchAttempted = new Set<number>();

/**
 * Build the same namespaced key Zotero stores internally for a
 * registered column: `CSS.escape(${pluginID}-${dataKey})`. Required
 * for `unregisterColumn` to find the entry — the un-prefixed key
 * silently fails. See pluginAPIBase._namespacedMainKey for the source
 * of truth.
 */
function namespacedColumnKey(pluginID: string, dataKey: string): string {
  const raw = `${pluginID}-${dataKey}`;
  type CSSWithEscape = { escape: (s: string) => string };
  const cssGlobal = (globalThis as unknown as { CSS?: CSSWithEscape }).CSS;
  if (cssGlobal && typeof cssGlobal.escape === "function") {
    return cssGlobal.escape(raw);
  }
  return raw.replace(/[@.]/g, "\\$&");
}

/**
 * Per-render-tick memo so all 9 columns share one `queueFetch` decision and
 * one `AllMetrics` object identity per item. The underlying `getCachedMetrics`
 * is already O(1) against the in-memory mirror, but consolidating here
 * ensures fetch queueing fires at most once per item per tick regardless of
 * which column triggered the render.
 */
const metricsCache = new Map<number, AllMetrics | null>();

/**
 * Per-item ranking cache. Resolved from ISSN on the Zotero item
 * against the bundled ranking table. No API calls.
 */
const rankingCache = new Map<number, JournalRanking | null | undefined>();

let autoFetchCached: boolean | null = null;
let autoFetchCacheTime = 0;

function getAutoFetch(): boolean {
  const now = Date.now();
  if (autoFetchCached === null || now - autoFetchCacheTime > AUTO_FETCH_PREF_TTL_MS) {
    autoFetchCached = Zotero.Prefs.get(PREF_AUTO_FETCH) as boolean;
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

  if (metricsCache.has(item.id)) {
    return metricsCache.get(item.id)!;
  }

  const metrics = getCachedMetrics(item);
  const hasFetchable = extractIdentifier(item) !== null;
  const hasUsableTitle = ((item.getField("title") as string) || "").trim().length > 0;

  // Nothing to show and nothing to fetch — skip entirely
  if (!hasFetchable && !hasUsableTitle && metrics.count === null && metrics.suggestion === null)
    return null;

  metricsCache.set(item.id, metrics);

  // Queue for fetch if stale/missing, not already attempted, and not suppressed
  if (
    getAutoFetch() &&
    (metrics.count === null || metrics.isStale) &&
    !fetchAttempted.has(item.id) &&
    !isNoMatchSuppressed(item, NO_MATCH_RETRY_DAYS)
  ) {
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
  // Flip the flag BEFORE the first await so a parallel/re-entrant call
  // (Zotero fires onStartup + onMainWindowLoad on the same launch and
  // can race) doesn't try to register again mid-flight. Previous code
  // set `registered = true` only at the END — every register call
  // racing past the guard hit "dataKey must be unique" and silently
  // never wired its dataProvider, leaving columns blank.
  registered = true;

  // FIRST PRINCIPLES: Zotero's pluginAPIBase stores registered keys
  // as `CSS.escape(${pluginID}-${dataKey})` — see
  // chrome/content/zotero/xpcom/pluginAPI/pluginAPIBase.mjs
  // `_namespacedMainKey()`. Calling `unregisterColumn("citegeist-fwci")`
  // looks up the un-prefixed key and silently fails (registry only
  // knows the namespaced form). Stale columns from a prior plugin
  // lifetime stay, and the next `registerColumn` throws
  // "dataKey must be unique" on the namespaced form — exactly the
  // error the user reported.
  registeredPluginID = pluginID;
  for (const key of ALL_COLUMNS) {
    try {
      await Zotero.ItemTreeManager.unregisterColumn(namespacedColumnKey(pluginID, key));
    } catch {
      // Expected when the column isn't already registered.
    }
  }

  // Wrap each register in try/catch so a single duplicate doesn't
  // poison the rest of the sequence — without this, the first column
  // collision aborted the whole `await` chain and the 8 remaining
  // columns silently never registered.
  const safeRegister = async (options: _ZoteroTypes.RegisterColumnOptions) => {
    try {
      await Zotero.ItemTreeManager.registerColumn(options);
    } catch (e) {
      Zotero.debug(`[Citegeist] registerColumn failed for ${options.dataKey}: ${String(e)}`);
    }
  };

  // ── Article-level columns ──

  await safeRegister({
    dataKey: COL_CITATIONS,
    label: "Citations",
    pluginID,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    sortReverse: true,
    dataProvider: (item: _ZoteroTypes.Item, _dataKey: string) => {
      const metrics = getMetricsAndMaybeQueue(item);
      if (!metrics) return "";
      if (metrics.count !== null) {
        // Suppress zero for books — OpenAlex coverage is incomplete for books,
        // so 0 almost always means "not tracked" rather than genuinely uncited.
        if (metrics.count === 0 && isBookType(item)) return "";
        return String(metrics.count);
      }
      // Unconfirmed title match
      if (metrics.suggestion) {
        if (metrics.suggestion.count === 0 && isBookType(item)) return "";
        return metrics.suggestion.tier === "high" ? `~${metrics.suggestion.count}` : "?";
      }
      return getAutoFetch() ? "…" : "";
    },
  });

  await safeRegister({
    dataKey: COL_FWCI,
    label: "FWCI",
    pluginID,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    sortReverse: true,
    dataProvider: (item: _ZoteroTypes.Item, _dataKey: string) => {
      const metrics = getMetricsAndMaybeQueue(item);
      if (!metrics) return "";
      if (metrics.fwci !== null) return metrics.fwci.toFixed(2);
      if (metrics.count !== null) {
        // Suppress the "—" placeholder for 0-count books (same coverage rationale)
        if (metrics.count === 0 && isBookType(item)) return "";
        return "—";
      }
      // Show FWCI for high-confidence suggestion only
      if (metrics.suggestion?.tier === "high" && metrics.suggestion.fwci !== null) {
        return `~${metrics.suggestion.fwci.toFixed(2)}`;
      }
      return getAutoFetch() ? "…" : "";
    },
  });

  await safeRegister({
    dataKey: COL_PERCENTILE,
    label: "Percentile",
    pluginID,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    sortReverse: true,
    dataProvider: (item: _ZoteroTypes.Item, _dataKey: string) => {
      const metrics = getMetricsAndMaybeQueue(item);
      if (!metrics) return "";
      if (metrics.percentile !== null) return metrics.percentile.toFixed(1);
      if (metrics.count !== null) {
        if (metrics.count === 0 && isBookType(item)) return "";
        return "—";
      }
      return getAutoFetch() ? "…" : "";
    },
  });

  // ── Journal-level columns (from OpenAlex source stats) ──

  await safeRegister({
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

  await safeRegister({
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

  await safeRegister({
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

  await safeRegister({
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

  await safeRegister({
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

  await safeRegister({
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

  Zotero.debug("[Citegeist] All columns registered (9 total: article, journal, rankings)");
}

/**
 * Invalidate the per-item metrics cache so columns re-read the SQLite mirror,
 * then force Zotero's item tree to repaint.
 *
 * Three layers of repaint signal because Zotero's column refresh
 * behavior is inconsistent across views (Library vs. saved searches vs.
 * collection):
 *   1. `metricsCache.delete(...)` clears OUR local memo so the next
 *      `dataProvider` invocation hits the fresh mirror.
 *   2. `Zotero.Notifier.trigger("modify", "item", ids)` — canonical
 *      "this item changed" event. ItemTreeManager listens and re-runs
 *      column dataProviders on the affected rows. Required: without
 *      it the menu-driven fetch path updated SQLite + mirror but the
 *      visible columns stayed stale until the user sorted/scrolled
 *      manually. (Reported during v2.0.0 testing.)
 *   3. `refreshAndMaintainSelection()` — belt-and-suspenders for
 *      builds where the Notifier path doesn't fully redraw.
 *
 * Pass `itemIds` (preferred) for targeted refresh of just the affected
 * rows. Plain `itemId` keeps backward compatibility with existing
 * callers; calling with no argument clears all caches but cannot
 * target a Notifier event (no ids to notify about).
 */
export async function invalidateColumnCache(itemId?: number | number[]): Promise<void> {
  const ids = itemId === undefined ? null : Array.isArray(itemId) ? itemId : [itemId];
  if (ids === null) {
    metricsCache.clear();
    rankingCache.clear();
  } else {
    for (const id of ids) {
      metricsCache.delete(id);
      rankingCache.delete(id);
    }
  }
  try {
    // **PRIMARY**: `Zotero.ItemTreeManager.refreshColumns()` is the
    // public API specifically built for "external data changed,
    // re-invoke every dataProvider on every visible row". Discovered
    // by reading the Zotero source at
    // chrome/content/zotero/xpcom/pluginAPI/itemTreeManager.js
    // (`refreshColumns() { this._columnManager.refresh(); }`).
    //
    // Notifier.trigger alone is necessary but NOT sufficient —
    // synthetic notifier events without an actual `item.dataModified`
    // change don't always re-run custom column dataProviders.
    const refreshFn = (Zotero.ItemTreeManager as unknown as { refreshColumns?: () => void })
      .refreshColumns;
    if (typeof refreshFn === "function") {
      refreshFn.call(Zotero.ItemTreeManager);
    }

    // **Belt-and-suspenders**: fire the canonical "redraw" Notifier
    // event so item tree handles targeted per-row invalidation. The
    // "redraw" action is documented in chrome/content/zotero/itemTree.jsx
    // — it calls `tree.invalidateRow(row)` for the supplied ids
    // (lighter than the full `refreshColumns` reset above, and
    // targeted to only the affected rows). Earlier code used "modify"
    // which is the EVENT FOR ITEM-CONTENT CHANGES, not "this row's
    // cached data needs re-evaluation"; the latter is "redraw".
    if (ids !== null && ids.length > 0) {
      const notifier = (
        Zotero as unknown as {
          Notifier?: { trigger: (...args: unknown[]) => Promise<unknown> };
        }
      ).Notifier;
      notifier?.trigger("redraw", "item", ids);
    }

    // **Fallback** for older builds without refreshColumns.
    if (typeof refreshFn !== "function") {
      const zp = Zotero.getActiveZoteroPane();
      const view = zp?.itemsView;
      if (view) {
        if (typeof view.invalidate === "function") view.invalidate();
        if (typeof view.refresh === "function") {
          await view.refresh();
        } else if (typeof view.refreshAndMaintainSelection === "function") {
          await view.refreshAndMaintainSelection();
        }
      }
    }
    Zotero.debug(
      `[Citegeist] invalidateColumnCache: cleared ${ids === null ? "all" : String(ids.length)} entries, refreshColumns=${typeof refreshFn === "function"}`,
    );
  } catch (e) {
    Zotero.debug(
      `[Citegeist] invalidateColumnCache: refresh dispatch failed (non-fatal): ${String(e)}`,
    );
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

  if (registeredPluginID) {
    for (const key of ALL_COLUMNS) {
      try {
        Zotero.ItemTreeManager.unregisterColumn(namespacedColumnKey(registeredPluginID, key));
      } catch {
        // Column may already be removed
      }
    }
    registeredPluginID = null;
  }
}

function queueFetch(itemId: number): void {
  fetchQueue.add(itemId);
  if (!fetchTimer) {
    fetchTimer = setTimeout(processFetchQueue, FETCH_QUEUE_DEBOUNCE_MS);
  }
}

async function processFetchQueue(): Promise<void> {
  fetchTimer = null;
  if (!registered || processingQueue) return;
  processingQueue = true;

  const ids = Array.from(fetchQueue);
  fetchQueue.clear();

  if (fetchAttempted.size > MAX_ATTEMPTED_FETCH_CACHE) {
    fetchAttempted.clear();
  }

  for (let i = 0; i < ids.length; i += FETCH_BATCH_SIZE) {
    if (!registered) break;

    const batch = ids.slice(i, i + FETCH_BATCH_SIZE);
    await Promise.all(
      batch.map(async (id) => {
        fetchAttempted.add(id);
        try {
          const item = Zotero.Items.get(id);
          if (item) {
            const result = await fetchAndCacheItem(item as _ZoteroTypes.Item);
            // Invalidate per-id for both "ok" (real metrics) and "suggestion"
            // (pending preview) so individual rows refresh as soon as their
            // data lands, instead of waiting for the bulk metricsCache.clear()
            // + refreshAndMaintainSelection() at the end of the batch. Makes
            // partial-batch repaints crisper on large queues.
            if (result.status === "ok" || result.status === "suggestion") {
              invalidateColumnCache(id);
            }
          }
        } catch (e) {
          logError(`processFetchQueue item ${id}`, e);
        }
      }),
    );

    if (i + FETCH_BATCH_SIZE < ids.length) {
      await new Promise((r) => setTimeout(r, FETCH_BATCH_DELAY_MS));
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
    fetchTimer = setTimeout(processFetchQueue, FETCH_QUEUE_DEBOUNCE_MS);
  }
}

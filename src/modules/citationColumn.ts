/**
 * Custom columns in Zotero's item tree.
 *
 * Article-level:  Citations, FWCI, Percentile
 * Journal-level:  2yr Citedness (JIF equiv), Journal H-Index
 * Rankings:       UTD24, FT50, ABDC (2022), AJG (2021)
 *
 * Uses Zotero 7's ItemTreeManager.registerColumn API.
 * Reads cached metrics and queues background lookups (see willBackgroundFetch).
 * All columns share a single fetch queue to avoid duplicate requests.
 * Journal rankings are resolved from a bundled lookup table (zero API calls).
 */

import {
  cacheWriteRefusalCode,
  getCachedMetrics,
  isNoMatchSuppressed,
  type AllMetrics,
} from "./cache";
import { canResolveWork, fetchAndCacheItem, fetchStopFor, type FetchStop } from "./citationService";
import { lookupRanking, RANKING_VERSIONS, type JournalRanking } from "../data/journalRankings";
import { getCachedSourceISSNs } from "./openalex";
import { logError, isBookType, OpenAlexAuthError, OpenAlexBudgetError } from "./utils";
import { guard } from "./diagnostics";
import {
  AUTO_FETCH_PREF_TTL_MS,
  COLUMN_REPAINT_DEBOUNCE_MS,
  FETCH_BATCH_DELAY_MS,
  FETCH_BATCH_SIZE,
  FETCH_QUEUE_DEBOUNCE_MS,
  MAX_ATTEMPTED_FETCH_CACHE,
  NO_MATCH_RETRY_DAYS,
} from "../constants";
import { getOpenAlexApiKey, isAutoFetchEnabled } from "./prefs";

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
/** Items waiting for a background lookup, oldest first. */
const fetchQueue = new Set<number>();
/** Items whose background lookup is running now. */
const fetchInFlight = new Set<number>();
/**
 * Items the background queue has looked up this session, so a repaint does not
 * queue them again. Each maps to the {@link fetchEpoch} it was last looked up or
 * drawn in, and the map stays in epoch order, oldest first. Bounded; see
 * {@link rememberAttempt}.
 */
const fetchAttempted = new Map<number, number>();
/**
 * How many queue passes have finished. A pass's lookups, and every paint from
 * the end of the previous pass until it ends, share one epoch.
 */
let fetchEpoch = 0;
let repaintTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Why background fetching stopped, or null while it runs. A rejected API key
 * (CG-API01) or a spent budget (CG-API42) fails every later request the same
 * way, and a cache that refuses writes would throw every result away, so the
 * queue stops at the first such result instead of working through the library.
 *
 * `apiKey` is the key the refused requests carried, and a different key resumes
 * fetching. A cache refusal carries none: it lasts until Citegeist restarts.
 */
interface BackgroundPause {
  readonly stop: FetchStop;
  readonly apiKey: string | null;
}
let backgroundPause: BackgroundPause | null = null;

/**
 * Coalesced, reliable column repaint. `invalidateColumnCache` clears the per-row
 * memo and fires the lightweight refreshColumns/Notifier signals, but on Zotero
 * 9 those don't reliably re-run custom column dataProviders —
 * `refreshAndMaintainSelection()` does. Debounced so a burst of per-item
 * invalidations (a collection/library fetch landing row by row) collapses into
 * ONE refresh instead of N, so rows fill in progressively without thrash.
 */
function scheduleColumnRepaint(): void {
  if (repaintTimer) return;
  repaintTimer = setTimeout(() => {
    repaintTimer = null;
    try {
      const view = Zotero.getActiveZoteroPane()?.itemsView;
      if (view?.refreshAndMaintainSelection) {
        void view.refreshAndMaintainSelection();
      } else if (view?.refresh) {
        void view.refresh();
      } else if (view?.invalidate) {
        view.invalidate();
      }
    } catch (e) {
      logError("scheduleColumnRepaint", e);
    }
  }, COLUMN_REPAINT_DEBOUNCE_MS);
}

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
 * Per-render-tick memo of each row's cached metrics, so the five metric columns
 * and the ranking lookup share one `AllMetrics` per item. The underlying
 * `getCachedMetrics` is already O(1) against the in-memory mirror. Only the
 * metrics are memoized: whether a lookup is due is decided on every paint.
 */
const metricsCache = new Map<number, AllMetrics>();

/**
 * Per-item ranking cache. Resolved from ISSN on the Zotero item
 * against the bundled ranking table. No API calls.
 */
const rankingCache = new Map<number, JournalRanking | null | undefined>();

let autoFetchCached: boolean | null = null;
let autoFetchCacheTime = 0;

function getAutoFetch(): boolean {
  if (autoFetchCached === null || Date.now() - autoFetchCacheTime > AUTO_FETCH_PREF_TTL_MS) {
    return readAutoFetchNow();
  }
  return autoFetchCached;
}

/** Read the auto-fetch setting past the TTL, and cache what it says. */
function readAutoFetchNow(): boolean {
  autoFetchCached = isAutoFetchEnabled();
  autoFetchCacheTime = Date.now();
  return autoFetchCached;
}

/** The API key the settings hold now, or `fallback` when Zotero cannot read it. */
function readApiKey(fallback: string): string {
  try {
    return getOpenAlexApiKey();
  } catch {
    return fallback;
  }
}

/** Whether background fetching is paused. A pause for a refused key or budget ends once the key changes. */
function backgroundFetchPaused(): boolean {
  if (backgroundPause === null) return false;
  const { apiKey } = backgroundPause;
  if (apiKey !== null && readApiKey(apiKey) !== apiKey) {
    backgroundPause = null;
    return false;
  }
  return true;
}

/**
 * Whether the background queue will look this item up. It is the one rule
 * behind both queueing an item and drawing "…" in its cells, so a cell never
 * promises a lookup the queue will not make, and the queue never spends a batch
 * slot on an item with nothing to look up. All of these hold:
 *
 * - "Automatically fetch citation data" is ticked;
 * - the queue has not looked the item up this session and is not doing so now;
 * - background fetching is not paused ({@link BackgroundPause});
 * - the cache takes writes;
 * - the cached metrics are missing or stale, the test the fetch itself uses to
 *   skip a row;
 * - no title search has found nothing for the item, nor the user dismissed its
 *   match, in the last NO_MATCH_RETRY_DAYS;
 * - the item is in the library, not the trash, and resolves to a work without a
 *   title search: a DOI, PMID, arXiv ID or ISBN, or an OpenAlex ID the user
 *   confirmed ({@link canResolveWork}, the fetch's own resolution).
 */
function willBackgroundFetch(item: _ZoteroTypes.Item, metrics: AllMetrics): boolean {
  return (
    getAutoFetch() &&
    !fetchAttempted.has(item.id) &&
    !fetchInFlight.has(item.id) &&
    !backgroundFetchPaused() &&
    cacheWriteRefusalCode() === null &&
    metrics.isStale &&
    !isNoMatchSuppressed(item, NO_MATCH_RETRY_DAYS) &&
    !item.deleted &&
    canResolveWork(item)
  );
}

/** What a metric column draws from: the row's cached metrics, and whether a lookup is coming. */
interface CellState {
  metrics: AllMetrics;
  /** A background lookup is queued, running, or due: the cell shows "…" until it lands. */
  pending: boolean;
}

/**
 * A row's cached metrics, queueing its background lookup when
 * {@link willBackgroundFetch} says one is due. Runs on every paint, including a
 * row whose metrics are memoized, so ticking the setting takes effect on rows
 * already drawn.
 */
function cellState(item: _ZoteroTypes.Item): CellState | null {
  if (!item.isRegularItem()) return null;

  let metrics = metricsCache.get(item.id);
  if (!metrics) {
    metrics = getCachedMetrics(item);
    metricsCache.set(item.id, metrics);
  }

  if (fetchInFlight.has(item.id) || fetchQueue.has(item.id)) return { metrics, pending: true };
  if (metrics.isStale) keepAttemptWhileDrawn(item.id);
  const due = willBackgroundFetch(item, metrics);
  if (due) queueFetch(item.id);
  return { metrics, pending: due };
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

  // Track the dataKeys registered this pass so a later failure can roll
  // them back. Zotero stores columns under the namespaced key, so rollback
  // (like the defensive unregister above) must use namespacedColumnKey —
  // the bare key silently no-ops.
  const registeredKeys: string[] = [];

  // Fail closed on any registration error: roll back the columns we already
  // wired (plus best-effort the one that just failed), reset state so a
  // retry starts clean, and rethrow so the caller (hooks.onStartup) can tear
  // down the cache and alert. The pre-registration unregister loop above
  // already clears stale columns, so a genuine throw here means the item
  // tree can't be wired correctly — better to surface it than to leave half
  // the columns dead with no dataProvider.
  const safeRegister = async (options: _ZoteroTypes.RegisterColumnOptions) => {
    // Guard the dataProvider HERE, at the one choke point every column passes
    // through, rather than at nine call sites — a column added later is
    // protected without anyone remembering to wrap it. Zotero calls
    // dataProvider synchronously while painting rows, and a throw blanks the
    // column with no error anywhere the user can see it.
    const provide = options.dataProvider;
    if (provide) {
      options = {
        ...options,
        dataProvider: (item: _ZoteroTypes.Item, dataKey: string) =>
          guard(`column dataProvider ${options.dataKey}`, () => provide(item, dataKey)) ?? "",
      };
    }
    try {
      await Zotero.ItemTreeManager.registerColumn(options);
      registeredKeys.push(options.dataKey);
    } catch (e) {
      logError("registerColumn", e);
      for (const key of [...registeredKeys, options.dataKey]) {
        try {
          await Zotero.ItemTreeManager.unregisterColumn(namespacedColumnKey(pluginID, key));
        } catch {
          // best-effort cleanup
        }
      }
      registered = false;
      registeredPluginID = null;
      throw e;
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
      const cell = cellState(item);
      if (!cell) return "";
      const { metrics } = cell;
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
      return cell.pending ? "…" : "";
    },
  });

  await safeRegister({
    dataKey: COL_FWCI,
    label: "FWCI",
    pluginID,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    sortReverse: true,
    dataProvider: (item: _ZoteroTypes.Item, _dataKey: string) => {
      const cell = cellState(item);
      if (!cell) return "";
      const { metrics } = cell;
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
      return cell.pending ? "…" : "";
    },
  });

  await safeRegister({
    dataKey: COL_PERCENTILE,
    label: "Percentile",
    pluginID,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    sortReverse: true,
    dataProvider: (item: _ZoteroTypes.Item, _dataKey: string) => {
      const cell = cellState(item);
      if (!cell) return "";
      const { metrics } = cell;
      if (metrics.percentile !== null) return metrics.percentile.toFixed(1);
      if (metrics.count !== null) {
        if (metrics.count === 0 && isBookType(item)) return "";
        return "—";
      }
      return cell.pending ? "…" : "";
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
      const cell = cellState(item);
      if (!cell) return "";
      const { metrics } = cell;
      if (metrics.citedness2yr !== null) return metrics.citedness2yr.toFixed(2);
      if (metrics.count !== null) return "—";
      return cell.pending ? "…" : "";
    },
  });

  await safeRegister({
    dataKey: COL_HINDEX,
    label: "J. H-Index",
    pluginID,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    sortReverse: true,
    dataProvider: (item: _ZoteroTypes.Item, _dataKey: string) => {
      const cell = cellState(item);
      if (!cell) return "";
      const { metrics } = cell;
      if (metrics.journalHIndex !== null) return String(metrics.journalHIndex);
      if (metrics.count !== null) return "—";
      return cell.pending ? "…" : "";
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
    // Lightweight, immediate signals: ask Zotero to refresh its column manager
    // and fire the targeted "redraw" Notifier for the affected rows. Necessary
    // but NOT sufficient on Zotero 9 — neither reliably re-runs a custom column
    // dataProvider — so we ALSO schedule the coalesced reliable repaint below.
    const refreshFn = (Zotero.ItemTreeManager as unknown as { refreshColumns?: () => void })
      .refreshColumns;
    if (typeof refreshFn === "function") {
      refreshFn.call(Zotero.ItemTreeManager);
    }
    if (ids !== null && ids.length > 0) {
      const notifier = (
        Zotero as unknown as {
          Notifier?: { trigger: (...args: unknown[]) => Promise<unknown> };
        }
      ).Notifier;
      notifier?.trigger("redraw", "item", ids);
    }

    // **Reliable repaint.** `refreshAndMaintainSelection()` is what actually
    // re-evaluates custom dataProviders on Zotero 8/9. It used to be gated
    // behind `refreshColumns` being ABSENT — so on 8/9 (where refreshColumns
    // exists) it never ran, and batch / collection / library fetches updated
    // the cache but never repainted the columns. Always schedule it now; the
    // debounce coalesces a burst of per-item invalidations into one refresh.
    scheduleColumnRepaint();
  } catch (e) {
    logError("invalidateColumnCache refresh", e);
  }
}

export function unregisterCitationColumn(): void {
  if (!registered) return;

  if (fetchTimer) {
    clearTimeout(fetchTimer);
    fetchTimer = null;
  }
  fetchQueue.clear();
  fetchInFlight.clear();
  fetchAttempted.clear();
  fetchEpoch = 0;
  backgroundPause = null;
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

/**
 * Work through the queue a batch at a time, including items queued while it
 * runs. Stops when the queue empties, when "Automatically fetch citation data"
 * is unticked (read at every batch, past the TTL), or when a result pauses
 * background fetching.
 */
async function processFetchQueue(): Promise<void> {
  fetchTimer = null;
  if (!registered || processingQueue) return;
  processingQueue = true;

  try {
    while (registered && fetchQueue.size > 0) {
      if (!readAutoFetchNow()) {
        fetchQueue.clear();
        break;
      }
      if (await runBackgroundBatch(takeFromQueue(FETCH_BATCH_SIZE))) break;
      if (fetchQueue.size > 0) {
        await new Promise((r) => setTimeout(r, FETCH_BATCH_DELAY_MS));
      }
    }
  } catch (e) {
    logError("processFetchQueue", e);
  } finally {
    processingQueue = false;
  }

  // The pass is over, so the repaint below and the next pass start a new epoch.
  fetchEpoch++;
  // Repaint so a cell whose lookup found nothing, or was dropped, stops showing "…".
  metricsCache.clear();
  scheduleColumnRepaint();
}

/** Remove up to `count` items from the front of the queue. */
function takeFromQueue(count: number): number[] {
  const batch: number[] = [];
  for (const id of fetchQueue) {
    if (batch.length === count) break;
    batch.push(id);
  }
  for (const id of batch) fetchQueue.delete(id);
  return batch;
}

/** Look up one batch side by side. True when a result paused background fetching. */
async function runBackgroundBatch(ids: number[]): Promise<boolean> {
  const apiKey = readApiKey("");
  for (const id of ids) fetchInFlight.add(id);
  const stops = await Promise.all(ids.map(backgroundFetch));
  const stop = stops.find((s) => s !== null);
  if (!stop) return false;
  pauseBackgroundFetching(stop, apiKey);
  return true;
}

/** One background lookup. Resolves to what stopped it, or null; never rejects. */
async function backgroundFetch(id: number): Promise<FetchStop | null> {
  try {
    const item = Zotero.Items.get(id) as _ZoteroTypes.Item | false | undefined;
    if (!item) {
      rememberAttempt(id);
      return null;
    }
    // Free identifier lookups only: the metered title search runs when the user
    // opens the item or fetches from the menu. A refusal is recorded once, for
    // the whole stop, by pauseBackgroundFetching.
    const result = await fetchAndCacheItem(item, {
      identifierLookupsOnly: true,
      recordRefusals: false,
    });
    const stop = fetchStopFor(result);
    // Not remembered as tried, so the item is looked up once fetching resumes.
    if (stop) return stop;
    rememberAttempt(id);
    // Repaint this row as soon as its data lands, rather than at the end of the pass.
    if (result.status === "ok") invalidateColumnCache(id);
    return null;
  } catch (e) {
    logError(`processFetchQueue item ${id}`, e);
    rememberAttempt(id);
    return null;
  } finally {
    fetchInFlight.delete(id);
  }
}

/**
 * Stop background fetching: drop the queue, and let no new lookup start until
 * {@link backgroundFetchPaused} says otherwise. A refused request is recorded
 * here, once for the stop; a cache that refuses writes is not, because opening
 * it read-only already recorded why.
 */
function pauseBackgroundFetching(stop: FetchStop, apiKey: string): void {
  fetchQueue.clear();
  if (stop === "cache-unwritable") {
    backgroundPause = { stop, apiKey: null };
    return;
  }
  backgroundPause = { stop, apiKey };
  logError(
    "column background fetch paused until the OpenAlex API key changes",
    stop === "auth" ? new OpenAlexAuthError() : new OpenAlexBudgetError(),
  );
}

/**
 * Remember that the queue looked an item up, in the current epoch.
 *
 * Past MAX_ATTEMPTED_FETCH_CACHE entries the oldest are forgotten, and only
 * those can be looked up again; clearing the whole set would re-run every
 * earlier lookup on the next repaint. An entry of the current epoch is never
 * forgotten: an item this pass looked up, or a stale row a paint drew since the
 * last pass ended. Each pass ends with a repaint, so forgetting a row that
 * repaint draws queues it again, and sorting by a Citegeist column draws every
 * row. A library with more stale rows than the cap would otherwise look the
 * overflow up again on every pass, all session.
 *
 * So the map holds at most MAX_ATTEMPTED_FETCH_CACHE entries, or, when one epoch
 * draws and looks up more items than that, as many as that epoch touched: never
 * more than the rows Zotero's item trees hold.
 */
function rememberAttempt(id: number): void {
  fetchAttempted.delete(id);
  fetchAttempted.set(id, fetchEpoch);
  for (const [oldest, epoch] of fetchAttempted) {
    if (fetchAttempted.size <= MAX_ATTEMPTED_FETCH_CACHE || epoch === fetchEpoch) break;
    fetchAttempted.delete(oldest);
  }
}

/**
 * Move a drawn row's entry into the current epoch, so {@link rememberAttempt}
 * does not forget an item a repaint still draws. Re-inserting it at the end
 * keeps the map in epoch order.
 */
function keepAttemptWhileDrawn(id: number): void {
  const epoch = fetchAttempted.get(id);
  if (epoch === undefined || epoch === fetchEpoch) return;
  fetchAttempted.delete(id);
  fetchAttempted.set(id, fetchEpoch);
}

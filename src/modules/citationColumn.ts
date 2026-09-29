/**
 * Custom columns in Zotero's item tree.
 *
 * Article-level:  Citations, FWCI, Percentile
 * Journal-level:  2yr Citedness (JIF equiv), Journal H-Index
 * Rankings:       UTD24, FT50, ABDC (2022), AJG (2021)
 *
 * Uses Zotero's ItemTreeManager.registerColumn API. The metric columns read
 * cached metrics and hand each drawn row to the registration's background
 * fetcher (backgroundFetch.ts), which decides whether the row is due a lookup;
 * all five share it, so a row is looked up once. Journal rankings come from a
 * bundled lookup table (zero API calls).
 *
 * A row whose data changed is redrawn with a targeted refresh of that row (see
 * {@link requestRows}), never by reloading the item list.
 */

import { getCachedMetrics, type AllMetrics } from "./cache";
import { fetchAndCacheItem, type FetchResult } from "./citationService";
import { createBackgroundFetcher, type BackgroundFetcher } from "./backgroundFetch";
import { lookupRanking, RANKING_VERSIONS, type JournalRanking } from "../data/journalRankings";
import { apiKeyForRequests, getCachedSourceISSNs } from "./openalex";
import { selectedItemsInWindow } from "./host/selection";
import { logError, isBookType } from "./utils";
import { guard } from "./diagnostics";
import { COLUMN_REFRESH_THROTTLE_MS, RECENTLY_DRAWN_ROWS } from "../constants";
import { isAutoFetchEnabled } from "./prefs";

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

type Item = _ZoteroTypes.Item;
type TimerHandle = ReturnType<typeof setTimeout>;

/** What one paint of a row reads, shared by its cells within that paint. */
interface RowReading {
  metrics?: AllMetrics;
  ranking?: JournalRanking | null;
}

/**
 * One registration of the columns, from `registerCitationColumn` to
 * `unregisterCitationColumn`. Everything that outlives a paint lives here and
 * ends with it: the background fetcher, the batched row refresh and every timer.
 * The dataProviders close over their own registration, so one Zotero still
 * calls after an unregistration reaches a stopped fetcher, never the next
 * registration's.
 */
interface ColumnRegistration {
  readonly pluginID: string;
  readonly fetcher: BackgroundFetcher;
  readonly rows: RowRefresher;
  readonly drawn: RecentlyDrawn;
  /** This paint's readings, by row, cleared once the paint is over. */
  readonly paint: Map<number, RowReading>;
  paintTimer: TimerHandle | null;
}

let registration: ColumnRegistration | null = null;

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

// ── Reading a row ────────────────────────────────────────────────────────────

/**
 * The row's item when it is a regular Zotero item, else null. Zotero hands a
 * column whatever the row holds, and in the trash that includes deleted
 * collections and saved searches (itemTree.jsx@8.0.4 lines 4146-4155 and
 * @9.0.6 lines 4377-4386 pass `this.ref`; itemTreeRow.js@10.0.2 lines 590-597
 * and 627-634), which have no `isRegularItem`. A Zotero item's `objectType` is
 * "item", or "feedItem" in a feed (dataObject.js@10.0.2 lines 75-77, item.js
 * line 99, feedItem.js line 41), so it is checked before anything is called.
 */
function asRegularItem(row: unknown): Item | null {
  if (typeof row !== "object" || row === null) return null;
  const objectType = (row as { objectType?: unknown }).objectType;
  if (objectType !== "item" && objectType !== "feedItem") return null;
  const item = row as Item;
  return item.isRegularItem() ? item : null;
}

/**
 * This paint's reading of a row. Zotero paints a row by calling each column's
 * dataProvider in turn, so the five metric columns and the four ranking columns
 * share one reading; it is cleared once the paint is over, so the next paint of
 * the row reads the cache again and sees data that went stale meanwhile.
 */
function reading(reg: ColumnRegistration, item: Item): RowReading {
  let entry = reg.paint.get(item.id);
  if (entry === undefined) {
    entry = {};
    reg.paint.set(item.id, entry);
    if (reg.paintTimer === null) {
      reg.paintTimer = setTimeout(() => {
        reg.paintTimer = null;
        reg.paint.clear();
      }, 0);
    }
  }
  return entry;
}

/** The row's cached metrics. Reads the cache; queues nothing. */
function cachedMetrics(reg: ColumnRegistration, item: Item): AllMetrics {
  const entry = reading(reg, item);
  entry.metrics ??= getCachedMetrics(item);
  return entry.metrics;
}

/** What a metric column draws from: the row's cached metrics, and whether a lookup is coming. */
interface MetricCell {
  readonly item: Item;
  readonly metrics: AllMetrics;
  /** A background lookup is queued or running: the cell shows "…" until it lands. */
  readonly pending: boolean;
}

/**
 * A metric cell's inputs: the row's cached metrics, and the fetcher's answer to
 * whether a lookup is coming, which queues one when it is due.
 */
function metricCell(reg: ColumnRegistration, row: unknown): MetricCell | null {
  const item = asRegularItem(row);
  if (!item) return null;
  reg.drawn.note(item.id);
  const metrics = cachedMetrics(reg, item);
  return { item, metrics, pending: reg.fetcher.offer(item, metrics) };
}

/**
 * Get journal ranking for an item. Uses the item's ISSN field
 * to look up against the bundled ranking table.
 */
function getRanking(reg: ColumnRegistration, row: unknown): JournalRanking | null {
  const item = asRegularItem(row);
  if (!item) return null;

  const entry = reading(reg, item);
  if (entry.ranking !== undefined) return entry.ranking;

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

  // 2. ISSNs stored from a previous OpenAlex fetch (persist across sessions)
  const metrics = cachedMetrics(reg, item);
  for (const stored of metrics.sourceISSNs) {
    if (stored && !issns.some((i) => i.toUpperCase() === stored.toUpperCase())) {
      issns.push(stored);
    }
  }

  // 3. In-memory OpenAlex source cache (current session, best coverage)
  if (metrics.sourceId) {
    for (const oa of getCachedSourceISSNs(metrics.sourceId)) {
      if (oa && !issns.some((i) => i.toUpperCase() === oa.toUpperCase())) {
        issns.push(oa);
      }
    }
  }

  entry.ranking = issns.length > 0 ? lookupRanking(issns) : null;
  return entry.ranking;
}

// ── Redrawing rows ───────────────────────────────────────────────────────────

/**
 * The rows the dataProviders drew last, newest last. Used only to lead a redraw
 * on Zotero 8 and 9 (see {@link orderForHost}).
 */
class RecentlyDrawn {
  private readonly ids = new Set<number>();

  note(id: number): void {
    this.ids.delete(id);
    this.ids.add(id);
    if (this.ids.size > RECENTLY_DRAWN_ROWS) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
  }

  /** The most recently drawn row that passes `accept`. */
  latest(accept: (id: number) => boolean): number | undefined {
    return [...this.ids].reverse().find(accept);
  }
}

/** Collects the rows to redraw and sends them together. */
interface RowRefresher {
  /**
   * Redraw these rows: at the next turn, at most once per
   * COLUMN_REFRESH_THROTTLE_MS, or at once when `now` (the end of a pass, a
   * pause lifting). Never sends within the call, which can come from a
   * dataProvider in the middle of Zotero's paint.
   */
  request(ids: readonly number[], now: boolean): void;
  /** Drop what is waiting and clear the timer. */
  stop(): void;
}

function createRowRefresher(drawn: RecentlyDrawn): RowRefresher {
  const waiting = new Set<number>();
  let timer: TimerHandle | null = null;
  let timerDue = 0;
  let lastSentAt: number | null = null;
  let stopped = false;

  function send(): void {
    timer = null;
    if (stopped || waiting.size === 0) return;
    const ids = [...waiting];
    waiting.clear();
    lastSentAt = Date.now();
    sendRowRefresh(ids, drawn);
  }

  return {
    request(ids, now) {
      if (stopped) return;
      for (const id of ids) waiting.add(id);
      if (waiting.size === 0) return;
      const at = Date.now();
      // A clock set backwards is treated as a window already over.
      const since = lastSentAt === null || at < lastSentAt ? Infinity : at - lastSentAt;
      const delay = now ? 0 : Math.max(0, COLUMN_REFRESH_THROTTLE_MS - since);
      if (timer !== null) {
        if (at + delay >= timerDue) return;
        clearTimeout(timer);
      }
      timerDue = at + delay;
      timer = setTimeout(() => guard("column row refresh", send), delay);
    },
    stop() {
      stopped = true;
      waiting.clear();
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * Forget this paint's readings of the rows and ask for them to be redrawn. The
 * one path by which a change of Citegeist's data reaches the item tree: the
 * background fetcher, the item pane, the citation browser and the menu's fetch
 * all come through here.
 */
function requestRows(reg: ColumnRegistration, ids: readonly number[], now: boolean): void {
  for (const id of ids) reg.paint.delete(id);
  reg.rows.request(ids, now);
}

/** `Zotero.Notifier`, limited to the one call the row refresh makes. */
interface ItemNotifier {
  trigger(event: "refresh", type: "item", ids: number[]): Promise<unknown>;
}

/**
 * Send one item "refresh" for these rows. Every window's item tree answers it
 * by dropping just those rows' cached cells and redrawing them, which calls the
 * dataProviders again (itemTree.jsx@8.0.4 lines 532-562 and @9.0.6 lines
 * 539-569; @10.0.2 through the row provider, itemTree.jsx lines 1322-1356 and
 * 854-868, collectionViewItemTree.jsx lines 719-762). It reloads no item list:
 * `ItemTreeManager.refreshColumns()` queues an "itemtree" refresh
 * (pluginAPIBase.mjs@10.0.2 lines 325-337) that makes every tree reset its
 * columns and reload every item (itemTree.jsx@8.0.4 lines 458-461, @10.0.2
 * lines 1324-1327), so it is left to Zotero's own register and unregister.
 * `trigger` queues the event while a notifier transaction is open
 * (notifier.js@10.0.2 lines 132-135), and runs each observer in turn.
 */
function sendRowRefresh(ids: readonly number[], drawn: RecentlyDrawn): void {
  const ordered = orderForHost(ids, drawn);
  if (ordered.length === 0) return;
  const notifier = Zotero.Notifier as ItemNotifier | undefined;
  if (typeof notifier?.trigger !== "function") return;
  void notifier
    .trigger("refresh", "item", ordered)
    .catch((e: unknown) => logError("column row refresh", e));
}

/**
 * The rows in an order Zotero redraws without touching the selection.
 *
 * Zotero 8 and 9 answer an item "refresh" whose first ID is a tree's only
 * selected item by redrawing that row alone, then deselecting and reselecting it
 * (itemTree.jsx@8.0.4 lines 545-553, @9.0.6 lines 552-560). The reselection
 * renders the item pane empty and then again (zoteroPane.js@8.0.4 lines
 * 1929-1974), which can take the focus from a field the user is typing in, and
 * the rest of the rows go unredrawn in that tree. Zotero 10 has no such branch
 * (itemTree.jsx@10.0.2 lines 854-868; collectionViewItemTree.jsx@10.0.2 lines
 * 719-762). So on hosts before 10 the refresh leads with a row that is no main
 * window's only selection: one of its own rows, or else a row drawn recently.
 * With neither, the only-selected rows wait for their next paint.
 */
function orderForHost(ids: readonly number[], drawn: RecentlyDrawn): number[] {
  if (!refreshReselectsSoleSelection()) return [...ids];
  const sole = soleSelectedItemIDs();
  if (sole.size === 0) return [...ids];
  const lead =
    ids.find((id) => !sole.has(id)) ?? drawn.latest((id) => !sole.has(id) && itemExists(id));
  if (lead === undefined) {
    Zotero.debug("[Citegeist] Row refresh skipped: its only rows are a window's sole selection");
    return [];
  }
  return [lead, ...ids.filter((id) => id !== lead)];
}

/** Whether an item "refresh" led by a tree's only selected item reselects it: every Zotero before 10. */
function refreshReselectsSoleSelection(): boolean {
  const major = Number.parseInt(String(Zotero.version), 10);
  return !(major >= 10);
}

/** The items that are the only selected item in some main window. */
function soleSelectedItemIDs(): Set<number> {
  const sole = new Set<number>();
  let windows: Window[] = [];
  try {
    windows = Zotero.getMainWindows();
  } catch {
    return sole;
  }
  for (const win of windows) {
    try {
      const selected = selectedItemsInWindow(win);
      if (selected.length === 1) sole.add(selected[0].id);
    } catch {
      // A window whose selection cannot be read has none to protect.
    }
  }
  return sole;
}

function itemExists(id: number): boolean {
  try {
    return Boolean(Zotero.Items.get(id));
  } catch {
    return false;
  }
}

// ── Registration ─────────────────────────────────────────────────────────────

/** One background lookup: identifier lookups only, and failures that pause lookups left to the fetcher to record. */
async function lookUpInBackground(id: number): Promise<FetchResult> {
  const item = Zotero.Items.get(id);
  if (!item) return { status: "error", error: "invalid-item" };
  return fetchAndCacheItem(item, { identifierLookupsOnly: true, callerRecordsStops: true });
}

function createRegistration(pluginID: string): ColumnRegistration {
  const drawn = new RecentlyDrawn();
  const rows = createRowRefresher(drawn);
  const paint = new Map<number, RowReading>();
  const reg: ColumnRegistration = {
    pluginID,
    drawn,
    rows,
    paint,
    paintTimer: null,
    // Zotero's pref observer (Zotero.Prefs.registerObserver, prefs.js@10.0.2
    // lines 485-493) reaches the fetcher as `watchSettings` once prefs.ts, the
    // only module allowed to touch Zotero.Prefs, offers one. Until then a
    // changed setting takes effect on the row's next paint.
    fetcher: createBackgroundFetcher({
      fetchItem: lookUpInBackground,
      refreshRows: (ids, now) => requestRows(reg, ids, now),
      readAutoFetch: isAutoFetchEnabled,
      readApiKey: apiKeyForRequests,
      now: () => Date.now(),
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (handle) => clearTimeout(handle),
    }),
  };
  return reg;
}

/** End a registration: stop its fetcher, its row refresh and its timers. Resolves once a running pass has ended. */
function retire(reg: ColumnRegistration): Promise<void> {
  reg.rows.stop();
  if (reg.paintTimer !== null) {
    clearTimeout(reg.paintTimer);
    reg.paintTimer = null;
  }
  reg.paint.clear();
  return reg.fetcher.stop();
}

export async function registerCitationColumn(pluginID: string): Promise<void> {
  if (registration) return;
  // Claim the registration BEFORE the first await so a parallel/re-entrant call
  // (Zotero fires onStartup + onMainWindowLoad on the same launch and can race)
  // doesn't register again mid-flight: every register call racing past the
  // guard hit "dataKey must be unique" and silently never wired its
  // dataProvider, leaving columns blank.
  const reg = createRegistration(pluginID);
  registration = reg;

  // FIRST PRINCIPLES: Zotero's pluginAPIBase stores registered keys
  // as `CSS.escape(${pluginID}-${dataKey})` — see
  // chrome/content/zotero/xpcom/pluginAPI/pluginAPIBase.mjs
  // `_namespacedMainKey()`. Calling `unregisterColumn("citegeist-fwci")`
  // looks up the un-prefixed key and silently fails (registry only
  // knows the namespaced form). Stale columns from a prior plugin
  // lifetime stay, and the next `registerColumn` throws
  // "dataKey must be unique" on the namespaced form — exactly the
  // error the user reported.
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
  // wired (plus best-effort the one that just failed), end this registration so
  // a retry starts clean, and rethrow so the caller (hooks.onStartup) can tear
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
      if (registration === reg) registration = null;
      void retire(reg);
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
    dataProvider: (row: _ZoteroTypes.Item, _dataKey: string) => {
      const cell = metricCell(reg, row);
      if (!cell) return "";
      const { item, metrics } = cell;
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
    dataProvider: (row: _ZoteroTypes.Item, _dataKey: string) => {
      const cell = metricCell(reg, row);
      if (!cell) return "";
      const { item, metrics } = cell;
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
    dataProvider: (row: _ZoteroTypes.Item, _dataKey: string) => {
      const cell = metricCell(reg, row);
      if (!cell) return "";
      const { item, metrics } = cell;
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
    dataProvider: (row: _ZoteroTypes.Item, _dataKey: string) => {
      const cell = metricCell(reg, row);
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
    dataProvider: (row: _ZoteroTypes.Item, _dataKey: string) => {
      const cell = metricCell(reg, row);
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
    dataProvider: (row: _ZoteroTypes.Item, _dataKey: string) => {
      const r = getRanking(reg, row);
      return r?.utd24 ? "✓" : "";
    },
  });

  await safeRegister({
    dataKey: COL_FT50,
    label: `FT50`,
    pluginID,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    sortReverse: true,
    dataProvider: (row: _ZoteroTypes.Item, _dataKey: string) => {
      const r = getRanking(reg, row);
      return r?.ft50 ? "✓" : "";
    },
  });

  await safeRegister({
    dataKey: COL_ABDC,
    label: `ABDC '${RANKING_VERSIONS.abdc.slice(2)}`,
    pluginID,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    sortReverse: true,
    dataProvider: (row: _ZoteroTypes.Item, _dataKey: string) => {
      const r = getRanking(reg, row);
      return r?.abdc ?? "";
    },
  });

  await safeRegister({
    dataKey: COL_AJG,
    label: `AJG '${RANKING_VERSIONS.ajg.slice(2)}`,
    pluginID,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    sortReverse: true,
    dataProvider: (row: _ZoteroTypes.Item, _dataKey: string) => {
      const r = getRanking(reg, row);
      return r?.ajg ?? "";
    },
  });

  Zotero.debug("[Citegeist] All columns registered (9 total: article, journal, rankings)");
}

/**
 * Redraw these rows' Citegeist cells after their cached data changed: this
 * paint's reading of them is dropped, and a targeted refresh of just those rows
 * follows, batched with other rows that change within
 * COLUMN_REFRESH_THROTTLE_MS. The item pane, the citation browser and the
 * menu's fetch call it; a fetch the user starts redraws its rows as they land.
 * Does nothing while the columns are not registered.
 */
export function invalidateColumnCache(itemIds: number | readonly number[]): void {
  const reg = registration;
  if (reg === null) return;
  requestRows(reg, typeof itemIds === "number" ? [itemIds] : itemIds, false);
}

/**
 * Take the columns down and end their registration: the background fetcher
 * stops, and no timer of the registration is left behind. Resolves once a pass
 * that was running has ended; the columns are gone before it resolves.
 */
export function unregisterCitationColumn(): Promise<void> {
  const reg = registration;
  if (reg === null) return Promise.resolve();
  registration = null;
  const stopped = retire(reg);

  for (const key of ALL_COLUMNS) {
    try {
      Zotero.ItemTreeManager.unregisterColumn(namespacedColumnKey(reg.pluginID, key));
    } catch {
      // Column may already be removed
    }
  }
  return stopped;
}

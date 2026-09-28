/**
 * The columns' background fetch (U18).
 *
 * The item-tree columns look up missing or stale metrics on their own once
 * `autoFetch` is on, which it is by default. OpenAlex meters title searches, so a
 * background pass over a large library of items without a DOI, PMID, arXiv ID or
 * ISBN would spend the user's daily allowance unseen. These tests drive the real
 * columns, the real background fetcher and the real fetch service against the
 * fake cache, with OpenAlex and the title search mocked. They check that only a
 * fetch the user starts searches by title, that a "…" cell always means a lookup
 * is coming, that lookups pause on a refused request, a spent budget or network
 * trouble and resume by rule, that landed rows are redrawn by a batched,
 * targeted refresh and never by reloading the item list, and that no lookup is
 * repeated needlessly.
 *
 * Each window's item tree is a {@link FakeTree} that answers an item "refresh"
 * as Zotero does: it redraws the named rows it shows, which calls the
 * dataProviders again, and on Zotero 8 and 9 a refresh led by its only selected
 * item redraws that row alone and reselects it (itemTree.jsx@8.0.4 lines
 * 545-561).
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, mockZotero, resetCacheHarness } from "./_helpers/cacheHarness";
import type * as ConstantsModule from "../src/constants";
import type * as OpenAlexModule from "../src/modules/openalex";

// A small tried-set cap, so the tests of the set of looked-up rows can overflow
// it with a few rows. No other test here leaves more than a couple of failed
// lookups behind.
vi.mock("../src/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof ConstantsModule>()),
  MAX_ATTEMPTED_FETCH_CACHE: 3,
}));
vi.mock("../src/modules/titleSearch", () => ({ searchByMetadata: vi.fn(async () => null) }));
vi.mock("../src/modules/openalex", async (importOriginal) => ({
  ...(await importOriginal<typeof OpenAlexModule>()),
  getWorkByDOI: vi.fn(async () => null),
  getWorkById: vi.fn(async () => null),
  getSourceStats: vi.fn(async () => null),
}));

import {
  AUTO_FETCH_PREF_TTL_MS,
  BACKGROUND_RETRY_MIN_MS,
  CACHE_SCHEMA_MAJOR,
  CACHE_SCHEMA_STAMP_MULTIPLIER,
  COLUMN_REFRESH_THROTTLE_MS,
  DEFAULT_CACHE_LIFETIME_DAYS,
  FETCH_BATCH_SIZE,
  FETCH_QUEUE_DEBOUNCE_MS,
  MAX_ATTEMPTED_FETCH_CACHE,
  NO_MATCH_RETRY_DAYS,
  PREF_AUTO_FETCH,
  PREF_OPENALEX_API_KEY,
} from "../src/constants";
import {
  cacheWriteRefusalCode,
  confirmTitleMatch,
  dismissAsNoMatch,
  getCachedData,
  initCache,
  isNoMatchSuppressed,
  writeNoMatch,
  writePendingSuggestion,
} from "../src/modules/cache";
import { _resetForTesting } from "../src/modules/cache/db";
import {
  invalidateColumnCache,
  registerCitationColumn,
  unregisterCitationColumn,
} from "../src/modules/citationColumn";
import { fetchAndCacheItem, fetchAndCacheItems } from "../src/modules/citationService";
import { clearDiagnostics, recentDiagnostics } from "../src/modules/diagnostics";
import { getWorkByDOI, getWorkById } from "../src/modules/openalex";
import { setPref } from "../src/modules/prefs";
import { searchByMetadata } from "../src/modules/titleSearch";
import { OpenAlexAuthError, OpenAlexBudgetError, OpenAlexNetworkError } from "../src/modules/utils";

const PLUGIN_ID = "citegeist@opusvita.org";
const DAY_MS = 24 * 60 * 60 * 1000;
/** The five columns that draw OpenAlex metrics, and so the five that can show "…". */
const METRIC_COLUMNS = [
  "citegeist-citation-count",
  "citegeist-fwci",
  "citegeist-percentile",
  "citegeist-citedness-2yr",
  "citegeist-journal-hindex",
] as const;
const RANKING_COLUMNS = [
  "citegeist-utd24",
  "citegeist-ft50",
  "citegeist-abdc",
  "citegeist-ajg",
] as const;
const CITATIONS = METRIC_COLUMNS[0];
const EMPTY_ROW = ["", "", "", "", ""];

type Item = _ZoteroTypes.Item;
type DataProvider = (item: Item, dataKey: string) => string;
const providers = new Map<string, DataProvider>();
const itemsById = new Map<number, Item>();
let nextItemId = 1;

/**
 * One window's item tree, as far as an item "refresh" reaches it: it redraws the
 * named rows it shows, and on Zotero 8 and 9 a refresh led by its only selected
 * item redraws that row alone and reselects it.
 */
class FakeTree {
  /** The rows in view. */
  rowsInView: () => Item[] = () => [];
  selection: Item[] = [];
  /** Redraw every row in view on each refresh, as while sorting by a Citegeist column. */
  drawsEveryRow = false;
  /** Every row a refresh redrew, in order. */
  readonly redrawn: number[] = [];
  /** Refreshes that deselected and reselected the tree's only selected item. */
  reselections = 0;
  readonly window = { ZoteroPane: { getSelectedItems: () => this.selection } };

  refresh(ids: readonly number[]): void {
    const major = Number.parseInt(mockZotero.version, 10);
    if (major < 10 && this.selection.length === 1 && this.selection[0].id === ids[0]) {
      this.reselections++;
      this.draw([ids[0]]);
      return;
    }
    const inView = this.rowsInView().map((row) => row.id);
    this.draw(this.drawsEveryRow ? inView : ids.filter((id) => inView.includes(id)));
  }

  private draw(ids: readonly number[]): void {
    for (const id of ids) {
      this.redrawn.push(id);
      const item = itemsById.get(id);
      if (item) rowCells(item);
    }
  }
}
const trees: FakeTree[] = [];

/** Every item refresh sent, with the fake time it was sent at. */
const refreshes: Array<{ at: number; ids: number[] }> = [];
const notifierTrigger = vi.fn(async (event: string, type: string, ids: number[]) => {
  if (event === "refresh" && type === "item") {
    refreshes.push({ at: Date.now(), ids: [...ids] });
    for (const tree of trees) tree.refresh(ids);
  }
  return true;
});
const refreshColumns = vi.fn();

vi.stubGlobal("CSS", { escape: (s: string) => s });
Object.assign(mockZotero, {
  ItemTreeManager: {
    registerColumn: vi.fn(async (options: { dataKey: string; dataProvider: DataProvider }) => {
      providers.set(options.dataKey, options.dataProvider);
    }),
    unregisterColumn: vi.fn(),
    refreshColumns,
  },
  Notifier: { trigger: notifierTrigger },
  getMainWindows: () => trees.map((tree) => tree.window),
  getActiveZoteroPane: () => trees[0]?.window.ZoteroPane ?? null,
});
const getItem = vi.fn((id: number) => itemsById.get(id));
Object.assign(mockZotero.Items, { get: getItem });

function makeItem(
  key: string,
  fields: { DOI?: string; title: string; deleted?: boolean; feed?: boolean },
): Item {
  const values: Record<string, string> = { DOI: fields.DOI ?? "", title: fields.title };
  const item = {
    id: nextItemId++,
    key,
    libraryID: 1,
    itemType: "journalArticle",
    objectType: fields.feed ? "feedItem" : "item",
    isFeedItem: fields.feed ? true : undefined,
    deleted: fields.deleted ?? false,
    isRegularItem: () => true,
    getField: (field: string) => values[field] ?? "",
    setField: (field: string, value: string) => {
      values[field] = value;
    },
    saveTx: async () => 1,
  } as unknown as Item;
  itemsById.set(item.id, item);
  return item;
}

/** `count` journal articles, each with its own DOI. */
function doiItems(count: number, prefix: string): Item[] {
  return Array.from({ length: count }, (_, i) =>
    makeItem(`${prefix}${i}`, {
      DOI: `10.5555/${prefix.toLowerCase()}-${i}`,
      title: `${prefix} ${i}`,
    }),
  );
}

function work(citedByCount: number) {
  return {
    id: "https://openalex.org/W4200000001",
    doi: "https://doi.org/10.5555/auto-fetch",
    title: "Auto-fetch fixture",
    display_name: "Auto-fetch fixture",
    publication_year: 2024,
    publication_date: "2024-01-01",
    cited_by_count: citedByCount,
    referenced_works_count: 0,
    fwci: 1.2,
    citation_normalized_percentile: {
      value: 0.8,
      is_in_top_1_percent: false,
      is_in_top_10_percent: false,
    },
    counts_by_year: [],
    open_access: { is_oa: false, oa_status: "closed", oa_url: null },
    authorships: [],
    primary_location: null,
    biblio: { volume: null, issue: null, first_page: null, last_page: null },
    type: "article",
    is_retracted: false,
    referenced_works: [],
    abstract_inverted_index: null,
  };
}

/** A cell as Zotero paints it. Painting is what queues the background fetch. */
function cell(row: unknown, dataKey: string = CITATIONS): string {
  const provide = providers.get(dataKey);
  if (!provide) throw new Error(`the ${dataKey} column never registered a dataProvider`);
  return provide(row as Item, dataKey);
}

/** Every metric cell of a row. */
function rowCells(row: unknown): string[] {
  return METRIC_COLUMNS.map((dataKey) => cell(row, dataKey));
}

/** How many times OpenAlex was asked for this DOI. */
function lookupsOf(doi: string): number {
  return vi.mocked(getWorkByDOI).mock.calls.filter(([asked]) => asked === doi).length;
}

/**
 * Let `ms` of fake time pass. Each step runs every timer due in it, including
 * timers set by the ones before, and settles their promises, so the step size
 * only bounds how much real time one call can take.
 */
async function settle(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += SETTLE_STEP_MS) {
    await vi.advanceTimersByTimeAsync(Math.min(SETTLE_STEP_MS, ms - elapsed));
  }
}
const SETTLE_STEP_MS = 1_000;

/**
 * Let fake time run until nothing is left scheduled: the queue has drained and
 * its rows have been redrawn. Not for a paused queue, whose resume timer stays.
 */
async function drainBackgroundQueue(): Promise<void> {
  for (let i = 0; i < 1_000; i++) {
    await vi.advanceTimersByTimeAsync(250);
    if (vi.getTimerCount() === 0) return;
  }
  throw new Error("the background queue never went quiet");
}

/**
 * Real-time budget for a test that runs minutes of fake time: well inside it on
 * its own, but the whole suite runs files side by side.
 */
const LONG_FAKE_TIME_BUDGET_MS = 20_000;

/** A tree in one window showing `rows`. */
function showRows(rows: readonly Item[] | (() => Item[])): FakeTree {
  const tree = new FakeTree();
  tree.rowsInView = typeof rows === "function" ? rows : () => [...rows];
  trees.push(tree);
  return tree;
}

beforeEach(async () => {
  await resetCacheHarness(initCache, _resetForTesting);
  vi.mocked(searchByMetadata).mockReset().mockResolvedValue(null);
  vi.mocked(getWorkByDOI).mockReset().mockResolvedValue(null);
  vi.mocked(getWorkById).mockReset().mockResolvedValue(null);
  providers.clear();
  itemsById.clear();
  getItem.mockClear();
  trees.length = 0;
  refreshes.length = 0;
  notifierTrigger.mockClear();
  refreshColumns.mockClear();
  mockZotero.version = "9.0.6";
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await registerCitationColumn(PLUGIN_ID);
  clearDiagnostics();
});

afterEach(async () => {
  await unregisterCitationColumn();
  vi.useRealTimers();
});

describe("the columns' background fetch", () => {
  it("is on by default, so painting a DOI item queues its lookup and shows it is on the way", async () => {
    const item = makeItem("DOI1", { DOI: "10.5555/auto-fetch", title: "Has a DOI" });
    vi.mocked(getWorkByDOI).mockResolvedValue(work(42) as never);

    expect(cell(item)).toBe("…");
    await drainBackgroundQueue();

    expect(getWorkByDOI).toHaveBeenCalledWith("10.5555/auto-fetch");
    expect(cell(item)).toBe("42");
    expect(searchByMetadata).not.toHaveBeenCalled();
  });

  it("never queues an item without an identifier: no lookup, no title search, no no-match, and an empty cell", async () => {
    const item = makeItem("NODOI", { title: "A paper with no identifier" });
    const control = makeItem("CTRL", { DOI: "10.5555/control", title: "Has a DOI" });

    expect(cell(item)).toBe("");
    expect(cell(control)).toBe("…");
    await drainBackgroundQueue();

    expect(getItem, "positive control: the queue reached the DOI item").toHaveBeenCalledWith(
      control.id,
    );
    expect(getItem, "the queue spent a batch slot on it").not.toHaveBeenCalledWith(item.id);
    expect(searchByMetadata).not.toHaveBeenCalled();
    expect(fakeDb.table.has(`1:${item.key}`), "a cache row was written").toBe(false);
    expect(isNoMatchSuppressed(item, NO_MATCH_RETRY_DAYS)).toBe(false);
    expect(recentDiagnostics()).toEqual([]);
    expect(cell(item)).toBe("");
  });

  it("does not fall back to a title search when OpenAlex does not know the DOI", async () => {
    const item = makeItem("DOI404", { DOI: "10.5555/unknown", title: "DOI OpenAlex lacks" });

    expect(cell(item)).toBe("…");
    await drainBackgroundQueue();

    expect(getWorkByDOI).toHaveBeenCalledWith("10.5555/unknown");
    expect(searchByMetadata).not.toHaveBeenCalled();
    expect(getCachedData(item)).toBeNull();
    expect(isNoMatchSuppressed(item, NO_MATCH_RETRY_DAYS)).toBe(false);
    expect(recentDiagnostics()).toEqual([]);
    expect(cell(item)).toBe("");
  });
});

describe("a '…' cell and the queue follow one rule", () => {
  it.each([
    ["a title search found nothing", writeNoMatch],
    ["the user dismissed its match", dismissAsNoMatch],
  ])(
    "an identifier item for which %s is still looked up by its identifier: the 30-day hold-off is for the metered search",
    async (_label, suppress) => {
      const item = makeItem("SUPP", { DOI: "10.5555/suppressed", title: "Suppressed" });
      await suppress(item);
      expect(isNoMatchSuppressed(item, NO_MATCH_RETRY_DAYS), "positive control").toBe(true);
      vi.mocked(getWorkByDOI).mockResolvedValue(work(11) as never);

      expect(cell(item)).toBe("…");
      await drainBackgroundQueue();

      expect(getWorkByDOI).toHaveBeenCalledWith("10.5555/suppressed");
      expect(searchByMetadata).not.toHaveBeenCalled();
      expect(cell(item)).toBe("11");
    },
  );

  it("a DOI added after a title search found nothing is looked up on the row's next paint", async () => {
    const item = makeItem("LATEDOI", { title: "No DOI yet" });
    await writeNoMatch(item);
    expect(cell(item)).toBe("");
    await settle(2_000);
    expect(getWorkByDOI).not.toHaveBeenCalled();

    item.setField("DOI", "10.5555/added-later");
    expect(cell(item)).toBe("…");
    await drainBackgroundQueue();

    expect(getWorkByDOI).toHaveBeenCalledWith("10.5555/added-later");
  });

  it("an item with a confirmed OpenAlex ID and no identifier shows '…' and is looked up by that ID", async () => {
    const item = makeItem("CONF", { title: "Matched by title" });
    await writePendingSuggestion(item, { ...work(7), doi: null } as never, "high", 0.95);
    await confirmTitleMatch(item, "high");
    vi.mocked(getWorkById).mockResolvedValue(work(7) as never);

    expect(cell(item)).toBe("…");
    await drainBackgroundQueue();

    expect(getWorkById).toHaveBeenCalledWith("W4200000001");
    expect(cell(item)).toBe("7");
    expect(searchByMetadata).not.toHaveBeenCalled();
  });

  it("ticking auto-fetch queues a row that was drawn while it was off, on its next paint", async () => {
    mockZotero.Prefs.user.set(PREF_AUTO_FETCH, false);
    const item = makeItem("TICK", { DOI: "10.5555/tick", title: "Drawn while off" });
    vi.mocked(getWorkByDOI).mockResolvedValue(work(3) as never);

    expect(cell(item)).toBe("");
    await settle(2_000);
    expect(getWorkByDOI).not.toHaveBeenCalled();

    setPref(PREF_AUTO_FETCH, true);
    await vi.advanceTimersByTimeAsync(AUTO_FETCH_PREF_TTL_MS + 1);
    expect(cell(item)).toBe("…");
    await drainBackgroundQueue();

    expect(getWorkByDOI).toHaveBeenCalledWith("10.5555/tick");
    expect(cell(item)).toBe("3");
  });

  it("a row repainted while its lookup is running keeps showing '…'", async () => {
    const item = makeItem("FLY", { DOI: "10.5555/in-flight", title: "In flight" });
    let land: (found: unknown) => void = () => {};
    vi.mocked(getWorkByDOI).mockImplementation(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }) as never,
    );

    expect(cell(item)).toBe("…");
    await settle(1_000);
    expect(getWorkByDOI, "positive control: the lookup started").toHaveBeenCalledTimes(1);
    invalidateColumnCache(item.id);
    expect(cell(item)).toBe("…");

    land(work(9));
    await settle(1_000);
    expect(cell(item)).toBe("9");
  });
});

describe("every metric column", () => {
  it.each(METRIC_COLUMNS)(
    "%s shows '…' while a DOI item's lookup is due, and '' once it finds nothing",
    async (dataKey) => {
      const item = makeItem("DUE", { DOI: "10.5555/due", title: "Due" });

      expect(cell(item, dataKey)).toBe("…");
      await drainBackgroundQueue();

      expect(getWorkByDOI).toHaveBeenCalledWith("10.5555/due");
      expect(cell(item, dataKey)).toBe("");
    },
  );

  it.each(METRIC_COLUMNS)(
    "%s leaves the cell of an item with nothing to look up empty",
    (dataKey) => {
      const item = makeItem("NOID", { title: "No identifier" });
      expect(cell(item, dataKey)).toBe("");
    },
  );

  it("is empty in every column, and nothing is looked up, when auto-fetch is off from the start", async () => {
    mockZotero.Prefs.user.set(PREF_AUTO_FETCH, false);
    const item = makeItem("OFF", { DOI: "10.5555/off", title: "Auto-fetch off" });

    expect(rowCells(item)).toEqual(EMPTY_ROW);
    await settle(3_000);

    expect(getWorkByDOI).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
    expect(rowCells(item)).toEqual(EMPTY_ROW);
  });
});

describe("rows that are no library item", () => {
  it.each([
    ["a collection in the trash", { objectType: "collection", id: 9001, name: "Trashed" }],
    ["a saved search in the trash", { objectType: "search", id: 9002, name: "Trashed" }],
  ])("%s draws an empty cell in every column and records nothing", async (_label, row) => {
    for (const dataKey of [...METRIC_COLUMNS, ...RANKING_COLUMNS]) {
      expect(cell(row, dataKey), dataKey).toBe("");
    }
    await settle(2_000);
    expect(recentDiagnostics(), "no column threw").toEqual([]);
    expect(getItem).not.toHaveBeenCalled();
  });

  it("a feed item is never looked up and never shows '…'", async () => {
    const item = makeItem("FEED", { DOI: "10.5555/feed", title: "From a feed", feed: true });
    const control = makeItem("CTRL", { DOI: "10.5555/control", title: "Control" });

    expect(rowCells(item)).toEqual(EMPTY_ROW);
    expect(cell(control), "positive control").toBe("…");
    await drainBackgroundQueue();

    expect(getWorkByDOI).not.toHaveBeenCalledWith("10.5555/feed");
    expect(rowCells(item)).toEqual(EMPTY_ROW);
  });

  it("an item in the trash is never looked up and never shows '…'", async () => {
    const item = makeItem("TRASH", { DOI: "10.5555/trash", title: "Trashed", deleted: true });

    expect(rowCells(item)).toEqual(EMPTY_ROW);
    await settle(3_000);

    expect(getWorkByDOI).not.toHaveBeenCalled();
  });
});

describe("redrawing the rows whose data landed", () => {
  it(
    "a pass of 40 rows landing at uneven latency: targeted refreshes, batched, at most one per throttle window plus one at the end, and no column reload",
    async () => {
      const rows = doiItems(40, "PASS");
      const windowA = showRows(rows);
      const windowB = showRows(rows);
      let firstLookupAt: number | null = null;
      vi.mocked(getWorkByDOI).mockImplementation(async (doi: string) => {
        firstLookupAt ??= Date.now();
        const index = Number(doi.split("-").at(-1));
        // Uneven: anywhere from 0 to 1.3 s, in no order.
        await new Promise((resolve) => setTimeout(resolve, (index * 7919) % 1_300));
        return work(100 + index) as never;
      });

      for (const row of rows) expect(cell(row)).toBe("…");
      await drainBackgroundQueue();

      expect(firstLookupAt, "positive control: the pass ran").not.toBeNull();
      const passDuration = (refreshes.at(-1)?.at ?? 0) - (firstLookupAt ?? 0);
      expect(refreshes.length, "rows filled in as the pass went").toBeGreaterThan(1);
      expect(refreshes.length).toBeLessThanOrEqual(
        Math.ceil(passDuration / COLUMN_REFRESH_THROTTLE_MS) + 1,
      );
      expect(refreshColumns, "no refresh reloads the item list").not.toHaveBeenCalled();
      const sent = new Set(refreshes.flatMap((r) => r.ids));
      expect(sent).toEqual(new Set(rows.map((row) => row.id)));
      for (const tree of [windowA, windowB]) {
        expect(new Set(tree.redrawn), "each window's tree redrew every landed row").toEqual(sent);
      }
      rows.forEach((row, index) => expect(cell(row)).toBe(String(100 + index)));
    },
    LONG_FAKE_TIME_BUDGET_MS,
  );

  it("the item pane's redraw of the selected item on Zotero 9 leads with another drawn row, so the item is not reselected", async () => {
    mockZotero.Prefs.user.set(PREF_AUTO_FETCH, false);
    const rows = doiItems(3, "SEL");
    const tree = showRows(rows);
    for (const row of rows) cell(row);
    tree.selection = [rows[1]];

    invalidateColumnCache(rows[1].id);
    await settle(500);

    expect(refreshes, "positive control: one refresh").toHaveLength(1);
    expect(refreshes[0].ids[0]).not.toBe(rows[1].id);
    expect(refreshes[0].ids).toContain(rows[1].id);
    expect(tree.reselections).toBe(0);
    expect(tree.redrawn).toContain(rows[1].id);
  });

  it("a background lookup of the selected item on Zotero 9 does not reselect it", async () => {
    const neighbours = [
      makeItem("N1", { title: "No identifier" }),
      makeItem("N2", { title: "No identifier" }),
    ];
    const [selected] = doiItems(1, "PICKED");
    const tree = showRows([...neighbours, selected]);
    tree.selection = [selected];
    vi.mocked(getWorkByDOI).mockResolvedValue(work(5) as never);

    for (const row of neighbours) cell(row);
    expect(cell(selected)).toBe("…");
    await drainBackgroundQueue();

    expect(lookupsOf("10.5555/picked-0")).toBe(1);
    expect(tree.reselections).toBe(0);
    expect(tree.redrawn).toContain(selected.id);
    expect(cell(selected)).toBe("5");
  });

  it("two windows, each with its own only selected item landing in one batch: neither is reselected, and each redraws both", async () => {
    const other = makeItem("OTHER", { title: "No identifier" });
    const [x, y] = doiItems(2, "PAIR");
    const windowA = showRows([other, x, y]);
    const windowB = showRows([other, x, y]);
    windowA.selection = [x];
    windowB.selection = [y];
    vi.mocked(getWorkByDOI).mockResolvedValue(work(8) as never);

    cell(other);
    cell(x);
    cell(y);
    await drainBackgroundQueue();

    expect(windowA.reselections + windowB.reselections).toBe(0);
    for (const tree of [windowA, windowB]) {
      expect(tree.redrawn).toContain(x.id);
      expect(tree.redrawn).toContain(y.id);
    }
  });

  it("on Zotero 10, which never reselects, the rows go in the order they landed", async () => {
    mockZotero.version = "10.0.2";
    mockZotero.Prefs.user.set(PREF_AUTO_FETCH, false);
    const rows = doiItems(2, "TEN");
    const tree = showRows(rows);
    for (const row of rows) cell(row);
    tree.selection = [rows[0]];

    invalidateColumnCache(rows[0].id);
    await settle(500);

    expect(refreshes.map((r) => r.ids)).toEqual([[rows[0].id]]);
    expect(tree.reselections).toBe(0);
  });

  it("on Zotero 9, a selected row with no other row drawn waits for its next paint instead of being reselected", async () => {
    mockZotero.Prefs.user.set(PREF_AUTO_FETCH, false);
    const [only] = doiItems(1, "ALONE");
    const tree = showRows([only]);
    cell(only);
    tree.selection = [only];

    invalidateColumnCache(only.id);
    await settle(500);

    expect(refreshes).toEqual([]);
    expect(tree.reselections).toBe(0);
  });
});

describe("the background queue stops", () => {
  it.each([
    ["OpenAlex rejects the API key", () => new OpenAlexAuthError(), "CG-API01"],
    ["the daily budget is spent", () => new OpenAlexBudgetError(), "CG-API42"],
  ])(
    "when %s: one batch of lookups at most, one diagnostic, and no '…'",
    async (_label, refusal, code) => {
      vi.mocked(getWorkByDOI).mockRejectedValue(refusal());
      const rows = doiItems(20, "REF");
      showRows(rows);

      for (const row of rows) expect(cell(row)).toBe("…");
      await settle(30_000);

      const lookups = vi.mocked(getWorkByDOI).mock.calls.length;
      expect(lookups, "positive control: the queue ran").toBeGreaterThan(0);
      expect(lookups).toBeLessThanOrEqual(FETCH_BATCH_SIZE);
      expect(recentDiagnostics().map((d) => d.code)).toEqual([code]);
      for (const row of rows) expect(rowCells(row)).toEqual(EMPTY_ROW);
      await settle(5_000);
      expect(vi.mocked(getWorkByDOI).mock.calls.length, "a repaint queued the rows again").toBe(
        lookups,
      );
    },
    LONG_FAKE_TIME_BUDGET_MS,
  );

  it("until the API key changes, and then looks up every row", async () => {
    vi.mocked(getWorkByDOI).mockRejectedValue(new OpenAlexAuthError());
    const rows = doiItems(20, "KEY");
    for (const row of rows) cell(row);
    await settle(10_000);
    const refused = vi.mocked(getWorkByDOI).mock.calls.length;
    expect(refused).toBeLessThanOrEqual(FETCH_BATCH_SIZE);

    vi.mocked(getWorkByDOI).mockResolvedValue(work(5) as never);
    setPref(PREF_OPENALEX_API_KEY, "sk-replacement-key");
    for (const row of rows) expect(cell(row)).toBe("…");
    await drainBackgroundQueue();

    expect(vi.mocked(getWorkByDOI).mock.calls.length).toBe(refused + rows.length);
    for (const row of rows) expect(cell(row)).toBe("5");
  });

  it("before it starts on a cache opened read-only: no lookups and no '…'", async () => {
    await unregisterCitationColumn();
    _resetForTesting();
    fakeDb.pragma.userVersion = (CACHE_SCHEMA_MAJOR + 1) * CACHE_SCHEMA_STAMP_MULTIPLIER;
    await initCache();
    await registerCitationColumn(PLUGIN_ID);
    expect(cacheWriteRefusalCode(), "positive control: the cache is read-only").toBe("CG-DB03");
    const rows = doiItems(5, "RO");

    for (const row of rows) expect(rowCells(row)).toEqual(EMPTY_ROW);
    await settle(5_000);

    expect(getWorkByDOI).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
  });

  it("at its next batch when auto-fetch is unticked mid-pass, and leaves no row showing '…'", async () => {
    const rows = doiItems(30, "UNTICK");
    showRows(rows);
    for (const row of rows) cell(row);
    await vi.advanceTimersByTimeAsync(FETCH_QUEUE_DEBOUNCE_MS + 100);
    expect(getWorkByDOI, "positive control: one batch ran").toHaveBeenCalledTimes(FETCH_BATCH_SIZE);

    setPref(PREF_AUTO_FETCH, false);
    await settle(30_000);

    expect(getWorkByDOI).toHaveBeenCalledTimes(FETCH_BATCH_SIZE);
    for (const row of rows) expect(cell(row)).toBe("");
  });
});

describe("network trouble", () => {
  it(
    "pauses lookups with one diagnostic and no '…', and looks the rows up again once the network is back",
    async () => {
      vi.mocked(getWorkByDOI).mockRejectedValue(
        new OpenAlexNetworkError("OpenAlex unreachable while fetching work lookup (doi)"),
      );
      const rows = doiItems(6, "NET");
      showRows(rows);

      for (const row of rows) expect(cell(row)).toBe("…");
      await settle(2_000);

      expect(vi.mocked(getWorkByDOI).mock.calls.length, "one batch, then the pause").toBe(
        FETCH_BATCH_SIZE,
      );
      for (const row of rows) expect(cell(row), "no row keeps showing '…'").toBe("");
      const entries = recentDiagnostics();
      expect(entries.map((d) => d.code)).toEqual(["CG-NET01"]);
      expect(entries[0].context).toBe(
        "background lookups paused: OpenAlex is unreachable or overloaded",
      );

      // Still offline after the first cool-down: one more batch, and still one entry.
      await vi.advanceTimersByTimeAsync(BACKGROUND_RETRY_MIN_MS);
      await settle(2_000);
      expect(vi.mocked(getWorkByDOI).mock.calls.length).toBe(2 * FETCH_BATCH_SIZE);
      expect(recentDiagnostics()).toHaveLength(1);

      // Back online when the second, doubled cool-down ends: every row is looked up once more.
      vi.mocked(getWorkByDOI).mockResolvedValue(work(6) as never);
      await vi.advanceTimersByTimeAsync(2 * BACKGROUND_RETRY_MIN_MS);
      await drainBackgroundQueue();

      expect(vi.mocked(getWorkByDOI).mock.calls.length).toBe(2 * FETCH_BATCH_SIZE + rows.length);
      for (const row of rows) expect(cell(row)).toBe("6");
      expect(recentDiagnostics(), "recovery records nothing").toHaveLength(1);
    },
    LONG_FAKE_TIME_BUDGET_MS,
  );
});

describe("rows whose data goes stale again in a long session", () => {
  it("a row whose data landed is looked up again once the data is older than the cache lifetime", async () => {
    const item = makeItem("AGAIN", { DOI: "10.5555/again", title: "Again" });
    vi.mocked(getWorkByDOI).mockResolvedValue(work(1) as never);
    cell(item);
    await drainBackgroundQueue();
    expect(lookupsOf("10.5555/again")).toBe(1);

    cell(item);
    await drainBackgroundQueue();
    expect(lookupsOf("10.5555/again"), "fresh data is not looked up").toBe(1);

    vi.setSystemTime(Date.now() + (DEFAULT_CACHE_LIFETIME_DAYS + 1) * DAY_MS);
    cell(item);
    await drainBackgroundQueue();
    expect(lookupsOf("10.5555/again")).toBe(2);
  });

  it("a DOI OpenAlex did not know is tried again after a cache lifetime, not before", async () => {
    const item = makeItem("RETRY", { DOI: "10.5555/retry", title: "Retry" });
    cell(item);
    await drainBackgroundQueue();
    cell(item);
    await drainBackgroundQueue();
    expect(lookupsOf("10.5555/retry")).toBe(1);

    vi.setSystemTime(Date.now() + (DEFAULT_CACHE_LIFETIME_DAYS + 1) * DAY_MS);
    expect(cell(item)).toBe("…");
    await drainBackgroundQueue();
    expect(lookupsOf("10.5555/retry")).toBe(2);
  });
});

describe("stopping with the columns", () => {
  it("a pass cut off by unregistering changes nothing for the next registration", async () => {
    const rows = doiItems(4, "STOP");
    const lands: Array<() => void> = [];
    vi.mocked(getWorkByDOI).mockImplementation(
      () =>
        new Promise((resolve) => {
          lands.push(() => resolve(null));
        }) as never,
    );
    for (const row of rows) cell(row);
    await vi.advanceTimersByTimeAsync(FETCH_QUEUE_DEBOUNCE_MS + 1);
    expect(lands, "positive control: the first batch is in flight").toHaveLength(FETCH_BATCH_SIZE);

    const stopping = unregisterCitationColumn();
    await registerCitationColumn(PLUGIN_ID);
    for (const land of lands) land();
    await stopping;
    await settle(10_000);

    expect(lookupsOf("10.5555/stop-2"), "the old pass went on after unregistering").toBe(0);
    expect(lookupsOf("10.5555/stop-3"), "the old pass went on after unregistering").toBe(0);

    vi.mocked(getWorkByDOI).mockResolvedValue(work(4) as never);
    expect(cell(rows[2]), "the new registration looks the row up").toBe("…");
    await drainBackgroundQueue();
    expect(lookupsOf("10.5555/stop-2")).toBe(1);
    expect(cell(rows[2])).toBe("4");
  });

  it("leaves no timer behind", async () => {
    const rows = doiItems(3, "TIMER");
    showRows(rows);
    for (const row of rows) cell(row);
    invalidateColumnCache(rows.map((row) => row.id));
    expect(vi.getTimerCount(), "positive control: timers are set").toBeGreaterThan(0);

    await unregisterCitationColumn();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the set of rows already looked up", () => {
  /** Every redraw draws every row in view, as Zotero does while sorting by a Citegeist column. */
  function drawEveryRowOnRepaint(rows: () => Item[]): FakeTree {
    const tree = showRows(rows);
    tree.drawsEveryRow = true;
    return tree;
  }

  it("forgets only its oldest entries no repaint still draws, so each new row costs one lookup", async () => {
    const drawn: Item[] = [];
    // A redraw draws the rows in view: the last MAX_ATTEMPTED_FETCH_CACHE drawn.
    drawEveryRowOnRepaint(() => drawn.slice(-MAX_ATTEMPTED_FETCH_CACHE));
    const rows = doiItems(MAX_ATTEMPTED_FETCH_CACHE + 2, "TRIED");

    for (const row of rows) {
      drawn.push(row);
      cell(row);
      await settle(3_000);
    }

    for (const [i, row] of rows.entries()) {
      expect(lookupsOf(`10.5555/tried-${i}`), `lookups of ${row.key}`).toBe(1);
    }

    // The set stays bounded: the first row, which no repaint has drawn since it
    // scrolled out of view, was forgotten, so drawing it again looks it up again.
    cell(rows[0]);
    await settle(3_000);
    expect(lookupsOf("10.5555/tried-0")).toBe(2);
  });

  it("a repaint that draws more rows than the set holds looks each one up once, and the next repaint repeats none", async () => {
    const rows = doiItems(MAX_ATTEMPTED_FETCH_CACHE * 3, "WIDE");
    drawEveryRowOnRepaint(() => rows);

    for (const row of rows) cell(row);
    await settle(10_000);
    expect(notifierTrigger, "positive control: the pass redrew its rows").toHaveBeenCalled();

    for (const row of rows) cell(row);
    await settle(10_000);

    for (const [i, row] of rows.entries()) {
      expect(lookupsOf(`10.5555/wide-${i}`), `lookups of ${row.key}`).toBe(1);
    }
  });

  it("a later pass that looks up one new row forgets none of the rows a repaint still draws", async () => {
    const rows = doiItems(MAX_ATTEMPTED_FETCH_CACHE * 3, "KEEP");
    drawEveryRowOnRepaint(() => rows);
    for (const row of rows) cell(row);
    await settle(10_000);

    const [late] = doiItems(1, "LATE");
    rows.push(late);
    cell(late);
    await settle(10_000);

    expect(lookupsOf("10.5555/late-0"), "positive control: the later pass ran").toBe(1);
    for (let i = 0; i < MAX_ATTEMPTED_FETCH_CACHE * 3; i++) {
      expect(lookupsOf(`10.5555/keep-${i}`), `lookups of KEEP${i}`).toBe(1);
    }
  });
});

describe("a fetch the user starts", () => {
  it("Fetch Citation Counts still searches by title for an item the background fetch skipped", async () => {
    const item = makeItem("MENU", { title: "Skipped in the background" });
    expect(cell(item)).toBe("");
    await settle(2_000);
    expect(searchByMetadata).not.toHaveBeenCalled();

    // The menu command's call: fetchAndCacheItems with no options.
    const result = await fetchAndCacheItems([item]);

    expect(searchByMetadata).toHaveBeenCalledTimes(1);
    expect(searchByMetadata).toHaveBeenCalledWith(item);
    expect(result.errors).toBe(1);
    expect(
      isNoMatchSuppressed(item, NO_MATCH_RETRY_DAYS),
      "the search's no-match is recorded",
    ).toBe(true);
  });

  it("opening the item still searches by title", async () => {
    const item = makeItem("PANE", { title: "Opened in the item pane" });

    // The item pane's call: fetchAndCacheItem with no options.
    await fetchAndCacheItem(item);

    expect(searchByMetadata).toHaveBeenCalledWith(item);
  });
});

describe("who may skip the title search", () => {
  function srcFiles(dir = "src"): string[] {
    const abs = fileURLToPath(new URL(`../${dir}`, import.meta.url));
    return readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return srcFiles(rel);
      return entry.name.endsWith(".ts") ? [rel] : [];
    });
  }
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

  it("only the columns' background lookups opt out; menu, pane and bridge fetches keep the search and record every failure", () => {
    const optingOut = srcFiles().filter((f) => /identifierLookupsOnly:\s*true/.test(read(f)));
    expect(optingOut).toEqual(["src/modules/citationColumn.ts"]);
    const recordingItself = srcFiles().filter((f) => /callerRecordsStops:\s*true/.test(read(f)));
    expect(recordingItself).toEqual(["src/modules/citationColumn.ts"]);
    for (const file of [
      "src/modules/menu.ts",
      "src/modules/menu/batchActions.ts",
      "src/modules/menu/registration.ts",
      "src/modules/citationPane.ts",
      "src/modules/bridge.ts",
      "src/hooks.ts",
    ]) {
      expect(read(file), `${file} passes identifierLookupsOnly`).not.toContain(
        "identifierLookupsOnly",
      );
      expect(read(file), `${file} passes callerRecordsStops`).not.toContain("callerRecordsStops");
    }
  });
});

/**
 * The columns' background fetch (U18).
 *
 * The item-tree columns look up missing or stale metrics on their own once
 * `autoFetch` is on, which it is by default. OpenAlex meters title searches, so a
 * background pass over a large library of items without a DOI, PMID, arXiv ID or
 * ISBN would spend the user's daily allowance unseen. These tests drive the real
 * column queue and the real fetch service against the fake cache, with OpenAlex
 * and the title search mocked. They check that only a fetch the user starts
 * searches by title, that a "…" cell always means a lookup is coming, that the
 * queue stops on a refused request or an unticked setting, and that it never
 * repeats a lookup it has already made.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, mockZotero, resetCacheHarness } from "./_helpers/cacheHarness";
import type * as ConstantsModule from "../src/constants";
import type * as OpenAlexModule from "../src/modules/openalex";

// A small tried-set cap, so the eviction test can overflow it with a few rows.
// No other test here leaves more than a couple of failed lookups behind.
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
  CACHE_SCHEMA_MAJOR,
  CACHE_SCHEMA_STAMP_MULTIPLIER,
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
import { OpenAlexAuthError, OpenAlexBudgetError } from "../src/modules/utils";

const PLUGIN_ID = "citegeist@opusvita.org";
/** The five columns that draw OpenAlex metrics, and so the five that can show "…". */
const METRIC_COLUMNS = [
  "citegeist-citation-count",
  "citegeist-fwci",
  "citegeist-percentile",
  "citegeist-citedness-2yr",
  "citegeist-journal-hindex",
] as const;
const CITATIONS = METRIC_COLUMNS[0];
const EMPTY_ROW = ["", "", "", "", ""];

type DataProvider = (item: _ZoteroTypes.Item, dataKey: string) => string;
const providers = new Map<string, DataProvider>();
const itemsById = new Map<number, _ZoteroTypes.Item>();
const refreshItemTree = vi.fn();
let nextItemId = 1;

vi.stubGlobal("CSS", { escape: (s: string) => s });
Object.assign(mockZotero, {
  ItemTreeManager: {
    registerColumn: vi.fn(async (options: { dataKey: string; dataProvider: DataProvider }) => {
      providers.set(options.dataKey, options.dataProvider);
    }),
    unregisterColumn: vi.fn(),
  },
  getActiveZoteroPane: () => ({ itemsView: { refreshAndMaintainSelection: refreshItemTree } }),
});
const getItem = vi.fn((id: number) => itemsById.get(id));
Object.assign(mockZotero.Items, { get: getItem });

function makeItem(key: string, fields: { DOI?: string; title: string }): _ZoteroTypes.Item {
  const values: Record<string, string> = { DOI: fields.DOI ?? "", title: fields.title };
  const item = {
    id: nextItemId++,
    key,
    libraryID: 1,
    itemType: "journalArticle",
    deleted: false,
    isRegularItem: () => true,
    getField: (field: string) => values[field] ?? "",
    setField: (field: string, value: string) => {
      values[field] = value;
    },
    saveTx: async () => 1,
  } as unknown as _ZoteroTypes.Item;
  itemsById.set(item.id, item);
  return item;
}

/** `count` journal articles, each with its own DOI. */
function doiItems(count: number, prefix: string): _ZoteroTypes.Item[] {
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
function cell(item: _ZoteroTypes.Item, dataKey: string = CITATIONS): string {
  const provide = providers.get(dataKey);
  if (!provide) throw new Error(`the ${dataKey} column never registered a dataProvider`);
  return provide(item, dataKey);
}

/** Every metric cell of a row. */
function rowCells(item: _ZoteroTypes.Item): string[] {
  return METRIC_COLUMNS.map((dataKey) => cell(item, dataKey));
}

/** How many times OpenAlex was asked for this DOI. */
function lookupsOf(doi: string): number {
  return vi.mocked(getWorkByDOI).mock.calls.filter(([asked]) => asked === doi).length;
}

/** Let `ms` of fake time pass, in steps small enough for every batch and repaint to run. */
async function settle(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    await vi.advanceTimersByTimeAsync(100);
  }
}

/** Run the debounced background queue until it finishes with its item-tree repaint. */
async function drainBackgroundQueue(): Promise<void> {
  for (let i = 0; i < 100 && refreshItemTree.mock.calls.length === 0; i++) {
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(
    refreshItemTree,
    "positive control: the queue ran to its final repaint",
  ).toHaveBeenCalled();
}

beforeEach(async () => {
  await resetCacheHarness(initCache, _resetForTesting);
  vi.mocked(searchByMetadata).mockReset().mockResolvedValue(null);
  vi.mocked(getWorkByDOI).mockReset().mockResolvedValue(null);
  vi.mocked(getWorkById).mockReset().mockResolvedValue(null);
  providers.clear();
  itemsById.clear();
  getItem.mockClear();
  refreshItemTree.mockReset();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await registerCitationColumn(PLUGIN_ID);
  clearDiagnostics();
});

afterEach(() => {
  unregisterCitationColumn();
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
    "an identifier item for which %s shows no '…' and is not looked up",
    async (_label, suppress) => {
      const item = makeItem("SUPP", { DOI: "10.5555/suppressed", title: "Suppressed" });
      await suppress(item);
      const control = makeItem("CTRL", { DOI: "10.5555/control", title: "Control" });

      expect(rowCells(item)).toEqual(EMPTY_ROW);
      expect(cell(control)).toBe("…");
      await drainBackgroundQueue();

      expect(getWorkByDOI, "positive control: the queue ran").toHaveBeenCalledWith(
        "10.5555/control",
      );
      expect(getWorkByDOI).not.toHaveBeenCalledWith("10.5555/suppressed");
      expect(rowCells(item)).toEqual(EMPTY_ROW);
    },
  );

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

  it("ticking auto-fetch queues a row that was drawn while it was off", async () => {
    mockZotero.Prefs.user.set(PREF_AUTO_FETCH, false);
    const item = makeItem("TICK", { DOI: "10.5555/tick", title: "Drawn while off" });
    vi.mocked(getWorkByDOI).mockResolvedValue(work(3) as never);

    expect(cell(item)).toBe("");
    await settle(2_000);
    expect(getWorkByDOI).not.toHaveBeenCalled();

    setPref(PREF_AUTO_FETCH, true);
    await vi.advanceTimersByTimeAsync(AUTO_FETCH_PREF_TTL_MS + 1);
    // Nothing has cleared the row's memoized metrics since the first paint.
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
    await invalidateColumnCache(item.id);
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

describe("the background queue stops", () => {
  it.each([
    ["OpenAlex rejects the API key", () => new OpenAlexAuthError(), "CG-API01"],
    ["the daily budget is spent", () => new OpenAlexBudgetError(), "CG-API42"],
  ])(
    "when %s: one batch of lookups at most, one diagnostic, and no '…'",
    async (_label, refusal, code) => {
      vi.mocked(getWorkByDOI).mockRejectedValue(refusal());
      const rows = doiItems(20, "REF");

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
    await settle(60_000);

    expect(vi.mocked(getWorkByDOI).mock.calls.length).toBe(refused + rows.length);
    for (const row of rows) expect(cell(row)).toBe("5");
  });

  it("before it starts on a cache opened read-only: no lookups and no '…'", async () => {
    unregisterCitationColumn();
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

  it("at its next batch when auto-fetch is unticked mid-pass", async () => {
    const rows = doiItems(30, "UNTICK");
    for (const row of rows) cell(row);
    await vi.advanceTimersByTimeAsync(FETCH_QUEUE_DEBOUNCE_MS + 100);
    expect(getWorkByDOI, "positive control: one batch ran").toHaveBeenCalledTimes(FETCH_BATCH_SIZE);

    setPref(PREF_AUTO_FETCH, false);
    await settle(30_000);

    expect(getWorkByDOI).toHaveBeenCalledTimes(FETCH_BATCH_SIZE);
  });
});

describe("the set of rows already looked up", () => {
  it("forgets only its oldest entries when full, so each new row costs one lookup", async () => {
    const drawn: _ZoteroTypes.Item[] = [];
    // A repaint draws the rows in view: the last MAX_ATTEMPTED_FETCH_CACHE drawn.
    refreshItemTree.mockImplementation(() => {
      for (const row of drawn.slice(-MAX_ATTEMPTED_FETCH_CACHE)) cell(row);
    });
    const rows = doiItems(MAX_ATTEMPTED_FETCH_CACHE + 2, "TRIED");

    for (const row of rows) {
      drawn.push(row);
      cell(row);
      await settle(3_000);
    }

    for (const [i, row] of rows.entries()) {
      expect(lookupsOf(`10.5555/tried-${i}`), `lookups of ${row.key}`).toBe(1);
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

  it("only the column's background queue opts out; menu, pane and bridge fetches keep the search and record refusals", () => {
    const optingOut = srcFiles().filter((f) => /identifierLookupsOnly:\s*true/.test(read(f)));
    expect(optingOut).toEqual(["src/modules/citationColumn.ts"]);
    const leavingRefusals = srcFiles().filter((f) => /recordRefusals:\s*false/.test(read(f)));
    expect(leavingRefusals).toEqual(["src/modules/citationColumn.ts"]);
    for (const file of ["src/modules/menu.ts", "src/modules/citationPane.ts", "src/hooks.ts"]) {
      expect(read(file), `${file} passes identifierLookupsOnly`).not.toContain(
        "identifierLookupsOnly",
      );
      expect(read(file), `${file} passes recordRefusals`).not.toContain("recordRefusals");
    }
  });
});

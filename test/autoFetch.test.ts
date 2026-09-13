/**
 * Auto-fetch spends only free identifier lookups (U18 follow-up).
 *
 * The item-tree columns fetch in the background once `autoFetch` is on, which it
 * is by default. OpenAlex meters title searches, so a background pass over a
 * large library of items without a DOI, PMID, arXiv ID or ISBN would spend the
 * user's daily allowance unseen. These tests drive the real column queue and the
 * real fetch service against the fake cache, with OpenAlex and the title search
 * mocked, and check that only a fetch the user starts searches by title.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, mockZotero, resetCacheHarness } from "./_helpers/cacheHarness";
import type * as OpenAlexModule from "../src/modules/openalex";

vi.mock("../src/modules/titleSearch", () => ({ searchByMetadata: vi.fn(async () => null) }));
vi.mock("../src/modules/openalex", async (importOriginal) => ({
  ...(await importOriginal<typeof OpenAlexModule>()),
  getWorkByDOI: vi.fn(async () => null),
  getWorkById: vi.fn(async () => null),
  getSourceStats: vi.fn(async () => null),
}));

import { NO_MATCH_RETRY_DAYS } from "../src/constants";
import { getCachedData, initCache, isNoMatchSuppressed } from "../src/modules/cache";
import { _resetForTesting } from "../src/modules/cache/db";
import { registerCitationColumn, unregisterCitationColumn } from "../src/modules/citationColumn";
import { fetchAndCacheItem, fetchAndCacheItems } from "../src/modules/citationService";
import { clearDiagnostics, recentDiagnostics } from "../src/modules/diagnostics";
import { getWorkByDOI } from "../src/modules/openalex";
import { searchByMetadata } from "../src/modules/titleSearch";

const PLUGIN_ID = "citegeist@opusvita.org";
const CITATIONS = "citegeist-citation-count";

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
  const item = {
    id: nextItemId++,
    key,
    libraryID: 1,
    itemType: "journalArticle",
    deleted: false,
    isRegularItem: () => true,
    getField: (field: string) => {
      if (field === "DOI") return fields.DOI ?? "";
      if (field === "title") return fields.title;
      return "";
    },
  } as unknown as _ZoteroTypes.Item;
  itemsById.set(item.id, item);
  return item;
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

/** The Citations cell as Zotero paints it. Painting is what queues the background fetch. */
function citationsCell(item: _ZoteroTypes.Item): string {
  const provide = providers.get(CITATIONS);
  if (!provide) throw new Error("the Citations column never registered a dataProvider");
  return provide(item, CITATIONS);
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
  providers.clear();
  itemsById.clear();
  getItem.mockClear();
  refreshItemTree.mockClear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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

    expect(citationsCell(item)).toBe("…");
    await drainBackgroundQueue();

    expect(getWorkByDOI).toHaveBeenCalledWith("10.5555/auto-fetch");
    expect(citationsCell(item)).toBe("42");
    expect(searchByMetadata).not.toHaveBeenCalled();
  });

  it("never searches by title for an item without an identifier, records no no-match, and leaves the cell empty", async () => {
    const item = makeItem("NODOI", { title: "A paper with no identifier" });

    expect(citationsCell(item)).toBe("");
    await drainBackgroundQueue();

    expect(getItem, "positive control: the queue reached this item").toHaveBeenCalledWith(item.id);
    expect(searchByMetadata).not.toHaveBeenCalled();
    expect(fakeDb.table.has(`1:${item.key}`), "a cache row was written").toBe(false);
    expect(isNoMatchSuppressed(item, NO_MATCH_RETRY_DAYS)).toBe(false);
    expect(recentDiagnostics()).toEqual([]);
    expect(citationsCell(item)).toBe("");
  });

  it("does not fall back to a title search when OpenAlex does not know the DOI", async () => {
    const item = makeItem("DOI404", { DOI: "10.5555/unknown", title: "DOI OpenAlex lacks" });

    expect(citationsCell(item)).toBe("…");
    await drainBackgroundQueue();

    expect(getWorkByDOI).toHaveBeenCalledWith("10.5555/unknown");
    expect(searchByMetadata).not.toHaveBeenCalled();
    expect(getCachedData(item)).toBeNull();
    expect(isNoMatchSuppressed(item, NO_MATCH_RETRY_DAYS)).toBe(false);
    expect(recentDiagnostics()).toEqual([]);
    expect(citationsCell(item)).toBe("");
  });
});

describe("a fetch the user starts", () => {
  it("Fetch Citation Counts still searches by title for an item the background fetch skipped", async () => {
    const item = makeItem("MENU", { title: "Skipped in the background" });
    citationsCell(item);
    await drainBackgroundQueue();
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

  it("only the column's background queue opts out; menu, pane and bridge fetches keep the search", () => {
    const optingOut = srcFiles().filter((f) => /allowMetadataSearch:\s*false/.test(read(f)));
    expect(optingOut).toEqual(["src/modules/citationColumn.ts"]);
    for (const file of ["src/modules/menu.ts", "src/modules/citationPane.ts", "src/hooks.ts"]) {
      expect(read(file), `${file} passes allowMetadataSearch`).not.toContain("allowMetadataSearch");
    }
  });
});

/**
 * Tests for citationService orchestration logic.
 *
 * Verifies that fetchAndCacheItem correctly:
 * - Skips non-regular items
 * - Skips items without a DOI
 * - Skips items with a fresh cache
 * - Fetches and caches when cache is stale
 * - Handles API failures gracefully
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Zotero global
const mockZotero = {
  Prefs: {
    get: vi.fn().mockReturnValue(7),
  },
  HTTP: {
    request: vi.fn(),
  },
  debug: vi.fn(),
};
vi.stubGlobal("Zotero", mockZotero);

// Mock the openalex module so we don't make real HTTP requests
vi.mock("../src/modules/openalex", () => ({
  getWorkByDOI: vi.fn(),
}));

import { fetchAndCacheItem } from "../src/modules/citationService";
import { getWorkByDOI } from "../src/modules/openalex";

const mockedGetWorkByDOI = vi.mocked(getWorkByDOI);

function mockItem(overrides: {
  isRegular?: boolean;
  doi?: string;
  extra?: string;
} = {}) {
  const {
    isRegular = true,
    doi = "10.1234/test",
    extra = "",
  } = overrides;

  return {
    id: 1,
    isRegularItem: vi.fn().mockReturnValue(isRegular),
    getField: vi.fn((field: string) => {
      if (field === "DOI") return doi;
      if (field === "extra") return extra;
      return "";
    }),
    setField: vi.fn(),
    saveTx: vi.fn().mockResolvedValue(undefined),
  } as unknown as _ZoteroTypes.Item;
}

function makeFakeWork() {
  return {
    id: "https://openalex.org/W999",
    doi: "10.1234/test",
    title: "Test Paper",
    display_name: "Test Paper",
    publication_year: 2024,
    publication_date: "2024-01-01",
    cited_by_count: 42,
    referenced_works_count: 10,
    fwci: 1.5,
    citation_normalized_percentile: {
      value: 0.85,
      is_in_top_1_percent: false,
      is_in_top_10_percent: true,
    },
    counts_by_year: [{ year: 2024, cited_by_count: 42 }],
    open_access: { is_oa: false, oa_status: "closed", oa_url: null },
    authorships: [{
      author_position: "first",
      author: { id: "A1", display_name: "Test Author", orcid: null },
      institutions: [],
      is_corresponding: false,
    }],
    primary_location: {
      source: { id: "S1", display_name: "Test Journal", issn_l: null, type: "journal" },
    },
    biblio: { volume: "1", issue: "1", first_page: "1", last_page: "10" },
    type: "article",
    is_retracted: false,
    referenced_works: [],
    abstract_inverted_index: null,
  };
}

describe("fetchAndCacheItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockZotero.Prefs.get.mockReturnValue(7);
  });

  it("skips non-regular items (notes, attachments)", async () => {
    const item = mockItem({ isRegular: false });
    const result = await fetchAndCacheItem(item);
    expect(result.success).toBe(false);
    expect(result.work).toBeNull();
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
  });

  it("skips items without a DOI", async () => {
    const item = mockItem({ doi: "" });
    const result = await fetchAndCacheItem(item);
    expect(result.success).toBe(false);
    expect(result.work).toBeNull();
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
  });

  it("skips items with whitespace-only DOI", async () => {
    const item = mockItem({ doi: "   " });
    const result = await fetchAndCacheItem(item);
    expect(result.success).toBe(false);
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
  });

  it("skips fetch when cache is fresh", async () => {
    const recentTimestamp = new Date().toISOString();
    const item = mockItem({
      extra: `Citegeist.lastFetched: ${recentTimestamp}\nCitegeist.openAlexId: W999`,
    });
    const result = await fetchAndCacheItem(item);
    expect(result.success).toBe(true);
    expect(result.work).toBeNull(); // returns null because no fetch was needed
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
  });

  it("fetches and caches when cache is stale", async () => {
    const oldTimestamp = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const item = mockItem({
      extra: `Citegeist.lastFetched: ${oldTimestamp}`,
    });
    const fakeWork = makeFakeWork();
    mockedGetWorkByDOI.mockResolvedValue(fakeWork);

    const result = await fetchAndCacheItem(item);
    expect(result.success).toBe(true);
    expect(result.work).toBe(fakeWork);
    expect(mockedGetWorkByDOI).toHaveBeenCalledWith("10.1234/test");
    expect(item.saveTx).toHaveBeenCalled();
  });

  it("fetches when no cache exists", async () => {
    const item = mockItem({ extra: "" });
    const fakeWork = makeFakeWork();
    mockedGetWorkByDOI.mockResolvedValue(fakeWork);

    const result = await fetchAndCacheItem(item);
    expect(result.success).toBe(true);
    expect(result.work).toBe(fakeWork);
    expect(mockedGetWorkByDOI).toHaveBeenCalledWith("10.1234/test");
  });

  it("returns failure when API returns null", async () => {
    const item = mockItem({ extra: "" });
    mockedGetWorkByDOI.mockResolvedValue(null);

    const result = await fetchAndCacheItem(item);
    expect(result.success).toBe(false);
    expect(result.work).toBeNull();
  });
});

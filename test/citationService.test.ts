/**
 * Tests for citationService orchestration logic.
 *
 * Verifies that fetchAndCacheItem correctly:
 * - Skips non-regular items
 * - Skips items with no usable identifier
 * - Skips items with a fresh cache
 * - Fetches via DOI, PMID, or arXiv ID in priority order
 * - Handles API failures gracefully
 *
 * Also covers extractIdentifier:
 * - DOI from item field
 * - PMID from Extra field
 * - arXiv from Extra field, archiveID field, and URL field
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
  getWorkByPMID: vi.fn(),
  getWorkByArxivId: vi.fn(),
  getWorkByISBN: vi.fn(),
  getSourceStats: vi.fn().mockResolvedValue(null),
  normalizeDOI: (doi: string) =>
    doi
      .trim()
      .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, "")
      .replace(/^doi:\s*/i, "")
      .replace(/%2[Ff]/g, "/")
      .replace(/\/+$/, ""),
  normalizePMID: (id: string) =>
    id
      .trim()
      .replace(/^pmid:\s*/i, "")
      .replace(/\D/g, ""),
  normalizeArxivId: (id: string) =>
    id
      .trim()
      .replace(/^(?:https?:\/\/)?(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, "")
      .replace(/^arxiv:\s*/i, "")
      .replace(/\.pdf$/i, "")
      .replace(/v\d+$/i, "")
      .trim(),
  normalizeISBN: (id: string) => {
    const cleaned = id
      .trim()
      .replace(/^isbn:\s*/i, "")
      .replace(/[\s-]/g, "")
      .toUpperCase();
    if (/^\d{9}[\dX]$/.test(cleaned) || /^\d{13}$/.test(cleaned)) return cleaned;
    return "";
  },
}));

import { fetchAndCacheItem, extractIdentifier } from "../src/modules/citationService";
import { getWorkByDOI, getWorkByPMID, getWorkByArxivId, getWorkByISBN } from "../src/modules/openalex";

const mockedGetWorkByDOI = vi.mocked(getWorkByDOI);
const mockedGetWorkByPMID = vi.mocked(getWorkByPMID);
const mockedGetWorkByArxivId = vi.mocked(getWorkByArxivId);
const mockedGetWorkByISBN = vi.mocked(getWorkByISBN);

function mockItem(
  overrides: {
    isRegular?: boolean;
    doi?: string;
    extra?: string;
    archiveID?: string;
    url?: string;
    isbn?: string;
    itemType?: string;
  } = {},
) {
  const {
    isRegular = true,
    doi = "",
    extra = "",
    archiveID = "",
    url = "",
    isbn = "",
    itemType = "journalArticle",
  } = overrides;

  return {
    id: 1,
    itemType,
    isRegularItem: vi.fn().mockReturnValue(isRegular),
    getField: vi.fn((field: string) => {
      if (field === "DOI") return doi;
      if (field === "extra") return extra;
      if (field === "archiveID") return archiveID;
      if (field === "url") return url;
      if (field === "ISBN") return isbn;
      return "";
    }),
    setField: vi.fn(),
    saveTx: vi.fn().mockResolvedValue(undefined),
  } as unknown as _ZoteroTypes.Item;
}

function makeFakeWork(overrides: Record<string, unknown> = {}) {
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
    authorships: [
      {
        author_position: "first",
        author: { id: "A1", display_name: "Test Author", orcid: null },
        institutions: [],
        is_corresponding: false,
      },
    ],
    primary_location: {
      source: { id: "S1", display_name: "Test Journal", issn_l: null, type: "journal" },
    },
    biblio: { volume: "1", issue: "1", first_page: "1", last_page: "10" },
    type: "article",
    is_retracted: false,
    referenced_works: [],
    abstract_inverted_index: null,
    ...overrides,
  };
}

// ── extractIdentifier ────────────────────────────────────────────────────────

describe("extractIdentifier", () => {
  it("returns DOI when present", () => {
    const item = mockItem({ doi: "10.1234/test" });
    const id = extractIdentifier(item);
    expect(id).toEqual({ type: "doi", value: "10.1234/test" });
  });

  it("normalizes DOI URLs", () => {
    const item = mockItem({ doi: "https://doi.org/10.1234/test" });
    const id = extractIdentifier(item);
    expect(id).toEqual({ type: "doi", value: "10.1234/test" });
  });

  it("prefers DOI over PMID when both present", () => {
    const item = mockItem({ doi: "10.1234/test", extra: "PMID: 12345678" });
    const id = extractIdentifier(item);
    expect(id?.type).toBe("doi");
  });

  it("falls back to PMID from Extra when no DOI", () => {
    const item = mockItem({ extra: "PMID: 12345678" });
    const id = extractIdentifier(item);
    expect(id).toEqual({ type: "pmid", value: "12345678" });
  });

  it("parses PMID case-insensitively", () => {
    const item = mockItem({ extra: "pmid: 99887766" });
    const id = extractIdentifier(item);
    expect(id).toEqual({ type: "pmid", value: "99887766" });
  });

  it("falls back to arXiv from Extra when no DOI or PMID", () => {
    const item = mockItem({ extra: "arXiv: 2205.01833" });
    const id = extractIdentifier(item);
    expect(id).toEqual({ type: "arxiv", value: "2205.01833" });
  });

  it("parses arXiv case-insensitively", () => {
    const item = mockItem({ extra: "ARXIV: 2205.01833" });
    const id = extractIdentifier(item);
    expect(id).toEqual({ type: "arxiv", value: "2205.01833" });
  });

  it("falls back to arXiv from archiveID field", () => {
    const item = mockItem({ archiveID: "2205.01833v2" });
    const id = extractIdentifier(item);
    expect(id).toEqual({ type: "arxiv", value: "2205.01833" });
  });

  it("falls back to arXiv from URL", () => {
    const item = mockItem({ url: "https://arxiv.org/abs/2205.01833v1" });
    const id = extractIdentifier(item);
    expect(id).toEqual({ type: "arxiv", value: "2205.01833" });
  });

  it("falls back to ISBN when no other identifier", () => {
    const item = mockItem({ isbn: "978-0-262-04630-9", itemType: "book" });
    const id = extractIdentifier(item);
    expect(id).toEqual({ type: "isbn", value: "9780262046309" });
  });

  it("falls back to ISBN for bookSection items", () => {
    const item = mockItem({ isbn: "0262046305", itemType: "bookSection" });
    const id = extractIdentifier(item);
    expect(id).toEqual({ type: "isbn", value: "0262046305" });
  });

  it("prefers DOI over ISBN", () => {
    const item = mockItem({ doi: "10.1234/test", isbn: "9780262046309", itemType: "book" });
    const id = extractIdentifier(item);
    expect(id?.type).toBe("doi");
  });

  it("returns null when no identifier found", () => {
    const item = mockItem({ extra: "Some random note" });
    expect(extractIdentifier(item)).toBeNull();
  });

  it("returns null for empty item", () => {
    const item = mockItem();
    expect(extractIdentifier(item)).toBeNull();
  });

  it("prefers PMID over arXiv when no DOI", () => {
    const item = mockItem({ extra: "PMID: 12345678\narXiv: 2205.01833" });
    const id = extractIdentifier(item);
    expect(id?.type).toBe("pmid");
  });
});

// ── fetchAndCacheItem ─────────────────────────────────────────────────────────

describe("fetchAndCacheItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockZotero.Prefs.get.mockReturnValue(7);
  });

  it("skips non-regular items (notes, attachments)", async () => {
    const item = mockItem({ isRegular: false, doi: "10.1234/test" });
    const result = await fetchAndCacheItem(item);
    expect(result.success).toBe(false);
    expect(result.error).toBe("invalid-item");
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
  });

  it("returns no-identifier when item has no usable identifier", async () => {
    const item = mockItem({ extra: "Some note" });
    const result = await fetchAndCacheItem(item);
    expect(result.success).toBe(false);
    expect(result.error).toBe("no-identifier");
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
  });

  it("skips fetch when cache is fresh", async () => {
    const recentTimestamp = new Date().toISOString();
    const item = mockItem({
      doi: "10.1234/test",
      extra: `Citegeist.lastFetched: ${recentTimestamp}\nCitegeist.openAlexId: W999`,
    });
    const result = await fetchAndCacheItem(item);
    expect(result.success).toBe(true);
    expect(result.work).toBeNull();
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
  });

  it("fetches via DOI when DOI is present", async () => {
    const item = mockItem({ doi: "10.1234/test" });
    const fakeWork = makeFakeWork();
    mockedGetWorkByDOI.mockResolvedValue(fakeWork);

    const result = await fetchAndCacheItem(item);
    expect(result.success).toBe(true);
    expect(mockedGetWorkByDOI).toHaveBeenCalledWith("10.1234/test");
    expect(mockedGetWorkByPMID).not.toHaveBeenCalled();
    expect(mockedGetWorkByArxivId).not.toHaveBeenCalled();
  });

  it("fetches via PMID when no DOI", async () => {
    const item = mockItem({ extra: "PMID: 12345678" });
    const fakeWork = makeFakeWork();
    mockedGetWorkByPMID.mockResolvedValue(fakeWork);

    const result = await fetchAndCacheItem(item);
    expect(result.success).toBe(true);
    expect(mockedGetWorkByPMID).toHaveBeenCalledWith("12345678");
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
    expect(item.saveTx).toHaveBeenCalled();
  });

  it("fetches via arXiv when no DOI or PMID", async () => {
    const item = mockItem({ extra: "arXiv: 2205.01833" });
    const fakeWork = makeFakeWork();
    mockedGetWorkByArxivId.mockResolvedValue(fakeWork);

    const result = await fetchAndCacheItem(item);
    expect(result.success).toBe(true);
    expect(mockedGetWorkByArxivId).toHaveBeenCalledWith("2205.01833");
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
    expect(item.saveTx).toHaveBeenCalled();
  });

  it("fetches via arXiv from archiveID field", async () => {
    const item = mockItem({ archiveID: "2205.01833v1" });
    const fakeWork = makeFakeWork();
    mockedGetWorkByArxivId.mockResolvedValue(fakeWork);

    const result = await fetchAndCacheItem(item);
    expect(result.success).toBe(true);
    expect(mockedGetWorkByArxivId).toHaveBeenCalledWith("2205.01833");
  });

  it("fetches via arXiv from URL", async () => {
    const item = mockItem({ url: "https://arxiv.org/abs/2205.01833v2" });
    const fakeWork = makeFakeWork();
    mockedGetWorkByArxivId.mockResolvedValue(fakeWork);

    const result = await fetchAndCacheItem(item);
    expect(result.success).toBe(true);
    expect(mockedGetWorkByArxivId).toHaveBeenCalledWith("2205.01833");
  });

  it("returns not-found when API returns null", async () => {
    const item = mockItem({ doi: "10.1234/test" });
    mockedGetWorkByDOI.mockResolvedValue(null);

    const result = await fetchAndCacheItem(item);
    expect(result.success).toBe(false);
    expect(result.error).toBe("not-found");
  });

  it("returns not-found when PMID lookup returns null", async () => {
    const item = mockItem({ extra: "PMID: 99999999" });
    mockedGetWorkByPMID.mockResolvedValue(null);

    const result = await fetchAndCacheItem(item);
    expect(result.success).toBe(false);
    expect(result.error).toBe("not-found");
  });

  it("fetches via ISBN when no other identifier", async () => {
    const item = mockItem({ isbn: "9780262046309", itemType: "book" });
    const fakeWork = makeFakeWork();
    mockedGetWorkByISBN.mockResolvedValue(fakeWork);

    const result = await fetchAndCacheItem(item);
    expect(result.success).toBe(true);
    expect(mockedGetWorkByISBN).toHaveBeenCalledWith("9780262046309");
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
    expect(item.saveTx).toHaveBeenCalled();
  });

  it("returns not-found when ISBN lookup returns null", async () => {
    const item = mockItem({ isbn: "9780262046309", itemType: "book" });
    mockedGetWorkByISBN.mockResolvedValue(null);

    const result = await fetchAndCacheItem(item);
    expect(result.success).toBe(false);
    expect(result.error).toBe("not-found");
  });
});

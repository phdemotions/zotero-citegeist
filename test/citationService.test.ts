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
import { makeFakeDb } from "./_helpers/fakeDb";

let fakeDb = makeFakeDb();

vi.stubGlobal("PathUtils", { join: (...parts: string[]) => parts.join("/") });
vi.stubGlobal("IOUtils", {
  getChildren: vi.fn(async () => []),
  remove: vi.fn(async () => {}),
  setPermissions: vi.fn(async () => {}),
});

// Mock Zotero global
const mockZotero = {
  Prefs: {
    get: vi.fn().mockImplementation((pref: string) => {
      if (pref === "extensions.zotero.citegeist.migrationV1Complete") return true;
      if (pref === "extensions.zotero.citegeist.cacheLifetimeDays") return 7;
      return 7;
    }),
    set: vi.fn(),
    clearUserPref: vi.fn(),
  },
  HTTP: {
    request: vi.fn(),
  },
  debug: vi.fn(),
  DataDirectory: { dir: "/tmp/zotero-test-data" },
  File: { putContentsAsync: vi.fn(async () => {}) },
  DBConnection: vi.fn(function (this: unknown) {
    return fakeDb;
  }),
  Items: { getAll: vi.fn(async () => [] as _ZoteroTypes.Item[]) },
  Libraries: {
    userLibraryID: 1,
    getAll: vi.fn(
      () => [{ libraryID: 1, libraryType: "user", editable: true }] as _ZoteroTypes.Library[],
    ),
  },
  Sync: {
    Runner: { delaySync: vi.fn(async (fn: () => Promise<unknown>) => await fn()) },
  },
};
vi.stubGlobal("Zotero", mockZotero);

// Mock titleSearch so unit tests don't trigger title search fallback
vi.mock("../src/modules/titleSearch", () => ({
  searchByMetadata: vi.fn().mockResolvedValue(null),
}));

// Mock the openalex module so we don't make real HTTP requests
vi.mock("../src/modules/openalex", () => ({
  getWorkByDOI: vi.fn(),
  getWorkByPMID: vi.fn(),
  getWorkByArxivId: vi.fn(),
  getWorkByISBN: vi.fn(),
  getWorkById: vi.fn(),
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

import {
  fetchAndCacheItem,
  extractIdentifier,
  canResolveWork,
  resolveWorkForItem,
} from "../src/modules/citationService";
import {
  getWorkByDOI,
  getWorkByPMID,
  getWorkByArxivId,
  getWorkByISBN,
  getWorkById,
} from "../src/modules/openalex";
import { _resetForTesting } from "../src/modules/cache/db";
import {
  initCache,
  cacheWorkData,
  writePendingSuggestion,
  confirmTitleMatch,
} from "../src/modules/cache";
import { OpenAlexNetworkError } from "../src/modules/utils";

const mockedGetWorkByDOI = vi.mocked(getWorkByDOI);
const mockedGetWorkByPMID = vi.mocked(getWorkByPMID);
const mockedGetWorkByArxivId = vi.mocked(getWorkByArxivId);
const mockedGetWorkByISBN = vi.mocked(getWorkByISBN);
const mockedGetWorkById = vi.mocked(getWorkById);

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
    key: "TEST",
    libraryID: 1,
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
  beforeEach(async () => {
    vi.clearAllMocks();
    mockZotero.Prefs.get.mockImplementation((pref: string) => {
      if (pref === "extensions.zotero.citegeist.migrationV1Complete") return true;
      if (pref === "extensions.zotero.citegeist.cacheLifetimeDays") return 7;
      return 7;
    });
    fakeDb = makeFakeDb();
    _resetForTesting();
    await initCache();
  });

  it("skips non-regular items (notes, attachments)", async () => {
    const item = mockItem({ isRegular: false, doi: "10.1234/test" });
    const result = await fetchAndCacheItem(item);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toBe("invalid-item");
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
  });

  it("returns no-match when item has no usable identifier (title search also fails)", async () => {
    const item = mockItem({ extra: "Some note" });
    const result = await fetchAndCacheItem(item);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toBe("no-match");
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
  });

  it("skips fetch when cache is fresh", async () => {
    const item = mockItem({ doi: "10.1234/test" });
    // Seed the cache via the public write path so this test matches the
    // post-migration storage model (SQLite, not Extra-field).
    await cacheWorkData(item, makeFakeWork());
    const result = await fetchAndCacheItem(item);
    expect(result.status).toBe("cached");
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
  });

  it("fetches via DOI when DOI is present", async () => {
    const item = mockItem({ doi: "10.1234/test" });
    const fakeWork = makeFakeWork();
    mockedGetWorkByDOI.mockResolvedValue(fakeWork);

    const result = await fetchAndCacheItem(item);
    expect(result.status).toBe("ok");
    expect(mockedGetWorkByDOI).toHaveBeenCalledWith("10.1234/test");
    expect(mockedGetWorkByPMID).not.toHaveBeenCalled();
    expect(mockedGetWorkByArxivId).not.toHaveBeenCalled();
  });

  it("fetches via PMID when no DOI", async () => {
    const item = mockItem({ extra: "PMID: 12345678" });
    const fakeWork = makeFakeWork();
    mockedGetWorkByPMID.mockResolvedValue(fakeWork);

    const result = await fetchAndCacheItem(item);
    expect(result.status).toBe("ok");
    expect(mockedGetWorkByPMID).toHaveBeenCalledWith("12345678");
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
    // v2.0.0+: cache writes go to SQLite, not the item's Extra field —
    // so saveTx is no longer triggered by a normal fetch.
  });

  it("fetches via arXiv when no DOI or PMID", async () => {
    const item = mockItem({ extra: "arXiv: 2205.01833" });
    const fakeWork = makeFakeWork();
    mockedGetWorkByArxivId.mockResolvedValue(fakeWork);

    const result = await fetchAndCacheItem(item);
    expect(result.status).toBe("ok");
    expect(mockedGetWorkByArxivId).toHaveBeenCalledWith("2205.01833");
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
    // v2.0.0+: cache writes go to SQLite, not the item's Extra field —
    // so saveTx is no longer triggered by a normal fetch.
  });

  it("fetches via arXiv from archiveID field", async () => {
    const item = mockItem({ archiveID: "2205.01833v1" });
    const fakeWork = makeFakeWork();
    mockedGetWorkByArxivId.mockResolvedValue(fakeWork);

    const result = await fetchAndCacheItem(item);
    expect(result.status).toBe("ok");
    expect(mockedGetWorkByArxivId).toHaveBeenCalledWith("2205.01833");
  });

  it("fetches via arXiv from URL", async () => {
    const item = mockItem({ url: "https://arxiv.org/abs/2205.01833v2" });
    const fakeWork = makeFakeWork();
    mockedGetWorkByArxivId.mockResolvedValue(fakeWork);

    const result = await fetchAndCacheItem(item);
    expect(result.status).toBe("ok");
    expect(mockedGetWorkByArxivId).toHaveBeenCalledWith("2205.01833");
  });

  it("returns no-match when API returns null (falls through to title search, which also fails)", async () => {
    const item = mockItem({ doi: "10.1234/test" });
    mockedGetWorkByDOI.mockResolvedValue(null);

    const result = await fetchAndCacheItem(item);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toBe("no-match");
  });

  it("returns no-match when PMID lookup returns null (falls through to title search, which also fails)", async () => {
    const item = mockItem({ extra: "PMID: 99999999" });
    mockedGetWorkByPMID.mockResolvedValue(null);

    const result = await fetchAndCacheItem(item);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toBe("no-match");
  });

  it("fetches via ISBN when no other identifier", async () => {
    const item = mockItem({ isbn: "9780262046309", itemType: "book" });
    const fakeWork = makeFakeWork();
    mockedGetWorkByISBN.mockResolvedValue(fakeWork);

    const result = await fetchAndCacheItem(item);
    expect(result.status).toBe("ok");
    expect(mockedGetWorkByISBN).toHaveBeenCalledWith("9780262046309");
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
    // v2.0.0+: cache writes go to SQLite, not the item's Extra field —
    // so saveTx is no longer triggered by a normal fetch.
  });

  it("returns no-match when ISBN lookup returns null (falls through to title search, which also fails)", async () => {
    const item = mockItem({ isbn: "9780262046309", itemType: "book" });
    mockedGetWorkByISBN.mockResolvedValue(null);

    const result = await fetchAndCacheItem(item);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toBe("no-match");
  });
});

// ── canResolveWork ────────────────────────────────────────────────────────────

describe("canResolveWork", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    fakeDb = makeFakeDb();
    _resetForTesting();
    await initCache();
  });

  it("returns true for an item with a DOI", () => {
    expect(canResolveWork(mockItem({ doi: "10.1234/test" }))).toBe(true);
  });

  it("returns true for a PMID-only item", () => {
    expect(canResolveWork(mockItem({ extra: "PMID: 12345678" }))).toBe(true);
  });

  it("returns true for an arXiv-only item", () => {
    expect(canResolveWork(mockItem({ extra: "arXiv: 2205.01833" }))).toBe(true);
  });

  it("returns true for an ISBN-only item", () => {
    expect(canResolveWork(mockItem({ isbn: "9780262046309", itemType: "book" }))).toBe(true);
  });

  it("returns false for an item with no recognized identifier", () => {
    expect(canResolveWork(mockItem({ extra: "just a note" }))).toBe(false);
  });

  it("returns false for a non-regular item (note, attachment)", () => {
    expect(canResolveWork(mockItem({ isRegular: false, doi: "10.1234/test" }))).toBe(false);
  });

  it("returns true for a confirmed title match even with no other identifier", async () => {
    const item = mockItem({ extra: "no identifier here" });
    await writePendingSuggestion(
      item,
      {
        id: "https://openalex.org/W90100",
        display_name: "Confirmed Work",
        cited_by_count: 1,
        fwci: null,
        publication_year: 2020,
        doi: null,
      },
      "high",
      0.95,
    );
    await confirmTitleMatch(item, "high");
    expect(canResolveWork(item)).toBe(true);
  });
});

// ── resolveWorkForItem ──────────────────────────────────────────────────────────

describe("resolveWorkForItem", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    fakeDb = makeFakeDb();
    _resetForTesting();
    await initCache();
  });

  it("resolves via DOI when present", async () => {
    const item = mockItem({ doi: "10.1234/test" });
    const work = makeFakeWork();
    mockedGetWorkByDOI.mockResolvedValue(work);
    expect(await resolveWorkForItem(item)).toBe(work);
    expect(mockedGetWorkByDOI).toHaveBeenCalledWith("10.1234/test");
  });

  it("resolves via PMID when no DOI", async () => {
    const item = mockItem({ extra: "PMID: 12345678" });
    const work = makeFakeWork();
    mockedGetWorkByPMID.mockResolvedValue(work);
    expect(await resolveWorkForItem(item)).toBe(work);
    expect(mockedGetWorkByPMID).toHaveBeenCalledWith("12345678");
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
  });

  it("resolves via arXiv when no DOI or PMID", async () => {
    const item = mockItem({ extra: "arXiv: 2205.01833" });
    const work = makeFakeWork();
    mockedGetWorkByArxivId.mockResolvedValue(work);
    expect(await resolveWorkForItem(item)).toBe(work);
    expect(mockedGetWorkByArxivId).toHaveBeenCalledWith("2205.01833");
  });

  it("resolves via ISBN when no other identifier", async () => {
    const item = mockItem({ isbn: "9780262046309", itemType: "book" });
    const work = makeFakeWork();
    mockedGetWorkByISBN.mockResolvedValue(work);
    expect(await resolveWorkForItem(item)).toBe(work);
    expect(mockedGetWorkByISBN).toHaveBeenCalledWith("9780262046309");
  });

  it("returns null when the item has no resolvable identifier", async () => {
    const item = mockItem({ extra: "no id" });
    expect(await resolveWorkForItem(item)).toBeNull();
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
  });

  it("prefers a confirmed title-match id over identifier lookup", async () => {
    const item = mockItem({ doi: "10.1234/test" });
    await writePendingSuggestion(
      item,
      {
        id: "https://openalex.org/W90200",
        display_name: "Confirmed Work",
        cited_by_count: 1,
        fwci: null,
        publication_year: 2020,
        doi: null,
      },
      "high",
      0.95,
    );
    await confirmTitleMatch(item, "high");
    const confirmedWork = makeFakeWork({ id: "https://openalex.org/W90200" });
    mockedGetWorkById.mockResolvedValue(confirmedWork);

    expect(await resolveWorkForItem(item)).toBe(confirmedWork);
    expect(mockedGetWorkById).toHaveBeenCalledWith("W90200");
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
  });

  it("falls through to identifier lookup when the confirmed id no longer resolves", async () => {
    const item = mockItem({ doi: "10.1234/test" });
    await writePendingSuggestion(
      item,
      {
        id: "https://openalex.org/W90300",
        display_name: "Stale Confirmed Work",
        cited_by_count: 1,
        fwci: null,
        publication_year: 2020,
        doi: null,
      },
      "high",
      0.95,
    );
    await confirmTitleMatch(item, "high");
    mockedGetWorkById.mockResolvedValue(null); // confirmed id gone from OpenAlex
    const work = makeFakeWork();
    mockedGetWorkByDOI.mockResolvedValue(work);

    expect(await resolveWorkForItem(item)).toBe(work);
    expect(mockedGetWorkById).toHaveBeenCalledWith("W90300");
    expect(mockedGetWorkByDOI).toHaveBeenCalledWith("10.1234/test");
  });

  it("returns null when a stale confirmed id misses and the item has no fallback identifier", async () => {
    const item = mockItem({ extra: "no identifier here" });
    await writePendingSuggestion(
      item,
      {
        id: "https://openalex.org/W90400",
        display_name: "De-indexed Work",
        cited_by_count: 1,
        fwci: null,
        publication_year: 2020,
        doi: null,
      },
      "high",
      0.95,
    );
    await confirmTitleMatch(item, "high");
    mockedGetWorkById.mockResolvedValue(null); // confirmed id gone, nothing to fall back to

    expect(await resolveWorkForItem(item)).toBeNull();
    expect(mockedGetWorkById).toHaveBeenCalledWith("W90400");
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
  });

  it("propagates OpenAlexNetworkError instead of swallowing it as null", async () => {
    const item = mockItem({ doi: "10.1234/test" });
    mockedGetWorkByDOI.mockRejectedValue(new OpenAlexNetworkError("unreachable"));
    await expect(resolveWorkForItem(item)).rejects.toBeInstanceOf(OpenAlexNetworkError);
  });

  it("propagates OpenAlexNetworkError thrown while resolving a confirmed id", async () => {
    const item = mockItem({ doi: "10.1234/test" });
    await writePendingSuggestion(
      item,
      {
        id: "https://openalex.org/W90500",
        display_name: "Confirmed Work",
        cited_by_count: 1,
        fwci: null,
        publication_year: 2020,
        doi: null,
      },
      "high",
      0.95,
    );
    await confirmTitleMatch(item, "high");
    mockedGetWorkById.mockRejectedValue(new OpenAlexNetworkError("unreachable"));
    await expect(resolveWorkForItem(item)).rejects.toBeInstanceOf(OpenAlexNetworkError);
    expect(mockedGetWorkByDOI).not.toHaveBeenCalled();
  });
});

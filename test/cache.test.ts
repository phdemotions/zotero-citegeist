/**
 * Tests for the cache module's Extra-field parsing logic.
 *
 * We can't test the full cache read/write cycle because it depends on
 * Zotero's Item API, but we can extract and test the parsing logic
 * by exercising the public functions with mock items.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Zotero global before importing cache module
const mockZotero = {
  Prefs: {
    get: vi.fn().mockReturnValue(7), // default cache lifetime: 7 days
  },
};

vi.stubGlobal("Zotero", mockZotero);

import {
  getCachedCitationCount,
  getCachedOpenAlexId,
  getCachedData,
  getCachedMetrics,
  isCacheStale,
  getCachedCountAndStaleness,
} from "../src/modules/cache";

function mockItem(extra: string) {
  return {
    getField: vi.fn((field: string) => {
      if (field === "extra") return extra;
      return "";
    }),
    setField: vi.fn(),
    saveTx: vi.fn(),
  } as unknown as _ZoteroTypes.Item;
}

describe("getCachedCitationCount", () => {
  it("returns count from Extra field", () => {
    const item = mockItem("Citegeist.citedByCount: 42");
    expect(getCachedCitationCount(item)).toBe(42);
  });

  it("returns null when no Citegeist data exists", () => {
    const item = mockItem("PMID: 12345");
    expect(getCachedCitationCount(item)).toBeNull();
  });

  it("returns 0 for count of zero", () => {
    const item = mockItem("Citegeist.citedByCount: 0");
    expect(getCachedCitationCount(item)).toBe(0);
  });

  it("returns null for empty Extra", () => {
    const item = mockItem("");
    expect(getCachedCitationCount(item)).toBeNull();
  });

  it("preserves non-Citegeist lines when parsing", () => {
    const extra = "PMID: 12345\nCitegeist.citedByCount: 99\nsome other note";
    const item = mockItem(extra);
    expect(getCachedCitationCount(item)).toBe(99);
  });
});

describe("getCachedOpenAlexId", () => {
  it("returns OpenAlex ID from Extra", () => {
    const item = mockItem("Citegeist.openAlexId: W1234567890");
    expect(getCachedOpenAlexId(item)).toBe("W1234567890");
  });

  it("returns null when not present", () => {
    const item = mockItem("Citegeist.citedByCount: 10");
    expect(getCachedOpenAlexId(item)).toBeNull();
  });
});

describe("getCachedData", () => {
  it("returns full cached data object", () => {
    const extra = [
      "Citegeist.openAlexId: W123",
      "Citegeist.citedByCount: 50",
      "Citegeist.fwci: 2.31",
      "Citegeist.percentile: 92.5",
      "Citegeist.isTop1Percent: false",
      "Citegeist.isTop10Percent: true",
      "Citegeist.isRetracted: false",
      "Citegeist.lastFetched: 2026-04-01T12:00:00Z",
    ].join("\n");
    const item = mockItem(extra);
    const data = getCachedData(item);

    expect(data).not.toBeNull();
    expect(data!.openAlexId).toBe("W123");
    expect(data!.citedByCount).toBe(50);
    expect(data!.fwci).toBe(2.31);
    expect(data!.percentile).toBe(92.5);
    expect(data!.isTop1Percent).toBe(false);
    expect(data!.isTop10Percent).toBe(true);
    expect(data!.isRetracted).toBe(false);
    expect(data!.lastFetched).toBe("2026-04-01T12:00:00Z");
  });

  it("returns null when no OpenAlex ID is cached", () => {
    const item = mockItem("Citegeist.citedByCount: 10");
    expect(getCachedData(item)).toBeNull();
  });

  it("handles missing optional fields gracefully", () => {
    const extra = "Citegeist.openAlexId: W123\nCitegeist.citedByCount: 5";
    const item = mockItem(extra);
    const data = getCachedData(item);

    expect(data).not.toBeNull();
    expect(data!.fwci).toBeNull();
    expect(data!.percentile).toBeNull();
    expect(data!.isTop1Percent).toBe(false);
    expect(data!.isTop10Percent).toBe(false);
  });
});

describe("isCacheStale", () => {
  beforeEach(() => {
    mockZotero.Prefs.get.mockReturnValue(7);
  });

  it("returns true when no lastFetched exists", () => {
    const item = mockItem("Citegeist.openAlexId: W123");
    expect(isCacheStale(item)).toBe(true);
  });

  it("returns true when Extra is empty", () => {
    const item = mockItem("");
    expect(isCacheStale(item)).toBe(true);
  });

  it("returns false when fetched recently", () => {
    const recent = new Date().toISOString();
    const item = mockItem(`Citegeist.lastFetched: ${recent}`);
    expect(isCacheStale(item)).toBe(false);
  });

  it("returns true when fetched longer ago than cache lifetime", () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const item = mockItem(`Citegeist.lastFetched: ${old}`);
    expect(isCacheStale(item)).toBe(true);
  });

  it("returns true for corrupted date", () => {
    const item = mockItem("Citegeist.lastFetched: not-a-date");
    expect(isCacheStale(item)).toBe(true);
  });

  it("respects custom cache lifetime", () => {
    mockZotero.Prefs.get.mockReturnValue(1); // 1 day
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const item = mockItem(`Citegeist.lastFetched: ${twoDaysAgo}`);
    expect(isCacheStale(item)).toBe(true);
  });
});

describe("getCachedMetrics", () => {
  it("returns count, fwci, percentile, and staleness together", () => {
    const recent = new Date().toISOString();
    const extra = [
      "Citegeist.citedByCount: 25",
      "Citegeist.fwci: 1.85",
      "Citegeist.percentile: 91.2",
      `Citegeist.lastFetched: ${recent}`,
    ].join("\n");
    const item = mockItem(extra);
    const result = getCachedMetrics(item);

    expect(result.count).toBe(25);
    expect(result.fwci).toBe(1.85);
    expect(result.percentile).toBe(91.2);
    expect(result.isStale).toBe(false);
  });

  it("returns null for missing fwci and percentile", () => {
    const recent = new Date().toISOString();
    const extra = `Citegeist.citedByCount: 10\nCitegeist.lastFetched: ${recent}`;
    const item = mockItem(extra);
    const result = getCachedMetrics(item);

    expect(result.count).toBe(10);
    expect(result.fwci).toBeNull();
    expect(result.percentile).toBeNull();
    expect(result.isStale).toBe(false);
  });

  it("returns all null for empty Extra", () => {
    const item = mockItem("");
    const result = getCachedMetrics(item);
    expect(result.count).toBeNull();
    expect(result.fwci).toBeNull();
    expect(result.percentile).toBeNull();
    expect(result.isStale).toBe(true);
  });
});

describe("getCachedCountAndStaleness", () => {
  it("returns count and staleness together", () => {
    const recent = new Date().toISOString();
    const extra = `Citegeist.citedByCount: 25\nCitegeist.lastFetched: ${recent}`;
    const item = mockItem(extra);
    const result = getCachedCountAndStaleness(item);

    expect(result.count).toBe(25);
    expect(result.isStale).toBe(false);
  });

  it("returns null count when not cached", () => {
    const item = mockItem("");
    const result = getCachedCountAndStaleness(item);
    expect(result.count).toBeNull();
    expect(result.isStale).toBe(true);
  });
});

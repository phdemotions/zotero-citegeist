/**
 * Tests for the SQLite-backed cache module (v1.4.0+).
 *
 * The cache reads from an in-memory mirror populated at startup. Tests
 * stub `Zotero.DBConnection` with an in-memory fake and exercise the
 * public read/write API end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Fake DB ────────────────────────────────────────────────────────────────
//
// Records every queryAsync call. For INSERT/REPLACE and SELECT * FROM
// item_cache we maintain a Map<string, Record<string, unknown>> keyed on
// item_key so SELECT returns rows in insertion order. Everything else is
// a no-op (CREATE TABLE, CREATE INDEX, etc).

interface FakeRow {
  [col: string]: unknown;
}

function makeFakeDb() {
  const table = new Map<string, FakeRow>();
  const progress = new Map<string, string>();

  return {
    table,
    progress,
    queryAsync: vi.fn(async (sql: string, params?: unknown[]) => {
      const s = sql.trim();

      if (/^CREATE\s+(TABLE|INDEX)/i.test(s)) return [];

      // INSERT OR REPLACE INTO item_cache (...) VALUES (?, ?, ...)
      if (/^INSERT\s+OR\s+REPLACE\s+INTO\s+item_cache/i.test(s)) {
        const colsMatch = /\(([^)]+)\)\s+VALUES/i.exec(s);
        if (!colsMatch) throw new Error("bad INSERT statement: " + s);
        const cols = colsMatch[1].split(",").map((c) => c.trim());
        const row: FakeRow = {};
        cols.forEach((c, i) => {
          row[c] = params?.[i] ?? null;
        });
        const key = row.item_key as string;
        table.set(key, row);
        return [];
      }

      if (/^INSERT\s+OR\s+REPLACE\s+INTO\s+migration_progress/i.test(s)) {
        const [key, at] = params as [string, string];
        progress.set(key, at);
        return [];
      }

      if (/^SELECT\s+\*\s+FROM\s+item_cache/i.test(s)) {
        return Array.from(table.values());
      }

      if (/^SELECT\s+item_key\s+FROM\s+migration_progress/i.test(s)) {
        const key = (params as [string])[0];
        return progress.has(key) ? [{ item_key: key }] : [];
      }

      if (/^DELETE\s+FROM\s+item_cache\s+WHERE\s+item_key\s+=\s+\?/i.test(s)) {
        table.delete((params as [string])[0]);
        return [];
      }

      if (/^DELETE\s+FROM\s+item_cache\s+WHERE\s+item_key\s+IN/i.test(s)) {
        for (const k of params as string[]) table.delete(k);
        return [];
      }

      if (/^DELETE\s+FROM\s+migration_progress\s+WHERE\s+item_key\s+IN/i.test(s)) {
        for (const k of params as string[]) progress.delete(k);
        return [];
      }

      throw new Error("unhandled SQL in fake DB: " + s);
    }),
    executeTransaction: vi.fn(async (fn: () => Promise<unknown>) => await fn()),
    tableExists: vi.fn(async () => false),
    closeDatabase: vi.fn(async () => {}),
  };
}

// ── Test fixtures ──────────────────────────────────────────────────────────

const items: Map<string, { extra: string }> = new Map();

function mockItem(key: string, extra: string = ""): _ZoteroTypes.Item {
  items.set(key, { extra });
  return {
    id: parseInt(key, 36) || 1,
    key,
    libraryID: 1,
    isRegularItem: () => true,
    getField: vi.fn((field: string) => {
      if (field === "extra") return items.get(key)?.extra ?? "";
      return "";
    }),
    setField: vi.fn((field: string, value: string | number) => {
      if (field === "extra") items.set(key, { extra: String(value) });
    }),
    saveTx: vi.fn(async () => 1),
  } as unknown as _ZoteroTypes.Item;
}

let fakeDb: ReturnType<typeof makeFakeDb>;

const mockZotero = {
  debug: vi.fn(),
  Prefs: {
    get: vi.fn().mockImplementation((pref: string) => {
      if (pref === "extensions.zotero.citegeist.cacheLifetimeDays") return 7;
      if (pref === "extensions.zotero.citegeist.migrationV1Complete") return false;
      return null;
    }),
    set: vi.fn(),
    clearUserPref: vi.fn(),
  },
  Libraries: {
    userLibraryID: 1,
    getAll: vi.fn(() => [{ libraryID: 1, libraryType: "user" }] as _ZoteroTypes.Library[]),
  },
  Items: {
    getAll: vi.fn(async () => [] as _ZoteroTypes.Item[]),
  },
  Sync: {
    Runner: {
      delaySync: vi.fn(async (fn: () => Promise<unknown>) => await fn()),
    },
  },
  ProgressWindow: vi.fn(),
  DBConnection: vi.fn(),
};

vi.stubGlobal("Zotero", mockZotero);

import {
  _resetForTesting,
  initCache,
  cacheWorkData,
  clearCache,
  confirmTitleMatch,
  getCachedCitationCount,
  getCachedCountAndStaleness,
  getCachedData,
  getCachedMetrics,
  getCachedOpenAlexId,
  getPendingSuggestion,
  getTitleMatchMeta,
  isCacheStale,
  isNoMatchSuppressed,
  migrateFromExtraV1,
  writeNoMatch,
  writePendingSuggestion,
  clearPendingSuggestion,
  garbageCollectOrphans,
} from "../src/modules/cache";

beforeEach(async () => {
  items.clear();
  fakeDb = makeFakeDb();
  // Replace DBConnection with a constructor that returns the fake.
  // vi.fn() with new-call returns whatever its body returns.
  mockZotero.DBConnection = vi.fn(function (this: unknown) {
    return fakeDb;
  }) as unknown as typeof mockZotero.DBConnection;
  mockZotero.Prefs.get.mockImplementation((pref: string) => {
    if (pref === "extensions.zotero.citegeist.cacheLifetimeDays") return 7;
    if (pref === "extensions.zotero.citegeist.migrationV1Complete") return false;
    return null;
  });
  mockZotero.Items.getAll.mockResolvedValue([]);
  _resetForTesting();
  await initCache();
});

// ── Read path: empty mirror ─────────────────────────────────────────────────

describe("read API on empty mirror", () => {
  it("getCachedCitationCount returns null", () => {
    expect(getCachedCitationCount(mockItem("A"))).toBeNull();
  });

  it("getCachedMetrics returns the empty shape, not null", () => {
    const m = getCachedMetrics(mockItem("A"));
    expect(m.count).toBeNull();
    expect(m.isStale).toBe(true);
    expect(m.suggestion).toBeNull();
    expect(m.sourceISSNs).toEqual([]);
  });

  it("getCachedData returns null", () => {
    expect(getCachedData(mockItem("A"))).toBeNull();
  });

  it("isCacheStale returns true when no row exists", () => {
    expect(isCacheStale(mockItem("A"))).toBe(true);
  });
});

// ── Write → read round-trip ────────────────────────────────────────────────

describe("cacheWorkData → read round-trip", () => {
  function makeWork(overrides: Record<string, unknown> = {}) {
    return {
      id: "https://openalex.org/W123",
      cited_by_count: 50,
      fwci: 2.31,
      citation_normalized_percentile: {
        value: 0.925,
        is_in_top_1_percent: false,
        is_in_top_10_percent: true,
      },
      is_retracted: false,
      primary_location: { source: { id: "https://openalex.org/S55", issn_l: "0000-0000" } },
      ...overrides,
    } as never;
  }

  it("populates getCachedData", async () => {
    const item = mockItem("A");
    await cacheWorkData(item, makeWork());
    const d = getCachedData(item);
    expect(d).not.toBeNull();
    expect(d!.openAlexId).toBe("W123");
    expect(d!.citedByCount).toBe(50);
    expect(d!.fwci).toBe(2.31);
    expect(d!.percentile).toBeCloseTo(92.5, 1);
    expect(d!.isTop10Percent).toBe(true);
    expect(d!.isTop1Percent).toBe(false);
    expect(d!.isRetracted).toBe(false);
    expect(d!.sourceId).toBe("S55");
  });

  it("populates getCachedMetrics", async () => {
    const item = mockItem("A");
    await cacheWorkData(item, makeWork(), { citedness2yr: 4.5, hIndex: 88, issns: ["1234-5678"] });
    const m = getCachedMetrics(item);
    expect(m.count).toBe(50);
    expect(m.citedness2yr).toBe(4.5);
    expect(m.journalHIndex).toBe(88);
    expect(m.sourceISSNs).toEqual(["1234-5678"]);
  });

  it("suppresses fwci when cited_by_count is 0", async () => {
    await cacheWorkData(mockItem("A"), makeWork({ cited_by_count: 0, fwci: 1.5 }));
    expect(getCachedData(mockItem("A"))!.fwci).toBeNull();
  });

  it("getCachedCountAndStaleness reads single round of mirror", async () => {
    await cacheWorkData(mockItem("A"), makeWork());
    const cs = getCachedCountAndStaleness(mockItem("A"));
    expect(cs.count).toBe(50);
    expect(cs.isStale).toBe(false);
  });
});

// ── Staleness ──────────────────────────────────────────────────────────────

describe("isCacheStale", () => {
  it("returns false for a fresh cache", async () => {
    const item = mockItem("A");
    await cacheWorkData(item, {
      id: "https://openalex.org/W1",
      cited_by_count: 1,
      fwci: 1,
      is_retracted: false,
    } as never);
    expect(isCacheStale(item)).toBe(false);
  });

  it("returns true when last_fetched is older than the lifetime", async () => {
    const item = mockItem("A");
    await cacheWorkData(item, {
      id: "https://openalex.org/W1",
      cited_by_count: 1,
      fwci: 1,
      is_retracted: false,
    } as never);
    // Manually backdate the row
    const row = fakeDb.table.get("A")!;
    row.last_fetched = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    // Force-reload mirror by re-initing
    _resetForTesting();
    await initCache();
    expect(isCacheStale(item)).toBe(true);
  });
});

// ── Clear semantics (wide) ─────────────────────────────────────────────────

describe("clearCache", () => {
  it("removes work data, match meta, and pending suggestion together", async () => {
    const item = mockItem("A");
    await cacheWorkData(item, {
      id: "https://openalex.org/W1",
      cited_by_count: 1,
      fwci: null,
      is_retracted: false,
    } as never);
    await writeNoMatch(item);
    await writePendingSuggestion(
      item,
      {
        id: "https://openalex.org/W2",
        display_name: "Pending",
        cited_by_count: 7,
        fwci: 1.1,
        publication_year: 2020,
        doi: null,
      },
      "high",
      0.93,
    );
    await clearCache(item);
    expect(getCachedData(item)).toBeNull();
    expect(getTitleMatchMeta(item).noMatch).toBe(false);
    expect(getPendingSuggestion(item)).toBeNull();
  });
});

// ── Title-match flow ───────────────────────────────────────────────────────

describe("title-match flow", () => {
  it("writePendingSuggestion → getPendingSuggestion", async () => {
    const item = mockItem("A");
    await writePendingSuggestion(
      item,
      {
        id: "https://openalex.org/Wcand",
        display_name: "Candidate Title",
        cited_by_count: 12,
        fwci: 1.2,
        publication_year: 2022,
        doi: "10.1/abc",
      },
      "medium",
      0.81,
    );
    const s = getPendingSuggestion(item)!;
    expect(s.openAlexId).toBe("Wcand");
    expect(s.title).toBe("Candidate Title");
    expect(s.tier).toBe("medium");
    expect(s.confidence).toBeCloseTo(0.81);
  });

  it("getCachedMetrics surfaces suggestion only when no work data exists", async () => {
    const item = mockItem("A");
    await writePendingSuggestion(
      item,
      {
        id: "https://openalex.org/Wcand",
        display_name: "X",
        cited_by_count: 3,
        fwci: null,
        publication_year: 2020,
        doi: null,
      },
      "high",
      0.95,
    );
    expect(getCachedMetrics(item).suggestion).not.toBeNull();

    // Add real work data — suggestion should disappear from the metrics view.
    await cacheWorkData(item, {
      id: "https://openalex.org/W1",
      cited_by_count: 5,
      fwci: null,
      is_retracted: false,
    } as never);
    expect(getCachedMetrics(item).suggestion).toBeNull();
  });

  it("confirmTitleMatch promotes pending → confirmed and writes Extra mirror", async () => {
    const item = mockItem("A");
    await writePendingSuggestion(
      item,
      {
        id: "https://openalex.org/Wconfirm",
        display_name: "X",
        cited_by_count: 3,
        fwci: null,
        publication_year: 2020,
        doi: null,
      },
      "high",
      0.95,
    );
    await confirmTitleMatch(item, "high");
    expect(getTitleMatchMeta(item).confirmedOpenAlexId).toBe("Wconfirm");
    expect(getTitleMatchMeta(item).matchMethod).toBe("title-match");
    expect(items.get("A")!.extra).toContain("Citegeist match ID: Wconfirm");
  });

  it("clearPendingSuggestion zeros only pending fields", async () => {
    const item = mockItem("A");
    await cacheWorkData(item, {
      id: "https://openalex.org/W1",
      cited_by_count: 5,
      fwci: null,
      is_retracted: false,
    } as never);
    await writePendingSuggestion(
      item,
      {
        id: "https://openalex.org/Wcand",
        display_name: "X",
        cited_by_count: 3,
        fwci: null,
        publication_year: 2020,
        doi: null,
      },
      "high",
      0.95,
    );
    await clearPendingSuggestion(item);
    expect(getPendingSuggestion(item)).toBeNull();
    expect(getCachedData(item)).not.toBeNull(); // work data survives
  });
});

// ── No-match suppression window ────────────────────────────────────────────

describe("isNoMatchSuppressed", () => {
  it("returns false when there's no row", () => {
    expect(isNoMatchSuppressed(mockItem("A"), 30)).toBe(false);
  });

  it("returns true within the window", async () => {
    const item = mockItem("A");
    await writeNoMatch(item);
    expect(isNoMatchSuppressed(item, 30)).toBe(true);
  });

  it("returns false after the window elapses", async () => {
    const item = mockItem("A");
    await writeNoMatch(item);
    const row = fakeDb.table.get("A")!;
    row.no_match_timestamp = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    _resetForTesting();
    await initCache();
    expect(isNoMatchSuppressed(item, 30)).toBe(false);
  });
});

// ── Orphan GC ───────────────────────────────────────────────────────────────

describe("garbageCollectOrphans", () => {
  it("removes rows whose item_key is not in the live library", async () => {
    const item = mockItem("A");
    await cacheWorkData(item, {
      id: "https://openalex.org/W1",
      cited_by_count: 1,
      fwci: null,
      is_retracted: false,
    } as never);
    // Simulate the item no longer existing in the library.
    mockZotero.Items.getAll.mockResolvedValue([]);
    await garbageCollectOrphans({ force: true });
    expect(getCachedData(item)).toBeNull();
    expect(fakeDb.table.size).toBe(0);
  });

  it("keeps rows that do exist", async () => {
    const item = mockItem("A");
    await cacheWorkData(item, {
      id: "https://openalex.org/W1",
      cited_by_count: 1,
      fwci: null,
      is_retracted: false,
    } as never);
    mockZotero.Items.getAll.mockResolvedValue([item]);
    await garbageCollectOrphans({ force: true });
    expect(getCachedData(item)).not.toBeNull();
  });
});

// ── getCachedOpenAlexId thin wrapper ────────────────────────────────────────

describe("getCachedOpenAlexId", () => {
  it("returns the ID from the mirror", async () => {
    const item = mockItem("A");
    await cacheWorkData(item, {
      id: "https://openalex.org/W7",
      cited_by_count: 1,
      fwci: null,
      is_retracted: false,
    } as never);
    expect(getCachedOpenAlexId(item)).toBe("W7");
  });

  it("returns null when missing", () => {
    expect(getCachedOpenAlexId(mockItem("Z"))).toBeNull();
  });
});

// ── Migration from legacy Extra-field storage ──────────────────────────────

describe("migrateFromExtraV1", () => {
  function legacyExtra(): string {
    return [
      "Citegeist.openAlexId: W123",
      "Citegeist.citedByCount: 42",
      "Citegeist.fwci: 2.31",
      "Citegeist.percentile: 92.5",
      "Citegeist.isTop1Percent: false",
      "Citegeist.isTop10Percent: true",
      "Citegeist.isRetracted: false",
      "Citegeist.lastFetched: 2026-04-01T12:00:00Z",
    ].join("\n");
  }

  it("copies legacy fields into SQLite and strips Citegeist lines from Extra", async () => {
    const item = mockItem("A", legacyExtra());
    mockZotero.Items.getAll.mockResolvedValue([item]);
    await migrateFromExtraV1();
    // SQLite populated
    const data = getCachedData(item);
    expect(data!.openAlexId).toBe("W123");
    expect(data!.citedByCount).toBe(42);
    expect(data!.fwci).toBeCloseTo(2.31);
    // Extra cleaned
    expect(items.get("A")!.extra).not.toContain("Citegeist.");
  });

  it("preserves non-Citegeist Extra content byte-for-byte", async () => {
    const extra = ["PMID: 12345", "Citegeist.citedByCount: 99", "tex.note: hello"].join("\n");
    const item = mockItem("A", extra);
    mockZotero.Items.getAll.mockResolvedValue([item]);
    await migrateFromExtraV1();
    const cleaned = items.get("A")!.extra;
    expect(cleaned).toContain("PMID: 12345");
    expect(cleaned).toContain("tex.note: hello");
    expect(cleaned).not.toContain("Citegeist.");
  });

  it("mirrors confirmed match ID back to Extra under non-Citegeist prefix", async () => {
    const extra = [
      "Citegeist.openAlexId: W123",
      "Citegeist.citedByCount: 5",
      "Citegeist.matchMethod: title-match",
      "Citegeist.matchConfidence: high",
      "Citegeist.confirmedOpenAlexId: W123",
    ].join("\n");
    const item = mockItem("A", extra);
    mockZotero.Items.getAll.mockResolvedValue([item]);
    await migrateFromExtraV1();
    expect(items.get("A")!.extra).toContain("Citegeist match ID: W123");
    expect(getTitleMatchMeta(item).confirmedOpenAlexId).toBe("W123");
  });

  it("is idempotent: second run is a no-op", async () => {
    const item = mockItem("A", legacyExtra());
    mockZotero.Items.getAll.mockResolvedValue([item]);
    await migrateFromExtraV1();

    // Pretend the pref-guard fails (e.g. partial state) but checkpoint exists.
    mockZotero.Prefs.get.mockImplementation((pref: string) => {
      if (pref === "extensions.zotero.citegeist.migrationV1Complete") return false;
      if (pref === "extensions.zotero.citegeist.cacheLifetimeDays") return 7;
      return null;
    });
    items.get("A")!.extra = ""; // simulate already-stripped
    const initialSize = fakeDb.table.size;
    await migrateFromExtraV1();
    expect(fakeDb.table.size).toBe(initialSize);
  });

  it("tolerates legacy reordering of Citegeist lines (round-trip is set-based)", async () => {
    // The v1.3.0 writer always pushed Citegeist lines to the end of Extra.
    // The round-trip check must accept the original ordering as valid.
    const extra = "Citegeist.openAlexId: W7\nPMID: 12345\nCitegeist.citedByCount: 5";
    const item = mockItem("A", extra);
    mockZotero.Items.getAll.mockResolvedValue([item]);
    await migrateFromExtraV1();
    const cleaned = items.get("A")!.extra;
    expect(cleaned).toContain("PMID: 12345");
    expect(cleaned).not.toContain("Citegeist.openAlexId");
    expect(cleaned).not.toContain("Citegeist.citedByCount");
    expect(getCachedData(item)!.openAlexId).toBe("W7");
  });

  it("respects the migrationV1Complete pref", async () => {
    mockZotero.Prefs.get.mockImplementation((pref: string) => {
      if (pref === "extensions.zotero.citegeist.migrationV1Complete") return true;
      return null;
    });
    const item = mockItem("A", legacyExtra());
    mockZotero.Items.getAll.mockResolvedValue([item]);
    await migrateFromExtraV1();
    expect(items.get("A")!.extra).toContain("Citegeist.");
    expect(fakeDb.table.size).toBe(0);
  });
});

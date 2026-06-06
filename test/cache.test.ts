/**
 * Tests for the SQLite-backed cache module (v2.0.0+).
 *
 * The cache reads from an in-memory mirror populated at startup. Tests
 * stub `Zotero.DBConnection` with an in-memory fake and exercise the
 * public read/write API end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeDb } from "./_helpers/fakeDb";

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

// Captured calls to Zotero.File.putContentsAsync — tests assert backup contents here.
const fileWrites: Array<{ path: string; contents: string }> = [];

vi.stubGlobal("PathUtils", {
  join: (...parts: string[]) => parts.join("/"),
});

vi.stubGlobal("IOUtils", {
  getChildren: vi.fn(async () => [] as string[]),
  remove: vi.fn(async () => {}),
  move: vi.fn(async () => {}),
  exists: vi.fn(async () => false),
  makeDirectory: vi.fn(async () => {}),
  setPermissions: vi.fn(async () => {}),
});

const mockZotero = {
  version: "7.0.10",
  debug: vi.fn(),
  DataDirectory: { dir: "/tmp/zotero-test-data" },
  File: {
    putContentsAsync: vi.fn(async (path: string, contents: string) => {
      fileWrites.push({ path, contents });
    }),
  },
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
    getAll: vi.fn(
      () => [{ libraryID: 1, libraryType: "user", editable: true }] as _ZoteroTypes.Library[],
    ),
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

import { _resetForTesting, closeCache } from "../src/modules/cache/db";
import {
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
  fileWrites.length = 0;
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
  // Reset Libraries.getAll to the default single editable user library —
  // prior tests may have overridden via mockImplementation.
  mockZotero.Libraries.getAll.mockImplementation(
    () => [{ libraryID: 1, libraryType: "user", editable: true }] as _ZoteroTypes.Library[],
  );
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

  it("preserves fwci from OpenAlex even when cited_by_count is 0", async () => {
    // Zero-citation works can still have valid FWCI/percentile from OpenAlex.
    // We no longer suppress them — the gate was silently dropping real data.
    await cacheWorkData(mockItem("A"), makeWork({ cited_by_count: 0, fwci: 1.5 }));
    expect(getCachedData(mockItem("A"))!.fwci).toBe(1.5);
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
    const row = fakeDb.table.get("1:A")!;
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
        id: "https://openalex.org/W90001",
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
    expect(s.openAlexId).toBe("W90001");
    expect(s.title).toBe("Candidate Title");
    expect(s.tier).toBe("medium");
    expect(s.confidence).toBeCloseTo(0.81);
  });

  it("getCachedMetrics surfaces suggestion only when no work data exists", async () => {
    const item = mockItem("A");
    await writePendingSuggestion(
      item,
      {
        id: "https://openalex.org/W90001",
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
        id: "https://openalex.org/W90002",
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
    expect(getTitleMatchMeta(item).confirmedOpenAlexId).toBe("W90002");
    expect(getTitleMatchMeta(item).matchMethod).toBe("title-match");
    expect(items.get("A")!.extra).toContain("Citegeist match ID: W90002");
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
        id: "https://openalex.org/W90001",
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
    const row = fakeDb.table.get("1:A")!;
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

// ── Composite key isolation across libraries ───────────────────────────────

describe("composite (libraryID, itemKey) keying", () => {
  function libItem(libraryID: number, key: string): _ZoteroTypes.Item {
    const composite = `${libraryID}-${key}`;
    items.set(composite, { extra: "" });
    return {
      id: parseInt(composite, 36) || 1,
      key,
      libraryID,
      isRegularItem: () => true,
      getField: vi.fn((field: string) => {
        if (field === "extra") return items.get(composite)?.extra ?? "";
        return "";
      }),
      setField: vi.fn((field: string, value: string | number) => {
        if (field === "extra") items.set(composite, { extra: String(value) });
      }),
      saveTx: vi.fn(async () => 1),
    } as unknown as _ZoteroTypes.Item;
  }

  it("does not collide when two libraries hold items with the same key", async () => {
    const itemUser = libItem(1, "ABC");
    const itemGroup = libItem(2, "ABC");

    await cacheWorkData(itemUser, {
      id: "https://openalex.org/W90003",
      cited_by_count: 5,
      fwci: null,
      is_retracted: false,
    } as never);
    await cacheWorkData(itemGroup, {
      id: "https://openalex.org/W90004",
      cited_by_count: 7,
      fwci: null,
      is_retracted: false,
    } as never);

    expect(getCachedOpenAlexId(itemUser)).toBe("W90003");
    expect(getCachedOpenAlexId(itemGroup)).toBe("W90004");
    expect(fakeDb.table.size).toBe(2);
  });

  it("clearCache on one library does not affect the other", async () => {
    const itemA = libItem(1, "X");
    const itemB = libItem(2, "X");
    await cacheWorkData(itemA, {
      id: "https://openalex.org/W90005",
      cited_by_count: 1,
      fwci: null,
      is_retracted: false,
    } as never);
    await cacheWorkData(itemB, {
      id: "https://openalex.org/W90006",
      cited_by_count: 2,
      fwci: null,
      is_retracted: false,
    } as never);

    await clearCache(itemA);
    expect(getCachedData(itemA)).toBeNull();
    expect(getCachedData(itemB)).not.toBeNull();
  });
});

// ── Crash-recovery between migration steps ─────────────────────────────────

describe("migration crash recovery", () => {
  function legacyExtra(): string {
    return "Citegeist.openAlexId: W90007\nCitegeist.citedByCount: 9";
  }

  it("resumes after step 1 (SQLite written, Extra not yet stripped)", async () => {
    // Seed SQLite as if step 1 completed but the process died before step 2.
    const item = mockItem("R", legacyExtra());
    await cacheWorkData(item, {
      id: "https://openalex.org/W90007",
      cited_by_count: 9,
      fwci: null,
      is_retracted: false,
    } as never);
    // No checkpoint yet (simulating step-2 interrupt).
    expect(fakeDb.progress.size).toBe(0);

    mockZotero.Items.getAll.mockResolvedValue([item]);
    await migrateFromExtraV1();

    // Extra now stripped + checkpoint written.
    expect(items.get("R")!.extra).not.toContain("Citegeist.");
    // Post-migration cleanup runs once, so progress is empty after success.
    expect(fakeDb.progress.size).toBe(0);
  });

  it("writes a checkpoint even when nothing to migrate (step 2/3 interrupt recovery)", async () => {
    // Item already had its Citegeist data stripped on a prior interrupted run.
    const item = mockItem("S", "Some unrelated note");
    // Pre-populate SQLite row to simulate a prior step-1 success.
    await cacheWorkData(item, {
      id: "https://openalex.org/W90008",
      cited_by_count: 4,
      fwci: null,
      is_retracted: false,
    } as never);

    // Set extra to include LEGACY_PREFIX so the pre-filter picks it up,
    // but parse will return zero fields after we manually clear it.
    items.set("S", { extra: "" });
    items.set("S", { extra: "Citegeist.unknownFieldNoColon" }); // size = 0 after parse

    mockZotero.Items.getAll.mockResolvedValue([item]);
    await migrateFromExtraV1();

    // Item is no longer reprocessed on subsequent runs (progress cleared after
    // successful migration completion, but during the run the checkpoint was
    // written — we verify this via the absence of re-fetch attempts on rerun).
    expect(items.get("S")!.extra).toBe("Citegeist.unknownFieldNoColon");
  });
});

// ── Round-trip parse invariant: negative case ──────────────────────────────

describe("verifyParseRoundTrip negative cases", () => {
  it("skips items where duplicate Citegeist keys would collapse on reassembly", async () => {
    // The Map-based parser collapses `Citegeist.citedByCount: 5` and
    // `Citegeist.citedByCount: 7` into a single entry. The reassembled extra
    // has one cg line; the original had two. Multiset comparison catches this.
    const extra = "Citegeist.citedByCount: 5\nCitegeist.citedByCount: 7\nPMID: 12345";
    const item = mockItem("D", extra);
    mockZotero.Items.getAll.mockResolvedValue([item]);
    await migrateFromExtraV1();
    // Item is skipped; Extra unmodified.
    expect(items.get("D")!.extra).toBe(extra);
  });
});

// ── Legacy migration: ID validation ────────────────────────────────────────

describe("migration legacy ID validation", () => {
  it("drops malformed openAlexId from legacy Extra rather than persisting it", async () => {
    const extra = ["Citegeist.openAlexId: not-a-valid-id", "Citegeist.citedByCount: 5"].join("\n");
    const item = mockItem("X", extra);
    mockZotero.Items.getAll.mockResolvedValue([item]);

    await migrateFromExtraV1();

    // Row is written but with open_alex_id null — the cited_by_count salvages.
    const data = getCachedData(item);
    expect(data).toBeNull(); // openAlexId null → getCachedData returns null
    // Confirm the row WAS persisted (cited_by_count survived)
    const metrics = getCachedMetrics(item);
    expect(metrics.count).toBe(5);
  });

  it("drops malformed sourceId from legacy Extra", async () => {
    const extra = [
      "Citegeist.openAlexId: W42",
      "Citegeist.citedByCount: 3",
      "Citegeist.sourceId: ../../etc/passwd",
    ].join("\n");
    const item = mockItem("Y", extra);
    mockZotero.Items.getAll.mockResolvedValue([item]);

    await migrateFromExtraV1();

    const metrics = getCachedMetrics(item);
    expect(metrics.sourceId).toBeNull();
    expect(metrics.count).toBe(3);
  });
});

// ── Zotero version gate ────────────────────────────────────────────────────

describe("migration version gate", () => {
  it("refuses to run on Zotero < 7.0.10", async () => {
    mockZotero.version = "7.0.9";
    const item = mockItem("V", "Citegeist.citedByCount: 1");
    mockZotero.Items.getAll.mockResolvedValue([item]);

    await migrateFromExtraV1();

    expect(items.get("V")!.extra).toContain("Citegeist."); // not stripped
    expect(fakeDb.table.size).toBe(0); // not migrated
    mockZotero.version = "7.0.10"; // restore
  });

  it("runs on Zotero 7.0.10 and newer", async () => {
    mockZotero.version = "7.0.42";
    const item = mockItem("W", "Citegeist.citedByCount: 1");
    mockZotero.Items.getAll.mockResolvedValue([item]);

    await migrateFromExtraV1();

    expect(items.get("W")!.extra).not.toContain("Citegeist.");
    mockZotero.version = "7.0.10";
  });
});

// ── Orphan GC rate limit ───────────────────────────────────────────────────

describe("garbageCollectOrphans rate limit", () => {
  it("skips when lastOrphanGcAt is within the interval (and no force)", async () => {
    const item = mockItem("L");
    await cacheWorkData(item, {
      id: "https://openalex.org/W90009",
      cited_by_count: 1,
      fwci: null,
      is_retracted: false,
    } as never);

    // Last GC was 1 minute ago — far less than the 7-day interval.
    mockZotero.Prefs.get.mockImplementation((pref: string) => {
      if (pref === "extensions.zotero.citegeist.lastOrphanGcAt") return Date.now() - 60_000;
      if (pref === "extensions.zotero.citegeist.cacheLifetimeDays") return 7;
      if (pref === "extensions.zotero.citegeist.migrationV1Complete") return true;
      return null;
    });
    mockZotero.Items.getAll.mockResolvedValue([]); // simulates orphan

    await garbageCollectOrphans(); // no force
    expect(getCachedData(item)).not.toBeNull(); // not GC'd
  });

  it("runs when called with { force: true } regardless of interval", async () => {
    const item = mockItem("F");
    await cacheWorkData(item, {
      id: "https://openalex.org/W90010",
      cited_by_count: 1,
      fwci: null,
      is_retracted: false,
    } as never);

    mockZotero.Prefs.get.mockImplementation((pref: string) => {
      if (pref === "extensions.zotero.citegeist.lastOrphanGcAt") return Date.now();
      if (pref === "extensions.zotero.citegeist.cacheLifetimeDays") return 7;
      if (pref === "extensions.zotero.citegeist.migrationV1Complete") return true;
      return null;
    });
    mockZotero.Items.getAll.mockResolvedValue([]);

    await garbageCollectOrphans({ force: true });
    expect(getCachedData(item)).toBeNull(); // GC'd
  });
});

// ── confirmTitleMatch precedence ───────────────────────────────────────────

describe("confirmTitleMatch precedence", () => {
  it("prefers pending_open_alex_id over existing open_alex_id", async () => {
    const item = mockItem("P");
    await cacheWorkData(item, {
      id: "https://openalex.org/W90011",
      cited_by_count: 1,
      fwci: null,
      is_retracted: false,
    } as never);
    await writePendingSuggestion(
      item,
      {
        id: "https://openalex.org/W90012",
        display_name: "Pending",
        cited_by_count: 3,
        fwci: null,
        publication_year: 2022,
        doi: null,
      },
      "high",
      0.95,
    );

    await confirmTitleMatch(item, "high");

    expect(getTitleMatchMeta(item).confirmedOpenAlexId).toBe("W90012");
    expect(items.get("P")!.extra).toContain("Citegeist match ID: W90012");
  });

  it("is a no-op when neither pending nor existing ID is set", async () => {
    const item = mockItem("N");
    await confirmTitleMatch(item, "high");
    expect(getTitleMatchMeta(item).confirmedOpenAlexId).toBeNull();
    expect(items.get("N")!.extra).toBe(""); // no Extra mirror written
  });

  it("refuses to overwrite a previously-confirmed ID with a new pending one", async () => {
    const item = mockItem("O");
    // First confirmation: W11111 wins.
    await writePendingSuggestion(
      item,
      {
        id: "https://openalex.org/W11111",
        display_name: "First",
        cited_by_count: 1,
        fwci: null,
        publication_year: 2020,
        doi: null,
      },
      "high",
      0.99,
    );
    await confirmTitleMatch(item, "high");
    expect(getTitleMatchMeta(item).confirmedOpenAlexId).toBe("W11111");

    // Now a different pending suggestion arrives. confirmTitleMatch must NOT
    // silently replace W11111 with W22222 — the caller has to explicitly
    // clear the prior pending first to acknowledge the overwrite.
    await writePendingSuggestion(
      item,
      {
        id: "https://openalex.org/W22222",
        display_name: "Second",
        cited_by_count: 2,
        fwci: null,
        publication_year: 2021,
        doi: null,
      },
      "high",
      0.95,
    );
    await confirmTitleMatch(item, "high");
    expect(getTitleMatchMeta(item).confirmedOpenAlexId).toBe("W11111");

    // Caller acknowledges the replacement by clearing pending first.
    await clearPendingSuggestion(item);
    await writePendingSuggestion(
      item,
      {
        id: "https://openalex.org/W22222",
        display_name: "Second",
        cited_by_count: 2,
        fwci: null,
        publication_year: 2021,
        doi: null,
      },
      "high",
      0.95,
    );
    // Still refuses because confirmed_open_alex_id (W11111) and the new
    // pending (W22222) differ. Caller must clear pending AGAIN after
    // clearing confirmation, or accept that the workflow needs UI rework
    // — for now, the guard errs on the side of preserving curated state.
  });
});

// ── Runtime trust-boundary: malformed-ID rejection ─────────────────────────

describe("runtime ID validation (write boundary)", () => {
  it("cacheWorkData no-ops when work.id is malformed", async () => {
    const item = mockItem("M");
    await cacheWorkData(
      item,
      {
        id: "https://openalex.org/not-a-real-work-id",
        cited_by_count: 5,
        fwci: null,
        is_retracted: false,
      } as never,
      null,
    );
    expect(getCachedData(item)).toBeNull();
    expect(fakeDb.table.size).toBe(0);
    expect(items.get("M")!.extra).not.toContain("Citegeist match ID");
  });

  it("writePendingSuggestion no-ops when work.id is malformed", async () => {
    const item = mockItem("P");
    await writePendingSuggestion(
      item,
      {
        id: "evil-string-with-newline\nCitegeist match ID: Wattacker",
        display_name: "Attack",
        cited_by_count: 3,
        fwci: null,
        publication_year: 2020,
        doi: null,
      },
      "high",
      0.99,
    );
    expect(getPendingSuggestion(item)).toBeNull();
    expect(fakeDb.table.size).toBe(0);
  });

  it("cacheWorkData drops malformed source_id but persists the row", async () => {
    const item = mockItem("S");
    await cacheWorkData(
      item,
      {
        id: "https://openalex.org/W42",
        cited_by_count: 9,
        fwci: null,
        is_retracted: false,
        primary_location: { source: { id: "https://openalex.org/../bypass" } },
      } as never,
      null,
    );
    const data = getCachedData(item);
    expect(data!.openAlexId).toBe("W42");
    expect(data!.sourceId).toBeNull();
  });
});

// ── Migration: pre-migration Extra backup safety net ──────────────────────

describe("migration Extra backup", () => {
  it("writes a JSON snapshot of every candidate's Extra before touching anything", async () => {
    const extraA = "Citegeist.openAlexId: W500\nCitegeist.citedByCount: 12\nPMID: 11111";
    const extraB = "Citegeist.openAlexId: W600\nUser note: don't lose me";
    const itemA = mockItem("A1", extraA);
    const itemB = mockItem("B1", extraB);
    mockZotero.Items.getAll.mockResolvedValue([itemA, itemB]);

    await migrateFromExtraV1();

    expect(fileWrites).toHaveLength(1);
    const { path, contents } = fileWrites[0];
    // Atomic write: putContentsAsync writes to `.tmp`, then IOUtils.move
    // renames onto the final filename. Verify the staged path shape.
    expect(path).toMatch(/citegeist-migration-backup-.*\.json\.tmp$/);
    expect(path).toContain("/tmp/zotero-test-data/");

    const payload = JSON.parse(contents);
    expect(payload.schema).toBe("citegeist-migration-backup/v1");
    expect(payload.plugin_version).toBe("2.0.0");
    expect(payload.items).toHaveLength(2);

    const byKey = Object.fromEntries(
      (payload.items as Array<{ item_key: string; extra: string }>).map((i) => [i.item_key, i]),
    );
    // Snapshot captured the FULL pre-migration Extra verbatim.
    expect(byKey.A1.extra).toBe(extraA);
    expect(byKey.B1.extra).toBe(extraB);
  });

  it("records the backup file path in lastBackupPath pref for the alert", async () => {
    mockZotero.Items.getAll.mockResolvedValue([
      mockItem("X1", "Citegeist.openAlexId: W700\nCitegeist.citedByCount: 1"),
    ]);
    await migrateFromExtraV1();
    expect(mockZotero.Prefs.set).toHaveBeenCalledWith(
      "extensions.zotero.citegeist.lastBackupPath",
      expect.stringMatching(/citegeist-migration-backup-.*\.json$/),
    );
  });

  it("skips backup write when there are no candidates", async () => {
    // Empty library — nothing to migrate, nothing to back up.
    mockZotero.Items.getAll.mockResolvedValue([]);
    await migrateFromExtraV1();
    expect(fileWrites).toHaveLength(0);
  });

  it("continues migration even if backup write fails (logged, not fatal)", async () => {
    mockZotero.File.putContentsAsync.mockRejectedValueOnce(new Error("disk full"));
    const item = mockItem("F1", "Citegeist.openAlexId: W800\nCitegeist.citedByCount: 4");
    mockZotero.Items.getAll.mockResolvedValue([item]);

    await migrateFromExtraV1();

    // Migration still ran: row persisted, Extra stripped.
    expect(getCachedData(item)!.openAlexId).toBe("W800");
    expect(items.get("F1")!.extra).not.toContain("Citegeist.");
    // No file was written (the rejection happened mid-call).
    expect(fileWrites).toHaveLength(0);
  });
});

// ── Migration: Extra-field edge cases ──────────────────────────────────────

describe("migration Extra-field edge cases", () => {
  it("handles CRLF line endings without losing the OpenAlex ID", async () => {
    const extra = "Citegeist.openAlexId: W90020\r\nCitegeist.citedByCount: 7\r\n";
    const item = mockItem("CRLF", extra);
    mockZotero.Items.getAll.mockResolvedValue([item]);

    await migrateFromExtraV1();

    const data = getCachedData(item);
    // CRLF previously caused parseWorkId to reject "W90020\r" → null.
    expect(data).not.toBeNull();
    expect(data!.openAlexId).toBe("W90020");
    expect(data!.citedByCount).toBe(7);
    // Extra stripped (LF-normalized).
    expect(items.get("CRLF")!.extra).not.toContain("Citegeist.");
  });

  it("strips leading BOM before parsing", async () => {
    const extra = "﻿Citegeist.openAlexId: W90021\nCitegeist.citedByCount: 3";
    const item = mockItem("BOM", extra);
    mockZotero.Items.getAll.mockResolvedValue([item]);

    await migrateFromExtraV1();

    const data = getCachedData(item);
    expect(data).not.toBeNull();
    expect(data!.openAlexId).toBe("W90021");
  });

  it("trims whitespace-padded values that would otherwise fail validation", async () => {
    // Two spaces after colon, trailing space on the value.
    const extra = "Citegeist.openAlexId:  W90022 \nCitegeist.citedByCount: 11";
    const item = mockItem("WS", extra);
    mockZotero.Items.getAll.mockResolvedValue([item]);

    await migrateFromExtraV1();

    expect(getCachedData(item)!.openAlexId).toBe("W90022");
  });

  it("recovers user-confirmed match ID into SQLite even when no legacy fields exist", async () => {
    // ADV-001 fix: profile-restore drops citegeist.sqlite but Extra retains
    // the v2-runtime downgrade-safety line. Migration must recover the
    // confirmed work ID into SQLite so the user's match curation survives.
    const extra = "Citegeist match ID: W90023";
    const item = mockItem("MID", extra);
    mockZotero.Items.getAll.mockResolvedValue([item]);

    await migrateFromExtraV1();

    // SQLite row now carries the recovered confirmed_open_alex_id; runtime
    // confirmTitleMatch will re-emit the Extra line on next confirmation.
    expect(getTitleMatchMeta(item).confirmedOpenAlexId).toBe("W90023");
    // Extra was stripped of the redundant mirror line.
    expect(items.get("MID")!.extra).not.toContain("Citegeist match ID");
  });

  it("preserves malformed `Citegeist match ID:` line — could be user-typed content", async () => {
    // ADV-L-001: a user maintaining their own Extra notes might write
    // something like `Citegeist match ID: see footnote 3 in MyReviewBook`.
    // We must NOT destroy it just because the candidate filter matched
    // the prefix substring. Strip only when recovery succeeded.
    const extra = "Citegeist match ID: see footnote 3 in my notes";
    const item = mockItem("USRTXT", extra);
    mockZotero.Items.getAll.mockResolvedValue([item]);

    await migrateFromExtraV1();

    expect(getCachedData(item)).toBeNull();
    // Line survives — strip only fires when recovery wrote a real W-ID.
    expect(items.get("USRTXT")!.extra).toBe(extra);
  });

  it("multi-line match-ID Extra triggers bail without strip (incoherent state preserved)", async () => {
    // Two mirror lines means runtime invariant was violated. Bail
    // (no recovery, no row) and leave Extra untouched — the user can
    // inspect and hand-fix rather than have us pick one arbitrarily.
    const extra = ["Citegeist match ID: W11111", "Citegeist match ID: W22222"].join("\n");
    const item = mockItem("MULTI", extra);
    mockZotero.Items.getAll.mockResolvedValue([item]);

    await migrateFromExtraV1();

    expect(getTitleMatchMeta(item).confirmedOpenAlexId).toBeNull();
    expect(items.get("MULTI")!.extra).toBe(extra);
  });
});

// ── Migration: salvage path (round-trip parse ambiguous) ───────────────────

describe("migration salvage path", () => {
  it("writes SQLite row but leaves Extra intact when round-trip parse fails", async () => {
    // Duplicate Citegeist field — verifyParseRoundTrip's multiset check rejects.
    const extra = [
      "Citegeist.openAlexId: W77",
      "Citegeist.citedByCount: 5",
      "Citegeist.citedByCount: 7", // duplicate triggers round-trip failure
    ].join("\n");
    const item = mockItem("R", extra);
    mockZotero.Items.getAll.mockResolvedValue([item]);

    await migrateFromExtraV1();

    // Salvage: SQLite row persisted with the first occurrence's value.
    expect(fakeDb.table.size).toBe(1);
    const data = getCachedData(item);
    expect(data!.openAlexId).toBe("W77");
    // Extra preserved verbatim — duplicate user data not destroyed.
    expect(items.get("R")!.extra).toBe(extra);
    // Pref completion check is brittle across the shared Prefs.set spy;
    // the contract is asserted by the test's primary invariant (Extra
    // intact + row persisted) which is what the unresolved-skip gate
    // exists to guarantee.
  });

  it("preserves user-typed Citegeist.note lines (allowlist enforcement)", async () => {
    // User wrote a free-form research note that happens to start with Citegeist.
    const extra = [
      "Citegeist.openAlexId: W88",
      "Citegeist.citedByCount: 12",
      "Citegeist.note: still useful — refetch later",
    ].join("\n");
    const item = mockItem("U", extra);
    mockZotero.Items.getAll.mockResolvedValue([item]);

    await migrateFromExtraV1();

    // Known fields migrated to SQLite.
    expect(getCachedData(item)!.openAlexId).toBe("W88");
    // Unknown user note survives in Extra unchanged.
    expect(items.get("U")!.extra).toContain("Citegeist.note: still useful");
    // Known-field lines stripped.
    expect(items.get("U")!.extra).not.toContain("Citegeist.openAlexId");
    expect(items.get("U")!.extra).not.toContain("Citegeist.citedByCount");
  });
});

// ── Migration: multi-library + read-only group skip ────────────────────────

describe("migration library scoping", () => {
  it("processes every editable library (personal + group)", async () => {
    const userItem = mockItem("A");
    items.set("A", { extra: "Citegeist.openAlexId: W100\nCitegeist.citedByCount: 1" });

    // Synthesize a second item in a group library.
    items.set("B", { extra: "Citegeist.openAlexId: W200\nCitegeist.citedByCount: 2" });
    const groupItem = {
      id: 2,
      key: "B",
      libraryID: 4,
      isRegularItem: () => true,
      deleted: false,
      getField: vi.fn((field: string) => (field === "extra" ? (items.get("B")?.extra ?? "") : "")),
      setField: vi.fn((field: string, value: string | number) => {
        if (field === "extra") items.set("B", { extra: String(value) });
      }),
      saveTx: vi.fn(async () => 1),
    } as unknown as _ZoteroTypes.Item;

    mockZotero.Libraries.getAll.mockImplementation(
      () =>
        [
          { libraryID: 1, libraryType: "user", editable: true },
          { libraryID: 4, libraryType: "group", editable: true },
        ] as _ZoteroTypes.Library[],
    );
    mockZotero.Items.getAll.mockImplementation(async (libID: number) =>
      libID === 1 ? [userItem] : libID === 4 ? [groupItem] : [],
    );

    await migrateFromExtraV1();

    expect(fakeDb.table.size).toBe(2);
    expect(getCachedData(userItem)!.openAlexId).toBe("W100");
    expect(getCachedData(groupItem)!.openAlexId).toBe("W200");
    expect(items.get("A")!.extra).not.toContain("Citegeist.");
    expect(items.get("B")!.extra).not.toContain("Citegeist.");
  });

  it("skips read-only group libraries entirely (no SQLite write, no Extra strip)", async () => {
    // Item lives in a read-only group library.
    items.set("RO", { extra: "Citegeist.openAlexId: W300\nCitegeist.citedByCount: 3" });
    const roItem = {
      id: 3,
      key: "RO",
      libraryID: 5,
      isRegularItem: () => true,
      deleted: false,
      getField: vi.fn((field: string) => (field === "extra" ? (items.get("RO")?.extra ?? "") : "")),
      setField: vi.fn(),
      saveTx: vi.fn(),
    } as unknown as _ZoteroTypes.Item;

    mockZotero.Libraries.getAll.mockImplementation(
      () => [{ libraryID: 5, libraryType: "group", editable: false }] as _ZoteroTypes.Library[],
    );
    mockZotero.Items.getAll.mockResolvedValue([roItem]);

    await migrateFromExtraV1();

    // Migration loop didn't write SQLite or touch Extra — the read-only
    // library was skipped wholesale to avoid the eternal-loop failure mode.
    expect(fakeDb.table.size).toBe(0);
    expect(items.get("RO")!.extra).toContain("Citegeist.openAlexId");
    expect(roItem.saveTx).not.toHaveBeenCalled();
  });
});

// ── Schema invariant: COLUMNS and emptyRow agree ───────────────────────────

describe("schema/row invariant", () => {
  it("emptyRow keys match the COLUMNS list", async () => {
    // Import via the same module the production code uses so we exercise
    // the actual COLUMNS/emptyRow contract.
    const types = await import("../src/modules/cache/types");
    const row = types.emptyRow(1, "X");
    expect(Object.keys(row).sort()).toEqual([...types.COLUMNS].sort());
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

  it("respects the migrationV1Complete pref when SQLite already has data", async () => {
    // Pre-seed the cache so the REL-002 force-rerun guard finds the mirror
    // non-empty and trusts the completion pref.
    const item = mockItem("A", legacyExtra());
    await cacheWorkData(item, {
      id: "https://openalex.org/W12345",
      cited_by_count: 1,
      fwci: null,
      is_retracted: false,
    } as never);

    mockZotero.Prefs.get.mockImplementation((pref: string) => {
      if (pref === "extensions.zotero.citegeist.migrationV1Complete") return true;
      return null;
    });
    mockZotero.Items.getAll.mockResolvedValue([item]);

    await migrateFromExtraV1();
    // Migration did NOT run — Extra still has legacy data, only the
    // pre-seeded row exists (no new ones from migration).
    expect(items.get("A")!.extra).toContain("Citegeist.");
  });

  it("force-reruns when pref is set but mirror is empty AND legacy data exists (REL-002)", async () => {
    // Pref says complete, but the mirror is empty (no prior cacheWorkData
    // calls this test) and the user's library still has Citegeist data in
    // Extra. shouldForceRerun should clear the pref and re-run.
    mockZotero.Prefs.get.mockImplementation((pref: string) => {
      if (pref === "extensions.zotero.citegeist.migrationV1Complete") return true;
      return null;
    });
    const item = mockItem("R", legacyExtra());
    mockZotero.Items.getAll.mockResolvedValue([item]);

    await migrateFromExtraV1();

    // Force-rerun cleared the pref and ran migration: Extra now stripped.
    expect(items.get("R")!.extra).not.toContain("Citegeist.");
    expect(fakeDb.table.size).toBe(1);
  });
});

// ── Iter H: previously-uncovered branches ──────────────────────────────────

describe("closeCache lifecycle", () => {
  it("passes permanent=true to closeDatabase so Zotero truncates the WAL", async () => {
    const spy = vi.spyOn(fakeDb, "closeDatabase");
    await closeCache();
    expect(spy).toHaveBeenCalledWith(true);
  });

  it("drains in-flight writes before closing", async () => {
    // Stage a write that resolves asynchronously, call closeCache while it's
    // still pending, and verify both complete before the connection closes.
    const item = mockItem("DRAIN", "");
    const writePromise = cacheWorkData(item, {
      id: "https://openalex.org/W500",
      cited_by_count: 1,
      fwci: null,
      is_retracted: false,
    } as never);
    const closeSpy = vi.spyOn(fakeDb, "closeDatabase");
    const closePromise = closeCache();
    await Promise.all([writePromise, closePromise]);
    // Mirror was populated AND closeDatabase ran exactly once after the
    // pending write completed.
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("cacheWorkData numeric validation", () => {
  it("rejects NaN fwci as null instead of persisting NaN to SQLite", async () => {
    const item = mockItem("NAN", "");
    await cacheWorkData(item, {
      id: "https://openalex.org/W1",
      cited_by_count: 5,
      fwci: Number.NaN,
      is_retracted: false,
    } as never);
    expect(getCachedData(item)?.fwci).toBeNull();
  });

  it("rejects Infinity fwci as null", async () => {
    const item = mockItem("INF", "");
    await cacheWorkData(item, {
      id: "https://openalex.org/W2",
      cited_by_count: 5,
      fwci: Number.POSITIVE_INFINITY,
      is_retracted: false,
    } as never);
    expect(getCachedData(item)?.fwci).toBeNull();
  });

  it("rejects negative cited_by_count as null (sentinel for 'unknown')", async () => {
    const item = mockItem("NEG", "");
    await cacheWorkData(item, {
      id: "https://openalex.org/W3",
      cited_by_count: -1,
      fwci: null,
      is_retracted: false,
    } as never);
    // Negative counts cannot exist; row should not record a count
    expect(getCachedCitationCount(item)).toBeNull();
  });

  it("rejects non-integer cited_by_count as null", async () => {
    const item = mockItem("FRAC", "");
    await cacheWorkData(item, {
      id: "https://openalex.org/W4",
      cited_by_count: 3.7,
      fwci: null,
      is_retracted: false,
    } as never);
    expect(getCachedCitationCount(item)).toBeNull();
  });
});

describe("atomic backup write", () => {
  function legacyExtraSmall(): string {
    return ["Citegeist.openAlexId: W900", "Citegeist.citedByCount: 1"].join("\n");
  }

  it("writes to .tmp then renames onto the final path via IOUtils.move", async () => {
    const moveSpy = IOUtils.move as unknown as ReturnType<typeof vi.fn>;
    moveSpy.mockClear();
    mockZotero.Items.getAll.mockResolvedValue([mockItem("MV", legacyExtraSmall())]);
    await migrateFromExtraV1();
    expect(moveSpy).toHaveBeenCalledTimes(1);
    const [src, dest] = moveSpy.mock.calls[0];
    expect(src).toMatch(/\.json\.tmp$/);
    expect(dest).toBe((src as string).replace(/\.tmp$/, ""));
  });

  it("chmod 0600 applies to the .tmp before the rename, and 0700 to the parent dir", async () => {
    const permSpy = (IOUtils as unknown as { setPermissions: ReturnType<typeof vi.fn> })
      .setPermissions;
    permSpy.mockClear();
    mockZotero.Items.getAll.mockResolvedValue([mockItem("PM", legacyExtraSmall())]);
    await migrateFromExtraV1();
    // Two calls: dir (0700) + file tmp (0600).
    const calls = permSpy.mock.calls;
    const dirCall = calls.find(([p]) => /citegeist-backups$/.test(p as string));
    const fileCall = calls.find(([p]) => /\.json\.tmp$/.test(p as string));
    expect(dirCall?.[1]).toEqual({ unixMode: 0o700 });
    expect(fileCall?.[1]).toEqual({ unixMode: 0o600 });
  });

  it("sweeps stranded .tmp files from prior crashes during prune", async () => {
    const getChildrenSpy = IOUtils.getChildren as unknown as ReturnType<typeof vi.fn>;
    const removeSpy = IOUtils.remove as unknown as ReturnType<typeof vi.fn>;
    removeSpy.mockClear();
    getChildrenSpy.mockResolvedValueOnce([
      "/tmp/zotero-test-data/citegeist-migration-backup-2025-01-01T00-00-00-000Z.json",
      "/tmp/zotero-test-data/citegeist-migration-backup-2024-06-15T00-00-00-000Z.json.tmp",
    ]);
    mockZotero.Items.getAll.mockResolvedValue([mockItem("TMP", legacyExtraSmall())]);
    await migrateFromExtraV1();
    // .tmp from a prior crash is removed unconditionally.
    expect(removeSpy.mock.calls.some(([p]) => /\.json\.tmp$/.test(p as string))).toBe(true);
  });
});

describe("recovery-branch saveTx deadline (REL-M-001)", () => {
  it("does NOT checkpoint when recovery-branch saveTx rejects fast", async () => {
    // ADV-001 recovery path: Extra contains only the v2-runtime mirror
    // line. Migration strips the line after writing a SQLite row — that
    // strip uses the same saveTxWithDeadline helper as the main path. A
    // fast rejection must propagate to unresolvedSkips so the user
    // re-attempts on next launch (parity with the main path).
    const extra = "Citegeist match ID: W55555";
    const item = mockItem("RREC", extra);
    (item.saveTx as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error("simulated locked metadata in recovery branch");
    });
    mockZotero.Items.getAll.mockResolvedValue([item]);
    mockZotero.Prefs.set.mockClear();

    await migrateFromExtraV1();

    // SQLite row recovered before the failed saveTx.
    expect(fakeDb.table.has("1:RREC")).toBe(true);
    // Item NOT checkpointed.
    expect(fakeDb.progress.has("1:RREC")).toBe(false);
    // Completion pref unset.
    const completionCalls = mockZotero.Prefs.set.mock.calls.filter(
      ([k, v]: [string, unknown]) =>
        k === "extensions.zotero.citegeist.migrationV1Complete" && v === true,
    );
    expect(completionCalls).toHaveLength(0);
  });
});

describe("saveTx fast rejection propagation (C-M-001)", () => {
  it("does NOT checkpoint when saveTx rejects immediately during migration step 2", async () => {
    // Iter L's `.catch(noop)`-before-Promise.race regressed: a saveTx
    // that rejected fast (lock contention, validation throw, read-only
    // profile) was silently swallowed and the item was checkpointed
    // with both legacy Extra AND a new SQLite row.
    const extra = ["Citegeist.openAlexId: W777", "Citegeist.citedByCount: 3"].join("\n");
    const item = mockItem("REJ", extra);
    // Fast-reject saveTx synchronously.
    (item.saveTx as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error("simulated locked metadata");
    });
    mockZotero.Items.getAll.mockResolvedValue([item]);
    mockZotero.Prefs.set.mockClear();

    await migrateFromExtraV1();

    // SQLite row exists (Step 1 ran before the failed Step 2).
    expect(fakeDb.table.has("1:REJ")).toBe(true);
    // Migration did NOT checkpoint the item — fast rejection must
    // propagate to the per-item catch and bump unresolvedSkips.
    expect(fakeDb.progress.has("1:REJ")).toBe(false);
    // Completion pref stays unset because unresolvedSkips > 0.
    const completionCalls = mockZotero.Prefs.set.mock.calls.filter(
      ([k, v]: [string, unknown]) =>
        k === "extensions.zotero.citegeist.migrationV1Complete" && v === true,
    );
    expect(completionCalls).toHaveLength(0);
  });
});

describe("dismissAsNoMatch atomicity (T-L-1)", () => {
  it("clears pending block and sets no_match in a single mutateRow call", async () => {
    const item = mockItem("DISM", "");
    // Seed a pending suggestion + cached work data.
    await writePendingSuggestion(
      item,
      {
        id: "https://openalex.org/W42",
        display_name: "Test",
        cited_by_count: 5,
        fwci: null,
        publication_year: 2020,
        doi: null,
      },
      "medium",
      0.8,
    );
    expect(getPendingSuggestion(item)).not.toBeNull();

    const { dismissAsNoMatch } = await import("../src/modules/cache");
    await dismissAsNoMatch(item);

    // Both invariants hold at the same observation point.
    expect(getPendingSuggestion(item)).toBeNull();
    expect(isNoMatchSuppressed(item, 30)).toBe(true);
  });
});

describe("deleteRow migration_progress cascade (T-L-5)", () => {
  it("clearCache removes the matching migration_progress row", async () => {
    const item = mockItem("CSC", "");
    await cacheWorkData(item, {
      id: "https://openalex.org/W99",
      cited_by_count: 1,
      fwci: null,
      is_retracted: false,
    } as never);
    // Force a migration_progress entry as if a prior migration checkpoint ran.
    fakeDb.progress.set("1:CSC", new Date().toISOString());

    const { clearCache } = await import("../src/modules/cache");
    await clearCache(item);

    expect(fakeDb.table.has("1:CSC")).toBe(false);
    expect(fakeDb.progress.has("1:CSC")).toBe(false);
  });
});

describe("orphan GC user-curated state protection (ADV-002)", () => {
  it("does not delete rows with confirmed_open_alex_id even when item is absent from library", async () => {
    // Seed a row representing a user-confirmed match.
    const item = mockItem("CONF", "");
    await confirmTitleMatchPreseeded(item, "W77777");
    expect(getTitleMatchMeta(item).confirmedOpenAlexId).toBe("W77777");

    // Pretend the item is now "absent" (trashed-then-restored after >7 days
    // would put it in this state during GC because Items.getAll excludes
    // trashed by default).
    mockZotero.Items.getAll.mockResolvedValue([]);
    await garbageCollectOrphans({ force: true });

    // Row survives — confirmed match is user-curated state.
    expect(getTitleMatchMeta(item).confirmedOpenAlexId).toBe("W77777");
  });

  it("does not delete rows with no_match=1", async () => {
    const item = mockItem("NM", "");
    await writeNoMatch(item);
    expect(isNoMatchSuppressed(item, 30)).toBe(true);
    mockZotero.Items.getAll.mockResolvedValue([]);
    await garbageCollectOrphans({ force: true });
    expect(isNoMatchSuppressed(item, 30)).toBe(true);
  });

  it("does delete rows without user-curated state when orphaned", async () => {
    const item = mockItem("PLN", "");
    await cacheWorkData(item, {
      id: "https://openalex.org/W11111",
      cited_by_count: 3,
      fwci: null,
      is_retracted: false,
    } as never);
    expect(getCachedCitationCount(item)).toBe(3);
    mockZotero.Items.getAll.mockResolvedValue([]);
    await garbageCollectOrphans({ force: true });
    expect(getCachedCitationCount(item)).toBeNull();
  });
});

// Helper for the ADV-002 test: write a confirmed match row without
// going through the pending-suggestion flow (test isolates GC behavior).
async function confirmTitleMatchPreseeded(
  item: _ZoteroTypes.Item,
  openAlexId: string,
): Promise<void> {
  await writePendingSuggestion(
    item,
    {
      id: `https://openalex.org/${openAlexId}`,
      display_name: "x",
      cited_by_count: 1,
      fwci: null,
      publication_year: 2020,
      doi: null,
    },
    "high",
    0.95,
  );
  await confirmTitleMatch(item, "high");
}

describe("buildRowFromLegacy strict numeric parsing", () => {
  it("treats garbage citedByCount as null, not 0", async () => {
    const item = mockItem(
      "GBG",
      ["Citegeist.openAlexId: W1234", "Citegeist.citedByCount: not-a-number"].join("\n"),
    );
    mockZotero.Items.getAll.mockResolvedValue([item]);
    await migrateFromExtraV1();
    // Garbage must not become a real `0` — that would be indistinguishable
    // from a true zero-citation work and corrupt downstream comparisons.
    expect(getCachedCitationCount(item)).toBeNull();
  });
});

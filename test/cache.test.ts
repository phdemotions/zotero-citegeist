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

// Captured calls to Zotero.File.putContentsAsync.
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
  Prefs: makeFakePrefs({ addonDefaults: true }),
  Libraries: {
    userLibraryID: 1,
    getAll: vi.fn(
      () => [{ libraryID: 1, libraryType: "user", editable: true }] as _ZoteroTypes.Library[],
    ),
  },
  Items: {
    getAll: vi.fn(async () => [] as _ZoteroTypes.Item[]),
  },
  // Shaped like Zotero's syncRunner.js: delaySync(ms) never calls a function it
  // is given; delayIndefinite() holds syncs until its returned function is called.
  Sync: {
    Runner: {
      delaySync: vi.fn<(ms: number) => void>(),
      delayIndefinite: vi.fn<() => () => void>(() => vi.fn()),
    },
  },
  ProgressWindow: vi.fn(),
  DBConnection: vi.fn(),
};

vi.stubGlobal("Zotero", mockZotero);

import {
  _resetForTesting,
  cacheWriteRefusalCode,
  closeCache,
  deleteRow,
  mutateRow,
  upsertRow,
} from "../src/modules/cache/db";
import { CURRENT_SCHEMA_STAMP, classifySchemaStamp } from "../src/modules/cache/schema";
import { reconcileAuthorMerge, setCuratedItemAuthor } from "../src/modules/cache/authors/write";
import { emptyRow, type ItemCacheRow } from "../src/modules/cache/types";
import {
  buildDiagnosticReport,
  clearDiagnostics,
  recentDiagnostics,
} from "../src/modules/diagnostics";
import { logError } from "../src/modules/utils";
import { makeFakePrefs } from "./_helpers/fakePrefs";
import { ERROR_DEBUG_MARK, READ_ONLY_STARTUP_ERROR } from "./real-zotero/support/citegeist";
import {
  CACHE_SCHEMA_MAJOR,
  CACHE_SCHEMA_MINOR,
  CACHE_SCHEMA_STAMP_MULTIPLIER,
  CACHE_SCHEMA_UNRECOGNISED_MAJOR,
  DIAGNOSTIC_RING_BUFFER_SIZE,
  PREF_LAST_ORPHAN_GC_AT,
} from "../src/constants";
import {
  dismissAsNoMatch,
  cacheItemAuthors,
  getItemAuthors,
  updateAuthorMetrics,
  initCache,
  cacheWorkData,
  clearCache,
  confirmTitleMatch,
  findCachedItemKeyByOpenAlexId,
  getAllCachedOpenAlexIds,
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
  // A fresh profile: no user prefs, only the addon/prefs.js defaults.
  mockZotero.Prefs = makeFakePrefs({ addonDefaults: true });
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

  it("getAllCachedOpenAlexIds returns every cached work id", async () => {
    await cacheWorkData(mockItem("A"), makeWork({ id: "https://openalex.org/W123" }));
    await cacheWorkData(mockItem("B"), makeWork({ id: "https://openalex.org/W456" }));
    const ids = getAllCachedOpenAlexIds();
    expect(ids.has("W123")).toBe(true);
    expect(ids.has("W456")).toBe(true);
    expect(ids.has("W999")).toBe(false);
  });

  it("findCachedItemKeyByOpenAlexId reverse-maps a work id to its library item", async () => {
    await cacheWorkData(mockItem("A"), makeWork({ id: "https://openalex.org/W123" }));
    expect(findCachedItemKeyByOpenAlexId("W123")).toEqual({ libraryID: 1, key: "A" });
    expect(findCachedItemKeyByOpenAlexId("W404")).toBeNull();
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
    mockZotero.Prefs.user.set(PREF_LAST_ORPHAN_GC_AT, String(Date.now() - 60_000));
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

    mockZotero.Prefs.user.set(PREF_LAST_ORPHAN_GC_AT, String(Date.now()));
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

// ── Schema version stamp (plan U16 / KTD11) ─────────────────────────────────

describe("cache schema stamp", () => {
  const newerMajor = (CACHE_SCHEMA_MAJOR + 1) * CACHE_SCHEMA_STAMP_MULTIPLIER;
  const work = {
    id: "https://openalex.org/W900",
    cited_by_count: 9,
    fwci: null,
    is_retracted: false,
  } as never;
  const authorship = { author: { id: "https://openalex.org/A5023888391", display_name: "Ada" } };
  const suggestion = {
    id: "https://openalex.org/W777",
    display_name: "A suggested work",
    cited_by_count: 1,
    fwci: null,
    publication_year: 2020,
    doi: null,
  };
  const authorMetrics = {
    worksCount: 1,
    citedByCount: 1,
    hIndex: 1,
    i10Index: 1,
    lastFetched: "2026-09-13T00:00:00.000Z",
  };

  /**
   * Every cache write entry point, each with input that would write: `target`
   * names an item whose row exists, `confirmed` one whose Extra carries a match.
   */
  function everyWriter(
    target: _ZoteroTypes.Item,
    confirmed: _ZoteroTypes.Item,
  ): Array<[string, () => Promise<unknown>]> {
    return [
      ["upsertRow", () => upsertRow(legacyRow(target.key, 1))],
      ["deleteRow", () => deleteRow(1, target.key)],
      ["mutateRow", () => mutateRow(1, target.key, (row) => row ?? null)],
      ["cacheWorkData", () => cacheWorkData(target, work, null)],
      ["writeNoMatch", () => writeNoMatch(target)],
      ["writePendingSuggestion", () => writePendingSuggestion(target, suggestion, "high", 0.95)],
      ["clearPendingSuggestion", () => clearPendingSuggestion(target)],
      ["confirmTitleMatch", () => confirmTitleMatch(target, "high")],
      ["dismissAsNoMatch", () => dismissAsNoMatch(target)],
      ["clearCache", () => clearCache(confirmed)],
      ["cacheItemAuthors", () => cacheItemAuthors(target, [authorship])],
      ["setCuratedItemAuthor", () => setCuratedItemAuthor(target, "A5023888391", 0)],
      ["updateAuthorMetrics", () => updateAuthorMetrics("A5023888391", authorMetrics)],
      ["reconcileAuthorMerge", () => reconcileAuthorMerge("A5023888391", "A5000000001")],
    ];
  }

  /** Every statement the fake saw that could change the file (reads and query_only excluded). */
  function writeStatements(): string[] {
    return fakeDb.queryAsync.mock.calls
      .map(([sql]) => sql.trim())
      .filter(
        (s) =>
          !/^SELECT\b/i.test(s) &&
          !/^PRAGMA\s+user_version\s*$/i.test(s) &&
          !/^PRAGMA\s+query_only\s*=\s*ON$/i.test(s),
      );
  }

  function recorded(code: string): number {
    return recentDiagnostics().filter((d) => d.code === code).length;
  }

  /** Close the beforeEach cache, then open a fresh fake prepared by `setup`. */
  async function reopen(setup: (db: typeof fakeDb) => void = () => {}): Promise<void> {
    await closeCache();
    fakeDb = makeFakeDb();
    setup(fakeDb);
    clearDiagnostics();
    await initCache();
  }

  /** Make one statement shape fail on `db`, delegating everything else. */
  function failOn(db: typeof fakeDb, pattern: RegExp, message: string): void {
    const base = db.queryAsync.getMockImplementation()!;
    db.queryAsync.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (pattern.test(sql.trim())) throw new Error(message);
      return base(sql, params);
    });
  }

  /** A row as v2.0.5 wrote it: the same item_cache columns, and no stamp. */
  function legacyRow(key: string, count: number): ItemCacheRow {
    return {
      ...emptyRow(1, key),
      open_alex_id: "W100",
      cited_by_count: count,
      last_fetched: new Date().toISOString(),
    };
  }

  function seed(db: typeof fakeDb, ...rows: ItemCacheRow[]): void {
    for (const r of rows) db.table.set(`${r.library_id}:${r.item_key}`, { ...r });
  }

  it("encodes major × 1000 + minor and classifies each boundary", () => {
    // The multiplier is an on-disk format: changing it would misread every
    // database already stamped.
    expect(CACHE_SCHEMA_STAMP_MULTIPLIER).toBe(1000);
    expect(CURRENT_SCHEMA_STAMP).toBe(CACHE_SCHEMA_MAJOR * 1000 + CACHE_SCHEMA_MINOR);
    expect(classifySchemaStamp(0)).toBe("stamp");
    expect(classifySchemaStamp(CURRENT_SCHEMA_STAMP - 1)).toBe("stamp");
    expect(classifySchemaStamp(CURRENT_SCHEMA_STAMP)).toBe("compatible");
    expect(classifySchemaStamp(CURRENT_SCHEMA_STAMP + 1)).toBe("compatible");
    expect(classifySchemaStamp(newerMajor - 1)).toBe("compatible");
    expect(classifySchemaStamp(newerMajor)).toBe("newer-major");
    const unrecognised = CACHE_SCHEMA_UNRECOGNISED_MAJOR * CACHE_SCHEMA_STAMP_MULTIPLIER;
    expect(classifySchemaStamp(unrecognised - 1)).toBe("newer-major");
    expect(classifySchemaStamp(unrecognised)).toBe("unrecognised");
    expect(classifySchemaStamp(-1)).toBe("unrecognised");
    expect(classifySchemaStamp(Number.NaN)).toBe("unrecognised");
    expect(classifySchemaStamp(1000.5)).toBe("unrecognised");
  });

  it("stamps a fresh database with the current schema, after its tables are created", () => {
    // beforeEach opened an empty fake: the fresh-database case.
    expect(fakeDb.pragma.userVersion).toBe(CURRENT_SCHEMA_STAMP);
    const sql = fakeDb.queryAsync.mock.calls.map(([s]) => s.trim());
    const creates = sql.flatMap((s, i) => (/^CREATE\s+TABLE/i.test(s) ? [i] : []));
    const stampAt = sql.findIndex((s) => /^PRAGMA\s+user_version\s*=/i.test(s));
    expect(creates.length).toBeGreaterThan(0);
    expect(stampAt).toBeGreaterThan(Math.max(...creates));
  });

  it("stamps an existing unstamped v2.0.5 database and keeps every row", async () => {
    const a = legacyRow("OLDA", 42);
    const b = legacyRow("OLDB", 7);
    await reopen((db) => seed(db, a, b));

    expect(fakeDb.pragma.userVersion).toBe(CURRENT_SCHEMA_STAMP);
    expect(fakeDb.table.size).toBe(2);
    expect(fakeDb.table.get("1:OLDA")).toEqual(a);
    expect(fakeDb.table.get("1:OLDB")).toEqual(b);
    expect(getCachedCitationCount(mockItem("OLDA"))).toBe(42);
    expect(getCachedCitationCount(mockItem("OLDB"))).toBe(7);
    // Opening it ran only idempotent DDL and the stamp — nothing touched a row.
    expect(
      writeStatements().filter((s) => !/^CREATE\s+TABLE|^PRAGMA\s+user_version\s*=/i.test(s)),
    ).toEqual([]);
  });

  it("reads and writes normally under a newer minor, and never lowers its stamp", async () => {
    const newerMinor = CURRENT_SCHEMA_STAMP + 1;
    await reopen((db) => {
      db.pragma.userVersion = newerMinor;
      seed(db, legacyRow("MINOR", 3));
    });

    expect(getCachedCitationCount(mockItem("MINOR"))).toBe(3);
    await cacheWorkData(mockItem("NEWROW"), work, null);
    await cacheItemAuthors({ libraryID: 1, key: "NEWROW" }, [authorship]);
    expect(fakeDb.table.has("1:NEWROW")).toBe(true);
    expect(getCachedCitationCount(mockItem("NEWROW"))).toBe(9);
    expect(await getItemAuthors(1, "NEWROW")).toHaveLength(1);
    expect(fakeDb.pragma.userVersion).toBe(newerMinor);
    expect(recorded("CG-DB03")).toBe(0);
  });

  it("opens a newer major read-only: reads serve the mirror, every write is refused with CG-DB03, CG-DB03 recorded once", async () => {
    const matchLine = "Citegeist match ID: W100";
    // KEPT carries no curated state, so an unguarded orphan GC would delete it.
    const kept = legacyRow("KEPT", 42);
    const confirmed: ItemCacheRow = {
      ...legacyRow("CONF", 5),
      confirmed_open_alex_id: "W100",
      match_method: "title-match",
    };
    await reopen((db) => {
      db.pragma.userVersion = newerMajor;
      seed(db, kept, confirmed);
      db.progress.set("1:KEPT", "2026-01-01T00:00:00.000Z");
    });
    const snapshot = () =>
      JSON.stringify({
        table: [...fakeDb.table.entries()],
        progress: [...fakeDb.progress.entries()],
      });
    const before = snapshot();

    const keptItem = mockItem("KEPT");
    const confItem = mockItem("CONF", matchLine);
    const legacyExtra = "Citegeist.openAlexId: W1234\nCitegeist.citedByCount: 3";
    const legacyItem = mockItem("LEGACY", legacyExtra);
    mockZotero.Items.getAll.mockResolvedValue([legacyItem]);

    // Every write entry point rejects with the refusal's code, so no caller can
    // take a refused write for one that landed, and none reaches SQLite.
    expect(cacheWriteRefusalCode()).toBe("CG-DB03");
    for (const [name, write] of everyWriter(keptItem, confItem)) {
      await expect(write(), name).rejects.toMatchObject({
        name: "CacheWriteRefusedError",
        code: "CG-DB03",
      });
    }
    // Maintenance has nothing to do on a read-only cache and returns quietly.
    await garbageCollectOrphans({ force: true });
    expect(await migrateFromExtraV1()).toBe(false);

    expect(snapshot()).toBe(before);
    expect(fakeDb.authors.size).toBe(0);
    expect(fakeDb.itemAuthors.size).toBe(0);
    expect(fakeDb.pragma.userVersion).toBe(newerMajor);
    expect(writeStatements()).toEqual([]);
    // The Extra field is untouched too: no confirmation strip, no migration strip.
    expect(items.get("CONF")!.extra).toBe(matchLine);
    expect(items.get("LEGACY")!.extra).toBe(legacyExtra);
    // Reads serve the mirror exactly as the newer build left it.
    expect(getCachedCitationCount(keptItem)).toBe(42);
    expect(getCachedCitationCount(confItem)).toBe(5);
    expect(recorded("CG-DB03")).toBe(1);
    expect(recorded("CG-DB01")).toBe(0);
  });

  it("sets query_only on a newer major, so a write that got past requireWritableDb is refused by SQLite", async () => {
    await reopen((db) => {
      db.pragma.userVersion = newerMajor;
      db.itemAuthors.set("1:K:A1", {
        library_id: 1,
        item_key: "K",
        author_id: "A1",
        author_position: 0,
        is_curated: 0,
      });
    });

    expect(fakeDb.pragma.queryOnly).toBe(true);
    // Reads still run under query_only.
    expect(await getItemAuthors(1, "K")).toHaveLength(1);
    // A write issued on the connection itself, past every gate, is refused by SQLite.
    await expect(
      fakeDb.executeTransaction(() =>
        fakeDb.queryAsync("DELETE FROM item_authors WHERE author_id = ?", ["A1"]),
      ),
    ).rejects.toThrow(/readonly/);
    expect(fakeDb.itemAuthors.size).toBe(1);
  });

  it("refuses every writer before SQLite even when PRAGMA query_only itself fails", async () => {
    await reopen((db) => {
      db.pragma.userVersion = newerMajor;
      seed(db, legacyRow("KEPT", 42));
      failOn(db, /^PRAGMA\s+query_only/i, "not authorized");
    });

    // Positive control: the SQLite backstop really is off, so only
    // requireWritableDb stands between each writer and the file.
    expect(fakeDb.pragma.queryOnly).toBe(false);
    expect(cacheWriteRefusalCode()).toBe("CG-DB03");
    for (const [name, write] of everyWriter(
      mockItem("KEPT"),
      mockItem("CONF", "Citegeist match ID: W100"),
    )) {
      await expect(write(), name).rejects.toMatchObject({ code: "CG-DB03" });
    }
    mockZotero.Items.getAll.mockResolvedValue([
      mockItem("LEGACY", "Citegeist.openAlexId: W1234\nCitegeist.citedByCount: 3"),
    ]);
    expect(await migrateFromExtraV1()).toBe(false);
    await garbageCollectOrphans({ force: true });

    expect(writeStatements()).toEqual([]);
    expect(fakeDb.table.get("1:KEPT")?.cited_by_count).toBe(42);
    expect(items.get("CONF")!.extra).toBe("Citegeist match ID: W100");
  });

  it("re-applies query_only each time Zotero reopens the read-only connection", async () => {
    await reopen((db) => {
      db.pragma.userVersion = newerMajor;
    });
    expect(fakeDb.onConnect).toHaveBeenCalledTimes(1);

    await fakeDb.reconnect();
    expect(fakeDb.pragma.queryOnly).toBe(true);

    // Once closed, the callback leaves a reopened connection alone.
    await closeCache();
    await fakeDb.reconnect();
    expect(fakeDb.pragma.queryOnly).toBe(false);
  });

  it("registers no reopen callback on a writable cache", () => {
    expect(fakeDb.onConnect).not.toHaveBeenCalled();
  });

  it("refuses a write after closeCache with CG-DB02, with no init in between", async () => {
    await reopen((db) => {
      db.pragma.userVersion = newerMajor;
    });
    await closeCache();

    expect(cacheWriteRefusalCode()).toBe("CG-DB02");
    await expect(cacheWorkData(mockItem("AFTER"), work, null)).rejects.toMatchObject({
      name: "CacheWriteRefusedError",
      code: "CG-DB02",
    });
    await expect(upsertRow(legacyRow("AFTER", 1))).rejects.toMatchObject({ code: "CG-DB02" });
    expect(fakeDb.table.has("1:AFTER")).toBe(false);
  });

  it("logs a refused write once per operation, not once per write", async () => {
    await reopen((db) => {
      db.pragma.userVersion = newerMajor;
    });
    mockZotero.debug.mockClear();

    for (let i = 0; i < 3; i++) {
      await expect(upsertRow(legacyRow("R", i))).rejects.toMatchObject({ code: "CG-DB03" });
    }
    await expect(deleteRow(1, "R")).rejects.toMatchObject({ code: "CG-DB03" });

    const refusals = mockZotero.debug.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes("refused"));
    expect(refusals).toHaveLength(2);
    // Refusals are not failures to record: CG-DB03 stays the one init entry.
    expect(recorded("CG-DB03")).toBe(1);
  });

  it("logs exactly the one ERROR line the real-Zotero schema-stamp spec allows", async () => {
    await closeCache();
    mockZotero.debug.mockClear();
    await reopen((db) => {
      db.pragma.userVersion = newerMajor;
    });
    await expect(upsertRow(legacyRow("R", 1))).rejects.toMatchObject({ code: "CG-DB03" });

    const errorLines = mockZotero.debug.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes(ERROR_DEBUG_MARK));
    // Spec 91 fails on any ERROR line its pattern doesn't match, so the pattern
    // must match the line init really logs, and nothing else may appear.
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toMatch(READ_ONLY_STARTUP_ERROR);
  });

  it("keeps a read-only line in every report that later failures and Clear don't remove", async () => {
    await reopen((db) => {
      db.pragma.userVersion = newerMajor;
    });
    const line = `Cache: read-only, CG-DB03 (schema major ${CACHE_SCHEMA_MAJOR + 1}; this build supports schema major ${CACHE_SCHEMA_MAJOR})`;
    expect(buildDiagnosticReport({})).toContain(line);

    for (let i = 0; i <= DIAGNOSTIC_RING_BUFFER_SIZE; i++) {
      logError(`later failure ${i}`, new Error("x"));
    }
    expect(recorded("CG-DB03"), "positive control: the init entry was pushed out").toBe(0);
    expect(buildDiagnosticReport({})).toContain(line);
    clearDiagnostics();
    expect(buildDiagnosticReport({})).toContain(line);

    await reopen((db) => {
      db.pragma.userVersion = CURRENT_SCHEMA_STAMP;
    });
    expect(buildDiagnosticReport({})).not.toContain("Cache: read-only");
  });

  it("keeps a read-only cache usable when a newer major's item_cache can't be read", async () => {
    await reopen((db) => {
      db.pragma.userVersion = newerMajor;
      failOn(db, /^SELECT\b[\s\S]*\bFROM\s+item_cache\s*$/i, "no such table: item_cache");
    });

    expect(getCachedData(mockItem("ANY"))).toBeNull();
    expect(recorded("CG-DB03")).toBe(1);
    expect(recorded("CG-DB02")).toBe(0);
  });

  it("finishes init and logs the failure when the stamp write fails", async () => {
    await reopen((db) => failOn(db, /^PRAGMA\s+user_version\s*=/i, "database is locked"));

    expect(fakeDb.pragma.userVersion).toBe(0);
    expect(recentDiagnostics()).toContainEqual(
      expect.objectContaining({ code: "CG-DB01", context: "cache schema stamp" }),
    );
    // The database is still compatible, so the session stays writable.
    await cacheWorkData(mockItem("AFTER"), work, null);
    expect(fakeDb.table.has("1:AFTER")).toBe(true);
  });

  it("fails init as CG-DB02, before any DDL, when the stamp can't be read", async () => {
    await closeCache();
    fakeDb = makeFakeDb();
    failOn(fakeDb, /^PRAGMA\s+user_version\s*$/i, "file is not a database");

    await expect(initCache()).rejects.toMatchObject({ code: "CG-DB02" });
    expect(writeStatements()).toEqual([]);
  });

  it("fails init as CG-DB02 when the PRAGMA row lacks user_version, as Zotero's row Proxy throws", async () => {
    await closeCache();
    fakeDb = makeFakeDb();
    fakeDb.pragma.column = "schema_version";

    await expect(initCache()).rejects.toMatchObject({ code: "CG-DB02" });
    expect(writeStatements()).toEqual([]);
  });

  it("reads a numeric string or a bigint stamp as the number it spells", async () => {
    await reopen((db) => {
      db.pragma.userVersion = String(CURRENT_SCHEMA_STAMP);
    });
    expect(cacheWriteRefusalCode()).toBeNull();
    // Read as the current schema, so it isn't restamped.
    expect(fakeDb.pragma.userVersion).toBe(String(CURRENT_SCHEMA_STAMP));
    expect(writeStatements().filter((s) => /^PRAGMA\s+user_version\s*=/i.test(s))).toEqual([]);

    await reopen((db) => {
      db.pragma.userVersion = BigInt(newerMajor);
    });
    expect(cacheWriteRefusalCode()).toBe("CG-DB03");
  });

  it.each([
    ["an unreadable string", "abc"],
    ["a value that isn't a number", null],
    ["a negative stamp", -5],
    ["a major no release reaches", CACHE_SCHEMA_UNRECOGNISED_MAJOR * 1000],
  ])(
    "opens %s read-only as CG-DB04, leaving the stamp and every row alone",
    async (_label, stamp) => {
      await reopen((db) => {
        db.pragma.userVersion = stamp;
        seed(db, legacyRow("KEPT", 42));
      });

      expect(cacheWriteRefusalCode()).toBe("CG-DB04");
      await expect(cacheWorkData(mockItem("KEPT"), work, null)).rejects.toMatchObject({
        code: "CG-DB04",
      });
      expect(fakeDb.pragma.userVersion).toBe(stamp);
      expect(writeStatements()).toEqual([]);
      expect(getCachedCitationCount(mockItem("KEPT"))).toBe(42);
      expect(recorded("CG-DB04")).toBe(1);
      expect(recorded("CG-DB03")).toBe(0);
      expect(buildDiagnosticReport({})).toContain("Cache: read-only, CG-DB04");
    },
  );

  it("closeCache clears read-only mode, so the next compatible open writes again", async () => {
    await reopen((db) => {
      db.pragma.userVersion = newerMajor;
    });
    await expect(cacheWorkData(mockItem("RO"), work, null)).rejects.toMatchObject({
      code: "CG-DB03",
    });
    expect(fakeDb.table.has("1:RO")).toBe(false);

    const closeSpy = vi.spyOn(fakeDb, "closeDatabase");
    await reopen((db) => {
      db.pragma.userVersion = CURRENT_SCHEMA_STAMP;
    });
    expect(closeSpy).toHaveBeenCalledWith(true);
    await cacheWorkData(mockItem("RW"), work, null);
    expect(fakeDb.table.has("1:RW")).toBe(true);
  });
});

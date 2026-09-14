/**
 * The cache's transactions, host rows, init and shutdown, over the harness's
 * fake Zotero database (plan U16, review round A).
 *
 * - Every writer commits its statements together or not at all.
 * - A row loaded at startup keeps every column through a later write, although
 *   Zotero's row objects expose none as own keys.
 * - Init creates the tables and stamps them in one transaction, closes a
 *   connection it failed to open, and keeps query_only on a connection Zotero
 *   reopens mid-load.
 * - Shutdown lets writes that passed the gate land before it closes, refuses
 *   later ones, and migration on a closed cache touches nothing.
 * - A read-only cache records a failing author read once, not per render.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fakeDb,
  fileWrites,
  items,
  mockItem,
  mockZotero,
  resetCacheHarness,
} from "./_helpers/cacheHarness";
import {
  _resetForTesting,
  cacheWriteRefusalCode,
  closeCache,
  deleteRow,
  initCache,
  mirrorSnapshot,
  mutateRow,
  upsertRow,
} from "../src/modules/cache/db";
import { CURRENT_SCHEMA_STAMP } from "../src/modules/cache/schema";
import {
  cacheItemAuthors,
  getAuthor,
  getItemAuthors,
  reconcileAuthorMerge,
} from "../src/modules/cache/authors";
import { garbageCollectOrphans, migrateFromExtraV1 } from "../src/modules/cache/migration";
import { cacheWorkData } from "../src/modules/cache/write";
import {
  getCachedCitationCount,
  getCachedData,
  getTitleMatchMeta,
} from "../src/modules/cache/read";
import { emptyRow, type ItemCacheRow } from "../src/modules/cache/types";
import { clearDiagnostics, recentDiagnostics } from "../src/modules/diagnostics";
import { CACHE_SCHEMA_MAJOR, CACHE_SCHEMA_STAMP_MULTIPLIER } from "../src/constants";
import { ERROR_DEBUG_MARK } from "./real-zotero/support/citegeist";

const NEWER_MAJOR = (CACHE_SCHEMA_MAJOR + 1) * CACHE_SCHEMA_STAMP_MULTIPLIER;
const MIRROR_LOAD = /^SELECT\b[\s\S]*\bFROM\s+item_cache\s*$/i;
const ITEM_CACHE_UPSERT = /^INSERT\s+OR\s+REPLACE\s+INTO\s+item_cache/i;

beforeEach(async () => {
  await resetCacheHarness(initCache, _resetForTesting);
  clearDiagnostics();
});

function savedRow(key: string, over: Partial<ItemCacheRow> = {}): ItemCacheRow {
  return {
    ...emptyRow(1, key),
    open_alex_id: "W100",
    cited_by_count: 3,
    last_fetched: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/** Close the cache, change the file with `setup`, and open it again: a restart on the same file. */
async function restart(setup: () => void = () => {}): Promise<void> {
  await closeCache();
  setup();
  clearDiagnostics();
  await initCache();
}

/** Make statements matching `pattern` fail on the harness database. */
function failOn(pattern: RegExp, message = "database is locked"): void {
  const base = fakeDb.queryAsync.getMockImplementation()!;
  fakeDb.queryAsync.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (pattern.test(sql.trim())) throw new Error(message);
    return base(sql, params);
  });
}

/**
 * Hold the first `count` statements matching `pattern` until each is released.
 * `held(n)` resolves once the nth has arrived.
 */
function hold(pattern: RegExp, count = 1) {
  const base = fakeDb.queryAsync.getMockImplementation()!;
  const releases: Array<() => void> = [];
  const arrivals: Array<() => void> = [];
  const arrived = Array.from(
    { length: count },
    (_, index) =>
      new Promise<void>((resolve) => {
        arrivals[index] = resolve;
      }),
  );
  let seen = 0;
  fakeDb.queryAsync.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (seen < count && pattern.test(sql.trim())) {
      const index = seen++;
      await new Promise<void>((resolve) => {
        releases[index] = resolve;
        arrivals[index]();
      });
    }
    return base(sql, params);
  });
  return {
    held: (n: number): Promise<void> => arrived[n - 1],
    release: (n: number): void => releases[n - 1](),
  };
}

const nextMacrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("a write commits whole or not at all", () => {
  it("deleteRow's three deletes roll back together when the last one fails", async () => {
    await upsertRow(savedRow("DEL"));
    fakeDb.progress.set("1:DEL", "2026-01-01T00:00:00.000Z");
    await cacheItemAuthors({ libraryID: 1, key: "DEL" }, [{ author: { id: "A1" } }]);
    failOn(/^DELETE\s+FROM\s+item_authors/i);

    await expect(deleteRow(1, "DEL")).rejects.toMatchObject({ code: "CG-DB01" });

    expect(fakeDb.table.has("1:DEL")).toBe(true);
    expect(fakeDb.progress.has("1:DEL")).toBe(true);
    expect(getCachedCitationCount(mockItem("DEL"))).toBe(3);
    expect(fakeDb.transactions.rollbackCount).toBe(1);
  });

  it("cacheItemAuthors leaves an item's authors as they were when its reconcile fails partway", async () => {
    const item = { libraryID: 1, key: "AUTH" };
    await cacheItemAuthors(item, [{ author: { id: "A1", display_name: "First" } }]);
    failOn(/^INSERT\s+OR\s+REPLACE\s+INTO\s+item_authors/i);

    await expect(
      cacheItemAuthors(item, [{ author: { id: "A2", display_name: "Second" } }]),
    ).rejects.toMatchObject({ code: "CG-DB01" });

    expect((await getItemAuthors(1, "AUTH")).map((r) => r.author_id)).toEqual(["A1"]);
    expect(await getAuthor("A2")).toBeNull();
  });

  it("reconcileAuthorMerge moves no reference when its last statement fails", async () => {
    await cacheItemAuthors({ libraryID: 1, key: "K1" }, [{ author: { id: "A1" } }]);
    failOn(/^DELETE\s+FROM\s+authors\s+WHERE\s+author_id\s*=/i);

    await expect(reconcileAuthorMerge("A1", "A2")).rejects.toMatchObject({ code: "CG-DB01" });

    expect((await getItemAuthors(1, "K1")).map((r) => r.author_id)).toEqual(["A1"]);
    expect(await getAuthor("A1")).not.toBeNull();
  });

  it("orphan GC keeps a chunk's rows in every table, and in the mirror, when the chunk fails", async () => {
    await upsertRow(savedRow("GONE"));
    await cacheItemAuthors({ libraryID: 1, key: "GONE" }, [{ author: { id: "A1" } }]);
    failOn(/^DELETE\s+FROM\s+item_authors\s+WHERE\s+\(library_id/i);

    await expect(garbageCollectOrphans({ force: true })).rejects.toMatchObject({
      code: "CG-DB01",
    });

    expect(fakeDb.table.has("1:GONE")).toBe(true);
    expect(getCachedCitationCount(mockItem("GONE"))).toBe(3);
    expect(fakeDb.itemAuthors.size).toBe(1);
  });
});

describe("rows Zotero hands back", () => {
  it("a refetch after a restart keeps every column the earlier session saved", async () => {
    await restart(() => {
      fakeDb.table.set(
        "1:PREV",
        savedRow("PREV", {
          citedness_2yr: 2.5,
          journal_h_index: 50,
          source_issns: "1234-5678,8765-4321",
          issn_l: "1234-5678",
          confirmed_open_alex_id: "W100",
          match_method: "title-match",
          match_confidence: "high",
        }) as never,
      );
    });

    await cacheWorkData(
      mockItem("PREV"),
      { id: "https://openalex.org/W100", cited_by_count: 9, fwci: null, is_retracted: false },
      null,
    );

    expect([...fakeDb.table.keys()]).toEqual(["1:PREV"]);
    expect(fakeDb.table.get("1:PREV")).toMatchObject({
      library_id: 1,
      item_key: "PREV",
      cited_by_count: 9,
      citedness_2yr: 2.5,
      journal_h_index: 50,
      source_issns: "1234-5678,8765-4321",
      issn_l: "1234-5678",
      confirmed_open_alex_id: "W100",
      match_method: "title-match",
      match_confidence: "high",
    });
    expect(getCachedData(mockItem("PREV"))?.journalHIndex).toBe(50);
    expect(getTitleMatchMeta(mockItem("PREV")).confirmedOpenAlexId).toBe("W100");
  });

  it("loads the mirror as plain rows that spread to every column", async () => {
    await restart(() => {
      fakeDb.table.set("1:PLAIN", savedRow("PLAIN") as never);
    });

    const [[, row]] = mirrorSnapshot();
    expect({ ...row }).toEqual(savedRow("PLAIN"));
  });
});

describe("init", () => {
  it("creates every table and writes the stamp in one transaction", () => {
    // beforeEach opened a fresh, unstamped database.
    const setup = fakeDb.statements.filter((s) =>
      /^CREATE\s+TABLE|^PRAGMA\s+user_version\s*=/i.test(s.sql),
    );
    const names = setup.map(
      (s) => /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/i.exec(s.sql)?.[1] ?? "stamp",
    );

    expect(names).toEqual(["item_cache", "migration_progress", "authors", "item_authors", "stamp"]);
    expect(setup[0].transaction).not.toBeNull();
    expect(new Set(setup.map((s) => s.transaction)).size).toBe(1);
    expect(fakeDb.pragma.userVersion).toBe(CURRENT_SCHEMA_STAMP);
  });

  it.each([1, 999])(
    "stamps %i, an older schema below major 1, and takes writes instead of refusing them",
    async (stamp) => {
      await restart(() => {
        fakeDb.pragma.userVersion = stamp;
      });

      expect(cacheWriteRefusalCode()).toBeNull();
      expect(fakeDb.pragma.userVersion).toBe(CURRENT_SCHEMA_STAMP);
      await upsertRow(savedRow("AFTER"));
      expect(fakeDb.table.has("1:AFTER")).toBe(true);
    },
  );

  it.each([
    ["the stamp read", /^PRAGMA\s+user_version\s*$/i],
    ["the schema setup", /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+authors/i],
    ["the mirror load", MIRROR_LOAD],
  ])(
    "closes the connection when %s fails, so the file isn't left locked",
    async (_label, pattern) => {
      await closeCache();
      fakeDb.closeDatabase.mockClear();
      failOn(pattern, "file is not a database");

      await expect(initCache()).rejects.toMatchObject({ code: "CG-DB02" });

      expect(fakeDb.closeDatabase).toHaveBeenCalledTimes(1);
      expect(fakeDb.closeDatabase).toHaveBeenCalledWith(true);
      expect(cacheWriteRefusalCode()).toBe("CG-DB02");
    },
  );

  it("logs exactly the CG-DB04 startup line spec 91 allows for a stamp of -5", async () => {
    await closeCache();
    mockZotero.debug.mockClear();
    await restart(() => {
      fakeDb.pragma.userVersion = -5;
    });

    const errorLines = mockZotero.debug.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes(ERROR_DEBUG_MARK));
    // test/real-zotero/91-schema-stamp.spec.ts allows this text and no other.
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain(
      `[Citegeist] ERROR cache schema check: schema stamp -5 not recognised; this build writes schema major ${CACHE_SCHEMA_MAJOR}; cache writes disabled`,
    );
  });

  it("re-applies query_only when Zotero reopens a read-only connection while its mirror loads", async () => {
    await closeCache();
    fakeDb.pragma.userVersion = NEWER_MAJOR;
    const load = hold(MIRROR_LOAD);
    const opening = initCache();
    await load.held(1);

    await fakeDb.reconnect();
    expect(fakeDb.pragma.queryOnly).toBe(true);

    load.release(1);
    await opening;
    expect(cacheWriteRefusalCode()).toBe("CG-DB03");
  });
});

describe("shutdown", () => {
  it("lets two queued writes to one key land before it closes the database", async () => {
    const writes = hold(ITEM_CACHE_UPSERT, 2);
    let countWhenClosing: unknown = "never closed";
    let releaseClose: () => void = () => {};
    fakeDb.closeDatabase.mockImplementation(async () => {
      countWhenClosing = fakeDb.table.get("1:KEY")?.cited_by_count;
      await new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
    });

    const first = mutateRow(1, "KEY", () => savedRow("KEY", { cited_by_count: 1 }));
    const second = mutateRow(1, "KEY", (row) => ({
      ...(row ?? savedRow("KEY")),
      cited_by_count: 2,
    }));
    await writes.held(1);
    const closing = closeCache();
    writes.release(1);
    await first;
    await writes.held(2);
    await nextMacrotask();
    expect(fakeDb.closeDatabase, "closed while a queued write was pending").not.toHaveBeenCalled();

    writes.release(2);
    await second;
    await vi.waitFor(() => expect(fakeDb.closeDatabase).toHaveBeenCalledTimes(1));
    releaseClose();
    await closing;
    expect(countWhenClosing).toBe(2);
  });

  it("refuses a write that starts after closeCache began with CG-DB02, and it never reaches the database", async () => {
    const writes = hold(ITEM_CACHE_UPSERT, 1);
    const inFlight = upsertRow(savedRow("FIRST"));
    await writes.held(1);
    const closing = closeCache();

    const late = upsertRow(savedRow("LATE"));
    const outcome = await Promise.race([
      late.then(
        () => "landed",
        (e: unknown) => e,
      ),
      new Promise((resolve) => setTimeout(() => resolve("accepted, still waiting"), 10)),
    ]);
    expect(outcome).toMatchObject({ name: "CacheWriteRefusedError", code: "CG-DB02" });

    writes.release(1);
    await Promise.all([inFlight, closing]);
    expect(fakeDb.table.has("1:FIRST")).toBe(true);
    expect(fakeDb.table.has("1:LATE")).toBe(false);
    expect(fakeDb.statements.filter((s) => ITEM_CACHE_UPSERT.test(s.sql))).toHaveLength(1);
    expect(recentDiagnostics()).toEqual([]);
  });

  it("refuses migrateFromExtraV1 on a closed cache with CG-DB02, before any backup file or Extra change", async () => {
    const legacy = "Citegeist.openAlexId: W1234\nCitegeist.citedByCount: 3";
    const item = mockItem("LEG", legacy);
    mockZotero.Items.getAll.mockResolvedValue([item]);
    const io = (globalThis as unknown as { IOUtils: Record<string, ReturnType<typeof vi.fn>> })
      .IOUtils;
    await closeCache();
    for (const fn of Object.values(io)) fn.mockClear();
    mockZotero.File.putContentsAsync.mockClear();

    await expect(migrateFromExtraV1()).rejects.toMatchObject({
      name: "CacheWriteRefusedError",
      code: "CG-DB02",
    });

    expect(fileWrites).toEqual([]);
    expect(mockZotero.File.putContentsAsync).not.toHaveBeenCalled();
    expect(io.makeDirectory).not.toHaveBeenCalled();
    expect(io.move).not.toHaveBeenCalled();
    expect(items.get("LEG")!.extra).toBe(legacy);
    expect(item.setField).not.toHaveBeenCalled();
    expect(item.saveTx).not.toHaveBeenCalled();
  });
});

describe("author reads on a read-only cache", () => {
  it("records a failing read once per operation, and shows nothing", async () => {
    await restart(() => {
      fakeDb.pragma.userVersion = NEWER_MAJOR;
    });
    failOn(/\bFROM\s+item_authors\b/i, "no such column: author_position");
    failOn(/\bFROM\s+authors\s+WHERE\b/i, "no such table: authors");
    clearDiagnostics();

    for (let render = 0; render < 3; render++) {
      expect(await getItemAuthors(1, "ANY")).toEqual([]);
      expect(await getAuthor("A1")).toBeNull();
    }

    expect(
      recentDiagnostics()
        .map((d) => `${d.code} ${d.context}`)
        .sort(),
    ).toEqual([
      "CG-DB01 getAuthor on a read-only cache",
      "CG-DB01 getItemAuthors on a read-only cache",
    ]);
  });

  it("still throws every failing author read on a writable cache", async () => {
    failOn(/\bFROM\s+item_authors\b/i);

    await expect(getItemAuthors(1, "ANY")).rejects.toMatchObject({ code: "CG-DB01" });
    await expect(getItemAuthors(1, "ANY")).rejects.toMatchObject({ code: "CG-DB01" });
  });
});

/**
 * The one-time import of confirmed title matches from Extra
 * (src/modules/cache/migration.ts), and the orphan-GC preferences.
 *
 * The v2.0.0 migration never ran on any library: it passed its loop to
 * `Zotero.Sync.Runner.delaySync`, which takes milliseconds and never calls a
 * function, and the harness's mock called it anyway (BUG-MIGRATION). What
 * replaces it only imports (plan, Decisions item 8). Each block below holds one
 * rule of that: what it imports and from which lines; that no item's Extra
 * changes; that a decision the cache already holds wins; that it runs once per
 * profile, whatever the v2.0.x done flag says, and never scans again; that a
 * pass cut short runs again; and that sync is held through Zotero's
 * `delayIndefinite`.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fakeDb,
  fileWrites,
  items,
  mockItem,
  mockZotero,
  resetCacheHarness,
} from "./_helpers/cacheHarness";

import { _resetForTesting, closeCache, upsertRow } from "../src/modules/cache/db";
import {
  cacheWorkData,
  dismissAsNoMatch,
  garbageCollectOrphans,
  getCachedCitationCount,
  getCachedData,
  getPendingSuggestion,
  getTitleMatchMeta,
  initCache,
  isCacheStale,
  migrateFromExtraV1,
  writePendingSuggestion,
} from "../src/modules/cache";
import { emptyRow } from "../src/modules/cache/types";
import { clearDiagnostics, recentDiagnostics } from "../src/modules/diagnostics";
import {
  CACHE_SCHEMA_MAJOR,
  CACHE_SCHEMA_STAMP_MULTIPLIER,
  PREF_EXTRA_MATCH_IMPORT_COMPLETE,
  PREF_LAST_BACKUP_PATH,
  PREF_LAST_ORPHAN_GC_AT,
  PREF_MIGRATION_COMPLETE,
} from "../src/constants";
import { ZOTERO_PREF_BRANCH } from "./_helpers/fakePrefs";

/** The Debug Output lines the real-Zotero specs 92 and 93 count. */
const STARTED = "[Citegeist] migration started";
const COMPLETE = "[Citegeist] migration complete";

const doubled = (name: string): string => ZOTERO_PREF_BRANCH + name;

/** A library as `Zotero.Libraries.getAll` returns one, with the item loader the import calls. */
function library(libraryID: number, libraryType = "user", editable = true) {
  return {
    libraryID,
    libraryType,
    editable,
    waitForDataLoad: vi.fn(async (_objectType: string) => {}),
  };
}
type FakeLibrary = ReturnType<typeof library>;

/** Serve each library from `Zotero.Libraries.getAll`, and its items from `Zotero.Items.getAll`. */
function useLibraries(...entries: Array<[FakeLibrary, _ZoteroTypes.Item[]]>): void {
  mockZotero.Libraries.getAll.mockImplementation(
    () => entries.map(([lib]) => lib) as unknown as _ZoteroTypes.Library[],
  );
  mockZotero.Items.getAll.mockImplementation(
    async (libraryID: number) => entries.find(([lib]) => lib.libraryID === libraryID)?.[1] ?? [],
  );
}

/** My Library, holding `libraryItems`. */
function useItems(...libraryItems: _ZoteroTypes.Item[]): FakeLibrary {
  const mine = library(1);
  useLibraries([mine, libraryItems]);
  return mine;
}

/** The harness's `mockItem` in any library, trashed or not a regular item on request. */
function libraryItem(
  libraryID: number,
  key: string,
  extra: string,
  options: { deleted?: boolean; regular?: boolean } = {},
): _ZoteroTypes.Item {
  const item = mockItem(key, extra) as unknown as Record<string, unknown>;
  item.libraryID = libraryID;
  item.deleted = options.deleted ?? false;
  item.isRegularItem = () => options.regular ?? true;
  return item as unknown as _ZoteroTypes.Item;
}

const importDone = () => mockZotero.Prefs.user.get(PREF_EXTRA_MATCH_IMPORT_COMPLETE);

const debugLines = (): string[] => mockZotero.debug.mock.calls.map(([line]) => String(line));
const linesStartingWith = (mark: string): string[] =>
  debugLines().filter((line) => line.startsWith(mark));

/** The release function the nth `delayIndefinite` call returned. */
function syncRelease(n = 0) {
  return mockZotero.Sync.Runner.delayIndefinite.mock.results[n]?.value as
    | ReturnType<typeof vi.fn>
    | undefined;
}

beforeEach(async () => {
  await resetCacheHarness(initCache, _resetForTesting);
  mockZotero.debug.mockClear();
  // Reset, not clear: a "once" result a test queued, and a regression never
  // consumed, must not leak into the next test.
  mockZotero.Libraries.getAll.mockReset();
  mockZotero.Items.getAll.mockReset();
  mockZotero.Sync.Runner.delaySync.mockReset();
  mockZotero.Sync.Runner.delayIndefinite.mockReset();
  useItems();
  clearDiagnostics();
});

// ── What the import copies ─────────────────────────────────────────────────

describe("what the import copies into the cache", () => {
  it("imports a v1.3.x confirmed title match with its method and tier, and none of its metrics", async () => {
    const extra = [
      "Read for chapter 3",
      "Citegeist.openAlexId: W123",
      "Citegeist.citedByCount: 42",
      "Citegeist.fwci: 2.31",
      "Citegeist.percentile: 92.5",
      "Citegeist.isTop1Percent: false",
      "Citegeist.isTop10Percent: true",
      "Citegeist.isRetracted: false",
      "Citegeist.lastFetched: 2026-04-01T12:00:00.000Z",
      "Citegeist.sourceId: S77",
      "Citegeist.matchMethod: title-match",
      "Citegeist.matchConfidence: high",
      "Citegeist.confirmedOpenAlexId: W123",
    ].join("\n");
    const item = mockItem("A", extra);
    useItems(item);

    expect(await migrateFromExtraV1()).toBe(false);

    expect(getTitleMatchMeta(item)).toEqual({
      noMatch: false,
      noMatchTimestamp: null,
      matchMethod: "title-match",
      matchConfidence: "high",
      confirmedOpenAlexId: "W123",
    });
    // No metrics: the next lookup fetches them for the confirmed work.
    expect(getCachedData(item)).toBeNull();
    expect(getCachedCitationCount(item)).toBeNull();
    expect(isCacheStale(item)).toBe(true);
    expect(fakeDb.table.get("1:A")).toMatchObject({
      open_alex_id: null,
      cited_by_count: null,
      source_id: null,
      last_fetched: null,
    });
  });

  it("imports the `Citegeist match ID:` line v2.0.0 and later write on a confirm", async () => {
    const item = mockItem("MID", "Citegeist match ID: W90023");
    useItems(item);

    await migrateFromExtraV1();

    expect(getTitleMatchMeta(item)).toMatchObject({
      confirmedOpenAlexId: "W90023",
      matchMethod: "title-match",
      matchConfidence: null,
    });
  });

  it("leaves metrics, suggestions and no-match lines in Extra: an item with no confirmed match gets no row", async () => {
    const extra = [
      "Citegeist.openAlexId: W5",
      "Citegeist.citedByCount: 9",
      "Citegeist.lastFetched: 2026-04-01T12:00:00.000Z",
      "Citegeist.pendingSuggestionId: W6",
      "Citegeist.pendingSuggestionTitle: A near miss",
      "Citegeist.noMatch: true",
      "Citegeist.noMatchTimestamp: 2026-04-02T12:00:00.000Z",
      "Citegeist.matchMethod: title-match",
      "Citegeist.matchConfidence: medium",
    ].join("\n");
    useItems(mockItem("MET", extra));

    await migrateFromExtraV1();

    expect(fakeDb.table.size).toBe(0);
    expect(importDone()).toBe(true);
    expect(linesStartingWith(COMPLETE)[0]).toContain("with Citegeist lines 1, matches imported 0");
  });

  it("takes the `Citegeist match ID:` line over v1.x's confirmed id, which it replaced", async () => {
    const extra = [
      "Citegeist.matchConfidence: high",
      "Citegeist.confirmedOpenAlexId: W1",
      "Citegeist match ID: W2",
    ].join("\n");
    const item = mockItem("BOTH", extra);
    useItems(item);

    await migrateFromExtraV1();

    // v1.x's tier described W1, so it does not travel to W2.
    expect(getTitleMatchMeta(item)).toMatchObject({
      confirmedOpenAlexId: "W2",
      matchConfidence: null,
    });
  });

  it("keeps v1.x's tier when both lines name the same work, and a repeated line is no conflict", async () => {
    const extra = [
      "Citegeist.matchConfidence: medium",
      "Citegeist.confirmedOpenAlexId: W3",
      "Citegeist match ID: W3",
      "Citegeist match ID: W3",
    ].join("\n");
    const item = mockItem("SAME", extra);
    useItems(item);

    await migrateFromExtraV1();

    expect(getTitleMatchMeta(item)).toMatchObject({
      confirmedOpenAlexId: "W3",
      matchConfidence: "medium",
    });
  });

  it.each([
    ["two `Citegeist match ID:` lines", "Citegeist match ID: W11111\nCitegeist match ID: W22222"],
    [
      "two v1.x confirmed ids",
      "Citegeist.confirmedOpenAlexId: W11111\nCitegeist.confirmedOpenAlexId: W22222",
    ],
  ])(
    "leaves an item whose %s name different works for the user, and still finishes",
    async (_name, extra) => {
      const item = mockItem("TWO", extra);
      useItems(item);

      await migrateFromExtraV1();

      expect(fakeDb.table.size).toBe(0);
      expect(items.get("TWO")!.extra).toBe(extra);
      expect(importDone()).toBe(true);
      expect(linesStartingWith(COMPLETE)[0]).toContain("naming two works 1");
    },
  );

  it("ignores lines that are the user's own text", async () => {
    const extra = [
      "Citegeist match ID: see footnote 3 in my notes",
      "Citegeist.note: still useful for my review",
      "Citegeist.confirmedOpenAlexId: not-a-work-id",
      "Citegeist.confirmedOpenAlexId:W46",
      "  Citegeist.confirmedOpenAlexId: W47",
      "citegeist.confirmedOpenAlexId: W48",
    ].join("\n");
    useItems(mockItem("USER", extra));

    await migrateFromExtraV1();

    expect(fakeDb.table.size).toBe(0);
  });

  it("reads Extra saved with a byte-order mark, CRLF or CR line ends, and padded values", async () => {
    const crlf = mockItem(
      "CRLF",
      "﻿Citegeist.confirmedOpenAlexId:  W90021 \r\nCitegeist.matchConfidence: medium\r\nPMID: 1",
    );
    const cr = mockItem("CR", "Read later\rCitegeist match ID: W90022\r");
    useItems(crlf, cr);

    await migrateFromExtraV1();

    expect(getTitleMatchMeta(crlf)).toMatchObject({
      confirmedOpenAlexId: "W90021",
      matchConfidence: "medium",
    });
    expect(getTitleMatchMeta(cr).confirmedOpenAlexId).toBe("W90022");
  });

  it("reads every library but feeds, read-only groups too, loading each library's items first", async () => {
    const mine = library(1);
    const group = library(4, "group");
    const readOnly = library(5, "group", false);
    const feed = library(6, "feed");
    const confirmed = (libraryID: number, key: string, id: string) =>
      libraryItem(libraryID, key, `Citegeist.confirmedOpenAlexId: ${id}`);
    const inMine = confirmed(1, "MINE", "W1");
    const inGroup = confirmed(4, "GROUP", "W4");
    const inReadOnly = confirmed(5, "READONLY", "W5");
    const inFeed = confirmed(6, "FEED", "W6");
    useLibraries([mine, [inMine]], [group, [inGroup]], [readOnly, [inReadOnly]], [feed, [inFeed]]);

    await migrateFromExtraV1();

    expect(getTitleMatchMeta(inMine).confirmedOpenAlexId).toBe("W1");
    expect(getTitleMatchMeta(inGroup).confirmedOpenAlexId).toBe("W4");
    // A cache row only: nothing is written to the read-only library.
    expect(getTitleMatchMeta(inReadOnly).confirmedOpenAlexId).toBe("W5");
    expect(fakeDb.table.has("6:FEED")).toBe(false);
    expect(feed.waitForDataLoad).not.toHaveBeenCalled();
    const readCalls = mockZotero.Items.getAll.mock.calls.map(([libraryID]) => libraryID);
    expect(readCalls).toEqual([1, 4, 5]);
    for (const [index, lib] of [mine, group, readOnly].entries()) {
      expect(lib.waitForDataLoad).toHaveBeenCalledWith("item");
      expect(lib.waitForDataLoad.mock.invocationCallOrder[0]).toBeLessThan(
        mockZotero.Items.getAll.mock.invocationCallOrder[index],
      );
    }
  });

  it("skips trashed items, notes and attachments", async () => {
    useItems(
      libraryItem(1, "TRASHED", "Citegeist.confirmedOpenAlexId: W1", { deleted: true }),
      libraryItem(1, "NOTE", "Citegeist match ID: W2", { regular: false }),
    );

    await migrateFromExtraV1();

    expect(fakeDb.table.size).toBe(0);
    expect(importDone()).toBe(true);
  });
});

// ── No item changes ────────────────────────────────────────────────────────

describe("Extra is never written", () => {
  it("leaves every item's Extra byte for byte, saves no item and writes no backup file", async () => {
    const extras: Record<string, string> = {
      V1: [
        "Read for chapter 3",
        "Citegeist.openAlexId: W123",
        "Citegeist.citedByCount: 42",
        "Citegeist.matchConfidence: high",
        "Citegeist.confirmedOpenAlexId: W123",
      ].join("\n"),
      MID: "tex.citekey: smith2019\nCitegeist match ID: W456",
      METRICS: "Citegeist.openAlexId: W789\nCitegeist.citedByCount: 5\nCitegeist.note: my reminder",
      CRLF: "﻿Citegeist.confirmedOpenAlexId: W321\r\nPMID: 123\r\n",
      TWO: "Citegeist match ID: W11111\nCitegeist match ID: W22222",
    };
    const all = Object.entries(extras).map(([key, extra]) => mockItem(key, extra));
    useItems(...all);

    await migrateFromExtraV1();

    expect(fakeDb.table.size, "positive control: the import wrote its rows").toBe(3);
    for (const [key, extra] of Object.entries(extras)) {
      expect(items.get(key)!.extra, key).toBe(extra);
    }
    for (const item of all) {
      expect(item.setField, item.key).not.toHaveBeenCalled();
      expect(item.saveTx, item.key).not.toHaveBeenCalled();
    }
    expect(fileWrites).toEqual([]);
    expect(mockZotero.Prefs.user.has(PREF_LAST_BACKUP_PATH)).toBe(false);
  });

  it("migration.ts calls nothing that writes an item's fields or a file", () => {
    const source = readFileSync(
      new URL("../src/modules/cache/migration.ts", import.meta.url),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const writer of [
      /\.setField\s*\(/,
      /\.saveTx\s*\(/,
      /\bsaveItemGuarded\s*\(/,
      /\bclearCache\s*\(/,
      /\bconfirmTitleMatch\s*\(/,
      /\bputContentsAsync\s*\(/,
      /\bIOUtils\b/,
    ]) {
      expect(source, String(writer)).not.toMatch(writer);
    }
  });
});

// ── Curated wins ───────────────────────────────────────────────────────────

describe("a decision the cache already holds wins", () => {
  const legacyConfirmation = "Citegeist.matchConfidence: high\nCitegeist.confirmedOpenAlexId: W1";

  it("keeps a confirmation the cache holds, even of another work", async () => {
    await upsertRow({
      ...emptyRow(1, "CONF"),
      confirmed_open_alex_id: "W2",
      match_method: "title-match",
      match_confidence: "medium",
    });
    const before = { ...fakeDb.table.get("1:CONF") };
    const item = mockItem("CONF", legacyConfirmation);
    useItems(item);

    await migrateFromExtraV1();

    expect(fakeDb.table.get("1:CONF")).toEqual(before);
    expect(getTitleMatchMeta(item)).toMatchObject({
      confirmedOpenAlexId: "W2",
      matchConfidence: "medium",
    });
    expect(linesStartingWith(COMPLETE)[0]).toContain("matches imported 0, kept as cached 1");
  });

  it("keeps a no-match, which may be the user's 'Not this paper'", async () => {
    const item = mockItem("DISMISSED", legacyConfirmation);
    await dismissAsNoMatch(item);
    const before = { ...fakeDb.table.get("1:DISMISSED") };
    useItems(item);

    await migrateFromExtraV1();

    expect(fakeDb.table.get("1:DISMISSED")).toEqual(before);
    expect(getTitleMatchMeta(item)).toMatchObject({ noMatch: true, confirmedOpenAlexId: null });
  });

  it("keeps metrics a later lookup fetched for another work", async () => {
    const item = mockItem("OTHER", legacyConfirmation);
    await cacheWorkData(item, {
      id: "https://openalex.org/W3",
      cited_by_count: 8,
      fwci: null,
      is_retracted: false,
    });
    const before = { ...fakeDb.table.get("1:OTHER") };
    useItems(item);

    await migrateFromExtraV1();

    expect(fakeDb.table.get("1:OTHER")).toEqual(before);
    expect(getTitleMatchMeta(item).confirmedOpenAlexId).toBeNull();
  });

  it("confirms over a pending suggestion, clearing it as a confirm in the pane does", async () => {
    const item = mockItem("PENDING", legacyConfirmation);
    await writePendingSuggestion(
      item,
      {
        id: "https://openalex.org/W9",
        display_name: "Another paper",
        cited_by_count: 2,
        fwci: null,
        publication_year: 2020,
        doi: null,
      },
      "medium",
      0.8,
    );
    useItems(item);

    await migrateFromExtraV1();

    expect(getTitleMatchMeta(item)).toMatchObject({
      confirmedOpenAlexId: "W1",
      matchConfidence: "high",
    });
    expect(getPendingSuggestion(item)).toBeNull();
  });

  it("confirms over metrics for the same work, and keeps them", async () => {
    const item = mockItem("SAMEWORK", legacyConfirmation);
    await cacheWorkData(item, {
      id: "https://openalex.org/W1",
      cited_by_count: 8,
      fwci: null,
      is_retracted: false,
    });
    useItems(item);

    await migrateFromExtraV1();

    expect(getTitleMatchMeta(item).confirmedOpenAlexId).toBe("W1");
    expect(getCachedCitationCount(item)).toBe(8);
  });
});

// ── Once per profile ───────────────────────────────────────────────────────

describe("the import runs once per profile", () => {
  it("runs on a v2.0.x profile, whose done flag the migration that never ran had set", async () => {
    // Every v2.0.x profile: migrationV1Complete under the doubled name (and, once
    // U18 copied it forward, under the real one), and a cache the runtime filled
    // since, which is what made the old guard trust the flag.
    mockZotero.Prefs.user.set(doubled(PREF_MIGRATION_COMPLETE), true);
    mockZotero.Prefs.user.set(PREF_MIGRATION_COMPLETE, true);
    const fetched = mockItem("FETCHED");
    await cacheWorkData(fetched, {
      id: "https://openalex.org/W5",
      cited_by_count: 1,
      fwci: null,
      is_retracted: false,
    });
    const legacy = mockItem("LEGACY", "Citegeist.confirmedOpenAlexId: W6");
    useItems(fetched, legacy);

    await migrateFromExtraV1();

    expect(getTitleMatchMeta(legacy).confirmedOpenAlexId).toBe("W6");
    expect(importDone()).toBe(true);
  });

  it("does not scan again once a pass has read every library", async () => {
    const first = mockItem("FIRST", "Citegeist.confirmedOpenAlexId: W1");
    useItems(first);
    await migrateFromExtraV1();
    expect(importDone(), "positive control: the first pass finished").toBe(true);

    // The next launch, with a confirmation a scan would import.
    await closeCache();
    await initCache();
    const later = mockItem("LATER", "Citegeist.confirmedOpenAlexId: W2");
    const mine = useItems(first, later);
    mockZotero.Libraries.getAll.mockClear();
    mockZotero.Items.getAll.mockClear();
    mockZotero.Sync.Runner.delayIndefinite.mockClear();
    mockZotero.debug.mockClear();

    await migrateFromExtraV1();

    expect(mockZotero.Libraries.getAll).not.toHaveBeenCalled();
    expect(mockZotero.Items.getAll).not.toHaveBeenCalled();
    expect(mine.waitForDataLoad).not.toHaveBeenCalled();
    expect(mockZotero.Sync.Runner.delayIndefinite).not.toHaveBeenCalled();
    expect(getTitleMatchMeta(later).confirmedOpenAlexId).toBeNull();
    expect(debugLines().filter((line) => line.startsWith("[Citegeist] migration"))).toEqual([]);
  });

  it("finishes a pass that finds nothing, and sets its flag", async () => {
    useItems(mockItem("PLAIN", "An ordinary note"));

    await migrateFromExtraV1();

    expect(importDone()).toBe(true);
    expect(linesStartingWith(STARTED)).toHaveLength(1);
    expect(linesStartingWith(COMPLETE)).toHaveLength(1);
  });

  it("sets the v2.0.x done flag under both names too, so a copy downgraded to v2.0.x starts no migration", async () => {
    // v2.0.5 reads the full name without `global`, which lands on the doubled name.
    const readByV205 = () => mockZotero.Prefs.get(PREF_MIGRATION_COMPLETE);
    expect(readByV205(), "positive control: no flag before the pass").toBeUndefined();

    await migrateFromExtraV1();

    expect(mockZotero.Prefs.user.get(PREF_MIGRATION_COMPLETE)).toBe(true);
    expect(readByV205()).toBe(true);
  });

  it("does nothing on a read-only cache, leaving the import to a launch that can write", async () => {
    await closeCache();
    fakeDb.pragma.userVersion = (CACHE_SCHEMA_MAJOR + 1) * CACHE_SCHEMA_STAMP_MULTIPLIER;
    await initCache();
    useItems(mockItem("RO", "Citegeist.confirmedOpenAlexId: W1"));
    mockZotero.Libraries.getAll.mockClear();

    expect(await migrateFromExtraV1()).toBe(false);

    expect(mockZotero.Libraries.getAll).not.toHaveBeenCalled();
    expect(fakeDb.table.size).toBe(0);
    expect(importDone()).toBeUndefined();
  });

  it("records a preference it can't read and resolves, so startup goes on", async () => {
    mockZotero.Prefs.get.mockImplementationOnce(() => {
      throw new Error("prefs.js is locked");
    });

    await expect(migrateFromExtraV1()).resolves.toBe(false);

    expect(recentDiagnostics().map((d) => d.context)).toContain("migration");
    expect(mockZotero.Libraries.getAll).not.toHaveBeenCalled();
  });
});

// ── Cut short ──────────────────────────────────────────────────────────────

describe("a pass cut short runs again at the next launch", () => {
  it("keeps what it imported when the cache closes mid-pass, and imports the rest next launch", async () => {
    const first = mockItem("FIRST", "Citegeist.confirmedOpenAlexId: W1");
    const second = mockItem("SECOND", "Citegeist match ID: W2");
    let closing: Promise<void> | undefined;
    // Citegeist is disabled while the pass reads the second item.
    (second.getField as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      closing = closeCache();
      return items.get("SECOND")!.extra;
    });
    useItems(first, second);

    await migrateFromExtraV1();
    await closing;

    expect(fakeDb.table.has("1:FIRST")).toBe(true);
    expect(fakeDb.table.has("1:SECOND")).toBe(false);
    expect(importDone()).toBeUndefined();
    expect(mockZotero.Prefs.user.has(PREF_MIGRATION_COMPLETE)).toBe(false);
    expect(syncRelease()).toHaveBeenCalledTimes(1);
    expect(linesStartingWith("[Citegeist] migration stopped by the cache closed")).toHaveLength(1);
    expect(recentDiagnostics(), "a shutdown is not a failure").toEqual([]);

    await initCache();
    await migrateFromExtraV1();

    expect(getTitleMatchMeta(first).confirmedOpenAlexId).toBe("W1");
    expect(getTitleMatchMeta(second).confirmedOpenAlexId).toBe("W2");
    expect(importDone()).toBe(true);
    expect(linesStartingWith(COMPLETE)[0]).toContain("matches imported 1, kept as cached 1");
  });

  it("stops reading once the cache closes, loading no further library, even with nothing left to write", async () => {
    const mine = library(1);
    const group = library(4, "group");
    let closing: Promise<void> | undefined;
    // Citegeist is disabled while the pass loads My Library.
    mine.waitForDataLoad.mockImplementationOnce(async () => {
      closing = closeCache();
    });
    useLibraries(
      [mine, [mockItem("PLAIN", "An ordinary note")]],
      [group, [libraryItem(4, "GROUP", "Citegeist.confirmedOpenAlexId: W4")]],
    );

    await migrateFromExtraV1();
    await closing;

    expect(group.waitForDataLoad).not.toHaveBeenCalled();
    expect(importDone()).toBeUndefined();
    expect(syncRelease()).toHaveBeenCalledTimes(1);
  });

  it("stops at a write that fails, records it, and leaves the next launch to finish", async () => {
    useItems(
      mockItem("A", "Citegeist.confirmedOpenAlexId: W1"),
      mockItem("B", "Citegeist.confirmedOpenAlexId: W2"),
    );
    const base = fakeDb.queryAsync.getMockImplementation()!;
    fakeDb.queryAsync.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/^INSERT\s+OR\s+REPLACE\s+INTO\s+item_cache/i.test(sql.trim()) && params?.[1] === "A") {
        throw new Error("database is locked");
      }
      return base(sql, params);
    });

    await migrateFromExtraV1();

    expect(fakeDb.table.size, "the pass stopped at the failed write").toBe(0);
    expect(importDone()).toBeUndefined();
    expect(recentDiagnostics().map((d) => d.code)).toEqual(["CG-DB01"]);
    expect(syncRelease()).toHaveBeenCalledTimes(1);

    fakeDb.queryAsync.mockImplementation(base);
    await migrateFromExtraV1();

    expect(fakeDb.table.size).toBe(2);
    expect(importDone()).toBe(true);
  });

  it("reads the other libraries when one fails to load, and leaves the pass unfinished", async () => {
    const mine = library(1);
    const group = library(4, "group");
    group.waitForDataLoad.mockRejectedValueOnce(new Error("group library unavailable"));
    const inGroup = libraryItem(4, "GROUP", "Citegeist.confirmedOpenAlexId: W4");
    const inMine = mockItem("MINE", "Citegeist.confirmedOpenAlexId: W1");
    useLibraries([group, [inGroup]], [mine, [inMine]]);

    await migrateFromExtraV1();

    expect(getTitleMatchMeta(inMine).confirmedOpenAlexId).toBe("W1");
    expect(getTitleMatchMeta(inGroup).confirmedOpenAlexId).toBeNull();
    expect(importDone()).toBeUndefined();
    expect(recentDiagnostics().map((d) => d.context)).toContain("migration: read library 4");

    await migrateFromExtraV1();

    expect(getTitleMatchMeta(inGroup).confirmedOpenAlexId).toBe("W4");
    expect(importDone()).toBe(true);
  });

  it("skips an item Zotero can't read and still finishes, so it never scans every launch", async () => {
    const unreadable = mockItem("UNREAD", "Citegeist.confirmedOpenAlexId: W1");
    (unreadable.getField as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("Item data not loaded");
    });
    const readable = mockItem("READ", "Citegeist.confirmedOpenAlexId: W2");
    useItems(unreadable, readable);

    await migrateFromExtraV1();

    expect(getTitleMatchMeta(readable).confirmedOpenAlexId).toBe("W2");
    expect(importDone()).toBe(true);
    expect(linesStartingWith(COMPLETE)[0]).toContain("unreadable 1");
  });
});

// ── Sync ───────────────────────────────────────────────────────────────────

describe("sync waits while a pass runs", () => {
  it("holds sync with Zotero's delayIndefinite for the whole pass, and releases it once", async () => {
    let heldAt = -1;
    let releasedAt = -1;
    const release = vi.fn(() => {
      releasedAt = fakeDb.statements.length;
    });
    mockZotero.Sync.Runner.delayIndefinite.mockImplementationOnce(() => {
      heldAt = fakeDb.statements.length;
      return release;
    });
    useItems(
      mockItem("A", "Citegeist.confirmedOpenAlexId: W1"),
      mockItem("B", "Citegeist match ID: W2"),
    );

    await migrateFromExtraV1();

    const writes = fakeDb.statements
      .map((statement, index) => ({ statement, index }))
      .filter(({ statement }) => /^INSERT/i.test(statement.sql.trim()))
      .map(({ index }) => index);
    expect(writes, "positive control: the pass imported both").toHaveLength(2);
    for (const index of writes) {
      expect(index).toBeGreaterThanOrEqual(heldAt);
      expect(index).toBeLessThan(releasedAt);
    }
    expect(heldAt).toBeGreaterThanOrEqual(0);
    expect(release).toHaveBeenCalledTimes(1);
    expect(mockZotero.Sync.Runner.delaySync).not.toHaveBeenCalled();
  });

  it("releases the hold when a pass fails", async () => {
    mockZotero.Items.getAll.mockRejectedValueOnce(new Error("items unavailable"));

    await migrateFromExtraV1();

    expect(syncRelease()).toHaveBeenCalledTimes(1);
    expect(importDone()).toBeUndefined();
  });

  it("the harness's delaySync is Zotero's: it never runs a function it is given", async () => {
    let ran = false;
    // The call BUG-MIGRATION shipped, against the harness's Zotero.
    const delaySync = mockZotero.Sync.Runner.delaySync as unknown as (fn: () => unknown) => unknown;
    await delaySync(async () => {
      ran = true;
    });
    expect(ran).toBe(false);
  });
});

// ── U18: orphan-GC time, under its real name ───────────────────────────────

describe("orphan-GC prefs (U18)", () => {
  async function cachedItem(key: string, workId: string): Promise<_ZoteroTypes.Item> {
    const item = mockItem(key);
    await cacheWorkData(item, {
      id: `https://openalex.org/${workId}`,
      cited_by_count: 1,
      fwci: null,
      is_retracted: false,
    });
    return item;
  }

  it("records the orphan-GC time so a second run inside the interval skips", async () => {
    mockZotero.Items.getAll.mockResolvedValue([]); // every cached row is an orphan
    const first = await cachedItem("G1", "W90013");
    await garbageCollectOrphans({ force: true });
    expect(getCachedData(first)).toBeNull();

    const second = await cachedItem("G2", "W90014");
    await garbageCollectOrphans();

    expect(getCachedData(second), "GC ran again inside its interval").not.toBeNull();
    expect(mockZotero.Prefs.user.get(PREF_LAST_ORPHAN_GC_AT)).toMatch(/^\d+$/);
  });

  it("ignores the wrapped integer earlier builds left under the doubled name", async () => {
    mockZotero.Items.getAll.mockResolvedValue([]);
    mockZotero.Prefs.user.set(doubled(PREF_LAST_ORPHAN_GC_AT), Date.now() | 0);
    const orphan = await cachedItem("G3", "W90015");

    await garbageCollectOrphans();

    expect(getCachedData(orphan)).toBeNull();
    expect(mockZotero.Prefs.user.get(PREF_LAST_ORPHAN_GC_AT)).toMatch(/^\d+$/);
  });

  it("records the time of a GC that found no orphans, so the next run inside the interval skips", async () => {
    mockZotero.Items.getAll.mockResolvedValue([]); // every cached row is an orphan
    await garbageCollectOrphans(); // nothing cached yet, so nothing to remove
    expect(mockZotero.Prefs.user.get(PREF_LAST_ORPHAN_GC_AT)).toMatch(/^\d+$/);

    const orphan = await cachedItem("G4", "W90016");
    await garbageCollectOrphans();

    expect(getCachedData(orphan), "GC ran again inside its interval").not.toBeNull();
  });

  it("runs the GC when the recorded time is later than now", async () => {
    mockZotero.Items.getAll.mockResolvedValue([]);
    const nextYear = Date.now() + 365 * 24 * 60 * 60 * 1000;
    mockZotero.Prefs.user.set(PREF_LAST_ORPHAN_GC_AT, String(nextYear));
    const orphan = await cachedItem("G5", "W90017");

    await garbageCollectOrphans();

    expect(getCachedData(orphan)).toBeNull();
  });
});

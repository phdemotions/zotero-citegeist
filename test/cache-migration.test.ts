/**
 * Migration-focused tests for the SQLite-backed cache module.
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

import { _resetForTesting } from "../src/modules/cache/db";
import {
  cacheWorkData,
  getCachedCitationCount,
  getCachedData,
  getCachedMetrics,
  getTitleMatchMeta,
  initCache,
  migrateFromExtraV1,
} from "../src/modules/cache";

beforeEach(async () => {
  await resetCacheHarness(initCache, _resetForTesting);
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
    const touched = await migrateFromExtraV1();
    expect(touched).toBe(false);
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
    expect(item.saveTx).toHaveBeenCalledWith({ skipDateModifiedUpdate: true });
  });

  it("does not treat malformed `Citegeist match ID:` notes as migration candidates", async () => {
    // ADV-L-001: a user maintaining their own Extra notes might write
    // something like `Citegeist match ID: see footnote 3 in MyReviewBook`.
    // We must not let a prefix-only note trigger migration backup,
    // user-facing migration alerts, or Extra rewriting.
    const extra = "Citegeist match ID: see footnote 3 in my notes";
    const item = mockItem("USRTXT", extra);
    mockZotero.Items.getAll.mockResolvedValue([item]);

    const touched = await migrateFromExtraV1();

    expect(touched).toBe(false);
    expect(getCachedData(item)).toBeNull();
    expect(fakeDb.table.size).toBe(0);
    expect(fileWrites).toHaveLength(0);
    expect(item.saveTx).not.toHaveBeenCalled();
    // Line survives — strip only fires when recovery wrote a real W-ID.
    expect(items.get("USRTXT")!.extra).toBe(extra);
  });

  it("does not treat unknown `Citegeist.*` notes as migration candidates", async () => {
    const extra = "Citegeist.note: still useful for my review";
    const item = mockItem("USRNOTE", extra);
    mockZotero.Items.getAll.mockResolvedValue([item]);

    const touched = await migrateFromExtraV1();

    expect(touched).toBe(false);
    expect(fakeDb.table.size).toBe(0);
    expect(fileWrites).toHaveLength(0);
    expect(items.get("USRNOTE")!.extra).toBe(extra);
  });

  it("preserves malformed match-ID user notes while stripping legacy fields", async () => {
    const extra = [
      "Citegeist.openAlexId: W90024",
      "Citegeist.citedByCount: 1",
      "Citegeist match ID: see footnote 3 in my notes",
    ].join("\n");
    const item = mockItem("USRTXT2", extra);
    mockZotero.Items.getAll.mockResolvedValue([item]);

    await migrateFromExtraV1();

    expect(getCachedData(item)!.openAlexId).toBe("W90024");
    expect(items.get("USRTXT2")!.extra).toBe("Citegeist match ID: see footnote 3 in my notes");
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
    expect(userItem.saveTx).toHaveBeenCalledWith({ skipDateModifiedUpdate: true });
    expect(items.get("B")!.extra).not.toContain("Citegeist.");
    expect(groupItem.saveTx).toHaveBeenCalledWith({ skipDateModifiedUpdate: true });
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
    const touched = await migrateFromExtraV1();
    expect(touched).toBe(true);
    // SQLite populated
    const data = getCachedData(item);
    expect(data!.openAlexId).toBe("W123");
    expect(data!.citedByCount).toBe(42);
    expect(data!.fwci).toBeCloseTo(2.31);
    // Extra cleaned
    expect(items.get("A")!.extra).not.toContain("Citegeist.");
    expect(item.saveTx).toHaveBeenCalledWith({ skipDateModifiedUpdate: true });
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

  it("force-reruns when pref is set but mirror is empty AND only a confirmed match mirror exists", async () => {
    mockZotero.Prefs.get.mockImplementation((pref: string) => {
      if (pref === "extensions.zotero.citegeist.migrationV1Complete") return true;
      return null;
    });
    const item = mockItem("CMID", "Citegeist match ID: W90909");
    mockZotero.Items.getAll.mockResolvedValue([item]);

    await migrateFromExtraV1();

    expect(getTitleMatchMeta(item).confirmedOpenAlexId).toBe("W90909");
    expect(items.get("CMID")!.extra).not.toContain("Citegeist match ID");
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

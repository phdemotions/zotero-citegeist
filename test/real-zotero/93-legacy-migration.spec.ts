/**
 * The one-time import of confirmed title matches from Extra: at the first
 * startup of a profile without its flag, Citegeist copies the match each item's
 * Citegeist lines confirm into citegeist.sqlite, changes no item, and never
 * scans again.
 *
 * RESTARTS THE PLUGIN, so it is numbered in the 90s (00-root-hooks.spec.ts). It
 * disables Citegeist to seed and read citegeist.sqlite, which Citegeist holds
 * under an EXCLUSIVE lock while it runs (91-schema-stamp.spec.ts), and waits for
 * the "[Citegeist] Shutdown complete" line each time. Its after hook leaves a
 * running copy.
 *
 * Catches: an import that never runs, as the v2.0.0 migration never did
 * (BUG-MIGRATION: `Zotero.Sync.Runner.delaySync` takes milliseconds and never
 * calls a function); one that writes or saves an item it reads; one that
 * replaces a no-match the cache already holds; a flag that is never set; and a
 * startup that scans again once it is set.
 *
 * The seeded items carry no DOI, so the background lookups leave them alone, and
 * the confirmed works are ones the OpenAlex stub does not know, so a lookup by
 * an imported id finds nothing and writes nothing.
 */
import { PREF_EXTRA_MATCH_IMPORT_COMPLETE } from "../../src/constants";
import { linesAdded } from "./shared/debugLines";
import { BUDGETS, SHUTDOWN_WAIT_TIMEOUT_MS, STARTUP_WAIT_TIMEOUT_MS } from "./shared/timeouts";
import { SHUTDOWN_COMPLETE_DEBUG_LINE } from "./support/citegeist";
import {
  debugLinesContaining,
  ensureCitegeistReady,
  getCitegeistAddon,
  waitFor,
  waitForCitegeistReady,
  waitForNewDebugLine,
} from "./support/zotero";

/**
 * The Debug Output lines an import pass writes (src/modules/cache/migration.ts);
 * test/cache-migration.test.ts checks the same text against what it logs.
 */
const MIGRATION_MARK = "[Citegeist] migration";
const MIGRATION_STARTED = "[Citegeist] migration started";
const MIGRATION_COMPLETE = "[Citegeist] migration complete";

/** When the seeded no-match was recorded. */
const DISMISSED_AT = "2026-09-01T00:00:00.000Z";

interface Seed {
  readonly name: string;
  readonly extra: string;
}

/** Four items as a v1.3.x or v2.x profile holds them. v1.x wrote its lines after the user's own. */
const SEEDS: readonly Seed[] = [
  {
    name: "confirmed in v1.3.x",
    extra: [
      "Read for chapter 3",
      "tex.citekey: smith2019legacy",
      "Citegeist.openAlexId: W9300000001",
      "Citegeist.citedByCount: 17",
      "Citegeist.fwci: 1.20",
      "Citegeist.lastFetched: 2026-03-01T12:00:00.000Z",
      "Citegeist.matchMethod: title-match",
      "Citegeist.matchConfidence: high",
      "Citegeist.confirmedOpenAlexId: W9300000001",
    ].join("\n"),
  },
  {
    name: "confirmed in v2.x",
    extra: "Read for chapter 4\nCitegeist match ID: W9300000002",
  },
  {
    name: "v1.3.x metrics only",
    extra: [
      "Citegeist.openAlexId: W9300000003",
      "Citegeist.citedByCount: 5",
      "Citegeist.note: my own reminder",
    ].join("\n"),
  },
  {
    name: "no-match in the cache",
    extra: "Citegeist.matchConfidence: medium\nCitegeist.confirmedOpenAlexId: W9300000004",
  },
];

/** An item's Extra as Zotero stores it, with the columns any save of the item changes. */
interface StoredItem {
  readonly extra: string;
  readonly dateModified: string;
  readonly clientDateModified: string;
  readonly synced: number;
  readonly version: number;
}

interface Seeded extends Seed {
  readonly id: number;
  readonly libraryID: number;
  readonly key: string;
  readonly stored: StoredItem;
}

/** The part of Zotero's DBConnection this spec uses on citegeist.sqlite. */
interface CacheFileConnection {
  queryAsync(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>> | undefined>;
  closeDatabase(permanent: boolean): Promise<void>;
}

/** The item_cache columns the spec reads, copied out of Zotero's row proxy. */
const ROW_COLUMNS = [
  "confirmed_open_alex_id",
  "match_method",
  "match_confidence",
  "no_match",
  "open_alex_id",
  "cited_by_count",
] as const;

async function storedItem(itemID: number): Promise<StoredItem> {
  const extra = await Zotero.DB.valueQueryAsync(
    "SELECT value FROM itemData JOIN itemDataValues USING (valueID) WHERE itemID = ? AND fieldID = ?",
    [itemID, Zotero.ItemFields.getID("extra")],
  );
  const row = await Zotero.DB.rowQueryAsync(
    "SELECT dateModified, clientDateModified, synced, version FROM items WHERE itemID = ?",
    [itemID],
  );
  return {
    extra: String(extra),
    dateModified: String(row.dateModified),
    clientDateModified: String(row.clientDateModified),
    synced: Number(row.synced),
    version: Number(row.version),
  };
}

async function createSeeded(seed: Seed): Promise<Seeded> {
  const item = new Zotero.Item("journalArticle");
  item.setField("title", `Citegeist legacy-import spec: ${seed.name}`);
  item.setField("extra", seed.extra);
  await item.saveTx({ skipSelect: true });
  return {
    ...seed,
    id: item.id,
    libraryID: item.libraryID,
    key: item.key,
    stored: await storedItem(item.id),
  };
}

/** Every seeded item's Extra and save columns are as they were when it was created. */
async function expectItemsUnchanged(seeded: readonly Seeded[]): Promise<void> {
  for (const item of seeded) {
    expect(await storedItem(item.id), `${item.name}: stored`).to.deep.equal(item.stored);
    expect(Zotero.Items.get(item.id).getField("extra"), `${item.name}: in memory`).to.equal(
      item.stored.extra,
    );
  }
}

/** Disable Citegeist and wait until its cache has closed. A no-op when it is already inactive. */
async function disableCitegeist(): Promise<void> {
  const addon = await getCitegeistAddon();
  if (!addon.isActive) return;
  const shutdownsBefore = debugLinesContaining(SHUTDOWN_COMPLETE_DEBUG_LINE);
  await addon.disable();
  await waitForNewDebugLine(
    "Citegeist's shutdown to complete (its cache closed)",
    SHUTDOWN_COMPLETE_DEBUG_LINE,
    shutdownsBefore,
    SHUTDOWN_WAIT_TIMEOUT_MS,
  );
  await waitFor("Zotero to report Citegeist inactive", async () => {
    return !(await getCitegeistAddon()).isActive;
  });
}

/** Enable Citegeist and wait until its startup, and so any import, has finished. */
async function enableCitegeist(what: string): Promise<void> {
  const addon = await getCitegeistAddon();
  await addon.enable();
  await waitForCitegeistReady(what, STARTUP_WAIT_TIMEOUT_MS);
}

/** Run `fn` on citegeist.sqlite over the spec's own connection. Citegeist must be disabled. */
async function withCacheFile<T>(fn: (conn: CacheFileConnection) => Promise<T>): Promise<T> {
  const conn: CacheFileConnection = new Zotero.DBConnection("citegeist");
  try {
    return await fn(conn);
  } finally {
    // Release the file before Citegeist opens it again.
    await conn.closeDatabase(true);
  }
}

/** The item's cache row, or null when it has none. */
async function cacheRow(
  conn: CacheFileConnection,
  item: Seeded,
): Promise<Record<string, unknown> | null> {
  const rows = await conn.queryAsync(
    `SELECT ${ROW_COLUMNS.join(", ")} FROM item_cache WHERE library_id = ? AND item_key = ?`,
    [item.libraryID, item.key],
  );
  const row = rows?.[0];
  return row ? Object.fromEntries(ROW_COLUMNS.map((column) => [column, row[column]])) : null;
}

describe("the one-time import of confirmed title matches from Extra", function () {
  const seeded: Seeded[] = [];
  const seededAs = (name: string): Seeded => {
    const item = seeded.find((s) => s.name === name);
    if (!item) throw new Error(`the "${name}" item was never created`);
    return item;
  };

  before(async function () {
    this.timeout(BUDGETS.legacyImportSetup.timeoutMs);
    // Start from a running copy even when an earlier spec failed partway.
    await ensureCitegeistReady();
    for (const seed of SEEDS) seeded.push(await createSeeded(seed));
  });

  after(async function () {
    this.timeout(BUDGETS.legacyImportSetup.timeoutMs);
    await ensureCitegeistReady();
    for (const { id } of seeded) {
      const item = await Zotero.Items.getAsync(id);
      if (item) await item.eraseTx();
    }
  });

  it("imports the confirmed matches at the first startup without its flag, and changes no item", async function () {
    this.timeout(BUDGETS.legacyImportRun.timeoutMs);
    const dismissed = seededAs("no-match in the cache");
    await disableCitegeist();
    // A no-match the cache already holds, as a "Not this paper" leaves it.
    await withCacheFile((conn) =>
      conn.queryAsync(
        "INSERT OR REPLACE INTO item_cache (library_id, item_key, no_match, no_match_timestamp) VALUES (?, ?, 1, ?)",
        [dismissed.libraryID, dismissed.key, DISMISSED_AT],
      ),
    );
    Services.prefs.clearUserPref(PREF_EXTRA_MATCH_IMPORT_COMPLETE);
    const linesBefore = debugLinesContaining(MIGRATION_MARK);

    await enableCitegeist("Citegeist to start and run the import");

    const lines = linesAdded(linesBefore, debugLinesContaining(MIGRATION_MARK));
    expect(
      lines.filter((line) => line.includes(MIGRATION_STARTED)),
      lines.join("\n"),
    ).to.have.length(1);
    expect(
      lines.filter((line) => line.includes(MIGRATION_COMPLETE)),
      lines.join("\n"),
    ).to.have.length(1);
    expect(
      Services.prefs.getBoolPref(PREF_EXTRA_MATCH_IMPORT_COMPLETE, false),
      "the import's flag after the pass",
    ).to.equal(true);
    await expectItemsUnchanged(seeded);
  });

  it("holds each imported match in citegeist.sqlite, and the no-match as it found it", async function () {
    this.timeout(BUDGETS.legacyImportRead.timeoutMs);
    await disableCitegeist();
    const rows = await withCacheFile(async (conn) => {
      const byName = new Map<string, Record<string, unknown> | null>();
      for (const item of seeded) byName.set(item.name, await cacheRow(conn, item));
      return byName;
    });

    expect(rows.get("confirmed in v1.3.x")).to.deep.include({
      confirmed_open_alex_id: "W9300000001",
      match_method: "title-match",
      match_confidence: "high",
    });
    expect(rows.get("confirmed in v2.x")).to.deep.include({
      confirmed_open_alex_id: "W9300000002",
      match_method: "title-match",
    });
    expect(
      rows.get("v1.3.x metrics only"),
      "an item with no confirmed match gets no row: its metrics are fetched again",
    ).to.equal(null);
    expect(rows.get("no-match in the cache")).to.deep.include({
      confirmed_open_alex_id: null,
      no_match: 1,
    });
  });

  it("does not scan again at the next startup, and still changes no item", async function () {
    this.timeout(BUDGETS.legacyImportRescan.timeoutMs);
    const linesBefore = debugLinesContaining(MIGRATION_MARK);

    await enableCitegeist("Citegeist to start again after the import");

    expect(linesAdded(linesBefore, debugLinesContaining(MIGRATION_MARK))).to.be.empty;
    await expectItemsUnchanged(seeded);
  });
});

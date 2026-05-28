/**
 * Connection + in-memory mirror lifecycle.
 *
 * The mirror is required because Zotero's column `dataProvider` callback
 * is synchronous (return type `string`, not `Promise<string>`) but the
 * SQLite API is async-only. We load all rows into a `Map` at startup so
 * read functions can stay sync; writes update SQLite first, then the map.
 *
 * Concurrency model
 * ─────────────────
 * • `initCache` is idempotent and races-safe: simultaneous calls share
 *   the same in-flight promise (Zotero may re-fire `onStartup` during a
 *   plugin-update restart sequence).
 * • Writes to the same `(libraryID, itemKey)` are serialized via a small
 *   per-key promise chain so that mirror state never diverges from SQLite.
 * • `closeCache` waits for all pending writes before closing the DB.
 */

import { CLOSE_CACHE_DRAIN_TIMEOUT_MS } from "../../constants";
import { COLUMNS, type ItemCacheRow, mirrorKey, rowToParams } from "./types";

/** Pre-computed UPSERT statement. COLUMNS is `as const` so this never changes. */
const UPSERT_SQL = `INSERT OR REPLACE INTO item_cache (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(
  () => "?",
).join(", ")})`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS item_cache (
  library_id                INTEGER NOT NULL,
  item_key                  TEXT NOT NULL,
  open_alex_id              TEXT,
  cited_by_count            INTEGER,
  fwci                      REAL,
  percentile                REAL,
  is_top_1_percent          INTEGER,
  is_top_10_percent         INTEGER,
  is_retracted              INTEGER,
  last_fetched              TEXT,
  source_id                 TEXT,
  citedness_2yr             REAL,
  journal_h_index           INTEGER,
  source_issns              TEXT,
  issn_l                    TEXT,
  no_match                  INTEGER,
  no_match_timestamp        TEXT,
  match_method              TEXT,
  match_confidence          TEXT,
  confirmed_open_alex_id    TEXT,
  pending_open_alex_id      TEXT,
  pending_title             TEXT,
  pending_cited_by_count    INTEGER,
  pending_fwci              REAL,
  pending_year              INTEGER,
  pending_tier              TEXT,
  pending_confidence        REAL,
  pending_doi               TEXT,
  PRIMARY KEY (library_id, item_key)
);
`;

const CREATE_PROGRESS_TABLE = `
CREATE TABLE IF NOT EXISTS migration_progress (
  library_id  INTEGER NOT NULL,
  item_key    TEXT NOT NULL,
  migrated_at TEXT NOT NULL,
  PRIMARY KEY (library_id, item_key)
);
`;

/**
 * Schema-version table. Establishes the convention now (empty in v1.4.0) so
 * future schema changes can ship an idempotent migration runner that reads
 * the recorded version, applies missing steps in order, and updates the row.
 */
const CREATE_SCHEMA_META = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Current schema version. Bump and add a migration when changing the shape. */
const SCHEMA_VERSION = "1";

let db: _ZoteroTypes.DBConnection | null = null;
let mirror: Map<string, ItemCacheRow> = new Map();
let initialized = false;
let initPromise: Promise<void> | null = null;

/** Per-(libraryID,itemKey) write tail. Each new write awaits the prior tail. */
const writeTails: Map<string, Promise<void>> = new Map();
/** Outstanding write promises tracked for `closeCache` to drain. */
const pendingWrites: Set<Promise<void>> = new Set();

/**
 * Initialize the cache: open the DB, ensure schema, load the in-memory mirror.
 * Must be called from `onStartup` before any read function runs.
 *
 * Race-safe: concurrent callers share the same in-flight promise instead of
 * each opening their own `DBConnection`.
 */
export function initCache(): Promise<void> {
  if (initialized) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = doInit().finally(() => {
    initPromise = null;
  });
  return initPromise;
}

async function doInit(): Promise<void> {
  db = new Zotero.DBConnection("citegeist");
  await db.queryAsync(SCHEMA);
  await db.queryAsync(CREATE_PROGRESS_TABLE);
  await db.queryAsync(CREATE_SCHEMA_META);
  // Drop any index left behind by an earlier v1.4.0 alpha. Staleness queries
  // happen against the in-memory mirror, never against SQLite, so the index
  // is pure write-amplification overhead.
  await db.queryAsync(`DROP INDEX IF EXISTS idx_item_cache_last_fetched`);
  // Record current schema version (idempotent — REPLACE keeps a single row).
  await db.queryAsync(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)`, [
    SCHEMA_VERSION,
  ]);

  const rows = await db.queryAsync<ItemCacheRow>(`SELECT * FROM item_cache`);
  mirror = new Map(rows.map((r) => [mirrorKey(r.library_id, r.item_key), r]));

  initialized = true;
  Zotero.debug(`[Citegeist] cache initialized: ${mirror.size} rows (schema v${SCHEMA_VERSION})`);
}

/**
 * Close the DB connection on shutdown. Drains pending writes first, with a
 * bounded timeout so a hung write (locked DB, antivirus stall) doesn't block
 * Zotero's shutdown sequence indefinitely.
 */
export async function closeCache(): Promise<void> {
  if (pendingWrites.size > 0) {
    const drain = Promise.allSettled([...pendingWrites]);
    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), CLOSE_CACHE_DRAIN_TIMEOUT_MS);
    });
    const result = await Promise.race([drain, timeout]);
    if (result === "timeout") {
      Zotero.debug(
        `[Citegeist] closeCache: pending writes did not drain within ${CLOSE_CACHE_DRAIN_TIMEOUT_MS}ms; forcing close`,
      );
    }
  }
  if (db) {
    await db.closeDatabase(false);
    db = null;
  }
  mirror = new Map();
  writeTails.clear();
  pendingWrites.clear();
  initialized = false;
}

/**
 * Test-only: inject a fake DBConnection and reset the mirror.
 */
export function _resetForTesting(fakeDb?: _ZoteroTypes.DBConnection): void {
  db = fakeDb ?? null;
  mirror = new Map();
  writeTails.clear();
  pendingWrites.clear();
  initialized = false;
  initPromise = null;
}

/**
 * Returns the live DB connection. Throws if init hasn't completed —
 * callers should accept the throw as a signal that the cache layer is
 * genuinely broken (e.g., disk full, locked DB).
 */
export function requireDb(): _ZoteroTypes.DBConnection {
  if (!db || !initialized) {
    throw new Error("[Citegeist] cache not initialized — call initCache() first");
  }
  return db;
}

export function getRow(libraryID: number, itemKey: string): ItemCacheRow | undefined {
  return mirror.get(mirrorKey(libraryID, itemKey));
}

/**
 * Snapshot of mirror entries as an array — safe to iterate while concurrent
 * writes mutate the underlying Map. Used by orphan GC.
 */
export function mirrorSnapshot(): Array<[string, ItemCacheRow]> {
  return [...mirror.entries()];
}

export function deleteMirrorEntries(keys: Iterable<string>): void {
  for (const k of keys) mirror.delete(k);
}

/**
 * Validate that a row's (libraryID, itemKey) pair looks safe to persist.
 * Defensive — Zotero's data model normally guarantees these, but a corrupt
 * item or in-memory transient could slip through.
 */
function assertWritableKey(libraryID: number, itemKey: string): void {
  if (!Number.isInteger(libraryID) || libraryID < 1) {
    throw new Error(`[Citegeist] invalid libraryID for cache write: ${libraryID}`);
  }
  if (typeof itemKey !== "string" || itemKey.length === 0) {
    throw new Error(`[Citegeist] invalid item key for cache write: ${itemKey}`);
  }
}

/**
 * Run `fn` serialized against any prior write to the same `(libraryID,
 * itemKey)` pair. Different keys run in parallel; same keys queue.
 *
 * This is the contract that prevents mirror/SQLite divergence under
 * concurrent writes to the same item (e.g., column refetch racing with
 * a manual user refresh).
 */
async function withKeyLock<T>(
  libraryID: number,
  itemKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  assertWritableKey(libraryID, itemKey);
  const key = mirrorKey(libraryID, itemKey);
  const prev = writeTails.get(key) ?? Promise.resolve();

  // Build the new tail once and capture its identity so we can detect when
  // we're still the last writer in `finally` and drop the Map entry. Without
  // this the writeTails Map grows monotonically with the count of distinct
  // keys ever written, leaking memory under sustained refetch workloads.
  let release!: () => void;
  const ticket = new Promise<void>((res) => {
    release = res;
  });
  const newTail = prev.then(() => ticket);
  writeTails.set(key, newTail);

  await prev;

  const work = fn();
  // Track this write so closeCache can await it.
  const tracker: Promise<void> = work.then(
    () => {},
    () => {},
  );
  pendingWrites.add(tracker);

  try {
    return await work;
  } finally {
    release();
    pendingWrites.delete(tracker);
    // If no new writer chained on us, drop the Map entry so it can be GC'd.
    if (writeTails.get(key) === newTail) {
      writeTails.delete(key);
    }
  }
}

export async function upsertRow(row: ItemCacheRow): Promise<void> {
  await withKeyLock(row.library_id, row.item_key, async () => {
    const conn = requireDb();
    await conn.queryAsync(UPSERT_SQL, rowToParams(row));
    mirror.set(mirrorKey(row.library_id, row.item_key), row);
  });
}

export async function deleteRow(libraryID: number, itemKey: string): Promise<void> {
  await withKeyLock(libraryID, itemKey, async () => {
    const conn = requireDb();
    await conn.queryAsync(`DELETE FROM item_cache WHERE library_id = ? AND item_key = ?`, [
      libraryID,
      itemKey,
    ]);
    mirror.delete(mirrorKey(libraryID, itemKey));
  });
}

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

import { COLUMNS, type ItemCacheRow, mirrorKey, rowToParams } from "./types";

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

const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS idx_item_cache_last_fetched ON item_cache (last_fetched)`;

const CREATE_PROGRESS_TABLE = `
CREATE TABLE IF NOT EXISTS migration_progress (
  library_id  INTEGER NOT NULL,
  item_key    TEXT NOT NULL,
  migrated_at TEXT NOT NULL,
  PRIMARY KEY (library_id, item_key)
);
`;

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
  await db.queryAsync(CREATE_INDEX);
  await db.queryAsync(CREATE_PROGRESS_TABLE);

  const rows = await db.queryAsync<ItemCacheRow>(`SELECT * FROM item_cache`);
  mirror = new Map(rows.map((r) => [mirrorKey(r.library_id, r.item_key), r]));

  initialized = true;
  Zotero.debug(`[Citegeist] cache initialized: ${mirror.size} rows`);
}

/** Close the DB connection on shutdown. Drains pending writes first. */
export async function closeCache(): Promise<void> {
  if (pendingWrites.size > 0) {
    await Promise.allSettled([...pendingWrites]);
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

export function mirrorEntries(): IterableIterator<[string, ItemCacheRow]> {
  return mirror.entries();
}

/**
 * Snapshot of mirror keys. Returned as an array so callers can iterate
 * safely while concurrent writes mutate the underlying Map.
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

  let release!: () => void;
  const ticket = new Promise<void>((res) => {
    release = res;
  });

  // The new tail is whatever was queued before, plus our ticket. Subsequent
  // writers chain on this tail.
  writeTails.set(
    key,
    prev.then(() => ticket),
  );

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
    // If we are the current tail and the queue drained, GC the entry.
    if (writeTails.get(key) === prev.then(() => ticket)) {
      // Note: identity match is unreliable due to the new promise above; we
      // simply allow stale tails to drop naturally as new writes replace them.
    }
  }
}

export async function upsertRow(row: ItemCacheRow): Promise<void> {
  await withKeyLock(row.library_id, row.item_key, async () => {
    const conn = requireDb();
    const placeholders = COLUMNS.map(() => "?").join(", ");
    const sql = `INSERT OR REPLACE INTO item_cache (${COLUMNS.join(", ")}) VALUES (${placeholders})`;
    await conn.queryAsync(sql, rowToParams(row));
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

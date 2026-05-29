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

/** Pre-computed UPSERT statement. `COLUMNS` is frozen, so this stays valid. */
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
  // Build the connection in a local. Don't assign to the module's `db`
  // until schema + mirror load have all succeeded, so a `closeCache()`
  // racing against init can't null-out a half-initialized connection.
  const conn = new Zotero.DBConnection("citegeist");
  await conn.queryAsync(SCHEMA);
  await conn.queryAsync(CREATE_PROGRESS_TABLE);

  const rows = await conn.queryAsync<ItemCacheRow>(`SELECT * FROM item_cache`);
  const nextMirror = new Map(rows.map((r) => [mirrorKey(r.library_id, r.item_key), r]));

  db = conn;
  mirror = nextMirror;
  initialized = true;
  Zotero.debug(`[Citegeist] cache initialized: ${mirror.size} rows`);
}

/**
 * Close the DB connection on shutdown. Awaits any in-flight init, then
 * drains pending writes, then closes. The init-await is what prevents
 * doInit from observing a null `db` after we cleared module state.
 *
 * `closeDatabase(true)` requests a permanent close — Zotero runs a WAL
 * checkpoint + truncate on the way out so we don't leave a multi-MB
 * `-wal` sidecar file behind across the Zotero process shutdown.
 */
export async function closeCache(): Promise<void> {
  if (initPromise) {
    await initPromise.catch(() => {});
  }
  if (pendingWrites.size > 0) {
    // Cap the drain at CLOSE_CACHE_DRAIN_TIMEOUT_MS so a hung writer can't
    // block Zotero's whole shutdown. Losing a few in-flight writes is
    // preferable to leaving a multi-MB un-checkpointed WAL behind because
    // the user had to force-kill the parent process.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const drain = Promise.allSettled([...pendingWrites]);
      const deadline = new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(resolve, CLOSE_CACHE_DRAIN_TIMEOUT_MS);
      });
      await Promise.race([drain, deadline]);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
    if (pendingWrites.size > 0) {
      Zotero.debug(
        `[Citegeist] closeCache: ${pendingWrites.size} write(s) still pending after ${CLOSE_CACHE_DRAIN_TIMEOUT_MS}ms — abandoning to unblock shutdown`,
      );
    }
  }
  if (db) {
    await db.closeDatabase(true);
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

const noop = (): void => {};

/**
 * Serialize `fn` against any prior write to the same `(libraryID, itemKey)`.
 * Different keys run in parallel; same keys queue. Prevents mirror/SQLite
 * divergence when, e.g., a column refetch races a manual refresh.
 *
 * Tail-tracking note: each call appends a fresh tail and, in `finally`,
 * drops its Map entry if no later writer chained on it. Without that the
 * Map would grow monotonically with the count of distinct keys ever
 * written, leaking memory under sustained workloads.
 */
async function withKeyLock<T>(
  libraryID: number,
  itemKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = mirrorKey(libraryID, itemKey);
  const prev = writeTails.get(key) ?? Promise.resolve();

  let releaseTicket: () => void = noop;
  const ticket = new Promise<void>((r) => {
    releaseTicket = r;
  });
  const newTail = prev.then(() => ticket);
  writeTails.set(key, newTail);

  await prev;

  // `fn()` runs inside the try so a synchronous throw still hits `finally`
  // and releases the ticket — without that, a sync throw would leave the
  // next waiter awaiting an unresolved promise forever.
  let tracker: Promise<void> | null = null;
  try {
    const work = fn();
    tracker = work.then(noop, noop);
    pendingWrites.add(tracker);
    return await work;
  } finally {
    releaseTicket();
    if (tracker) pendingWrites.delete(tracker);
    if (writeTails.get(key) === newTail) writeTails.delete(key);
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
    // Also drop the migration checkpoint so a future force-rerun can
    // actually re-process the item. Without this, a `clearCache` followed
    // by `shouldForceRerun` would skip the now-empty row at checkpoint
    // lookup and the user's intentional clear would not trigger re-migration.
    await conn.queryAsync(`DELETE FROM migration_progress WHERE library_id = ? AND item_key = ?`, [
      libraryID,
      itemKey,
    ]);
    mirror.delete(mirrorKey(libraryID, itemKey));
  });
}

/**
 * Read-modify-write under the per-key lock. The transform receives the
 * row as it exists AT THE MOMENT the lock is granted, not at call time —
 * so a concurrent `clearCache` between the caller's call and the lock
 * acquisition is observed correctly. Return `null` from `transform` to
 * leave the row unchanged.
 */
export async function mutateRow(
  libraryID: number,
  itemKey: string,
  transform: (existing: ItemCacheRow | undefined) => ItemCacheRow | null,
): Promise<void> {
  await withKeyLock(libraryID, itemKey, async () => {
    const existing = mirror.get(mirrorKey(libraryID, itemKey));
    const next = transform(existing);
    if (next === null) return;
    const conn = requireDb();
    await conn.queryAsync(UPSERT_SQL, rowToParams(next));
    mirror.set(mirrorKey(next.library_id, next.item_key), next);
  });
}

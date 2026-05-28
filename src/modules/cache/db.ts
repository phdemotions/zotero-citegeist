/**
 * Connection + in-memory mirror lifecycle.
 *
 * The mirror is required because Zotero's column `dataProvider` callback
 * is synchronous (return type `string`, not `Promise<string>`) but the
 * SQLite API is async-only. We load all rows into a `Map` at startup so
 * read functions can stay sync; writes update SQLite first, then the map.
 */

import { COLUMNS, type ItemCacheRow, rowToParams } from "./types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS item_cache (
  item_key                  TEXT PRIMARY KEY,
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
  pending_doi               TEXT
);
`;

const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS idx_item_cache_last_fetched ON item_cache (last_fetched)`;

const CREATE_PROGRESS_TABLE = `
CREATE TABLE IF NOT EXISTS migration_progress (
  item_key    TEXT PRIMARY KEY,
  migrated_at TEXT NOT NULL
);
`;

let db: _ZoteroTypes.DBConnection | null = null;
let mirror: Map<string, ItemCacheRow> = new Map();
let initialized = false;

/**
 * Initialize the cache: open the DB, ensure schema, load the in-memory mirror.
 * Must be called from `onStartup` before any read function runs. Idempotent.
 */
export async function initCache(): Promise<void> {
  if (initialized) return;

  db = new Zotero.DBConnection("citegeist");
  await db.queryAsync(SCHEMA);
  await db.queryAsync(CREATE_INDEX);
  await db.queryAsync(CREATE_PROGRESS_TABLE);

  const rows = await db.queryAsync<ItemCacheRow>(`SELECT * FROM item_cache`);
  mirror = new Map(rows.map((r) => [r.item_key, r]));

  initialized = true;
  Zotero.debug(`[Citegeist] cache initialized: ${mirror.size} rows`);
}

/** Close the DB connection on shutdown. */
export async function closeCache(): Promise<void> {
  if (db) {
    await db.closeDatabase(false);
    db = null;
  }
  mirror = new Map();
  initialized = false;
}

/** True if `initCache()` has completed without throwing. */
export function cacheReady(): boolean {
  return initialized;
}

/**
 * Test-only: inject a fake DBConnection and reset the mirror.
 */
export function _resetForTesting(fakeDb?: _ZoteroTypes.DBConnection): void {
  db = fakeDb ?? null;
  mirror = new Map();
  initialized = false;
}

/**
 * Returns the live DB connection. Throws if init hasn't completed —
 * callers should either guard with `cacheReady()` or accept the throw
 * as a signal that the cache layer is genuinely broken.
 */
export function requireDb(): _ZoteroTypes.DBConnection {
  if (!db || !initialized) {
    throw new Error("[Citegeist] cache not initialized — call initCache() first");
  }
  return db;
}

export function getRow(itemKey: string): ItemCacheRow | undefined {
  return mirror.get(itemKey);
}

export function mirrorKeys(): IterableIterator<string> {
  return mirror.keys();
}

export function deleteMirrorKeys(keys: Iterable<string>): void {
  for (const k of keys) mirror.delete(k);
}

export async function upsertRow(row: ItemCacheRow): Promise<void> {
  const conn = requireDb();
  const placeholders = COLUMNS.map(() => "?").join(", ");
  const sql = `INSERT OR REPLACE INTO item_cache (${COLUMNS.join(", ")}) VALUES (${placeholders})`;
  await conn.queryAsync(sql, rowToParams(row));
  mirror.set(row.item_key, row);
}

export async function deleteRow(itemKey: string): Promise<void> {
  const conn = requireDb();
  await conn.queryAsync(`DELETE FROM item_cache WHERE item_key = ?`, [itemKey]);
  mirror.delete(itemKey);
}

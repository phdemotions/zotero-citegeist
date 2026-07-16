/**
 * Author-table schema + garbage collection.
 *
 * Additive-only: two `CREATE TABLE IF NOT EXISTS` statements run from the
 * cache's `doInit` (no schema-version gate, no ALTER TABLE — see the plan's
 * KTD4). There is no in-memory mirror for authors in v1: reads (`read.ts`)
 * query SQLite asynchronously, which the item pane can do in `onAsyncRender`.
 */

import { ORPHAN_GC_CHUNK_SIZE } from "../../../constants";
import type { SqliteBindValue } from "../types";

const AUTHORS_SCHEMA = `
CREATE TABLE IF NOT EXISTS authors (
  author_id       TEXT PRIMARY KEY,
  display_name    TEXT,
  orcid           TEXT,
  works_count     INTEGER,
  cited_by_count  INTEGER,
  h_index         INTEGER,
  i10_index       INTEGER,
  last_fetched    TEXT
);
`;

const ITEM_AUTHORS_SCHEMA = `
CREATE TABLE IF NOT EXISTS item_authors (
  library_id      INTEGER NOT NULL,
  item_key        TEXT NOT NULL,
  author_id       TEXT NOT NULL,
  author_position INTEGER,
  is_curated      INTEGER,
  PRIMARY KEY (library_id, item_key, author_id)
);
`;

/**
 * Create the author tables. Called from the cache's `doInit` after the
 * `item_cache` schema, on the same connection. Idempotent.
 */
export async function createAuthorSchema(conn: _ZoteroTypes.DBConnection): Promise<void> {
  await conn.queryAsync(AUTHORS_SCHEMA);
  await conn.queryAsync(ITEM_AUTHORS_SCHEMA);
}

/**
 * Two-level orphan sweep, invoked from `garbageCollectOrphans` with the same
 * orphan set it computed for `item_cache`:
 *   1. delete `item_authors` rows for items no longer in any library, and
 *   2. delete `authors` rows left with no referencing `item_authors`.
 *
 * Note: curated `item_authors` rows for a genuinely-removed item are deleted
 * along with the item (the item is gone). This mirrors the item_cache GC's
 * treatment of non-confirmed rows; author identity re-resolves cheaply on a
 * later fetch if the item returns.
 */
export async function garbageCollectOrphanAuthors(
  conn: _ZoteroTypes.DBConnection,
  orphans: ReadonlyArray<{ libraryID: number; itemKey: string }>,
): Promise<void> {
  for (let i = 0; i < orphans.length; i += ORPHAN_GC_CHUNK_SIZE) {
    const slice = orphans.slice(i, i + ORPHAN_GC_CHUNK_SIZE);
    const tuplePlaceholders = slice.map(() => "(?, ?)").join(",");
    const params: SqliteBindValue[] = [];
    for (const o of slice) params.push(o.libraryID, o.itemKey);
    await conn.queryAsync(
      `DELETE FROM item_authors WHERE (library_id, item_key) IN (${tuplePlaceholders})`,
      params,
    );
  }

  // Sweep authors no longer referenced by any item_authors row.
  await conn.queryAsync(
    `DELETE FROM authors WHERE author_id NOT IN (SELECT DISTINCT author_id FROM item_authors)`,
  );
}

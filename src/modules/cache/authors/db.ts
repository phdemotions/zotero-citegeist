/**
 * Author-table schema + garbage collection.
 *
 * Additive-only: two `CREATE TABLE IF NOT EXISTS` statements, which the cache's
 * schema setup runs in the same transaction as the `item_cache` DDL and the
 * stamp (no ALTER TABLE — see the plan's KTD4). A read-only open runs none of
 * them. Every function here writes, so each takes the caller's
 * `WriteTransaction`. There is no in-memory mirror for authors in v1: reads
 * (`read.ts`) query SQLite asynchronously, which the item pane can do in
 * `onAsyncRender`.
 */

import { runWrite, type WriteTransaction } from "../db";
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

/** Create the author tables on the schema setup's transaction. Idempotent. */
export async function createAuthorSchema(tx: WriteTransaction): Promise<void> {
  await runWrite(tx, AUTHORS_SCHEMA);
  await runWrite(tx, ITEM_AUTHORS_SCHEMA);
}

/**
 * Delete the `item_authors` rows of items no longer in any library. Orphan GC
 * calls it for each chunk, on the transaction that deletes the same items'
 * `item_cache` rows, so an item's rows go together or not at all.
 *
 * Curated `item_authors` rows for a genuinely-removed item are deleted along
 * with the item (the item is gone). This mirrors the item_cache GC's treatment
 * of non-confirmed rows; author identity re-resolves cheaply on a later fetch if
 * the item returns.
 */
export async function deleteOrphanItemAuthors(
  tx: WriteTransaction,
  orphans: ReadonlyArray<{ libraryID: number; itemKey: string }>,
): Promise<void> {
  if (orphans.length === 0) return;
  const tuplePlaceholders = orphans.map(() => "(?, ?)").join(",");
  const params: SqliteBindValue[] = [];
  for (const o of orphans) params.push(o.libraryID, o.itemKey);
  await runWrite(
    tx,
    `DELETE FROM item_authors WHERE (library_id, item_key) IN (${tuplePlaceholders})`,
    params,
  );
}

/** Delete `authors` rows that no `item_authors` row references any more. */
export async function deleteUnreferencedAuthors(tx: WriteTransaction): Promise<void> {
  await runWrite(
    tx,
    `DELETE FROM authors WHERE author_id NOT IN (SELECT DISTINCT author_id FROM item_authors)`,
  );
}

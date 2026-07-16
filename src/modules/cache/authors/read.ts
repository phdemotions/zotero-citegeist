/**
 * Async read API for author identity.
 *
 * No in-memory mirror in v1 (KTD5) — reads query SQLite directly. The item
 * pane consumes these in `onAsyncRender`, which already awaits, so a sync
 * mirror isn't needed until authors surface in a sortable column or the v2
 * "My Authors" index.
 */

import { requireDb } from "../db";
import type { AuthorRow, ItemAuthorRow } from "./types";

/**
 * The item's resolved authors, ordered by their position on the work.
 * Empty array when the item has no resolved authors yet.
 */
export async function getItemAuthors(libraryID: number, itemKey: string): Promise<ItemAuthorRow[]> {
  const conn = requireDb();
  const rows = await conn.queryAsync<ItemAuthorRow>(
    `SELECT library_id, item_key, author_id, author_position, is_curated
       FROM item_authors
      WHERE library_id = ? AND item_key = ?
      ORDER BY author_position`,
    [libraryID, itemKey],
  );
  return rows ?? [];
}

/** One author by OpenAlex id, or null if not cached. */
export async function getAuthor(authorId: string): Promise<AuthorRow | null> {
  const conn = requireDb();
  const rows = await conn.queryAsync<AuthorRow>(
    `SELECT author_id, display_name, orcid, works_count, cited_by_count,
            h_index, i10_index, last_fetched
       FROM authors
      WHERE author_id = ?`,
    [authorId],
  );
  return rows && rows.length > 0 ? rows[0] : null;
}

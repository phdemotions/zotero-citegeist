/**
 * Async read API for author identity.
 *
 * No in-memory mirror in v1 (KTD5) — reads query SQLite directly. The item
 * pane consumes these in `onAsyncRender`, which already awaits, so a sync
 * mirror isn't needed until authors surface in a sortable column or the v2
 * "My Authors" index.
 *
 * On a read-only cache a newer schema may have reshaped these tables, so a
 * failed read records once per session and returns nothing
 * (`readFailureFallback`); on a writable cache it throws for the caller.
 */

import { readFailureFallback, requireDb, runRead } from "../db";
import { AUTHOR_COLUMNS, ITEM_AUTHOR_COLUMNS, type AuthorRow, type ItemAuthorRow } from "./types";

/**
 * The item's resolved authors, ordered by their position on the work.
 * Empty array when the item has no resolved authors yet.
 */
export async function getItemAuthors(libraryID: number, itemKey: string): Promise<ItemAuthorRow[]> {
  const conn = requireDb();
  try {
    return await runRead<ItemAuthorRow>(
      conn,
      `SELECT library_id, item_key, author_id, author_position, is_curated
         FROM item_authors
        WHERE library_id = ? AND item_key = ?
        ORDER BY author_position`,
      [libraryID, itemKey],
      ITEM_AUTHOR_COLUMNS,
    );
  } catch (e) {
    return readFailureFallback("getItemAuthors", e, []);
  }
}

/** One author by OpenAlex id, or null if not cached. */
export async function getAuthor(authorId: string): Promise<AuthorRow | null> {
  const conn = requireDb();
  try {
    const rows = await runRead<AuthorRow>(
      conn,
      `SELECT author_id, display_name, orcid, works_count, cited_by_count,
              h_index, i10_index, last_fetched
         FROM authors
        WHERE author_id = ?`,
      [authorId],
      AUTHOR_COLUMNS,
    );
    return rows.length > 0 ? rows[0] : null;
  } catch (e) {
    return readFailureFallback("getAuthor", e, null);
  }
}

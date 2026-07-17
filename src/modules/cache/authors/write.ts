/**
 * Async write API for author identity.
 *
 * Concurrency: writes that touch a given item's `item_authors` rows run under
 * the cache's shared per-`(libraryID, itemKey)` lock (`withKeyLock`, exported
 * from `../db`). Sharing the lock — rather than a second parallel lock — means
 * a background identity write and a user override for the same item serialize
 * against each other AND against the item's `item_cache` write, and all of them
 * participate in the `closeCache` drain.
 *
 * Author-row writes are split into column-disjoint statements so they never
 * clobber each other: the identity path (`INSERT OR IGNORE` + `UPDATE` of
 * display_name/orcid) leaves the metric columns untouched, and the metric path
 * (U6 profile fetch) updates only metric columns. No read-modify-write of the
 * shared author row is required, so cross-item author writes are safe without a
 * dedicated author-id lock.
 */

import { requireDb, withKeyLock } from "../db";
import type { CacheItemKey } from "../types";
import { parseAuthorId } from "./types";

/** Minimum authorship shape the cache consumes — structurally a subset of
 * `OpenAlexWork["authorships"][number]`, so callers pass those directly. */
export interface CacheAuthorshipInput {
  author: {
    id: string;
    display_name?: string;
    orcid?: string | null;
  };
}

/** Derived author metrics written by the profile fetch (U6). */
export interface AuthorMetricsInput {
  worksCount: number | null;
  citedByCount: number | null;
  hIndex: number | null;
  i10Index: number | null;
  lastFetched: string;
}

/** Ensure the author row exists, then set identity fields only (metric-preserving). */
async function upsertAuthorIdentity(
  conn: _ZoteroTypes.DBConnection,
  authorId: string,
  displayName: string | null,
  orcid: string | null,
): Promise<void> {
  await conn.queryAsync(`INSERT OR IGNORE INTO authors (author_id) VALUES (?)`, [authorId]);
  await conn.queryAsync(`UPDATE authors SET display_name = ?, orcid = ? WHERE author_id = ?`, [
    displayName,
    orcid,
    authorId,
  ]);
}

/**
 * Resolve and persist a library item's authors from a fetched work's
 * authorships. Free-riding the metrics fetch (KTD9): callers invoke this right
 * after `cacheWorkData`, where the `work` (and its authorships) is in hand.
 *
 * Curated rows (`is_curated = 1`) are never overwritten — the user's confirmed
 * identity wins over a later background refresh (KTD7 / AE1). All of it runs
 * inside the per-item lock so a concurrent override can't be clobbered.
 */
export async function cacheItemAuthors(
  item: CacheItemKey,
  authorships: ReadonlyArray<CacheAuthorshipInput>,
): Promise<void> {
  const { libraryID, key: itemKey } = item;

  // Validate + order at the trust boundary. Position is the array index
  // (OpenAlex's `author_position` is "first"/"middle"/"last", not an index).
  const valid: Array<{ id: string; position: number; name: string | null; orcid: string | null }> =
    [];
  const seen = new Set<string>();
  authorships.forEach((a, idx) => {
    const id = parseAuthorId(a.author?.id);
    if (!id || seen.has(id)) return;
    seen.add(id);
    valid.push({
      id,
      position: idx,
      name: a.author.display_name ?? null,
      orcid: a.author.orcid ?? null,
    });
  });

  await withKeyLock(libraryID, itemKey, async () => {
    const conn = requireDb();

    for (const v of valid) {
      await upsertAuthorIdentity(conn, v.id, v.name, v.orcid);
    }

    // Preserve curated rows; replace the rest.
    const existing = await conn.queryAsync<{ author_id: string; is_curated: 0 | 1 | null }>(
      `SELECT author_id, is_curated FROM item_authors WHERE library_id = ? AND item_key = ?`,
      [libraryID, itemKey],
    );
    const curated = new Set(
      (existing ?? []).filter((r) => r.is_curated === 1).map((r) => r.author_id),
    );

    await conn.queryAsync(
      `DELETE FROM item_authors WHERE library_id = ? AND item_key = ? AND (is_curated IS NULL OR is_curated != 1)`,
      [libraryID, itemKey],
    );

    for (const v of valid) {
      if (curated.has(v.id)) continue; // don't downgrade a curated identity
      await conn.queryAsync(
        `INSERT OR REPLACE INTO item_authors (library_id, item_key, author_id, author_position, is_curated) VALUES (?, ?, ?, ?, ?)`,
        [libraryID, itemKey, v.id, v.position, 0],
      );
    }
  });
}

/**
 * Record a user-confirmed/overridden author identity for a creator position on
 * an item. Stored as `is_curated = 1` so future background refreshes preserve
 * it. Storage primitive for the U8 curation UI.
 */
export async function setCuratedItemAuthor(
  item: CacheItemKey,
  authorId: string,
  position: number | null,
): Promise<void> {
  const id = parseAuthorId(authorId);
  if (!id) return;
  await withKeyLock(item.libraryID, item.key, async () => {
    const conn = requireDb();
    await conn.queryAsync(`INSERT OR IGNORE INTO authors (author_id) VALUES (?)`, [id]);
    await conn.queryAsync(
      `INSERT OR REPLACE INTO item_authors (library_id, item_key, author_id, author_position, is_curated) VALUES (?, ?, ?, ?, ?)`,
      [item.libraryID, item.key, id, position, 1],
    );
  });
}

/**
 * Write derived author metrics (from the profile fetch, U6). Column-disjoint
 * from the identity path so the two never clobber. Ensures the row exists.
 */
export async function updateAuthorMetrics(
  authorId: string,
  metrics: AuthorMetricsInput,
): Promise<void> {
  const id = parseAuthorId(authorId);
  if (!id) return;
  const conn = requireDb();
  await conn.queryAsync(`INSERT OR IGNORE INTO authors (author_id) VALUES (?)`, [id]);
  await conn.queryAsync(
    `UPDATE authors SET works_count = ?, cited_by_count = ?, h_index = ?, i10_index = ?, last_fetched = ? WHERE author_id = ?`,
    [
      metrics.worksCount,
      metrics.citedByCount,
      metrics.hIndex,
      metrics.i10Index,
      metrics.lastFetched,
      id,
    ],
  );
}

/**
 * Reconcile an OpenAlex author-id merge (301, KTD3): rewrite every `item_authors`
 * reference from the stale id to the canonical survivor, then drop the now-
 * orphaned `authors` row.
 *
 * Cross-item by nature (every item that referenced the stale id), so it does NOT
 * run under the per-`(library,item)` lock — the statements are bulk and SQLite
 * serializes them, and the whole op is idempotent, so a rare interleave with a
 * background write self-heals at the next fetch. Where an item already carries
 * the survivor, the stale row is dropped rather than merged (its curation, if
 * any, is not carried over — merges are rare and the user can re-confirm).
 *
 * The synced relation URI is intentionally NOT rewritten here: OpenAlex
 * 301-redirects the stale author URI to the survivor, so an already-synced
 * relation still resolves; the canonical URI is re-asserted on the next user
 * confirm (curation).
 */
export async function reconcileAuthorMerge(fromId: string, toId: string): Promise<void> {
  const from = parseAuthorId(fromId);
  const to = parseAuthorId(toId);
  if (!from || !to || from === to) return;
  const conn = requireDb();
  // Move refs to the survivor where the item doesn't already carry it…
  await conn.queryAsync(`UPDATE OR IGNORE item_authors SET author_id = ? WHERE author_id = ?`, [
    to,
    from,
  ]);
  // …drop any leftover stale refs (items that already had the survivor)…
  await conn.queryAsync(`DELETE FROM item_authors WHERE author_id = ?`, [from]);
  // …and the now-orphaned author row.
  await conn.queryAsync(`DELETE FROM authors WHERE author_id = ?`, [from]);
}

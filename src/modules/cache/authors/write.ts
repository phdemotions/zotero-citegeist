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
 * Every writer runs its statements in one transaction, so a reconcile or merge
 * lands whole or not at all, and each commit advances Zotero's commit count (see
 * `../db`, "Why every write runs in a transaction").
 *
 * Author-row writes are split into column-disjoint statements so they never
 * clobber each other: the identity path (`INSERT OR IGNORE` + `UPDATE` of
 * display_name/orcid) leaves the metric columns untouched, and the metric path
 * (U6 profile fetch) updates only metric columns. No read-modify-write of the
 * shared author row is required, so cross-item author writes are safe without a
 * dedicated author-id lock.
 *
 * Every exported writer gets its connection from `requireWritableDb`, so a
 * cache that refuses writes (read-only CG-DB03/CG-DB04, or closed CG-DB02)
 * rejects with that code before any author statement runs.
 */

import { requireWritableDb, runRead, runWrite, withKeyLock, type WriteTransaction } from "../db";
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
  tx: WriteTransaction,
  authorId: string,
  displayName: string | null,
  orcid: string | null,
): Promise<void> {
  await runWrite(tx, `INSERT OR IGNORE INTO authors (author_id) VALUES (?)`, [authorId]);
  await runWrite(tx, `UPDATE authors SET display_name = ?, orcid = ? WHERE author_id = ?`, [
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
 * inside the per-item lock and one transaction, so a concurrent override can't
 * be clobbered and a failure leaves the item's rows as they were.
 */
export async function cacheItemAuthors(
  item: CacheItemKey,
  authorships: ReadonlyArray<CacheAuthorshipInput>,
): Promise<void> {
  const writable = requireWritableDb("cacheItemAuthors");
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

  await withKeyLock(libraryID, itemKey, () =>
    writable.transaction(async (tx) => {
      for (const v of valid) {
        await upsertAuthorIdentity(tx, v.id, v.name, v.orcid);
      }

      // Preserve curated rows; replace the rest.
      const existing = await runRead<{ author_id: string; is_curated: 0 | 1 | null }>(
        tx,
        `SELECT author_id, is_curated FROM item_authors WHERE library_id = ? AND item_key = ?`,
        [libraryID, itemKey],
        ["author_id", "is_curated"],
      );
      const curated = new Set(existing.filter((r) => r.is_curated === 1).map((r) => r.author_id));

      await runWrite(
        tx,
        `DELETE FROM item_authors WHERE library_id = ? AND item_key = ? AND (is_curated IS NULL OR is_curated != 1)`,
        [libraryID, itemKey],
      );

      for (const v of valid) {
        if (curated.has(v.id)) continue; // don't downgrade a curated identity
        await runWrite(
          tx,
          `INSERT OR REPLACE INTO item_authors (library_id, item_key, author_id, author_position, is_curated) VALUES (?, ?, ?, ?, ?)`,
          [libraryID, itemKey, v.id, v.position, 0],
        );
      }
    }),
  );
}

/**
 * Record a user-confirmed/overridden author identity for a creator position on
 * an item. Stored as `is_curated = 1` so future background refreshes preserve it
 * (cacheItemAuthors above honors that flag).
 *
 * DEFERRED — no live production caller. The curation UI that drove this was cut
 * from the v3.0.0 pane rebuild; this is retained as the write primitive for the
 * roadmapped v2 "My Authors" curation and is intentionally NOT on the public
 * `cache` surface (see cache/index.ts). Covered by test/authorCache.test.ts.
 */
export async function setCuratedItemAuthor(
  item: CacheItemKey,
  authorId: string,
  position: number | null,
): Promise<void> {
  const writable = requireWritableDb("setCuratedItemAuthor");
  const id = parseAuthorId(authorId);
  if (!id) return;
  await withKeyLock(item.libraryID, item.key, () =>
    writable.transaction(async (tx) => {
      await runWrite(tx, `INSERT OR IGNORE INTO authors (author_id) VALUES (?)`, [id]);
      // Override: clear whatever author previously occupied this creator slot so
      // the position ends up with exactly the confirmed id. The PK is
      // `(library, item, author_id)`, so a bare INSERT OR REPLACE of a *different*
      // id would leave the superseded row behind (two authors at one position).
      if (position !== null) {
        await runWrite(
          tx,
          `DELETE FROM item_authors WHERE library_id = ? AND item_key = ? AND author_position = ? AND author_id != ?`,
          [item.libraryID, item.key, position, id],
        );
      }
      await runWrite(
        tx,
        `INSERT OR REPLACE INTO item_authors (library_id, item_key, author_id, author_position, is_curated) VALUES (?, ?, ?, ?, ?)`,
        [item.libraryID, item.key, id, position, 1],
      );
    }),
  );
}

/**
 * Write derived author metrics (from the profile fetch, U6). Column-disjoint
 * from the identity path so the two never clobber. Ensures the row exists.
 */
export async function updateAuthorMetrics(
  authorId: string,
  metrics: AuthorMetricsInput,
): Promise<void> {
  const writable = requireWritableDb("updateAuthorMetrics");
  const id = parseAuthorId(authorId);
  if (!id) return;
  await writable.transaction(async (tx) => {
    await runWrite(tx, `INSERT OR IGNORE INTO authors (author_id) VALUES (?)`, [id]);
    await runWrite(
      tx,
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
  });
}

/**
 * Reconcile an OpenAlex author-id merge (301, KTD3): rewrite every `item_authors`
 * reference from the stale id to the canonical survivor, then drop the now-
 * orphaned `authors` row.
 *
 * Cross-item by nature (every item that referenced the stale id), so it does NOT
 * run under the per-`(library,item)` lock. Its three statements share one
 * transaction, which Zotero serializes against every other write on the
 * connection, and the whole op is idempotent. Where an item already carries
 * the survivor, the stale row is dropped rather than merged (its curation, if
 * any, is not carried over — merges are rare and the user can re-confirm).
 *
 * The synced relation URI is intentionally NOT rewritten here: OpenAlex
 * 301-redirects the stale author URI to the survivor, so an already-synced
 * relation still resolves; the canonical URI is re-asserted on the next user
 * confirm (curation).
 */
export async function reconcileAuthorMerge(fromId: string, toId: string): Promise<void> {
  const writable = requireWritableDb("reconcileAuthorMerge");
  const from = parseAuthorId(fromId);
  const to = parseAuthorId(toId);
  if (!from || !to || from === to) return;
  await writable.transaction(async (tx) => {
    // Move refs to the survivor where the item doesn't already carry it…
    await runWrite(tx, `UPDATE OR IGNORE item_authors SET author_id = ? WHERE author_id = ?`, [
      to,
      from,
    ]);
    // …drop any leftover stale refs (items that already had the survivor)…
    await runWrite(tx, `DELETE FROM item_authors WHERE author_id = ?`, [from]);
    // …and the now-orphaned author row.
    await runWrite(tx, `DELETE FROM authors WHERE author_id = ?`, [from]);
  });
}

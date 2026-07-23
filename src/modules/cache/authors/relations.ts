/**
 * The `openalex:author` item-relation predicate, and the one-time purge that
 * removes every relation this plugin ever wrote under it.
 *
 * WHY THERE IS NO WRITER HERE: the handoff that asserted a work's resolved
 * authors as native Zotero item relations is DISABLED. Zotero's sync SERVER
 * rejects the custom predicate ("Error 400 — Unsupported predicate
 * 'openalex:author'") and halts the user's entire library sync ("Made no
 * progress during upload"). v3.0.0 stopped writing these; the SQLite
 * `item_authors` table is now the sole author-identity store, and a downstream
 * pipeline reads `citegeist.sqlite` directly. Do NOT reintroduce a writer under
 * this predicate — it breaks sync for every user. A future handoff needs a
 * sync-safe predicate or channel.
 */

export const AUTHOR_RELATION_PREDICATE = "openalex:author";
/**
 * One-time cleanup that strips EVERY `openalex:author` item relation this plugin
 * ever wrote (see the module header for why the writer is gone), so a library
 * stuck on the rejected predicate can sync again.
 *
 * Iterates EVERY item in EVERY library rather than just item_authors rows: a
 * single stray relation keeps the whole sync stuck, so completeness beats speed
 * for a once-per-profile pass. Removes only our predicate; saves only the items
 * that carried it. Best-effort per item — a read-only/locked item is skipped so
 * one failure can't abort the pass.
 *
 * Returns both the number of items cleaned and the number that could NOT be
 * cleaned (a library whose item list wouldn't load, or an item whose save
 * failed). The caller gates the "done" pref on `failures === 0`, so a partial
 * pass retries on the next launch — a single stray relation left behind keeps
 * the whole library's sync stuck, so "done" must mean actually done.
 */
export interface PurgeResult {
  cleaned: number;
  failures: number;
}

export async function purgeAllAuthorRelations(): Promise<PurgeResult> {
  let cleaned = 0;
  let failures = 0;
  for (const lib of Zotero.Libraries.getAll()) {
    let items: _ZoteroTypes.Item[];
    try {
      items = await Zotero.Items.getAll(lib.libraryID);
    } catch {
      // Couldn't enumerate this library — it may still hold stray relations, so
      // the pass is not complete.
      failures++;
      continue;
    }
    for (const item of items) {
      const uris = item.getRelationsByPredicate(AUTHOR_RELATION_PREDICATE);
      if (uris.length === 0) continue;
      // Snapshot before removing: removeRelation splices the item's live relation
      // array, so iterating `uris` directly would skip every other entry.
      for (const uri of [...uris]) item.removeRelation(AUTHOR_RELATION_PREDICATE, uri);
      try {
        await item.saveTx();
        cleaned++;
      } catch {
        // Read-only library / locked item — its relation survives, so the pass
        // is incomplete and must run again next launch.
        failures++;
      }
    }
  }
  return { cleaned, failures };
}

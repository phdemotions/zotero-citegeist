/**
 * Zotero item-relation handoff for author identity (the "who is saying what"
 * bridge into the user's Obsidian pipeline).
 *
 * A work's resolved authors are asserted as native Zotero item relations under
 * the custom predicate `openalex:author`, each object the author's OpenAlex URI
 * (`https://openalex.org/A…`). Relations are native, synced by Zotero across
 * devices, and readable by any tool — a clean, standards-based handoff that does
 * NOT pollute the item's `Extra` field. The predicate is letters-colon-letters,
 * which Zotero's `setRelations` validation requires.
 *
 * Design notes:
 *  • Item-level, not per-creator. Which OpenAlex id maps to which creator
 *    *position* stays in the `item_authors` SQLite table (KTD6); the relation is
 *    the denormalized "this work involves these authors" convenience.
 *  • Written only on explicit user action — the U4 "resolve authors" pass and
 *    curation (U8) — never on passive background resolution, so a metrics
 *    refresh doesn't churn Zotero item-sync for the whole library.
 *  • Gated on `item.isEditable()`: a read-only group library can't take the
 *    write, and silently skipping is correct (the SQLite identity still exists;
 *    the documented fallback is the pipeline reading `citegeist.sqlite`).
 *  • Surgical add/remove (not a wholesale `setRelations`) so an override cleanly
 *    replaces a superseded author URI and other predicates are never touched.
 */

import { getItemAuthors } from "./read";

export const AUTHOR_RELATION_PREDICATE = "openalex:author";
const OPENALEX_URL_PREFIX = "https://openalex.org/";

function authorUri(authorId: string): string {
  return OPENALEX_URL_PREFIX + authorId;
}

/**
 * Replace the item's `openalex:author` relation set with exactly `authorIds`.
 * Adds missing URIs, removes superseded ones (override), and saves only when
 * something changed. No-op on a read-only library. `authorIds` must already be
 * validated `A…` ids (callers pass ids straight from `item_authors`).
 */
export async function setItemAuthorRelations(
  item: _ZoteroTypes.Item,
  authorIds: readonly string[],
): Promise<void> {
  if (!item.isEditable()) return;

  const desired = new Set(authorIds.map(authorUri));
  const current = new Set(item.getRelationsByPredicate(AUTHOR_RELATION_PREDICATE));

  let changed = false;
  for (const uri of desired) {
    if (!current.has(uri)) {
      item.addRelation(AUTHOR_RELATION_PREDICATE, uri);
      changed = true;
    }
  }
  for (const uri of current) {
    if (!desired.has(uri)) {
      item.removeRelation(AUTHOR_RELATION_PREDICATE, uri);
      changed = true;
    }
  }

  if (changed) await item.saveTx();
}

/**
 * Bring the item's `openalex:author` relations in line with its currently
 * resolved authors in `item_authors`. Called after the explicit resolve pass
 * (U4) and after a background metrics fetch resolves an item's authors.
 */
export async function syncItemAuthorRelations(item: _ZoteroTypes.Item): Promise<void> {
  if (!item.isEditable()) return;
  const rows = await getItemAuthors(item.libraryID, item.key);
  await setItemAuthorRelations(
    item,
    rows.map((r) => r.author_id),
  );
}

/**
 * One-time cleanup that strips EVERY `openalex:author` item relation this plugin
 * ever wrote. Zotero's sync SERVER rejects the custom predicate ("Error 400 ...
 * Unsupported predicate 'openalex:author'") and halts the user's entire library
 * sync ("Made no progress during upload"). v3.0.0 stopped writing these
 * (setItemAuthorRelations/syncItemAuthorRelations are no longer called — the
 * SQLite item_authors table is the sole author-identity store now) and removes
 * the ones already written here so sync can resume.
 *
 * Iterates EVERY item in EVERY library rather than just item_authors rows: a
 * single stray relation keeps the whole sync stuck, so completeness beats speed
 * for a once-per-profile pass. Removes only our predicate; saves only the items
 * that carried it. Best-effort per item — a read-only/locked item is skipped so
 * one failure can't abort the pass. Returns the number of items cleaned.
 */
export async function purgeAllAuthorRelations(): Promise<number> {
  let cleaned = 0;
  for (const lib of Zotero.Libraries.getAll()) {
    let items: _ZoteroTypes.Item[];
    try {
      items = await Zotero.Items.getAll(lib.libraryID);
    } catch {
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
        // Read-only library / locked item — skip. The purge pref is only set on a
        // fully successful pass (see hooks.ts), so a later launch retries.
      }
    }
  }
  return cleaned;
}

/**
 * TODO(U2 -> U4): AE3 multi-select collection spec. NOT collected: scaffold only
 * runs `*.spec.ts`. Rename to `09-multiselect-collections.spec.ts` and implement
 * once U2 (context-row selection, `src/modules/host/selection.ts`) has merged;
 * on current `main` these cases fail by design, because `getSelectedCollection()`
 * and `getSelectedLibraryID()` throw on multi-row selections in Zotero 10.
 *
 * Cases (plan: docs/plans/2026-09-13-001-fix-zotero-10-compat-host-bugs-plan.md,
 * AE3 and the U4 test scenarios):
 *
 * 1. Zotero 10 cell: two collections selected, "Fetch All Citation Counts" fetches
 *    the items of both, each item exactly once (assert via the loopback stub's
 *    request log).
 * 2. Zotero 10 cell: two collections plus a saved search in the selection (also a
 *    feed, Unfiled, Trash or Duplicates row) hides the Citegeist collection
 *    entries, and invoking the command anyway starts no fetch.
 * 3. Zotero 9 cell: one collection selected behaves as v2.0.5 did.
 * 4. A multi-collection items view with library header rows raises no column
 *    error (no `[Citegeist] ERROR` line in Debug Output).
 */
export {};

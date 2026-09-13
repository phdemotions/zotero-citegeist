/**
 * Reading the collection-tree selection from Zotero.
 *
 * Zotero 10 made its singular selection getters throw once more than one row is
 * selected, and on beta and dev builds even for one row:
 * `ZoteroPane.getSelectedCollection()`, `getSelectedLibraryID()`,
 * `getCollectionTreeRow()`, and the MenuManager context's `collectionTreeRow`.
 * The full selection arrives as `collectionTreeRows` instead. Every read of the
 * collection-tree selection lives in this module, so that contract is handled
 * in one place.
 *
 * One rule governs it: **an unrecognised row never widens the scope.** Citegeist
 * acts on collections and on libraries (personal and group). A selection holding
 * anything else (a saved search, a feed, Unfiled, Trash, Duplicates, My
 * Publications, Retracted) yields no targets, and the caller hides the entry and
 * starts nothing. A selection that can't be read gets the same answer: nothing,
 * never "no collection". The batch actions used to read "no collection" as the
 * library root, so that shortcut fetched a whole library against the user's
 * metered OpenAlex budget.
 */

import { CitegeistError, logError, normalizeError } from "../utils";

/** What a batch collection action runs on. A library target covers the whole library. */
export type CollectionTarget =
  | { readonly kind: "collection"; readonly collection: _ZoteroTypes.Collection }
  | { readonly kind: "library"; readonly libraryID: number };

type ActivePane = ReturnType<typeof Zotero.getActiveZoteroPane>;

/** Row types that stand for a whole library: the personal library and group libraries. */
const LIBRARY_ROW_TYPES: ReadonlySet<string> = new Set(["library", "group"]);

/**
 * Targets for the collection menu's MenuManager handlers.
 *
 * Reads `collectionTreeRows` where the context has it (Zotero 10) and
 * `collectionTreeRow` otherwise (Zotero 8 and 9). The singular field is never
 * touched when the plural one exists, because on Zotero 10 reading it throws for
 * a multi-row selection.
 *
 * Returns `null` when the entries should be hidden and nothing started: an empty
 * selection, any unsupported row, or a context carrying neither field (recorded
 * as CG-UI02).
 */
export function collectionTargetsFromMenuContext(
  ctx: _ZoteroTypes.MenuSelectionContext | null | undefined,
): readonly CollectionTarget[] | null {
  const rows: unknown = ctx?.collectionTreeRows;
  if (rows !== undefined) {
    return Array.isArray(rows)
      ? targetsForRows(rows)
      : reportUnreadable("menu context collectionTreeRows is not an array");
  }
  if (ctx && "collectionTreeRow" in ctx) {
    return targetsForRows(ctx.collectionTreeRow ? [ctx.collectionTreeRow] : []);
  }
  return reportUnreadable("menu context has neither collectionTreeRows nor collectionTreeRow");
}

/**
 * Targets for the DOM menu path, which has no MenuManager context: Zotero 7,
 * and Zotero 8+ when MenuManager rejects the registration.
 *
 * Reads the pane's collection-tree rows, so the row type decides exactly as it
 * does on the MenuManager path. `getCollectionTreeRows()` is used where it
 * exists (Zotero 10), since it is safe with any selection. `getCollectionTreeRow()`
 * is read only where the plural getter does not exist (Zotero 7 to 9), because
 * on Zotero 10 it throws for a multi-row selection. The pane's
 * `getSelectedCollection()` and `getSelectedLibraryID()` are not read at all:
 * they cannot tell a saved search, Unfiled or Trash row from the library root.
 *
 * A getter that throws anyway, or a plural result that is not an array, is an
 * unreadable selection (recorded as CG-UI02): the entries hide and nothing starts.
 */
export function collectionTargetsFromPane(
  pane: Pick<ActivePane, "getCollectionTreeRows" | "getCollectionTreeRow">,
): readonly CollectionTarget[] | null {
  let rows: unknown;
  try {
    if (typeof pane.getCollectionTreeRows === "function") {
      rows = pane.getCollectionTreeRows();
    } else if (typeof pane.getCollectionTreeRow === "function") {
      const row = pane.getCollectionTreeRow();
      rows = row ? [row] : [];
    } else {
      return reportUnreadable("pane has neither getCollectionTreeRows nor getCollectionTreeRow");
    }
  } catch (e) {
    return reportUnreadable(`pane selection getter threw: ${normalizeError(e)}`);
  }
  return Array.isArray(rows)
    ? targetsForRows(rows)
    : reportUnreadable("pane getCollectionTreeRows did not return an array");
}

/**
 * The collections selected in the pane, for the citation-network dialog's
 * default filing target. Prefers Zotero 10's `getSelectedCollections()`, because
 * the singular getter throws on a multi-row selection and on beta builds; the
 * singular getter is read only where the plural one does not exist. Rows that
 * are not collections contribute nothing.
 */
export function selectedCollectionsFromPane(
  pane: Pick<ActivePane, "getSelectedCollections" | "getSelectedCollection"> | null | undefined,
): _ZoteroTypes.Collection[] {
  if (!pane) return [];
  if (typeof pane.getSelectedCollections === "function") return pane.getSelectedCollections();
  const collection = pane.getSelectedCollection();
  return collection ? [collection] : [];
}

/**
 * The window a menu command came from, so its progress window and alerts open
 * where the user right-clicked rather than in the main window. Prefers the
 * context's `menuElem`, then the command event's target, then the main window.
 */
export function menuCommandWindow(
  event: Event | null | undefined,
  ctx: _ZoteroTypes.MenuSelectionContext | null | undefined,
): Window {
  return windowOf(ctx?.menuElem) ?? windowOf(event?.target) ?? Zotero.getMainWindow();
}

// ── Internals ────────────────────────────────────────────────────────────────

function windowOf(target: unknown): Window | null {
  return isRecord(target) ? ((target.ownerDocument as Document | null)?.defaultView ?? null) : null;
}

/**
 * Classify every row, then let a library subsume its own collections and drop
 * repeats. One unsupported row makes the whole selection unsupported: acting on
 * the rest would silently skip part of what the user selected.
 */
function targetsForRows(rows: readonly unknown[]): readonly CollectionTarget[] | null {
  if (rows.length === 0) return null;
  const targets: CollectionTarget[] = [];
  for (const row of rows) {
    const target = targetForRow(row);
    if (!target) return null;
    targets.push(target);
  }
  const libraryIDs = new Set(targets.flatMap((t) => (t.kind === "library" ? [t.libraryID] : [])));
  const seen = new Set<string>();
  return targets.filter((t) => {
    if (t.kind === "collection" && libraryIDs.has(t.collection.libraryID)) return false;
    const key = t.kind === "library" ? `L${t.libraryID}` : `C${t.collection.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function targetForRow(row: unknown): CollectionTarget | null {
  if (!isRecord(row)) return null;
  const { type, ref } = row;
  if (type === "collection" && isCollection(ref)) {
    return { kind: "collection", collection: ref };
  }
  if (typeof type === "string" && LIBRARY_ROW_TYPES.has(type) && isRecord(ref)) {
    const { libraryID } = ref;
    if (typeof libraryID === "number" && Number.isInteger(libraryID) && libraryID > 0) {
      return { kind: "library", libraryID };
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCollection(value: unknown): value is _ZoteroTypes.Collection {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.getChildItems === "function" &&
    typeof value.getChildCollections === "function"
  );
}

/**
 * Recorded once per session. The menu opens many times, and a repeat of the
 * same host-contract break would push older, more useful entries out of the
 * diagnostics ring buffer.
 */
let unreadableReported = false;

function reportUnreadable(detail: string): null {
  if (!unreadableReported) {
    unreadableReported = true;
    logError("collection menu selection", new CitegeistError(detail, "CG-UI02"));
  }
  return null;
}

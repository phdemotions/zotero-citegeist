/**
 * Reading the Zotero selection for the context menus and the citation-network
 * dialog.
 *
 * Zotero 10 retired the singular collection-tree getters:
 * `ZoteroPane.getSelectedCollection()`, `getSelectedLibraryID()`,
 * `getCollectionTreeRow()`, and the MenuManager context's `collectionTreeRow`.
 * Each throws when more than one row is selected and otherwise logs a
 * removed-API warning, on release and beta builds alike. The full selection
 * arrives as `collectionTreeRows` instead. Every read of the selection lives in
 * this module, so that contract is handled in one place;
 * `test/selection-guard-invariants.test.ts` fails if a read appears anywhere else.
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

import { recentDiagnostics } from "../diagnostics";
import { CitegeistError, logError, normalizeError, redactSensitive } from "../utils";

/** What a batch collection action runs on. A library target covers the whole library. */
export type CollectionTarget =
  | { readonly kind: "collection"; readonly collection: _ZoteroTypes.Collection }
  | { readonly kind: "library"; readonly libraryID: number };

type Pane = _ZoteroTypes.ZoteroPane;

/** Row types that stand for a whole library: the personal library and group libraries. */
const LIBRARY_ROW_TYPES: ReadonlySet<string> = new Set(["library", "group"]);

/**
 * The Zotero pane of `win`, the window a menu opened in. Zotero's own context
 * menus read the right-clicked window's pane, while `Zotero.getActiveZoteroPane()`
 * is the most recent window's, so the active pane is only the fallback for a
 * window that has none of its own (or when no window is known).
 */
export function paneForWindow(win: Window | null | undefined): Pane | null {
  const own = (win as { ZoteroPane?: Pane | null } | null | undefined)?.ZoteroPane;
  return own ?? Zotero.getActiveZoteroPane() ?? null;
}

/** The items selected in `win`'s pane (see {@link paneForWindow}); none when there is no pane. */
export function selectedItemsInWindow(win: Window | null | undefined): _ZoteroTypes.Item[] {
  return paneForWindow(win)?.getSelectedItems() ?? [];
}

/**
 * Targets for the collection menu's MenuManager handlers.
 *
 * Reads `collectionTreeRows` where the context has it (Zotero 10) and
 * `collectionTreeRow` otherwise (Zotero 8 and 9). The singular field is never
 * touched when the plural one exists: on Zotero 10 it throws for a multi-row
 * selection.
 *
 * Returns `null` when the entries should be hidden and nothing started: an empty
 * selection, an unsupported row or mix of rows, or a context that can't be read
 * (recorded as CG-UI02).
 */
export function collectionTargetsFromMenuContext(
  ctx: _ZoteroTypes.MenuSelectionContext | null | undefined,
): readonly CollectionTarget[] | null {
  const plural = attempt((): unknown => ctx?.collectionTreeRows);
  if (plural === THREW) return reportUnreadable(MENU, "menu context collectionTreeRows threw");
  if (plural !== undefined) {
    return Array.isArray(plural)
      ? targetsForRows(plural)
      : reportUnreadable(MENU, "menu context collectionTreeRows is not an array");
  }
  const singular = attempt(() =>
    ctx && "collectionTreeRow" in ctx ? { row: ctx.collectionTreeRow } : null,
  );
  if (singular === THREW) return reportUnreadable(MENU, "menu context collectionTreeRow threw");
  if (!singular) {
    return reportUnreadable(
      MENU,
      "menu context has neither collectionTreeRows nor collectionTreeRow",
    );
  }
  return targetsForRows(singular.row ? [singular.row] : []);
}

/**
 * Targets for the DOM menu path, which has no MenuManager context: Zotero 7,
 * and Zotero 8+ when MenuManager rejects the registration.
 *
 * DOM path only; delete with registerViaDOM (U9).
 *
 * Reads the pane's collection-tree rows, so the row type decides exactly as it
 * does on the MenuManager path. `getCollectionTreeRows()` is used where it
 * exists (Zotero 10), since it is safe with any selection. `getCollectionTreeRow()`
 * is read only where the plural getter does not exist (Zotero 7 to 9). The
 * pane's `getSelectedCollection()` and `getSelectedLibraryID()` are not read at
 * all: they cannot tell a saved search, Unfiled or Trash row from the library root.
 *
 * A missing pane, a getter that throws, or a plural result that is not an array
 * is an unreadable selection (recorded as CG-UI02): the entries hide and nothing
 * starts.
 */
export function collectionTargetsFromPane(
  pane: Pick<Pane, "getCollectionTreeRows" | "getCollectionTreeRow"> | null | undefined,
): readonly CollectionTarget[] | null {
  if (!pane) return reportUnreadable(MENU, "no Zotero pane to read the selection from");
  if (typeof pane.getCollectionTreeRows === "function") {
    const rows = attempt((): unknown => pane.getCollectionTreeRows?.());
    if (rows === THREW) return reportUnreadable(MENU, "pane getCollectionTreeRows threw");
    return Array.isArray(rows)
      ? targetsForRows(rows)
      : reportUnreadable(MENU, "pane getCollectionTreeRows did not return an array");
  }
  if (typeof pane.getCollectionTreeRow === "function") {
    const row = attempt(() => pane.getCollectionTreeRow?.());
    if (row === THREW) return reportUnreadable(MENU, "pane getCollectionTreeRow threw");
    return targetsForRows(row ? [row] : []);
  }
  return reportUnreadable(MENU, "pane has neither getCollectionTreeRows nor getCollectionTreeRow");
}

/**
 * The collections selected in the pane, for the citation-network dialog's
 * default filing target. Prefers Zotero 10's `getSelectedCollections()`, because
 * the singular getter throws on a multi-row selection; the singular getter is
 * read only where the plural one does not exist. Rows that are not collections
 * contribute nothing.
 *
 * Total: a missing pane gives no collections, and a getter that throws or
 * returns something other than an array gives none too, recorded as CG-UI02.
 */
export function selectedCollectionsFromPane(
  pane: Pick<Pane, "getSelectedCollections" | "getSelectedCollection"> | null | undefined,
): _ZoteroTypes.Collection[] {
  if (!pane) return [];
  if (typeof pane.getSelectedCollections === "function") {
    const collections = attempt((): unknown => pane.getSelectedCollections?.());
    if (collections === THREW) {
      return reportUnreadable(DIALOG, "pane getSelectedCollections threw") ?? [];
    }
    return Array.isArray(collections)
      ? collections
      : (reportUnreadable(DIALOG, "pane getSelectedCollections did not return an array") ?? []);
  }
  if (typeof pane.getSelectedCollection !== "function") {
    return (
      reportUnreadable(
        DIALOG,
        "pane has neither getSelectedCollections nor getSelectedCollection",
      ) ?? []
    );
  }
  const collection = attempt(() => pane.getSelectedCollection());
  if (collection === THREW)
    return reportUnreadable(DIALOG, "pane getSelectedCollection threw") ?? [];
  return collection ? [collection] : [];
}

// ── Internals ────────────────────────────────────────────────────────────────

/** Diagnostic contexts: which surface's selection read failed. */
const MENU = "collection menu selection";
const DIALOG = "network dialog default collection";

const THREW: unique symbol = Symbol("selection read threw");

/**
 * Run a host read, turning a throw into {@link THREW}. The error itself is
 * dropped on purpose: its message is host text that could name a collection,
 * and the caller records a fixed description of the read instead.
 */
function attempt<T>(read: () => T): T | typeof THREW {
  try {
    return read();
  } catch {
    return THREW;
  }
}

/**
 * Classify every row, then apply the selection rules:
 *
 * - One unsupported row makes the whole selection unsupported: acting on the
 *   rest would silently skip part of what the user selected.
 * - A library row together with a collection row is unsupported too. Zotero 10
 *   does not keep that selection itself (`ZoteroPane.onCollectionSelected` trims
 *   a library row mixed with a collection back to the focused row), so a context
 *   carrying both is a transient state, and hiding beats guessing which the user
 *   meant. It is valid, not unreadable, so nothing is recorded.
 * - Several libraries, or several collections from any libraries, are supported.
 *   Repeats are dropped.
 *
 * A row whose fields throw while being read is an unreadable selection (CG-UI02).
 */
function targetsForRows(rows: readonly unknown[]): readonly CollectionTarget[] | null {
  const classified = attempt(() => rows.map(targetForRow));
  if (classified === THREW) return reportUnreadable(MENU, "a collection-tree row threw when read");
  if (classified.length === 0) return null;

  const targets: CollectionTarget[] = [];
  for (const target of classified) {
    if (!target) return null;
    targets.push(target);
  }
  const libraries = targets.filter((t) => t.kind === "library").length;
  if (libraries > 0 && libraries < targets.length) return null;

  const seen = new Set<string>();
  return targets.filter((t) => {
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
 * Record CG-UI02, unless the same failure is still in the diagnostics buffer:
 * the same surface (`context`) and the same failed read (`detail`). The menu
 * opens many times, and a repeat of one host-contract break would push older,
 * more useful entries out of the buffer. A different failed read, or a read
 * failing on the other surface, is a separate fact about the host and records
 * its own entry. Once an entry has aged out (or the user cleared the buffer),
 * the same failure records again, so a report never hides a failure that is
 * still happening.
 *
 * `detail` is a fixed string naming the read that failed, never host error text:
 * a Zotero error message could carry a collection name into the shareable report.
 * The comparison uses the context and detail exactly as `logError` stores them
 * (redacted and normalized), so it matches what an earlier call recorded.
 */
function reportUnreadable(context: string, detail: string): null {
  const error = new CitegeistError(detail, "CG-UI02");
  const recordedContext = redactSensitive(context);
  const recordedDetail = normalizeError(error);
  const alreadyRecorded = recentDiagnostics().some(
    (entry) =>
      entry.code === "CG-UI02" &&
      entry.context === recordedContext &&
      entry.detail === recordedDetail,
  );
  if (!alreadyRecorded) logError(context, error);
  return null;
}

/**
 * `Zotero.Citegeist`: Citegeist's entry points for callers that cannot import the
 * bundle.
 *
 * The settings pane is a standalone XHTML document with an inline script, so it
 * calls the diagnostics API through here rather than duplicating the report
 * builder (where it would immediately drift). The real-Zotero suite
 * (`test/real-zotero/`, Mocha specs running inside Zotero) waits on `ready`
 * before any spec runs and drives the fetch and resolve commands by item ID,
 * through the same functions the menu commands run.
 *
 * Frozen, and `ready` has no setter, so no caller can flip the flag or swap an
 * entry point. Namespaced under `Zotero` so it is reachable from any Zotero
 * document, and removed on shutdown so a disabled plugin leaves nothing behind.
 */

import {
  canResolveWork,
  resolveAuthorsForItems,
  type AuthorBackfillResult,
  type FetchBatchResult,
} from "./citationService";
import { buildDiagnosticReport, clearDiagnostics, guardAsync } from "./diagnostics";
import { fetchItemsAndRepaint } from "./menu/batchActions";

/** Install the bridge. `isReady` is true once startup opened the cache and registered every cache-dependent surface. */
export function installBridge(isReady: () => boolean): void {
  (Zotero as unknown as Record<string, unknown>).Citegeist = Object.freeze({
    buildDiagnosticReport,
    clearDiagnostics,
    /** True once startup finished: the cache is open and all cache-dependent UI registered. */
    get ready(): boolean {
      return isReady();
    },
    fetchItems: (itemIDs: unknown) =>
      guardAsync("bridge fetchItems", () => fetchItemsByID(isReady, itemIDs)),
    resolveAuthors: (itemIDs: unknown) =>
      guardAsync("bridge resolveAuthors", () => resolveAuthorsByID(isReady, itemIDs)),
  });
}

export function removeBridge(): void {
  delete (Zotero as unknown as Record<string, unknown>).Citegeist;
}

/**
 * The "Fetch Citation Counts" command for explicit item IDs, repaint included.
 * Resolves `undefined` before startup completes, and on any failure (guarded).
 */
async function fetchItemsByID(
  isReady: () => boolean,
  itemIDs: unknown,
): Promise<FetchBatchResult | undefined> {
  if (!isReady()) {
    Zotero.debug("[Citegeist] Bridge fetchItems ignored: startup has not completed");
    return undefined;
  }
  return fetchItemsAndRepaint(await resolvableItems(itemIDs));
}

/**
 * The "Resolve Author Identities" command for explicit item IDs. Resolves
 * `undefined` before startup completes, and on any failure.
 */
async function resolveAuthorsByID(
  isReady: () => boolean,
  itemIDs: unknown,
): Promise<AuthorBackfillResult | undefined> {
  if (!isReady()) {
    Zotero.debug("[Citegeist] Bridge resolveAuthors ignored: startup has not completed");
    return undefined;
  }
  return resolveAuthorsForItems(await resolvableItems(itemIDs));
}

/**
 * The items behind `itemIDs` that Citegeist can resolve to an OpenAlex work, the
 * eligibility the menu commands apply. Anything that is not a positive integer
 * is dropped before it reaches Zotero.
 */
async function resolvableItems(itemIDs: unknown): Promise<_ZoteroTypes.Item[]> {
  if (!Array.isArray(itemIDs)) return [];
  const ids = [...new Set(itemIDs.filter((id) => Number.isInteger(id) && id > 0))] as number[];
  if (ids.length === 0) return [];
  const items = await Zotero.Items.getAsync(ids);
  return items.filter((item) => item && canResolveWork(item));
}

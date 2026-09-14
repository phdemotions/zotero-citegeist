/**
 * Which of Citegeist's menu entries show for a selection.
 *
 * Every visibility decision is made here: the MenuManager `onShowing` handlers
 * and the DOM fallback's `popupshowing` listeners only apply the answer. The two
 * paths therefore cannot drift apart, and a fix to when an entry shows is made
 * once.
 */

import { canResolveWork } from "../citationService";
import type { CollectionTarget } from "../host/selection";

/** Whether each item-menu entry shows. */
export interface ItemMenuVisibility {
  readonly fetch: boolean;
  readonly resolveAuthors: boolean;
  readonly citing: boolean;
  readonly references: boolean;
  /**
   * The separator above the entries. MenuManager draws none of its own.
   * Zotero 7 DOM fallback: delete with registerViaDOM (U9)
   */
  readonly separator: boolean;
}

/**
 * The item-menu entries for `items`, the selection the menu opened on.
 *
 * Fetch and Resolve show when any selected item can be resolved to a work.
 * Citing and References act on one work, so they show only for a single item
 * that resolves. The separator groups the entries below it, so it shows exactly
 * when one of them does, which reduces to "any item resolves": a separator kept
 * for a single item that does not resolve left an empty section in the menu
 * (issue #72).
 */
export function itemMenuVisibility(items: readonly _ZoteroTypes.Item[]): ItemMenuVisibility {
  const eligibleCount = items.filter(canResolveWork).length;
  const singleResolvable = items.length === 1 && eligibleCount === 1;
  return {
    fetch: eligibleCount > 0,
    resolveAuthors: eligibleCount > 0,
    citing: singleResolvable,
    references: singleResolvable,
    separator: eligibleCount > 0,
  };
}

/**
 * Whether the collection-menu entries show: only when the selection resolved to
 * targets Citegeist acts on (see `host/selection.ts`), so a saved search, feed,
 * Unfiled or Trash row never reaches a batch.
 */
export function collectionEntriesVisible(targets: readonly CollectionTarget[] | null): boolean {
  return targets !== null;
}

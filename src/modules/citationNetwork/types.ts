/**
 * Shared types and constants for the Citation Network dialog.
 */

import type { OpenAlexWork } from "../openalex";

export type NetworkMode = "citing" | "references";

export const MAX_RENDERED_RESULTS = 200;
export const UNDO_TIMEOUT_MS = 3000;

/** Common surname prefixes that belong with the last name, not the first. */
export const SURNAME_PREFIXES = new Set([
  "van", "von", "de", "del", "della", "di", "da", "dos", "das", "du",
  "la", "le", "el", "al", "bin", "ibn", "ben", "ter", "ten",
]);

export interface CollectionNode {
  id: number;
  name: string;
  depth: number;
  parentId: number | false;
  hasChildren: boolean;
}

export interface NetworkState {
  overlay: HTMLElement;
  dialog: HTMLElement;
  win: Window;
  work: OpenAlexWork;
  mode: NetworkMode;
  results: OpenAlexWork[];
  cursor: string;
  hasMore: boolean;
  loading: boolean;
  sortBy: string;
  existingDOIs: Set<string>;
  /** Incremented on tab switch to invalidate in-flight requests */
  generation: number;
  searchTimeout: ReturnType<typeof setTimeout> | null;
  /** Default collection IDs for new items */
  defaultCollectionIds: Set<number>;
  /** Flat list of all collections for pickers */
  allCollections: CollectionNode[];
  /** Currently expanded work IDs (for abstract view) */
  expandedIds: Set<string>;
  /** Cached abstracts keyed by work ID */
  abstractCache: Map<string, string | null>;
  /** Work IDs with pending undo — maps to timeout handle */
  undoTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Work IDs that were added this session (past undo window) */
  addedThisSession: Set<string>;
  /** Map of item DOI → collection IDs it belongs to (for filing) */
  itemCollections: Map<string, Set<number>>;
  /** Map of work ID → Zotero item ID for undo tracking */
  createdItemIds: Map<string, number>;
  /** Expanded parent IDs in the default collection picker */
  defaultPickerExpanded: Set<number>;
}

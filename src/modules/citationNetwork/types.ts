/**
 * Shared types and constants for the Citation Network dialog.
 */

import type { OpenAlexWork } from "../openalex";
import type { OpenAlexAuthorProfile } from "../openalexAuthors";

/**
 * Dialog subject: works that cite / are cited by a paper, or the works OF an
 * author. `"author"` reuses the whole browser shell — only the header (an author
 * hero instead of source metadata + tabs) and the fetch source differ.
 */
export type NetworkMode = "citing" | "references" | "author";

// Re-export so existing imports in this folder keep working.
export { MAX_RENDERED_RESULTS, UNDO_TIMEOUT_MS } from "../../constants";

/** Explicit lifecycle state so guards against closed-mid-load are obvious. */
export type DialogPhase = "loading-skeleton" | "loading-data" | "ready" | "closed";

/**
 * Sort modes for the citation network results. `citations`, `fwci-desc`,
 * `percentile-desc`, `year-desc`, and `year-asc` rank by a metric; `author-asc`
 * orders by first-author surname; `not-in-library` floats works you haven't
 * added yet to the top so new discoveries are easy to spot.
 */
export type NetworkSortKey =
  | "citations"
  | "fwci-desc"
  | "percentile-desc"
  | "year-desc"
  | "year-asc"
  | "author-asc"
  | "not-in-library";

/** Common surname prefixes that belong with the last name, not the first. */
export const SURNAME_PREFIXES = new Set([
  "van",
  "von",
  "de",
  "del",
  "della",
  "di",
  "da",
  "dos",
  "das",
  "du",
  "la",
  "le",
  "el",
  "al",
  "bin",
  "ibn",
  "ben",
  "ter",
  "ten",
]);

export interface CollectionNode {
  id: number;
  name: string;
  depth: number;
  parentId: number | false;
  hasChildren: boolean;
}

export interface NetworkState {
  /** Current dialog lifecycle phase (see {@link DialogPhase}). */
  phase: DialogPhase;
  overlay: HTMLElement;
  dialog: HTMLElement;
  win: Window;
  /** The subject paper for `citing`/`references`; null in `author` mode. */
  work: OpenAlexWork | null;
  mode: NetworkMode;
  /** `author` mode only: the OpenAlex author id the works are filtered by. */
  authorId?: string;
  /** `author` mode only: the resolved profile driving the header hero. */
  authorProfile?: OpenAlexAuthorProfile;
  results: OpenAlexWork[];
  cursor: string;
  hasMore: boolean;
  loading: boolean;
  sortBy: NetworkSortKey;
  /** When true, results already in the user's library are hidden. */
  hideInLibrary: boolean;
  existingDOIs: Set<string>;
  /**
   * OpenAlex work ids already in the user's library (snapshot of the cache
   * mirror at dialog open). Marks DOI-less results "in library" so they don't
   * render as "+ Add" and create silent duplicates.
   */
  existingWorkIds: Set<string>;
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
  /** Map of work ID → collection IDs it belongs to (for filing) */
  itemCollections: Map<string, Set<number>>;
  /** Map of work ID → Zotero item ID for undo tracking */
  createdItemIds: Map<string, number>;
  /** Expanded parent IDs in the default collection picker */
  defaultPickerExpanded: Set<number>;
  /** Work IDs with an `addItemToLibrary` call in flight. Synchronous gate
   *  against spam-click; cleared in the finally block once the create +
   *  cache write resolves (success or error). */
  pendingAdds: Set<string>;
}

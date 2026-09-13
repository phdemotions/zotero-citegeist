/**
 * Shared DOM fakes and item/collection factories for menu-related tests.
 *
 * Extracted from collection-menu.test.ts to avoid duplication with
 * menu.test.ts and any future menu-level tests.
 */

import { vi } from "vitest";

// ─── Fake DOM ────────────────────────────────────────────────────────────────

export class FakeElement {
  id = "";
  hidden = false;
  readonly children: FakeElement[] = [];
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, EventListener>();

  constructor(private readonly doc: FakeDocument) {}

  appendChild(child: FakeElement): void {
    this.children.push(child);
    if (child.id) this.doc.elements.set(child.id, child);
  }

  remove(): void {
    if (this.id) this.doc.elements.delete(this.id);
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  /** Trigger an event listener and return the Promise it produces (if async). */
  dispatch(type: string): Promise<void> | void {
    return (this.listeners.get(type) as ((e: Event) => void | Promise<void>) | undefined)?.({
      type,
    } as Event);
  }
}

export class FakeDocument {
  readonly elements = new Map<string, FakeElement>();

  constructor() {
    this.addRoot("zotero-itemmenu");
    this.addRoot("zotero-collectionmenu");
  }

  addRoot(id: string): FakeElement {
    const el = new FakeElement(this);
    el.id = id;
    this.elements.set(id, el);
    return el;
  }

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }

  createXULElement(): FakeElement {
    return new FakeElement(this);
  }
}

// ─── Item + Collection factories ─────────────────────────────────────────────

export function makeItem(
  id: number,
  hasIdentifier = true,
): _ZoteroTypes.Item & { hasIdentifier: boolean } {
  return {
    id,
    key: `KEY${id}`,
    libraryID: 1,
    itemTypeID: 1,
    itemType: "journalArticle",
    hasIdentifier,
    isRegularItem: () => true,
    isAttachment: () => false,
    isNote: () => false,
    deleted: false,
    getField: vi.fn(() => ""),
    setField: vi.fn(),
    getCreators: vi.fn(() => []),
    setCreators: vi.fn(),
    getTags: vi.fn(() => []),
    addTag: vi.fn(() => true),
    getCollections: vi.fn(() => []),
    addToCollection: vi.fn(),
    removeFromCollection: vi.fn(),
    getNotes: vi.fn(() => []),
    getAttachments: vi.fn(() => []),
    saveTx: vi.fn(async () => 1),
    save: vi.fn(async () => 1),
    eraseTx: vi.fn(async () => {}),
  } as unknown as _ZoteroTypes.Item & { hasIdentifier: boolean };
}

let _collectionSeq = 0;

export function makeCollection(
  items: _ZoteroTypes.Item[],
  children: _ZoteroTypes.Collection[] = [],
  libraryID = 1,
): _ZoteroTypes.Collection {
  return {
    id: ++_collectionSeq,
    libraryID,
    getChildItems: () => items,
    getChildCollections: () => children,
  } as unknown as _ZoteroTypes.Collection;
}

// ─── Collection-tree rows ────────────────────────────────────────────────────

/** A collection row, shaped like Zotero.CollectionTreeRow. */
export function collectionRow(collection: _ZoteroTypes.Collection): _ZoteroTypes.CollectionTreeRow {
  return { type: "collection", ref: collection };
}

/** A personal ("library") or group ("group") library row. */
export function libraryRow(
  libraryID: number,
  type: "library" | "group" = "library",
): _ZoteroTypes.CollectionTreeRow {
  return { type, ref: { libraryID } };
}

/**
 * A row Citegeist does not act on. Its ref carries a libraryID, as a saved
 * search's or Unfiled's does, which is exactly what used to widen to the whole
 * library.
 */
export function otherRow(type: string, libraryID = 1): _ZoteroTypes.CollectionTreeRow {
  return { type, ref: { id: 900, libraryID } };
}

/** Collection-tree row types that must never reach a batch fetch. */
export const UNSUPPORTED_ROW_TYPES = [
  "search",
  "feed",
  "feeds",
  "unfiled",
  "trash",
  "duplicates",
  "publications",
  "retracted",
] as const;

// ─── Async helpers ───────────────────────────────────────────────────────────

/** Drain the microtask + macrotask queue after dispatching an async handler. */
export const flushAsync = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

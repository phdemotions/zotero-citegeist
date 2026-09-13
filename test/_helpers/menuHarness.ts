/**
 * Shared DOM fakes, factories and diagnostics probes for menu-related tests.
 *
 * Extracted from collection-menu.test.ts to avoid duplication with
 * menu.test.ts, hostSelection.test.ts and any future menu-level tests.
 */

import { vi, type Mock } from "vitest";

// ─── Fake DOM ────────────────────────────────────────────────────────────────

export class FakeElement {
  id = "";
  hidden = false;
  readonly children: FakeElement[] = [];
  readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, EventListener[]>();

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

  /** Honours `options.signal` as the DOM does: aborting it removes the listener. */
  addEventListener(
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions | boolean,
  ): void {
    const signal = typeof options === "object" ? options.signal : undefined;
    if (signal?.aborted) return;
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    signal?.addEventListener("abort", () => this.removeEventListener(type, listener), {
      once: true,
    });
  }

  removeEventListener(type: string, listener: EventListener): void {
    const remaining = (this.listeners.get(type) ?? []).filter((l) => l !== listener);
    if (remaining.length > 0) this.listeners.set(type, remaining);
    else this.listeners.delete(type);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }

  /** Run every listener for `type`. Drain the async work they start with flushAsync(). */
  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type } as Event);
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

/** One fake progress window and the progress lines added to it. */
export interface FakeProgressWindow {
  readonly changeHeadline: Mock;
  readonly show: Mock;
  readonly startCloseTimer: Mock;
  readonly close: Mock;
  readonly lines: Array<{
    readonly initialText: string;
    readonly setProgress: Mock;
    readonly setText: Mock;
  }>;
}

/**
 * A `Zotero.ProgressWindow` constructor fake that keeps every window it built in
 * `instances`. A regular function, not an arrow, so `new Zotero.ProgressWindow(...)`
 * works in the handler.
 */
export function fakeProgressWindowClass() {
  const instances: FakeProgressWindow[] = [];
  const ProgressWindow = vi.fn(function () {
    const lines: FakeProgressWindow["lines"] = [];
    const progressWindow = {
      changeHeadline: vi.fn(),
      show: vi.fn(),
      startCloseTimer: vi.fn(),
      close: vi.fn(),
      lines,
      ItemProgress: function (_icon: string, initialText: string) {
        const line = { initialText, setProgress: vi.fn(), setText: vi.fn() };
        lines.push(line);
        return line;
      },
    };
    instances.push(progressWindow);
    return progressWindow;
  });
  return Object.assign(ProgressWindow, { instances });
}

/** The progress windows opened since `Zotero` was stubbed, oldest first. */
export function progressWindows(): FakeProgressWindow[] {
  return (Zotero.ProgressWindow as unknown as { instances: FakeProgressWindow[] }).instances;
}

/** The `window` option each progress window was opened with, oldest first. */
export function progressWindowParents(): unknown[] {
  return (Zotero.ProgressWindow as unknown as Mock).mock.calls.map(
    ([options]) => (options as { window?: unknown }).window,
  );
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

/** Item IDs, sorted, for order-insensitive comparison. */
export function idsOf(items: readonly { id: number }[]): number[] {
  return items.map((i) => i.id).sort((a, b) => a - b);
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
  "recentlyRead",
  "header",
] as const;

// ─── Diagnostics probes ──────────────────────────────────────────────────────
//
// Every assertion about what a selection read recorded goes through these, so a
// port to a branch that reports failures through another channel changes these
// functions and nothing else. Each imports the diagnostics module dynamically,
// so it reads the same instance as a module graph a test reloaded with
// vi.resetModules().

async function diagnostics() {
  return import("../../src/modules/diagnostics");
}

/** The CG-UI02 records: selection reads that failed. */
export async function selectionUnreadableReports() {
  return (await diagnostics()).recentDiagnostics().filter((d) => d.code === "CG-UI02");
}

/** Every recorded failure, whatever its code. */
export async function recordedFailures() {
  return (await diagnostics()).recentDiagnostics();
}

export async function clearRecordedFailures(): Promise<void> {
  (await diagnostics()).clearDiagnostics();
}

// ─── Async helpers ───────────────────────────────────────────────────────────

/**
 * Drain pending async work after dispatching a handler. Several macrotask turns,
 * because a batch hands the event loop back between the targets it gathers.
 */
export async function flushAsync(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

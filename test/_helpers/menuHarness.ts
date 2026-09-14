/**
 * Fakes, factories and checks shared by the menu tests: a fake menu DOM, the
 * MenuManager contexts each supported Zotero builds, a fake MenuManager, batch
 * results, and the host-contract check every menu test ends with.
 */

import { expect, vi, type Mock } from "vitest";
import type { AuthorBackfillResult, FetchBatchResult } from "../../src/modules/citationService";
import type { DiagnosticCode } from "../../src/modules/diagnostics";

/**
 * Budget for a setup hook that loads a module graph cold. Under the parallel
 * suite a first import can take longer than vitest's 5 s test timeout, so
 * imports belong in hooks with this budget, never in a test body.
 */
export const MODULE_LOAD_TIMEOUT_MS = 30_000;

// ─── Fake menu DOM ───────────────────────────────────────────────────────────

export class FakeMenuElement {
  id = "";
  hidden = false;
  parent: FakeMenuElement | null = null;
  readonly children: FakeMenuElement[] = [];
  readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, EventListener[]>();

  constructor(private readonly doc: FakeMenuDocument) {}

  appendChild(child: FakeMenuElement): void {
    child.parent = this;
    this.children.push(child);
    if (child.id) this.doc.elements.set(child.id, child);
  }

  /** Detach from the parent and the document, as the DOM does, so `children` shows what is left. */
  remove(): void {
    if (this.id && this.doc.elements.get(this.id) === this) this.doc.elements.delete(this.id);
    if (this.parent) {
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
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

export class FakeMenuDocument {
  readonly elements = new Map<string, FakeMenuElement>();

  constructor() {
    this.addRoot("zotero-itemmenu");
    this.addRoot("zotero-collectionmenu");
  }

  addRoot(id: string): FakeMenuElement {
    const el = new FakeMenuElement(this);
    el.id = id;
    this.elements.set(id, el);
    return el;
  }

  getElementById(id: string): FakeMenuElement | null {
    return this.elements.get(id) ?? null;
  }

  /** Nothing matches: the only query the lifecycle hooks make is for their FTL link. */
  querySelector(): null {
    return null;
  }

  createXULElement(): FakeMenuElement {
    return new FakeMenuElement(this);
  }
}

/** A main window as the menus see it. */
export type FakeWindow = Window & {
  readonly document: FakeMenuDocument;
  AbortController: typeof AbortController;
  ZoteroPane?: unknown;
  closed: boolean;
};

/**
 * A main window for menu tests: its own document, its own Zotero pane when one
 * is given, the `AbortController` constructor every chrome window carries, and
 * `closed`, which a test sets to close it. The DOM menus build their listener
 * signal from the window's own constructor, so a fake without one would only
 * ever exercise the global fallback.
 */
export function fakeWindow(pane?: unknown): FakeWindow {
  return {
    document: new FakeMenuDocument(),
    AbortController,
    ZoteroPane: pane,
    closed: false,
    // Timers never fire: the startup alerts scheduled on a window are not under test.
    setTimeout: () => 0,
  } as unknown as FakeWindow;
}

/** An element in `win`'s document, as a context's `menuElem` or an event's target. */
export function menuElementIn(win: Window): { ownerDocument: { defaultView: Window } } {
  return { ownerDocument: { defaultView: win } };
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

/** The last line the first progress window showed. */
export function lastProgressLine(): unknown {
  return progressWindows()[0]?.lines[0]?.setText.mock.calls.at(-1)?.[0];
}

// ─── Menu contexts, as each supported Zotero builds them ─────────────────────

/** What a MenuManager handler receives, with the spies a test reads back. */
export type FakeMenuContext = _ZoteroTypes.MenuManagerContext & {
  readonly setVisible: Mock;
  readonly setEnabled: Mock;
};

/** What a test adds to a context: where the menu opened and, on the item target, the items. */
export interface ContextFields {
  readonly menuElem?: unknown;
  readonly items?: readonly _ZoteroTypes.Item[];
}

const removedApiWarnings: string[] = [];

/** The removed-API warnings fake Zotero 10 contexts logged since the last call, which it forgets. */
export function takeRemovedApiWarnings(): string[] {
  return removedApiWarnings.splice(0);
}

function defaultContextFields() {
  return { setVisible: vi.fn(), setEnabled: vi.fn(), tabType: "library", tabID: "zotero-pane" };
}

/**
 * A Zotero 8 or 9 context: MenuManager `Object.assign`s its defaults with the
 * pane's fields (menuManager.js@9.0.6 636, @8.0.4 608), and the pane passes the
 * focused row as a plain `collectionTreeRow` (zoteroPane.js@9.0.6 3716 collection,
 * 4249 item; @8.0.4 3688, 4207). There is no `collectionTreeRows`.
 */
function zotero9Context(row: unknown, fields: ContextFields): FakeMenuContext {
  return {
    ...defaultContextFields(),
    collectionTreeRow: row,
    ...fields,
  } as unknown as FakeMenuContext;
}

/**
 * A Zotero 10 context. MenuManager copies property descriptors rather than values
 * (menuManager.js@10.0.2 635-645), so the pane's `collectionTreeRow` arrives as
 * its getter, which throws for more than one selected row and logs a removed-API
 * warning for one (zoteroPane.js@10.0.2 4138-4151 collection, 4689-4702 item).
 *
 * This fake keeps both: the getter is enumerable, as an object-literal getter
 * is, so spreading, serializing or `Object.assign`-ing the context reads it, and
 * the warning lands where takeRemovedApiWarnings() finds it.
 */
function zotero10Context(rows: readonly unknown[], fields: ContextFields): FakeMenuContext {
  const context = { ...defaultContextFields(), ...fields };
  Object.defineProperties(context, {
    collectionTreeRow: {
      configurable: true,
      enumerable: true,
      get() {
        if (rows.length > 1) {
          throw new Error("collectionTreeRow was removed -- use collectionTreeRows");
        }
        removedApiWarnings.push("Menu context collectionTreeRow");
        return rows[0];
      },
    },
    collectionTreeRows: { configurable: true, enumerable: true, writable: true, value: rows },
  });
  return context as unknown as FakeMenuContext;
}

/** A Zotero 8 or 9 collection-menu context for the right-clicked row. */
export function zotero9CollectionContext(
  row: unknown,
  fields: ContextFields = {},
): FakeMenuContext {
  return zotero9Context(row, fields);
}

/** A Zotero 10 collection-menu context for the selected rows. */
export function zotero10CollectionContext(
  rows: readonly unknown[],
  fields: ContextFields = {},
): FakeMenuContext {
  return zotero10Context(rows, fields);
}

/** A supported Zotero's collection-menu context for one right-clicked row. */
export interface CollectionMenuHost {
  readonly name: string;
  context(row: unknown, fields?: ContextFields): FakeMenuContext;
}

export const COLLECTION_MENU_HOSTS: readonly CollectionMenuHost[] = [
  { name: "Zotero 8 and 9", context: (row, fields) => zotero9CollectionContext(row, fields) },
  {
    name: "Zotero 10",
    context: (row, fields) => zotero10CollectionContext(row ? [row] : [], fields),
  },
];

/**
 * A supported Zotero's item-menu context. Zotero 10 appears twice, with one and
 * with two collection-tree rows selected, because its getter warns for the first
 * and throws for the second.
 */
export interface ItemMenuHost {
  readonly name: string;
  context(fields?: ContextFields): FakeMenuContext;
}

export const ITEM_MENU_HOSTS: readonly ItemMenuHost[] = [
  { name: "Zotero 8 and 9", context: (fields = {}) => zotero9Context(libraryRow(1), fields) },
  {
    name: "Zotero 10 with one collection-tree row selected",
    context: (fields = {}) => zotero10Context([libraryRow(1)], fields),
  },
  {
    name: "Zotero 10 with two collection-tree rows selected",
    context: (fields = {}) =>
      zotero10Context(
        [collectionRow(makeCollection([])), collectionRow(makeCollection([]))],
        fields,
      ),
  },
];

// ─── Fake MenuManager ────────────────────────────────────────────────────────

/** A registered menu entry, as the fake MenuManager captured it. */
export interface CapturedMenuEntry {
  readonly l10nID?: string;
  readonly label?: string;
  readonly onShowing?: (event: Event, context: FakeMenuContext) => void;
  readonly onCommand?: (event: Event, context: FakeMenuContext) => void;
}

export interface CapturedMenu {
  readonly menuID: string;
  readonly pluginID: string;
  readonly target: string;
  readonly menus: readonly CapturedMenuEntry[];
}

export interface FakeMenuManager {
  readonly registerMenu: Mock;
  readonly unregisterMenu: Mock;
  /** Every registration attempt, in order. */
  readonly captured: CapturedMenu[];
  /**
   * What the next `registerMenu` calls do, oldest first: return the value, or
   * throw it when it is an Error. Calls past the list return the menu ID.
   */
  readonly outcomes: Array<string | false | Error>;
  /** The entry with `l10nID` on the most recent menu registered for `target`. */
  entry(target: "item" | "collection", l10nID: string): CapturedMenuEntry;
}

export function fakeMenuManager(): FakeMenuManager {
  const captured: CapturedMenu[] = [];
  const outcomes: Array<string | false | Error> = [];
  const registerMenu = vi.fn((options: CapturedMenu) => {
    captured.push(options);
    const outcome = outcomes.length > 0 ? outcomes.shift()! : options.menuID;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return {
    registerMenu,
    unregisterMenu: vi.fn(() => true),
    captured,
    outcomes,
    entry(target, l10nID) {
      const menu = captured.findLast((c) => c.target === `main/library/${target}`);
      const found = menu?.menus.find((m) => m.l10nID === l10nID);
      if (!found) throw new Error(`no ${l10nID} entry registered on the ${target} menu`);
      return found;
    },
  };
}

// ─── Batch results ───────────────────────────────────────────────────────────

/** The cache refusal a result may name for its `unwritableStopped` count. */
interface Refusal {
  readonly code?: DiagnosticCode;
}

/** A fetch batch result with every count zero except those given. */
export function batchResult(overrides: Partial<FetchBatchResult> & Refusal = {}): FetchBatchResult {
  return {
    fresh: 0,
    cached: 0,
    suggestion: 0,
    errors: 0,
    budgetStopped: 0,
    authStopped: 0,
    unwritableStopped: 0,
    ...overrides,
  };
}

/** An author backfill result with every count zero, not cancelled, except as given. */
export function backfillResult(
  overrides: Partial<AuthorBackfillResult> & Refusal = {},
): AuthorBackfillResult {
  return {
    resolved: 0,
    already: 0,
    unresolved: 0,
    budgetStopped: 0,
    authStopped: 0,
    unwritableStopped: 0,
    errors: 0,
    cancelled: false,
    ...overrides,
  };
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
// Every assertion about what a menu recorded goes through these, so a port to a
// branch that reports failures through another channel changes these functions
// and nothing else. Each imports the diagnostics module dynamically, so it reads
// the same instance as a module graph a test reloaded with vi.resetModules().

let failuresRead = false;

async function diagnostics() {
  return import("../../src/modules/diagnostics");
}

/** The CG-UI02 records: selection reads that failed. */
export async function selectionUnreadableReports() {
  failuresRead = true;
  return (await diagnostics()).recentDiagnostics().filter((d) => d.code === "CG-UI02");
}

/** Every recorded failure, whatever its code. */
export async function recordedFailures() {
  failuresRead = true;
  return (await diagnostics()).recentDiagnostics();
}

export async function clearRecordedFailures(): Promise<void> {
  (await diagnostics()).clearDiagnostics();
}

/**
 * The check every menu test ends with, from `afterEach`: no fake Zotero 10
 * context logged a removed-API warning, and nothing was recorded unless the test
 * read the recorded failures itself. A handler that reads a context the way
 * Zotero 10 forbids either throws into guard(), which records, or logs the
 * warning, so neither can pass a test silently.
 */
export async function expectHostContractKept(): Promise<void> {
  const read = failuresRead;
  failuresRead = false;
  expect(takeRemovedApiWarnings(), "a handler read Zotero 10's removed collectionTreeRow").toEqual(
    [],
  );
  if (!read) {
    const recorded = (await diagnostics()).recentDiagnostics();
    expect(
      recorded.map((d) => `${d.code} ${d.context}: ${d.detail}`),
      "a handler recorded a failure the test did not expect",
    ).toEqual([]);
  }
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

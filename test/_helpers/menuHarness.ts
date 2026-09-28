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

/** An element's class list, as far as the code under test and the fakes use one. */
class FakeClassList {
  private readonly tokens = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) this.tokens.add(token);
  }

  contains(token: string): boolean {
    return this.tokens.has(token);
  }
}

export class FakeMenuElement {
  id = "";
  hidden = false;
  parent: FakeMenuElement | null = null;
  readonly children: FakeMenuElement[] = [];
  readonly attrs = new Map<string, string>();
  readonly classList = new FakeClassList();
  private readonly listeners = new Map<string, EventListener[]>();

  constructor(
    private readonly doc: FakeMenuDocument,
    readonly localName = "",
  ) {}

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

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  /** This element's descendants, in document order. */
  descendants(): FakeMenuElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
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

/**
 * The selectors the fake document answers, the only ones the code under test
 * and these helpers use: a single class (`.name`), or a tag with exact
 * attribute values (`link[rel="localization"][href="x.ftl"]`). Any other
 * selector throws, so code that starts querying differently fails loudly here
 * rather than matching nothing.
 */
function selectorMatcher(selector: string): (el: FakeMenuElement) => boolean {
  const byClass = /^\.([\w-]+)$/.exec(selector);
  if (byClass) return (el) => el.classList.contains(byClass[1]);
  const byAttrs = /^([a-z]+)((?:\[[\w-]+="[^"]*"\])+)$/.exec(selector);
  if (byAttrs) {
    const attrs = [...byAttrs[2].matchAll(/\[([\w-]+)="([^"]*)"\]/g)];
    return (el) =>
      el.localName === byAttrs[1] &&
      attrs.every(([, name, value]) => el.getAttribute(name) === value);
  }
  throw new Error(`FakeMenuDocument does not answer the selector ${selector}`);
}

export class FakeMenuDocument {
  readonly elements = new Map<string, FakeMenuElement>();
  /** Where `MozXULElement.insertFTLIfNeeded` puts localization links in a main window. */
  readonly head = new FakeMenuElement(this, "head");
  private readonly roots: FakeMenuElement[] = [this.head];

  constructor() {
    this.addRoot("zotero-itemmenu");
    this.addRoot("zotero-collectionmenu");
  }

  addRoot(id: string): FakeMenuElement {
    const el = new FakeMenuElement(this, "menupopup");
    el.id = id;
    this.elements.set(id, el);
    this.roots.push(el);
    return el;
  }

  getElementById(id: string): FakeMenuElement | null {
    return this.elements.get(id) ?? null;
  }

  querySelectorAll(selector: string): FakeMenuElement[] {
    const matches = selectorMatcher(selector);
    return this.roots.flatMap((root) => [root, ...root.descendants()]).filter(matches);
  }

  querySelector(selector: string): FakeMenuElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  createXULElement(localName = ""): FakeMenuElement {
    return new FakeMenuElement(this, localName);
  }

  createElementNS(_namespace: string, localName: string): FakeMenuElement {
    return new FakeMenuElement(this, localName);
  }

  /** The localization links whose `href` is `path`. */
  localizationLinks(path: string): FakeMenuElement[] {
    return this.querySelectorAll(`link[rel="localization"][href="${path}"]`);
  }
}

/** A main window as the menus see it. */
export type FakeWindow = Window & {
  readonly document: FakeMenuDocument;
  AbortController: typeof AbortController;
  MozXULElement: { insertFTLIfNeeded: Mock };
  ZoteroPane?: unknown;
  closed: boolean;
};

/**
 * A main window for menu tests: its own document, its own Zotero pane when one
 * is given, the `AbortController` constructor every chrome window carries, and
 * `closed`, which a test sets to close it. The DOM menus build their listener
 * signal from the window's own constructor, so a fake without one would only
 * ever exercise the global fallback.
 *
 * `MozXULElement.insertFTLIfNeeded` does what Gecko's does: it appends an XHTML
 * `<link rel="localization" href=path>` to the head unless one with that `href`
 * is there (customElements.js@esr140 587-621).
 */
export function fakeWindow(pane?: unknown): FakeWindow {
  const document = new FakeMenuDocument();
  const insertFTLIfNeeded = vi.fn((path: string) => {
    if (document.head.children.some((el) => el.getAttribute("href") === path)) return;
    const link = document.createElementNS("http://www.w3.org/1999/xhtml", "link");
    link.setAttribute("rel", "localization");
    link.setAttribute("href", path);
    document.head.appendChild(link);
  });
  return {
    document,
    AbortController,
    MozXULElement: { insertFTLIfNeeded },
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

/**
 * `CSS.escape`, as the CSSOM specifies it ("serialize an identifier"). Node has
 * no `CSS`, and the fake MenuManager needs the real escaping to build the keys
 * Zotero builds.
 */
export function cssEscape(value: string): string {
  let escaped = "";
  const first = value.charCodeAt(0);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const char = value.charAt(i);
    if (code === 0) {
      escaped += "�";
    } else if (
      (code >= 0x01 && code <= 0x1f) ||
      code === 0x7f ||
      (i === 0 && code >= 0x30 && code <= 0x39) ||
      (i === 1 && code >= 0x30 && code <= 0x39 && first === 0x2d)
    ) {
      escaped += `\\${code.toString(16)} `;
    } else if (i === 0 && value.length === 1 && code === 0x2d) {
      escaped += `\\${char}`;
    } else if (code >= 0x80 || /[\w-]/.test(char)) {
      escaped += char;
    } else {
      escaped += `\\${char}`;
    }
  }
  return escaped;
}

/** The key Zotero stores a plugin's menu under: `CSS.escape(`${pluginID}-${menuID}`)`. */
export function menuKey(pluginID: string, menuID: string): string {
  return cssEscape(`${pluginID}-${menuID}`);
}

/**
 * How a Zotero version renders MenuManager entries. Every version puts the
 * `zotero-custom-menu-item` class and a per-entry key class on each entry and
 * copies its `l10nID` into `data-l10n-id`. Zotero 9.0.6 and later also add the
 * menu's key as a class and remove a plugin's rendered entries when its shutdown
 * observer unregisters them; 8.0.4 does neither (menuManager.js @8.0.4 290-309
 * and 435, @9.0.6 and @10.0.2 304-323 and 449).
 */
export interface MenuRenderingHost {
  readonly name: string;
  readonly stampsMenuKey: boolean;
}

export const MENU_RENDERING_HOSTS: readonly MenuRenderingHost[] = [
  { name: "Zotero 8.0.4", stampsMenuKey: false },
  { name: "Zotero 9.0.6 and 10.0.2", stampsMenuKey: true },
];

/** The popup MenuManager renders a target's entries into. */
const TARGET_POPUPS: Record<string, string> = {
  "main/library/item": "zotero-itemmenu",
  "main/library/collection": "zotero-collectionmenu",
};

const RENDERED_ENTRY_CLASS = "zotero-custom-menu-item";

const menuManagerWarnings: string[] = [];

/** The warnings the fake MenuManager logged since the last call, which it forgets. */
export function takeMenuManagerWarnings(): string[] {
  return menuManagerWarnings.splice(0);
}

/** What the next `registerMenu` call does: register as Zotero would, refuse, or throw. */
export type RegisterOutcome = "register" | false | Error;

export interface FakeMenuManager {
  readonly registerMenu: Mock;
  readonly unregisterMenu: Mock;
  /** Zotero's internal registry, as Citegeist reads it. Absent when made with `exposeRegistry: false`. */
  readonly _menuManager?: { readonly options: readonly CapturedMenu[] };
  /** Every registration attempt, in order. */
  readonly captured: CapturedMenu[];
  /** What the next `registerMenu` calls do, oldest first; calls past the list register. */
  readonly outcomes: RegisterOutcome[];
  /** The registrations Zotero holds, by key. */
  readonly registered: ReadonlyMap<string, CapturedMenu>;
  /** The entry with `l10nID` on the most recent menu registered for `target`. */
  entry(target: "item" | "collection", l10nID: string): CapturedMenuEntry;
  /**
   * Render every registered menu into `win`'s popups, as `updateMenuPopup` does
   * when a popup opens: entries no longer registered go, registered ones are
   * (re)built.
   */
  render(win: FakeWindow, host: MenuRenderingHost): void;
  /**
   * What Zotero's plugin-shutdown observer does (pluginAPIBase.mjs
   * `_unregisterByPluginID` 345-356, menuManager.js 304-323): remove every menu
   * `pluginID` registered, silently, and on a host that stamps menu keys, their
   * rendered entries in `windows`.
   */
  shutdownPlugin(pluginID: string, windows: readonly FakeWindow[], host: MenuRenderingHost): void;
}

/**
 * A `Zotero.MenuManager` that keeps its registry the way PluginAPIBase does
 * (pluginAPIBase.mjs, identical at 8.0.4, 9.0.6 and 10.0.2): `registerMenu`
 * stores a menu under `CSS.escape(`${pluginID}-${menuID}`)` and returns that
 * key, and returns `false` with a warning for a key already registered
 * (`_validate` 177-194); `unregisterMenu` removes a menu by that key only, and
 * for any other string returns `false` and warns "Can't remove unknown option"
 * (`_remove` 163-170). The warnings land where takeMenuManagerWarnings() finds
 * them, and expectHostContractKept() fails a test that leaves one unread.
 */
export function fakeMenuManager(options: { exposeRegistry?: boolean } = {}): FakeMenuManager {
  const captured: CapturedMenu[] = [];
  const outcomes: RegisterOutcome[] = [];
  const registered = new Map<string, CapturedMenu>();
  let renderedKeys = 0;

  const registerMenu = vi.fn((menu: CapturedMenu) => {
    captured.push(menu);
    const outcome = outcomes.length > 0 ? outcomes.shift()! : "register";
    if (outcome instanceof Error) throw outcome;
    if (outcome === false) return false;
    const key = menuKey(menu.pluginID, menu.menuID);
    if (registered.has(key)) {
      menuManagerWarnings.push(`MenuAPI: 'menuID' must be unique, got ${key}`);
      return false;
    }
    registered.set(key, { ...menu, menuID: key });
    return key;
  });

  const unregisterMenu = vi.fn((key: string) => {
    if (!registered.delete(key)) {
      menuManagerWarnings.push(`MenuAPI: Can't remove unknown option '${key}'`);
      return false;
    }
    return true;
  });

  function removeEntries(win: FakeWindow, keep: (entry: FakeMenuElement) => boolean): void {
    for (const entry of win.document.querySelectorAll(`.${RENDERED_ENTRY_CLASS}`)) {
      if (!keep(entry)) entry.remove();
    }
  }

  const manager: FakeMenuManager = {
    registerMenu,
    unregisterMenu,
    captured,
    outcomes,
    registered,
    entry(target, l10nID) {
      const menu = captured.findLast((c) => c.target === `main/library/${target}`);
      const found = menu?.menus.find((m) => m.l10nID === l10nID);
      if (!found) throw new Error(`no ${l10nID} entry registered on the ${target} menu`);
      return found;
    },
    render(win, host) {
      removeEntries(win, () => false);
      for (const [key, menu] of [...registered].sort(([a], [b]) => a.localeCompare(b))) {
        const popup = win.document.getElementById(TARGET_POPUPS[menu.target]);
        if (!popup) continue;
        for (const data of menu.menus) {
          const entry = win.document.createXULElement("menuitem");
          entry.classList.add(RENDERED_ENTRY_CLASS, `zotero-custom-menu-${++renderedKeys}`);
          if (host.stampsMenuKey) entry.classList.add(key);
          if (data.l10nID) entry.setAttribute("data-l10n-id", data.l10nID);
          popup.appendChild(entry);
        }
      }
    },
    shutdownPlugin(pluginID, windows, host) {
      const removed = [...registered].filter(([, menu]) => menu.pluginID === pluginID);
      for (const [key] of removed) registered.delete(key);
      if (!host.stampsMenuKey || removed.length === 0) return;
      for (const win of windows) {
        removeEntries(win, (entry) => !removed.some(([key]) => entry.classList.contains(key)));
      }
    },
  };
  if (options.exposeRegistry === false) return manager;
  return {
    ...manager,
    _menuManager: {
      get options() {
        return [...registered.values()].map((menu) => ({ ...menu }));
      },
    },
  };
}

/**
 * An entry another plugin's menu rendered into `popupID`, with the class
 * MenuManager puts on every entry, so a test can check that Citegeist removes
 * only its own.
 */
export function renderOtherPluginEntry(win: FakeWindow, popupID: string): FakeMenuElement {
  const entry = win.document.createXULElement("menuitem");
  entry.classList.add(
    RENDERED_ENTRY_CLASS,
    "zotero-custom-menu-other",
    menuKey("other@example.org", "menu"),
  );
  entry.setAttribute("data-l10n-id", "other-plugin-menu-entry");
  win.document.getElementById(popupID)!.appendChild(entry);
  return entry;
}

/** The `data-l10n-id` of every rendered MenuManager entry in `win`, in document order. */
export function renderedEntryL10nIDs(win: FakeWindow): string[] {
  return win.document
    .querySelectorAll(`.${RENDERED_ENTRY_CLASS}`)
    .map((entry) => entry.getAttribute("data-l10n-id") ?? "");
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
 * context logged a removed-API warning, the fake MenuManager logged no warning
 * the test did not take, and nothing was recorded unless the test read the
 * recorded failures itself. A handler that reads a context the way Zotero 10
 * forbids either throws into guard(), which records, or logs the warning, so
 * neither can pass a test silently. MenuManager's warnings are how Zotero
 * answers an unregister by the wrong key or a duplicate registration, and Zotero
 * 8 to 10 file them as errors in Help → Report Errors.
 */
export async function expectHostContractKept(): Promise<void> {
  const read = failuresRead;
  failuresRead = false;
  expect(takeRemovedApiWarnings(), "a handler read Zotero 10's removed collectionTreeRow").toEqual(
    [],
  );
  expect(takeMenuManagerWarnings(), "Zotero's MenuManager logged a warning").toEqual([]);
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

/** A promise a test settles itself, to hold an await open while something else happens. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

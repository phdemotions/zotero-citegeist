/**
 * Tests for the Zotero 8+ `Zotero.MenuManager` registration path and its
 * fallback to the DOM path (Zotero 7.0.x). The DOM handler behaviour itself is
 * covered by collection-menu.test.ts.
 *
 * `menu.ts` holds process-global module state (`menuManagerRegistered`), so
 * each test loads a fresh module instance via `loadMenu()` (vi.resetModules +
 * dynamic import) — the same pattern citationColumn.test.ts uses for its own
 * `registered` flag. Without it, the flag would leak across tests.
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  FakeDocument,
  UNSUPPORTED_ROW_TYPES,
  clearRecordedFailures,
  collectionRow,
  fakeProgressWindowClass,
  flushAsync,
  idsOf,
  libraryRow,
  makeCollection,
  makeItem,
  otherRow,
  progressWindowParents,
  recordedFailures,
  selectionUnreadableReports,
} from "./_helpers/menuHarness";

const mocks = vi.hoisted(() => ({
  fetchAndCacheItems: vi.fn(async () => ({
    fresh: 1,
    cached: 0,
    suggestion: 0,
    errors: 0,
    budgetStopped: 0,
    authStopped: 0,
  })),
  canResolveWork: vi.fn(
    (item: { isRegularItem?: () => boolean; hasIdentifier?: boolean }) =>
      item.isRegularItem?.() !== false && item.hasIdentifier !== false,
  ),
  resolveAuthorsForItems: vi.fn(async () => ({
    resolved: 1,
    already: 0,
    unresolved: 0,
    budgetStopped: 0,
    authStopped: 0,
    errors: 0,
    cancelled: false,
  })),
  invalidateColumnCache: vi.fn(),
  showCitationNetwork: vi.fn(async () => {}),
}));

vi.mock("../src/modules/citationService", () => ({
  fetchAndCacheItems: mocks.fetchAndCacheItems,
  canResolveWork: mocks.canResolveWork,
  resolveAuthorsForItems: mocks.resolveAuthorsForItems,
}));
vi.mock("../src/modules/citationColumn", () => ({
  invalidateColumnCache: mocks.invalidateColumnCache,
}));
vi.mock("../src/modules/citationNetwork", () => ({
  showCitationNetwork: mocks.showCitationNetwork,
}));

const PLUGIN_ID = "citegeist@opusvita.org";

interface CapturedMenu {
  menuID: string;
  pluginID: string;
  target: string;
  menus: Array<{
    l10nID?: string;
    label?: string;
    onShowing?: (e: Event, ctx: unknown) => void;
    onCommand?: (e: Event, ctx: unknown) => void;
  }>;
}

let doc: FakeDocument;
let win: Window;
let selectedItems: _ZoteroTypes.Item[];
let libraryItems: _ZoteroTypes.Item[];
let alertSpy: Mock;
let registerReturns: Array<string | false>;
let registerMenu: Mock;
let unregisterMenu: Mock;
let captured: CapturedMenu[];

function installZotero(withMenuManager: boolean): void {
  captured = [];
  registerMenu = vi.fn((opts: CapturedMenu) => {
    captured.push(opts);
    return registerReturns.length ? registerReturns.shift()! : opts.menuID;
  });
  unregisterMenu = vi.fn(() => true);
  alertSpy = vi.fn();

  const zotero: Record<string, unknown> = {
    debug: vi.fn(),
    getMainWindow: vi.fn(() => win),
    // The most recent window's pane. `win` has no ZoteroPane of its own, so a
    // handler that names no other window falls back to this one.
    getActiveZoteroPane: vi.fn(() => ({
      getSelectedItems: () => selectedItems,
      // Zotero 10's singular collection getters throw on a multi-row selection.
      // The MenuManager path reads the context rows and must never call them.
      getSelectedCollection: () => {
        throw new Error("getSelectedCollection() was removed -- use getSelectedCollections()");
      },
      getSelectedLibraryID: () => {
        throw new Error("getSelectedLibraryID() was removed -- use getSelectedLibraryIDs()");
      },
    })),
    Items: { getAll: vi.fn(async () => libraryItems) },
    Libraries: { userLibraryID: 1 },
    ProgressWindow: fakeProgressWindowClass(),
  };
  if (withMenuManager) {
    zotero.MenuManager = { registerMenu, unregisterMenu };
  }
  vi.stubGlobal("Zotero", zotero);
  vi.stubGlobal("Services", { prompt: { alert: alertSpy } });
}

/**
 * Fresh `menu.ts` instance per call so the module-global
 * `menuManagerRegistered` flag never leaks between tests. Mirrors
 * citationColumn.test.ts's `loadCitationColumn()`.
 */
async function loadMenu() {
  vi.resetModules();
  const mod = await import("../src/modules/menu");
  mod.setMenuPluginID(PLUGIN_ID);
  return mod;
}

beforeEach(() => {
  vi.clearAllMocks();
  doc = new FakeDocument();
  win = { document: doc } as unknown as Window;
  selectedItems = [makeItem(1)];
  libraryItems = [makeItem(1), makeItem(2)];
  registerReturns = [];
});

/** A MenuManager context for the collection target. */
function collectionContext(fields: Record<string, unknown>) {
  return { setVisible: vi.fn(), setEnabled: vi.fn(), ...fields };
}

/** A menu element whose document belongs to `w`, as a context's `menuElem` or an event target. */
const elementIn = (w: Window) => ({ ownerDocument: { defaultView: w } });

const findMenu = (target: string) => captured.find((c) => c.target === target)!;

describe("MenuManager path (Zotero 8+)", () => {
  it("registers item + collection menus via MenuManager, not the DOM", async () => {
    installZotero(true);
    const { registerMenus } = await loadMenu();
    registerMenus(win);

    expect(registerMenu).toHaveBeenCalledTimes(2);
    const item = findMenu("main/library/item");
    const collection = findMenu("main/library/collection");
    expect(item.pluginID).toBe(PLUGIN_ID);
    expect(collection.pluginID).toBe(PLUGIN_ID);
    // MenuManager renders text ONLY from data-l10n-id — a plain `label` is
    // dropped and the item shows blank. So the menus MUST carry l10nIDs (not
    // labels); the text itself comes from the FTL, injected per window by
    // hooks.ensureCitegeistFTL via the bare-filename auto-registered source.
    expect(item.menus.map((m) => m.l10nID)).toEqual([
      "citegeist-menu-fetch",
      "citegeist-menu-citing",
      "citegeist-menu-refs",
      "citegeist-menu-resolve-authors",
    ]);
    expect(item.menus.every((m) => m.label === undefined)).toBe(true);
    expect(collection.menus.map((m) => m.l10nID)).toEqual([
      "citegeist-menu-fetch-collection",
      "citegeist-menu-resolve-collection",
    ]);
    // No DOM nodes were injected — the MenuManager path returned first.
    expect(doc.getElementById("citegeist-menu-fetch")).toBeNull();
  });

  it("decides item-menu visibility from context.items in onShowing", async () => {
    installZotero(true);
    const { registerMenus } = await loadMenu();
    registerMenus(win);
    const item = findMenu("main/library/item");

    const fetchShowing = item.menus[0].onShowing!;
    const citingShowing = item.menus[1].onShowing!;

    const visFetch = vi.fn();
    fetchShowing({} as Event, { items: [makeItem(1)], setVisible: visFetch });
    expect(visFetch).toHaveBeenCalledWith(true);

    const visFetchNone = vi.fn();
    selectedItems = [];
    fetchShowing({} as Event, { items: [], setVisible: visFetchNone });
    expect(visFetchNone).toHaveBeenCalledWith(false);

    // ctx.items is authoritative when present: a single non-resolvable target
    // hides Fetch even though the pane selection holds an eligible item. Pins
    // the ctx.items-first semantics (no OR-with-pane fallback) and prevents a
    // revert to the old `... || eligibleSelectedCount() > 0` form.
    const visFetchIneligible = vi.fn();
    selectedItems = [makeItem(9, true)];
    fetchShowing({} as Event, { items: [makeItem(2, false)], setVisible: visFetchIneligible });
    expect(visFetchIneligible).toHaveBeenCalledWith(false);

    // Citing is single-item only
    const visCiting2 = vi.fn();
    citingShowing({} as Event, { items: [makeItem(1), makeItem(2)], setVisible: visCiting2 });
    expect(visCiting2).toHaveBeenCalledWith(false);

    const visCiting1 = vi.fn();
    citingShowing({} as Event, { items: [makeItem(1)], setVisible: visCiting1 });
    expect(visCiting1).toHaveBeenCalledWith(true);
  });

  it("gates View Citing/References on canResolveWork, not mere single-selection", async () => {
    installZotero(true);
    const { registerMenus } = await loadMenu();
    registerMenus(win);
    const item = findMenu("main/library/item");
    const citingShowing = item.menus[1].onShowing!;
    const refsShowing = item.menus[2].onShowing!;

    // Single resolvable item → View entries shown.
    const visResolvable = vi.fn();
    citingShowing({} as Event, { items: [makeItem(1, true)], setVisible: visResolvable });
    expect(visResolvable).toHaveBeenCalledWith(true);

    // Single NON-resolvable item (no recognized identifier, no confirmed match)
    // → hidden. Pins the gate to canResolveWork; a revert to a single-select-only
    // check would wrongly reveal it.
    const visNonResolvable = vi.fn();
    refsShowing({} as Event, { items: [makeItem(2, false)], setVisible: visNonResolvable });
    expect(visNonResolvable).toHaveBeenCalledWith(false);
  });

  it("runs the View Citing action from onCommand", async () => {
    installZotero(true);
    const { registerMenus } = await loadMenu();
    registerMenus(win);
    const item = findMenu("main/library/item");
    selectedItems = [makeItem(7)];
    item.menus[1].onCommand!({} as Event, {});
    expect(mocks.showCitationNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      "citing",
    );
  });

  it("runs the collection fetch action from onCommand", async () => {
    installZotero(true);
    const { registerMenus } = await loadMenu();
    registerMenus(win);
    const collection = findMenu("main/library/collection");
    collection.menus[0].onCommand!(
      {} as Event,
      collectionContext({
        collectionTreeRows: [collectionRow(makeCollection([makeItem(1), makeItem(2)]))],
      }),
    );
    await flushAsync();
    expect(mocks.fetchAndCacheItems).toHaveBeenCalled();
  });

  it("rolls back the item menu and falls back to DOM when the collection registration is rejected", async () => {
    installZotero(true);
    const { registerMenus } = await loadMenu();
    registerReturns = ["citegeist-item-menu", false]; // item ok, collection rejected
    registerMenus(win);

    // Item menu rolled back…
    expect(unregisterMenu).toHaveBeenCalledWith("citegeist-item-menu");
    // …and the DOM fallback ran instead.
    expect(doc.getElementById("citegeist-menu-fetch")).not.toBeNull();
    expect(doc.getElementById("citegeist-menu-fetch-collection")).not.toBeNull();
  });
});

describe("resolve-authors handlers (MenuManager, U4 backfill)", () => {
  it("gates item resolve-authors visibility on eligibility and runs the backfill from onCommand", async () => {
    installZotero(true);
    const { registerMenus } = await loadMenu();
    registerMenus(win);
    const item = findMenu("main/library/item");
    const resolve = item.menus[3]; // [fetch, citing, refs, resolve-authors]
    expect(resolve.l10nID).toBe("citegeist-menu-resolve-authors");

    const visYes = vi.fn();
    resolve.onShowing!({} as Event, { items: [makeItem(1, true)], setVisible: visYes });
    expect(visYes).toHaveBeenCalledWith(true);

    const visNo = vi.fn();
    resolve.onShowing!({} as Event, { items: [makeItem(2, false)], setVisible: visNo });
    expect(visNo).toHaveBeenCalledWith(false);

    selectedItems = [makeItem(7)];
    resolve.onCommand!({} as Event, {});
    await flushAsync();
    expect(mocks.resolveAuthorsForItems).toHaveBeenCalled();
  });

  it("runs the collection resolve-authors backfill from onCommand", async () => {
    installZotero(true);
    const { registerMenus } = await loadMenu();
    registerMenus(win);
    const collection = findMenu("main/library/collection");
    const resolve = collection.menus[1]; // [fetch-collection, resolve-collection]
    expect(resolve.l10nID).toBe("citegeist-menu-resolve-collection");

    resolve.onCommand!(
      {} as Event,
      collectionContext({
        collectionTreeRows: [collectionRow(makeCollection([makeItem(1), makeItem(2)]))],
      }),
    );
    await flushAsync();
    expect(mocks.resolveAuthorsForItems).toHaveBeenCalled();
  });
});

describe("collection menu reads the selection from the context rows (Zotero 10, AE3)", () => {
  async function collectionMenu() {
    installZotero(true);
    const { registerMenus } = await loadMenu();
    registerMenus(win);
    // Same fresh module graph as menu.ts, so this clears the buffer logError records into.
    await clearRecordedFailures();
    const menu = findMenu("main/library/collection");
    return { fetch: menu.menus[0], resolve: menu.menus[1] };
  }

  const fetchedIds = () => idsOf(mocks.fetchAndCacheItems.mock.calls[0][0] as _ZoteroTypes.Item[]);

  it("covers AE3: two selected collections fetch both collections' items, each item once", async () => {
    const { fetch } = await collectionMenu();
    const shared = makeItem(2);
    const ctx = collectionContext({
      collectionTreeRows: [
        collectionRow(makeCollection([makeItem(1), shared])),
        collectionRow(makeCollection([shared, makeItem(3)])),
      ],
    });

    fetch.onShowing!({} as Event, ctx);
    expect(ctx.setVisible).toHaveBeenCalledWith(true);

    fetch.onCommand!({} as Event, ctx);
    await flushAsync();
    expect(mocks.fetchAndCacheItems).toHaveBeenCalledTimes(1);
    expect(fetchedIds()).toEqual([1, 2, 3]);
  });

  it("never reads Zotero 10's collectionTreeRow getter, which throws on a multi-row selection", async () => {
    const { fetch } = await collectionMenu();
    // Built literally, not spread: a spread would invoke the throwing getter.
    const ctx = {
      setVisible: vi.fn(),
      setEnabled: vi.fn(),
      collectionTreeRows: [
        collectionRow(makeCollection([makeItem(1)])),
        collectionRow(makeCollection([makeItem(2)])),
      ],
      get collectionTreeRow(): never {
        throw new Error("collectionTreeRow was removed -- use collectionTreeRows");
      },
    };

    fetch.onShowing!({} as Event, ctx);
    fetch.onCommand!({} as Event, ctx);
    await flushAsync();

    expect(ctx.setVisible).toHaveBeenCalledWith(true);
    expect(fetchedIds()).toEqual([1, 2]);
    expect(await recordedFailures()).toEqual([]);
  });

  it("fetches every selected library, each item once, not only the first", async () => {
    const { fetch } = await collectionMenu();
    (Zotero.Items.getAll as Mock).mockImplementation(async (libraryID: number) =>
      libraryID === 2 ? [makeItem(10)] : [makeItem(3)],
    );
    fetch.onCommand!(
      {} as Event,
      collectionContext({ collectionTreeRows: [libraryRow(2, "group"), libraryRow(1)] }),
    );
    await flushAsync();

    expect(Zotero.Items.getAll).toHaveBeenCalledTimes(2);
    expect(Zotero.Items.getAll).toHaveBeenCalledWith(2, false);
    expect(Zotero.Items.getAll).toHaveBeenCalledWith(1, false);
    expect(fetchedIds()).toEqual([3, 10]);
  });

  it("fetches collections from different libraries in one batch", async () => {
    const { fetch } = await collectionMenu();
    fetch.onCommand!(
      {} as Event,
      collectionContext({
        collectionTreeRows: [
          collectionRow(makeCollection([makeItem(3)], [], 1)),
          collectionRow(makeCollection([makeItem(10)], [], 2)),
        ],
      }),
    );
    await flushAsync();

    expect(fetchedIds()).toEqual([3, 10]);
    expect(Zotero.Items.getAll).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a library row with one of its collections",
      () => [libraryRow(1), collectionRow(makeCollection([makeItem(50)], [], 1))],
    ],
    [
      "a collection with its library row",
      () => [collectionRow(makeCollection([makeItem(50)], [], 1)), libraryRow(1)],
    ],
    [
      "a group library with a collection from another library",
      () => [libraryRow(2, "group"), collectionRow(makeCollection([makeItem(3)], [], 1))],
    ],
  ])(
    "%s hides both entries and the commands start nothing, as Zotero 10 keeps no such selection",
    async (_label, rows) => {
      const { fetch, resolve } = await collectionMenu();
      for (const entry of [fetch, resolve]) {
        const ctx = collectionContext({ collectionTreeRows: rows() });
        entry.onShowing!({} as Event, ctx);
        expect(ctx.setVisible).toHaveBeenCalledWith(false);
        entry.onCommand!({} as Event, ctx);
      }
      await flushAsync();

      expect(mocks.fetchAndCacheItems).not.toHaveBeenCalled();
      expect(mocks.resolveAuthorsForItems).not.toHaveBeenCalled();
      expect(Zotero.Items.getAll).not.toHaveBeenCalled();
      expect(Zotero.ProgressWindow).not.toHaveBeenCalled();
      expect(alertSpy).not.toHaveBeenCalled();
      expect(await recordedFailures()).toEqual([]);
    },
  );

  describe.each(UNSUPPORTED_ROW_TYPES)("a %s row", (type) => {
    it.each([
      ["alone", () => [otherRow(type)]],
      ["after a collection", () => [collectionRow(makeCollection([makeItem(1)])), otherRow(type)]],
      ["before a collection", () => [otherRow(type), collectionRow(makeCollection([makeItem(1)]))]],
    ])("%s hides both collection entries, and the commands start nothing", async (_label, rows) => {
      const { fetch, resolve } = await collectionMenu();
      for (const entry of [fetch, resolve]) {
        const ctx = collectionContext({ collectionTreeRows: rows() });
        entry.onShowing!({} as Event, ctx);
        expect(ctx.setVisible).toHaveBeenCalledWith(false);
        entry.onCommand!({} as Event, ctx);
      }
      await flushAsync();

      expect(mocks.fetchAndCacheItems).not.toHaveBeenCalled();
      expect(mocks.resolveAuthorsForItems).not.toHaveBeenCalled();
      expect(Zotero.Items.getAll).not.toHaveBeenCalled();
      expect(Zotero.ProgressWindow).not.toHaveBeenCalled();
      expect(alertSpy).not.toHaveBeenCalled();
      // A crash would satisfy every "not called" above; nothing recorded rules it out.
      expect(await recordedFailures()).toEqual([]);
    });
  });

  it("Zotero 8/9: a context with only collectionTreeRow fetches that one collection", async () => {
    const { fetch } = await collectionMenu();
    const ctx = collectionContext({
      collectionTreeRow: collectionRow(makeCollection([makeItem(4), makeItem(5)])),
    });

    fetch.onShowing!({} as Event, ctx);
    expect(ctx.setVisible).toHaveBeenCalledWith(true);

    fetch.onCommand!({} as Event, ctx);
    await flushAsync();
    expect(fetchedIds()).toEqual([4, 5]);
    expect(Zotero.Items.getAll).not.toHaveBeenCalled();
  });

  it("Zotero 8/9: a library-root collectionTreeRow fetches that library", async () => {
    const { fetch } = await collectionMenu();
    fetch.onCommand!({} as Event, collectionContext({ collectionTreeRow: libraryRow(7) }));
    await flushAsync();
    expect(Zotero.Items.getAll).toHaveBeenCalledWith(7, false);
    expect(fetchedIds()).toEqual([1, 2]);
  });

  it("a context with neither selection field hides the entries, throws nothing, and records CG-UI02", async () => {
    const { fetch, resolve } = await collectionMenu();
    for (const entry of [fetch, resolve]) {
      const ctx = collectionContext({});
      entry.onShowing!({} as Event, ctx);
      expect(ctx.setVisible).toHaveBeenCalledWith(false);
      entry.onCommand!({} as Event, ctx);
    }
    await flushAsync();

    expect(mocks.fetchAndCacheItems).not.toHaveBeenCalled();
    expect(mocks.resolveAuthorsForItems).not.toHaveBeenCalled();
    // One record for four reads, and no CG-BUG01: nothing threw into guard().
    expect(await selectionUnreadableReports()).toHaveLength(1);
    expect(await recordedFailures()).toHaveLength(1);
  });

  it.each([
    [
      "two collections",
      () => [
        collectionRow(makeCollection([makeItem(1, false)])),
        collectionRow(makeCollection([makeItem(2, false)])),
      ],
      "in these 2 collections",
    ],
    ["one library", () => [libraryRow(1)], "in this library"],
    ["two libraries", () => [libraryRow(1), libraryRow(2, "group")], "in these 2 libraries"],
  ])("names %s in the no-eligible-items alert", async (_label, rows, phrase) => {
    const { fetch } = await collectionMenu();
    libraryItems = [makeItem(10, false)];
    fetch.onCommand!({} as Event, collectionContext({ collectionTreeRows: rows() }));
    await flushAsync();

    expect(alertSpy).toHaveBeenCalledWith(
      win,
      "Citegeist: Nothing to fetch",
      expect.stringContaining(phrase),
    );
    expect(mocks.fetchAndCacheItems).not.toHaveBeenCalled();
  });

  it("says 'These 2 collections are empty.' when both selected collections are empty", async () => {
    const { fetch } = await collectionMenu();
    fetch.onCommand!(
      {} as Event,
      collectionContext({
        collectionTreeRows: [collectionRow(makeCollection([])), collectionRow(makeCollection([]))],
      }),
    );
    await flushAsync();
    expect(alertSpy).toHaveBeenCalledWith(
      win,
      "Citegeist: Nothing to fetch",
      "These 2 collections are empty.",
    );
  });

  it("names the selection in the resolve-authors alert too", async () => {
    const { resolve } = await collectionMenu();
    resolve.onCommand!(
      {} as Event,
      collectionContext({
        collectionTreeRows: [
          collectionRow(makeCollection([makeItem(1, false)])),
          collectionRow(makeCollection([makeItem(2, false)])),
        ],
      }),
    );
    await flushAsync();
    expect(alertSpy).toHaveBeenCalledWith(
      win,
      "Citegeist: Nothing to resolve",
      expect.stringContaining("in these 2 collections"),
    );
    expect(mocks.resolveAuthorsForItems).not.toHaveBeenCalled();
  });
});

describe("menu commands run in the right-clicked window, never the main window", () => {
  // `win` and `win2` have the same shape, so only an identity check (`toBe`)
  // tells them apart: it is what catches a runner that falls back to
  // Zotero.getMainWindow(), which returns `win`.
  let win2: Window;

  async function menus() {
    installZotero(true);
    const { registerMenus } = await loadMenu();
    registerMenus(win);
    win2 = { document: new FakeDocument() } as unknown as Window;
    return { item: findMenu("main/library/item"), collection: findMenu("main/library/collection") };
  }

  function expectOpenedOnlyIn(expected: Window): void {
    const parents = progressWindowParents();
    expect(parents.length).toBeGreaterThan(0);
    for (const parent of parents) expect(parent).toBe(expected);
  }

  it.each([
    ["Fetch Citation Counts", 0, "Citegeist: Nothing to fetch"],
    ["Resolve Author Identities", 3, "Citegeist: Nothing to resolve"],
  ])("%s opens its progress window and alert in the menu's window", async (_l, index, title) => {
    const { item } = await menus();
    const entry = item.menus[index];

    entry.onCommand!({} as Event, { menuElem: elementIn(win2), items: [makeItem(1)] });
    await flushAsync();
    expectOpenedOnlyIn(win2);

    entry.onCommand!({} as Event, { menuElem: elementIn(win2), items: [makeItem(2, false)] });
    await flushAsync();
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toBe(win2);
    expect(alertSpy.mock.calls[0][1]).toBe(title);
    expect(Zotero.getMainWindow).not.toHaveBeenCalled();
  });

  it.each([
    ["Fetch All Citation Counts", 0, "Citegeist: Nothing to fetch"],
    ["Resolve All Author Identities", 1, "Citegeist: Nothing to resolve"],
  ])("%s opens its progress window and alert in the menu's window", async (_l, index, title) => {
    const { collection } = await menus();
    const entry = collection.menus[index];

    entry.onCommand!(
      {} as Event,
      collectionContext({
        menuElem: elementIn(win2),
        collectionTreeRows: [collectionRow(makeCollection([makeItem(1)]))],
      }),
    );
    await flushAsync();
    expectOpenedOnlyIn(win2);

    entry.onCommand!(
      {} as Event,
      collectionContext({
        menuElem: elementIn(win2),
        collectionTreeRows: [collectionRow(makeCollection([makeItem(2, false)]))],
      }),
    );
    await flushAsync();
    expectOpenedOnlyIn(win2);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toBe(win2);
    expect(alertSpy.mock.calls[0][1]).toBe(title);
    expect(Zotero.getMainWindow).not.toHaveBeenCalled();
  });

  it("uses the window of the command's target when the context has no menuElem", async () => {
    const { item } = await menus();
    item.menus[0].onCommand!({ target: elementIn(win2) } as unknown as Event, {
      setVisible: vi.fn(),
      items: [makeItem(1)],
    });
    await flushAsync();
    expectOpenedOnlyIn(win2);
  });

  it("falls back to the main window when neither the context nor the event names one", async () => {
    const { item } = await menus();
    item.menus[0].onCommand!({} as Event, { items: [makeItem(1)] });
    await flushAsync();
    expectOpenedOnlyIn(win);
  });
});

describe("item commands act on the right-clicked pane's selection, not the most recent window's", () => {
  async function itemMenu() {
    installZotero(true);
    const { registerMenus } = await loadMenu();
    registerMenus(win);
    return findMenu("main/library/item");
  }

  it("Fetch, Resolve and View Citing act on the context's items", async () => {
    const item = await itemMenu();
    selectedItems = [makeItem(1)]; // the most recent window's selection

    item.menus[0].onCommand!({} as Event, { items: [makeItem(7)] });
    item.menus[3].onCommand!({} as Event, { items: [makeItem(7)] });
    item.menus[1].onCommand!({} as Event, { items: [makeItem(7)] });
    await flushAsync();

    expect(idsOf(mocks.fetchAndCacheItems.mock.calls[0][0] as _ZoteroTypes.Item[])).toEqual([7]);
    expect(idsOf(mocks.resolveAuthorsForItems.mock.calls[0][0] as _ZoteroTypes.Item[])).toEqual([
      7,
    ]);
    expect(mocks.showCitationNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      "citing",
    );
  });

  it("without context items, reads the pane of the window the menu opened in", async () => {
    const item = await itemMenu();
    selectedItems = [makeItem(1, false)]; // the most recent window: nothing eligible
    const win2 = {
      document: new FakeDocument(),
      ZoteroPane: { getSelectedItems: () => [makeItem(8)] },
    } as unknown as Window;
    const ctx = () => ({ menuElem: elementIn(win2), setVisible: vi.fn() });

    const showing = ctx();
    item.menus[0].onShowing!({} as Event, showing);
    expect(showing.setVisible).toHaveBeenCalledWith(true);

    item.menus[0].onCommand!({} as Event, ctx());
    item.menus[2].onCommand!({} as Event, ctx());
    await flushAsync();

    expect(idsOf(mocks.fetchAndCacheItems.mock.calls[0][0] as _ZoteroTypes.Item[])).toEqual([8]);
    expect(mocks.showCitationNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ id: 8 }),
      "references",
    );
    expect(Zotero.getActiveZoteroPane).not.toHaveBeenCalled();
  });
});

describe("registration is idempotent across repeat calls (issue #67)", () => {
  it("a second registerMenus call does not re-register or fall back to DOM", async () => {
    installZotero(true);
    const { registerMenus } = await loadMenu();
    registerMenus(win);
    registerMenus(win); // File > New Window / hot-reload re-entry

    // registerMenu fired only on the first call (2 menus), never again.
    expect(registerMenu).toHaveBeenCalledTimes(2);
    // The repeat call injected no DOM fallback nodes.
    expect(doc.getElementById("citegeist-menu-fetch")).toBeNull();
    expect(doc.getElementById("citegeist-menu-fetch-collection")).toBeNull();
  });

  it("stays a no-op for a second, distinct window — the guard is process-global", async () => {
    installZotero(true);
    const { registerMenus } = await loadMenu();
    registerMenus(win);

    const doc2 = new FakeDocument();
    const win2 = { document: doc2 } as unknown as Window;
    registerMenus(win2);

    expect(registerMenu).toHaveBeenCalledTimes(2);
    expect(doc2.getElementById("citegeist-menu-fetch")).toBeNull();
  });
});

describe("global-vs-per-window teardown (issue #67)", () => {
  it("unregisterMenus removes only DOM nodes, leaving the MenuManager registration intact", async () => {
    installZotero(true);
    const { registerMenus, unregisterMenus } = await loadMenu();
    registerMenus(win);
    unregisterMenus(win); // one window closing

    // The process-global MenuManager registration must survive — other open
    // windows still depend on it.
    expect(unregisterMenu).not.toHaveBeenCalled();
  });

  it("unregisterGlobalMenus tears down both MenuManager menus and resets the guard", async () => {
    installZotero(true);
    const { registerMenus, unregisterGlobalMenus } = await loadMenu();
    registerMenus(win);
    unregisterGlobalMenus();

    const ids = unregisterMenu.mock.calls.map((c) => c[0]);
    expect(ids).toContain("citegeist-item-menu");
    expect(ids).toContain("citegeist-collection-menu");

    // Flag reset: a subsequent registerMenus re-attempts registration.
    registerMenus(win);
    expect(registerMenu).toHaveBeenCalledTimes(4); // 2 initial + 2 after reset
  });

  it("a per-window unload does not let a later registerMenus re-register", async () => {
    installZotero(true);
    const { registerMenus, unregisterMenus } = await loadMenu();
    registerMenus(win);
    unregisterMenus(win); // window B closes — DOM-only teardown
    registerMenus(win); // a window re-registers

    // Still globally registered, so no second MenuManager attempt.
    expect(registerMenu).toHaveBeenCalledTimes(2);
  });
});

describe("DOM fallback (Zotero 7.0.x, no MenuManager)", () => {
  it("registers menus via the DOM when Zotero.MenuManager is absent", async () => {
    installZotero(false);
    const { registerMenus } = await loadMenu();
    registerMenus(win);
    expect(doc.getElementById("citegeist-menu-fetch")).not.toBeNull();
    expect(doc.getElementById("citegeist-menu-citing")).not.toBeNull();
    expect(doc.getElementById("citegeist-menu-fetch-collection")).not.toBeNull();
  });
});

describe("item-menu visibility — no stray separator (issue #72)", () => {
  it("hides the separator and every entry for a single ineligible item", async () => {
    const { itemMenuVisibility } = await loadMenu();
    expect(itemMenuVisibility([makeItem(1, false)])).toEqual({
      fetch: false,
      resolveAuthors: false,
      citing: false,
      references: false,
      separator: false,
    });
  });

  it("hides the separator and every entry for an empty selection", async () => {
    const { itemMenuVisibility } = await loadMenu();
    expect(itemMenuVisibility([])).toEqual({
      fetch: false,
      resolveAuthors: false,
      citing: false,
      references: false,
      separator: false,
    });
  });

  it("shows the separator, batch actions, and the single-item View actions for one eligible item", async () => {
    const { itemMenuVisibility } = await loadMenu();
    expect(itemMenuVisibility([makeItem(1, true)])).toEqual({
      fetch: true,
      resolveAuthors: true,
      citing: true,
      references: true,
      separator: true,
    });
  });

  it("shows the separator + batch actions but hides the single-item View actions for multiple eligible items", async () => {
    const { itemMenuVisibility } = await loadMenu();
    expect(itemMenuVisibility([makeItem(1), makeItem(2)])).toEqual({
      fetch: true,
      resolveAuthors: true,
      citing: false,
      references: false,
      separator: true,
    });
  });

  it("keeps the separator visible when only some of several items are eligible", async () => {
    const { itemMenuVisibility } = await loadMenu();
    expect(itemMenuVisibility([makeItem(1, true), makeItem(2, false)])).toMatchObject({
      fetch: true,
      citing: false,
      separator: true,
    });
  });
});

describe("context-menu FTL uses attribute syntax (issue #67)", () => {
  const ftl = readFileSync(new URL("../addon/locale/en-US/citegeist.ftl", import.meta.url), "utf8");
  const MENU_MESSAGES = [
    "citegeist-menu-fetch",
    "citegeist-menu-citing",
    "citegeist-menu-refs",
    "citegeist-menu-fetch-collection",
  ];

  /** The message header line + its indented attribute continuation lines. */
  function block(id: string): string {
    const lines = ftl.split("\n");
    const start = lines.findIndex((l) => l.startsWith(`${id} =`) || l.startsWith(`${id}=`));
    if (start === -1) return "";
    let end = start + 1;
    while (end < lines.length && lines[end].startsWith(" ")) end++;
    return lines.slice(start, end).join("\n");
  }

  it("every context-menu message uses .label attribute syntax, never a bare value", () => {
    for (const id of MENU_MESSAGES) {
      const b = block(id);
      expect(b, `${id} must be present in the FTL`).not.toBe("");
      // A bare value (`id = text`) renders blank on a XUL menuitem because
      // MenuManager sets dataset.l10nId and the item has no text node.
      const header = b.split("\n")[0];
      expect(header.trim(), `${id} header must have no inline value`).toMatch(/=\s*$/);
      expect(b, `${id} must define a .label attribute`).toMatch(/^\s+\.label\s*=\s*\S/m);
    }
  });

  it("fetch actions carry an accesskey; view actions deliberately do not", () => {
    expect(block("citegeist-menu-fetch")).toMatch(/\.accesskey\s*=\s*G/);
    expect(block("citegeist-menu-fetch-collection")).toMatch(/\.accesskey\s*=\s*I/);
    expect(block("citegeist-menu-citing")).not.toMatch(/\.accesskey/);
    expect(block("citegeist-menu-refs")).not.toMatch(/\.accesskey/);
  });
});

describe("item-pane section FTL uses the right attribute per surface (Z9 blank-header bug)", () => {
  const ftl = readFileSync(new URL("../addon/locale/en-US/citegeist.ftl", import.meta.url), "utf8");

  function block(id: string): string {
    const lines = ftl.split("\n");
    const start = lines.findIndex((l) => l.startsWith(`${id} =`) || l.startsWith(`${id}=`));
    if (start === -1) return "";
    let end = start + 1;
    while (end < lines.length && lines[end].startsWith(" ")) end++;
    return lines.slice(start, end).join("\n");
  }

  // Zotero reads the collapsible-section title from the header message's `.label`,
  // and the sidenav strip + section-button tooltips from `.tooltiptext`. A bare
  // `id = value` has no attribute to land on and renders BLANK — the confirmed
  // Z9 empty-header / blank-sidenav failure. Each surface must use its attribute.
  const CASES: Array<[string, "label" | "tooltiptext"]> = [
    ["citegeist-pane-header", "label"],
    ["citegeist-pane-sidenav", "tooltiptext"],
    ["citegeist-pane-refresh", "tooltiptext"],
    ["citegeist-pane-settings", "tooltiptext"],
  ];

  it.each(CASES)("%s defines .%s and no inline value", (id, attr) => {
    const b = block(id);
    expect(b, `${id} must be present in the FTL`).not.toBe("");
    expect(b.split("\n")[0].trim(), `${id} header must have no inline value`).toMatch(/=\s*$/);
    expect(b, `${id} must define a .${attr} attribute`).toMatch(
      new RegExp(`^\\s+\\.${attr}\\s*=\\s*\\S`, "m"),
    );
  });
});

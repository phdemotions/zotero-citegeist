/**
 * Tests for the MenuManager menus: registration, which item-menu entries show,
 * what the item and collection commands act on, the window they act in, batch
 * summaries, teardown, and the FTL the labels come from.
 *
 * Every handler runs against contexts shaped as Zotero 8 and 9, and Zotero 10,
 * build them (test/_helpers/menuHarness.ts), and every test ends by checking that
 * no handler read a context the way Zotero 10 forbids. The collection commands'
 * batch behaviour is in collection-menu.test.ts. The DOM fallback's tests sit at
 * the end, marked for deletion with it.
 *
 * Registration holds process-global state, so every test loads a fresh module
 * graph in beforeEach.
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { CACHE_READ_ONLY_HEADLINE } from "../src/constants";
import {
  COLLECTION_MENU_HOSTS,
  ITEM_MENU_HOSTS,
  MODULE_LOAD_TIMEOUT_MS,
  UNSUPPORTED_ROW_TYPES,
  backfillResult,
  batchResult,
  clearRecordedFailures,
  collectionRow,
  expectHostContractKept,
  fakeMenuManager,
  fakeProgressWindowClass,
  fakeWindow,
  flushAsync,
  idsOf,
  lastProgressLine,
  libraryRow,
  makeCollection,
  makeItem,
  menuElementIn,
  otherRow,
  progressWindowParents,
  recordedFailures,
  selectionUnreadableReports,
  zotero10CollectionContext,
  type FakeMenuManager,
  type FakeWindow,
} from "./_helpers/menuHarness";

const mocks = vi.hoisted(() => ({
  fetchAndCacheItems: vi.fn(),
  canResolveWork: vi.fn(),
  resolveAuthorsForItems: vi.fn(),
  invalidateColumnCache: vi.fn(),
  showCitationNetwork: vi.fn(),
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

import type * as RegistrationModule from "../src/modules/menu/registration";
import type * as VisibilityModule from "../src/modules/menu/visibility";

type Registration = typeof RegistrationModule;
type Visibility = typeof VisibilityModule;

const PLUGIN_ID = "citegeist@opusvita.org";
const FETCH = "citegeist-menu-fetch";
const CITING = "citegeist-menu-citing";
const REFS = "citegeist-menu-refs";
const RESOLVE = "citegeist-menu-resolve-authors";
const FETCH_ALL = "citegeist-menu-fetch-collection";
const RESOLVE_ALL = "citegeist-menu-resolve-collection";

let menu: Registration;
let itemMenuVisibility: Visibility["itemMenuVisibility"];
let win: FakeWindow;
let selectedItems: _ZoteroTypes.Item[];
let libraryItems: _ZoteroTypes.Item[];
let alertSpy: Mock;
let mm: FakeMenuManager;

/** The service's rule, as far as these tests need it: a regular item with an identifier. */
function resolvable(item: { isRegularItem?: () => boolean; hasIdentifier?: boolean }): boolean {
  return item.isRegularItem?.() !== false && item.hasIdentifier !== false;
}

function installZotero(withMenuManager: boolean): void {
  mm = fakeMenuManager();
  alertSpy = vi.fn();
  vi.stubGlobal("Zotero", {
    debug: vi.fn(),
    getMainWindow: vi.fn(() => win),
    // The most recent window's pane. `win` has no pane of its own, so a handler
    // that names no other window falls back to this one. Zotero 10's singular
    // collection getters throw on a multi-row selection, and nothing may call them.
    getActiveZoteroPane: vi.fn(() => ({
      getSelectedItems: () => selectedItems,
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
    ...(withMenuManager ? { MenuManager: mm } : {}),
  });
  vi.stubGlobal("Services", { prompt: { alert: alertSpy } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.canResolveWork.mockReset().mockImplementation(resolvable);
  mocks.fetchAndCacheItems.mockReset().mockResolvedValue(batchResult({ fresh: 1 }));
  mocks.resolveAuthorsForItems.mockReset().mockResolvedValue(backfillResult({ resolved: 1 }));
  mocks.showCitationNetwork.mockReset().mockResolvedValue(undefined);
  win = fakeWindow();
  selectedItems = [makeItem(1)];
  libraryItems = [makeItem(1), makeItem(2)];
  installZotero(true);
  vi.resetModules();
  menu = await import("../src/modules/menu/registration");
  ({ itemMenuVisibility } = await import("../src/modules/menu/visibility"));
  menu.setMenuPluginID(PLUGIN_ID);
  await clearRecordedFailures();
}, MODULE_LOAD_TIMEOUT_MS);

afterEach(expectHostContractKept);

/** Register the menus in `win`. */
function register(): void {
  menu.registerMenus(win);
}

const itemEntry = (l10nID: string) => mm.entry("item", l10nID);
const collectionEntry = (l10nID: string) => mm.entry("collection", l10nID);

/** The items the first call to a batch mock acted on. */
const firstCallItems = (batch: Mock) => batch.mock.calls[0][0] as _ZoteroTypes.Item[];

/**
 * Item id and mode of the first citation-browser open, and whether it was handed
 * `expected` as its window. Windows are compared by identity: two fake windows
 * are structurally equal, so a deep comparison could not tell them apart.
 */
function firstNetworkOpen(expected: Window): {
  id: number;
  mode: unknown;
  inExpectedWindow: boolean;
} {
  const [item, mode, opener] = mocks.showCitationNetwork.mock.calls[0] as unknown as [
    _ZoteroTypes.Item,
    string,
    Window,
  ];
  return { id: item.id, mode, inExpectedWindow: opener === expected };
}

describe("MenuManager registration", () => {
  it("registers the item and collection menus with l10nIDs, never labels, and adds no DOM entries", () => {
    register();

    expect(mm.registerMenu).toHaveBeenCalledTimes(2);
    const item = mm.captured.find((c) => c.target === "main/library/item")!;
    const collection = mm.captured.find((c) => c.target === "main/library/collection")!;
    expect([item.pluginID, collection.pluginID]).toEqual([PLUGIN_ID, PLUGIN_ID]);
    // MenuManager renders text only from data-l10n-id; a plain label is dropped
    // and the entry shows blank.
    expect(item.menus.map((m) => m.l10nID)).toEqual([FETCH, CITING, REFS, RESOLVE]);
    expect(collection.menus.map((m) => m.l10nID)).toEqual([FETCH_ALL, RESOLVE_ALL]);
    expect([...item.menus, ...collection.menus].every((m) => m.label === undefined)).toBe(true);
    expect(win.document.getElementById(FETCH)).toBeNull();
  });

  it("a second call, for the same window or another, registers nothing more (issue #67)", () => {
    register();
    register();
    const other = fakeWindow();
    menu.registerMenus(other);

    expect(mm.registerMenu).toHaveBeenCalledTimes(2);
    expect(win.document.getElementById(FETCH)).toBeNull();
    expect(other.document.getElementById(FETCH)).toBeNull();
  });

  it("a rejected collection menu rolls back the item menu", () => {
    mm.outcomes.push("citegeist-item-menu", false);
    register();
    expect(mm.unregisterMenu.mock.calls.map(([id]) => id)).toEqual(["citegeist-item-menu"]);
  });

  it("a registration that throws rolls back what registered and records the failure", async () => {
    mm.outcomes.push("citegeist-item-menu", new Error("registry is busy"));
    register();
    expect(mm.unregisterMenu.mock.calls.map(([id]) => id)).toEqual(["citegeist-item-menu"]);
    expect((await recordedFailures()).map((d) => d.context)).toEqual(["menu MenuManager register"]);
  });

  it("a window unload leaves the MenuManager registration, which other windows still use", () => {
    register();
    menu.unregisterMenus(win);
    register();
    expect(mm.unregisterMenu).not.toHaveBeenCalled();
    expect(mm.registerMenu).toHaveBeenCalledTimes(2);
  });

  it("the global teardown unregisters both menus, and a later registration registers again", () => {
    register();
    menu.unregisterGlobalMenus();
    expect(mm.unregisterMenu.mock.calls.map(([id]) => id)).toEqual([
      "citegeist-item-menu",
      "citegeist-collection-menu",
    ]);
    register();
    expect(mm.registerMenu).toHaveBeenCalledTimes(4);
  });
});

describe("item-menu visibility rule (issue #72)", () => {
  const none = { fetch: false, resolveAuthors: false, citing: false, references: false };

  it("hides the separator and every entry for a single item that does not resolve", () => {
    expect(itemMenuVisibility([makeItem(1, false)])).toEqual({ ...none, separator: false });
  });

  it("hides the separator and every entry for an empty selection", () => {
    expect(itemMenuVisibility([])).toEqual({ ...none, separator: false });
  });

  it("shows the separator, the batch entries and the single-item View entries for one item that resolves", () => {
    expect(itemMenuVisibility([makeItem(1, true)])).toEqual({
      fetch: true,
      resolveAuthors: true,
      citing: true,
      references: true,
      separator: true,
    });
  });

  it("shows the separator and batch entries, but not the View entries, for several items that resolve", () => {
    expect(itemMenuVisibility([makeItem(1), makeItem(2)])).toEqual({
      fetch: true,
      resolveAuthors: true,
      citing: false,
      references: false,
      separator: true,
    });
  });

  it("keeps the separator when only some of several items resolve", () => {
    expect(itemMenuVisibility([makeItem(1, true), makeItem(2, false)])).toMatchObject({
      fetch: true,
      citing: false,
      separator: true,
    });
  });
});

/** Selections whose visibility differs entry by entry. */
const SELECTIONS: ReadonlyArray<readonly [string, () => _ZoteroTypes.Item[]]> = [
  ["one item that resolves", () => [makeItem(1)]],
  ["one item that does not resolve", () => [makeItem(1, false)]],
  ["two items that resolve", () => [makeItem(1), makeItem(2)]],
  ["an item that resolves and one that does not", () => [makeItem(1), makeItem(2, false)]],
  [
    "one note",
    () => [{ ...makeItem(3), isRegularItem: () => false } as unknown as _ZoteroTypes.Item],
  ],
];

describe.each(ITEM_MENU_HOSTS)("item menu on $name", (host) => {
  beforeEach(register);

  describe.each(SELECTIONS)("for %s", (_label, items) => {
    it("each entry shows exactly when the shared visibility rule says", () => {
      const rule = itemMenuVisibility(items());
      const expected: Record<string, boolean> = {
        [FETCH]: rule.fetch,
        [CITING]: rule.citing,
        [REFS]: rule.references,
        [RESOLVE]: rule.resolveAuthors,
      };
      for (const id of [FETCH, CITING, REFS, RESOLVE]) {
        const ctx = host.context({ items: items() });
        itemEntry(id).onShowing!({} as Event, ctx);
        expect(ctx.setVisible.mock.calls, id).toEqual([[expected[id]]]);
      }
    });
  });

  it("the context's items decide, even when the menu window's selection could be acted on", () => {
    selectedItems = [makeItem(9)];
    for (const id of [FETCH, CITING, RESOLVE]) {
      const ctx = host.context({ items: [makeItem(2, false)] });
      itemEntry(id).onShowing!({} as Event, ctx);
      expect(ctx.setVisible, id).toHaveBeenCalledWith(false);
    }
  });

  it("Fetch, Resolve and View Citing act on the context's items, not the most recent window's selection", async () => {
    selectedItems = [makeItem(1)];
    itemEntry(FETCH).onCommand!({} as Event, host.context({ items: [makeItem(7)] }));
    itemEntry(RESOLVE).onCommand!({} as Event, host.context({ items: [makeItem(7)] }));
    itemEntry(CITING).onCommand!({} as Event, host.context({ items: [makeItem(7)] }));
    await flushAsync();

    expect(idsOf(firstCallItems(mocks.fetchAndCacheItems))).toEqual([7]);
    expect(idsOf(firstCallItems(mocks.resolveAuthorsForItems))).toEqual([7]);
    expect(firstNetworkOpen(win)).toEqual({ id: 7, mode: "citing", inExpectedWindow: true });
  });

  describe("an entry whose context carries no items reads the menu window's pane, never the main window's", () => {
    // Zotero.getMainWindow() returns `win`, whose own pane (also the active pane)
    // selects an item Citegeist can't resolve; the menu's window selects one it
    // can. An entry that reads the wrong pane shows the wrong visibility and acts
    // on the wrong item, so each entry is checked on its own.
    let menuWin: FakeWindow;

    beforeEach(() => {
      selectedItems = [makeItem(1, false)];
      win.ZoteroPane = { getSelectedItems: () => selectedItems };
      menuWin = fakeWindow({ getSelectedItems: () => [makeItem(8)] });
    });

    const ENTRIES: ReadonlyArray<readonly [string, () => void]> = [
      [FETCH, () => expect(idsOf(firstCallItems(mocks.fetchAndCacheItems))).toEqual([8])],
      [
        CITING,
        () =>
          expect(firstNetworkOpen(menuWin)).toEqual({
            id: 8,
            mode: "citing",
            inExpectedWindow: true,
          }),
      ],
      [
        REFS,
        () =>
          expect(firstNetworkOpen(menuWin)).toEqual({
            id: 8,
            mode: "references",
            inExpectedWindow: true,
          }),
      ],
      [RESOLVE, () => expect(idsOf(firstCallItems(mocks.resolveAuthorsForItems))).toEqual([8])],
    ];

    describe.each([
      ["no items", {}],
      ["an empty items list", { items: [] }],
    ])("given %s", (_label, fields) => {
      it.each(ENTRIES)("%s shows for, and acts on, that selection", async (id, expectActed) => {
        const showing = host.context({ ...fields, menuElem: menuElementIn(menuWin) });
        itemEntry(id).onShowing!({} as Event, showing);
        expect(showing.setVisible).toHaveBeenCalledWith(true);

        itemEntry(id).onCommand!(
          {} as Event,
          host.context({ ...fields, menuElem: menuElementIn(menuWin) }),
        );
        await flushAsync();
        expectActed();
        expect(alertSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe("commands run in the right-clicked window, never the main window", () => {
    // `win` and `win2` have the same shape, so only an identity check (`toBe`)
    // tells them apart: it is what catches a runner that falls back to
    // Zotero.getMainWindow(), which returns `win`.
    let win2: FakeWindow;
    beforeEach(() => {
      win2 = fakeWindow();
    });

    it.each([
      ["Fetch Citation Counts", FETCH, "Citegeist: Nothing to fetch"],
      ["Resolve Author Identities", RESOLVE, "Citegeist: Nothing to resolve"],
    ])("%s opens its progress window and alert in the menu's window", async (_l, id, title) => {
      itemEntry(id).onCommand!(
        {} as Event,
        host.context({ menuElem: menuElementIn(win2), items: [makeItem(1)] }),
      );
      await flushAsync();
      expect(progressWindowParents()).toEqual([win2]);
      expect(progressWindowParents()[0]).toBe(win2);

      itemEntry(id).onCommand!(
        {} as Event,
        host.context({ menuElem: menuElementIn(win2), items: [makeItem(2, false)] }),
      );
      await flushAsync();
      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(alertSpy.mock.calls[0][0]).toBe(win2);
      expect(alertSpy.mock.calls[0][1]).toBe(title);
      expect(Zotero.getMainWindow).not.toHaveBeenCalled();
    });

    it.each([
      ["View Citing Works", CITING, "citing"],
      ["View References", REFS, "references"],
    ])("%s opens the citation browser in the menu's window", (_l, id, mode) => {
      itemEntry(id).onCommand!(
        {} as Event,
        host.context({ menuElem: menuElementIn(win2), items: [makeItem(5)] }),
      );
      expect(firstNetworkOpen(win2)).toEqual({ id: 5, mode, inExpectedWindow: true });
      expect(Zotero.getMainWindow).not.toHaveBeenCalled();
    });

    it("uses the window of the command's target when the context has no menuElem", async () => {
      itemEntry(FETCH).onCommand!(
        { target: menuElementIn(win2) } as unknown as Event,
        host.context({ items: [makeItem(1)] }),
      );
      await flushAsync();
      expect(progressWindowParents()[0]).toBe(win2);
    });

    it("falls back to the main window when neither the context nor the event names one", async () => {
      itemEntry(FETCH).onCommand!({} as Event, host.context({ items: [makeItem(1)] }));
      await flushAsync();
      expect(progressWindowParents()[0]).toBe(win);
    });

    it.each([
      ["Fetch Citation Counts", FETCH],
      ["Resolve Author Identities", RESOLVE],
    ])(
      "%s opens its progress window and alert in the main window once the menu's window has closed",
      async (_l, id) => {
        win2.closed = true;
        itemEntry(id).onCommand!(
          {} as Event,
          host.context({ menuElem: menuElementIn(win2), items: [makeItem(1)] }),
        );
        itemEntry(id).onCommand!(
          {} as Event,
          host.context({ menuElem: menuElementIn(win2), items: [makeItem(2, false)] }),
        );
        await flushAsync();
        expect(progressWindowParents()).toHaveLength(1);
        expect(progressWindowParents()[0]).toBe(win);
        expect(alertSpy.mock.calls.map(([parent]) => parent === win)).toEqual([true]);
      },
    );
  });

  describe("batch summaries when the cache refuses writes", () => {
    const CLOSED = "Citegeist's local database is closed; restart Zotero";

    it.each([
      ["a read-only cache (CG-DB03)", "CG-DB03", CACHE_READ_ONLY_HEADLINE],
      ["a cache stamped by no release (CG-DB04)", "CG-DB04", CACHE_READ_ONLY_HEADLINE],
      ["a closed cache (CG-DB02)", "CG-DB02", CLOSED],
      ["a result that names no code", undefined, CACHE_READ_ONLY_HEADLINE],
    ] as const)("Fetch Citation Counts names the items %s skipped", async (_l, code, reason) => {
      mocks.fetchAndCacheItems.mockResolvedValueOnce(
        batchResult({ cached: 2, unwritableStopped: 3, code }),
      );
      itemEntry(FETCH).onCommand!(
        {} as Event,
        host.context({ items: [1, 2, 3, 4, 5].map((id) => makeItem(id)) }),
      );
      await flushAsync();
      expect(lastProgressLine()).toBe(`Done — 2 already up to date, 3 skipped (${reason})`);
    });

    it.each([
      ["a read-only cache (CG-DB03)", "CG-DB03", CACHE_READ_ONLY_HEADLINE],
      ["a cache stamped by no release (CG-DB04)", "CG-DB04", CACHE_READ_ONLY_HEADLINE],
      ["a closed cache (CG-DB02)", "CG-DB02", CLOSED],
      ["a result that names no code", undefined, CACHE_READ_ONLY_HEADLINE],
    ] as const)(
      "Resolve Author Identities names the items %s skipped",
      async (_l, code, reason) => {
        mocks.resolveAuthorsForItems.mockResolvedValueOnce(
          backfillResult({ resolved: 1, unwritableStopped: 4, code }),
        );
        itemEntry(RESOLVE).onCommand!(
          {} as Event,
          host.context({ items: [1, 2, 3, 4, 5].map((id) => makeItem(id)) }),
        );
        await flushAsync();
        expect(lastProgressLine()).toBe(`Done — 1 resolved, 4 skipped (${reason})`);
      },
    );

    it("Fetch Citation Counts does not report items as processed when the cache skipped them all", async () => {
      mocks.fetchAndCacheItems.mockResolvedValueOnce(
        batchResult({ unwritableStopped: 2, code: "CG-DB03" }),
      );
      itemEntry(FETCH).onCommand!({} as Event, host.context({ items: [makeItem(1), makeItem(2)] }));
      await flushAsync();
      expect(lastProgressLine()).toBe(`Done — 2 skipped (${CACHE_READ_ONLY_HEADLINE})`);
    });
  });
});

describe("collection menu reads the selection from the context rows", () => {
  beforeEach(register);

  const fetchedIds = () => idsOf(firstCallItems(mocks.fetchAndCacheItems));

  function expectNothingStarted(): void {
    expect(mocks.fetchAndCacheItems).not.toHaveBeenCalled();
    expect(mocks.resolveAuthorsForItems).not.toHaveBeenCalled();
    expect(Zotero.Items.getAll).not.toHaveBeenCalled();
    expect(Zotero.ProgressWindow).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  }

  describe.each(COLLECTION_MENU_HOSTS)("one right-clicked row on $name", (host) => {
    it("a collection row shows both entries and fetches that collection's items", async () => {
      const ctx = host.context(collectionRow(makeCollection([makeItem(4), makeItem(5)])));
      collectionEntry(FETCH_ALL).onShowing!({} as Event, ctx);
      expect(ctx.setVisible).toHaveBeenCalledWith(true);

      collectionEntry(FETCH_ALL).onCommand!({} as Event, ctx);
      await flushAsync();
      expect(fetchedIds()).toEqual([4, 5]);
      expect(Zotero.Items.getAll).not.toHaveBeenCalled();
    });

    it("a library row fetches that library", async () => {
      collectionEntry(FETCH_ALL).onCommand!({} as Event, host.context(libraryRow(7)));
      await flushAsync();
      expect(Zotero.Items.getAll).toHaveBeenCalledWith(7, false);
      expect(fetchedIds()).toEqual([1, 2]);
    });

    it.each(UNSUPPORTED_ROW_TYPES)(
      "a %s row hides both entries, and the commands start nothing and record nothing",
      async (type) => {
        for (const id of [FETCH_ALL, RESOLVE_ALL]) {
          const ctx = host.context(otherRow(type));
          collectionEntry(id).onShowing!({} as Event, ctx);
          expect(ctx.setVisible).toHaveBeenCalledWith(false);
          collectionEntry(id).onCommand!({} as Event, ctx);
        }
        await flushAsync();
        expectNothingStarted();
      },
    );

    it("no selected row hides both entries and starts nothing", async () => {
      for (const id of [FETCH_ALL, RESOLVE_ALL]) {
        const ctx = host.context(null);
        collectionEntry(id).onShowing!({} as Event, ctx);
        expect(ctx.setVisible).toHaveBeenCalledWith(false);
        collectionEntry(id).onCommand!({} as Event, ctx);
      }
      await flushAsync();
      expectNothingStarted();
    });
  });

  describe("several rows on Zotero 10", () => {
    it("two selected collections show the entries and fetch both collections' items, each item once", async () => {
      const shared = makeItem(2);
      const ctx = zotero10CollectionContext([
        collectionRow(makeCollection([makeItem(1), shared])),
        collectionRow(makeCollection([shared, makeItem(3)])),
      ]);
      collectionEntry(FETCH_ALL).onShowing!({} as Event, ctx);
      expect(ctx.setVisible).toHaveBeenCalledWith(true);

      collectionEntry(FETCH_ALL).onCommand!({} as Event, ctx);
      await flushAsync();
      expect(mocks.fetchAndCacheItems).toHaveBeenCalledTimes(1);
      expect(fetchedIds()).toEqual([1, 2, 3]);
    });

    it("fetches every selected library, each item once, not only the first", async () => {
      vi.mocked(Zotero.Items.getAll).mockImplementation(async (libraryID: number) =>
        libraryID === 2 ? [makeItem(10)] : [makeItem(3)],
      );
      collectionEntry(FETCH_ALL).onCommand!(
        {} as Event,
        zotero10CollectionContext([libraryRow(2, "group"), libraryRow(1)]),
      );
      await flushAsync();

      expect(Zotero.Items.getAll).toHaveBeenCalledTimes(2);
      expect(Zotero.Items.getAll).toHaveBeenCalledWith(2, false);
      expect(Zotero.Items.getAll).toHaveBeenCalledWith(1, false);
      expect(fetchedIds()).toEqual([3, 10]);
    });

    it("fetches collections from different libraries in one batch", async () => {
      collectionEntry(FETCH_ALL).onCommand!(
        {} as Event,
        zotero10CollectionContext([
          collectionRow(makeCollection([makeItem(3)], [], 1)),
          collectionRow(makeCollection([makeItem(10)], [], 2)),
        ]),
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
        for (const id of [FETCH_ALL, RESOLVE_ALL]) {
          const ctx = zotero10CollectionContext(rows());
          collectionEntry(id).onShowing!({} as Event, ctx);
          expect(ctx.setVisible).toHaveBeenCalledWith(false);
          collectionEntry(id).onCommand!({} as Event, ctx);
        }
        await flushAsync();
        expectNothingStarted();
      },
    );

    describe.each(UNSUPPORTED_ROW_TYPES)("a %s row", (type) => {
      it.each([
        [
          "after a collection",
          () => [collectionRow(makeCollection([makeItem(1)])), otherRow(type)],
        ],
        [
          "before a collection",
          () => [otherRow(type), collectionRow(makeCollection([makeItem(1)]))],
        ],
      ])("%s hides both entries, and the commands start nothing", async (_label, rows) => {
        for (const id of [FETCH_ALL, RESOLVE_ALL]) {
          const ctx = zotero10CollectionContext(rows());
          collectionEntry(id).onShowing!({} as Event, ctx);
          expect(ctx.setVisible).toHaveBeenCalledWith(false);
          collectionEntry(id).onCommand!({} as Event, ctx);
        }
        await flushAsync();
        expectNothingStarted();
      });
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
      ["two libraries", () => [libraryRow(1), libraryRow(2, "group")], "in these 2 libraries"],
    ])("names %s in the no-eligible-items alert", async (_label, rows, phrase) => {
      libraryItems = [makeItem(10, false)];
      collectionEntry(FETCH_ALL).onCommand!({} as Event, zotero10CollectionContext(rows()));
      await flushAsync();

      expect(alertSpy).toHaveBeenCalledWith(
        win,
        "Citegeist: Nothing to fetch",
        expect.stringContaining(phrase),
      );
      expect(mocks.fetchAndCacheItems).not.toHaveBeenCalled();
    });

    it("says 'These 2 collections are empty.' when both selected collections are empty", async () => {
      collectionEntry(FETCH_ALL).onCommand!(
        {} as Event,
        zotero10CollectionContext([
          collectionRow(makeCollection([])),
          collectionRow(makeCollection([])),
        ]),
      );
      await flushAsync();
      expect(alertSpy).toHaveBeenCalledWith(
        win,
        "Citegeist: Nothing to fetch",
        "These 2 collections are empty.",
      );
    });

    it("names the selection in the resolve-authors alert too", async () => {
      collectionEntry(RESOLVE_ALL).onCommand!(
        {} as Event,
        zotero10CollectionContext([
          collectionRow(makeCollection([makeItem(1, false)])),
          collectionRow(makeCollection([makeItem(2, false)])),
        ]),
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

  it("a context with neither selection field hides the entries, throws nothing, and records CG-UI02 once", async () => {
    for (const id of [FETCH_ALL, RESOLVE_ALL]) {
      const ctx = { setVisible: vi.fn(), setEnabled: vi.fn() };
      collectionEntry(id).onShowing!({} as Event, ctx as never);
      expect(ctx.setVisible).toHaveBeenCalledWith(false);
      collectionEntry(id).onCommand!({} as Event, ctx as never);
    }
    await flushAsync();

    expect(mocks.fetchAndCacheItems).not.toHaveBeenCalled();
    expect(mocks.resolveAuthorsForItems).not.toHaveBeenCalled();
    // One record for four reads, and no CG-BUG01: nothing threw into guard().
    expect(await selectionUnreadableReports()).toHaveLength(1);
    expect(await recordedFailures()).toHaveLength(1);
  });

  describe.each(COLLECTION_MENU_HOSTS)("windows on $name", (host) => {
    let win2: FakeWindow;
    beforeEach(() => {
      win2 = fakeWindow();
    });

    it.each([
      ["Fetch All Citation Counts", FETCH_ALL, "Citegeist: Nothing to fetch"],
      ["Resolve All Author Identities", RESOLVE_ALL, "Citegeist: Nothing to resolve"],
    ])("%s opens its progress window and alert in the menu's window", async (_l, id, title) => {
      collectionEntry(id).onCommand!(
        {} as Event,
        host.context(collectionRow(makeCollection([makeItem(1)])), {
          menuElem: menuElementIn(win2),
        }),
      );
      await flushAsync();
      collectionEntry(id).onCommand!(
        {} as Event,
        host.context(collectionRow(makeCollection([makeItem(2, false)])), {
          menuElem: menuElementIn(win2),
        }),
      );
      await flushAsync();

      expect(progressWindowParents()).toHaveLength(2);
      for (const parent of progressWindowParents()) expect(parent).toBe(win2);
      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(alertSpy.mock.calls[0][0]).toBe(win2);
      expect(alertSpy.mock.calls[0][1]).toBe(title);
      expect(Zotero.getMainWindow).not.toHaveBeenCalled();
    });
  });
});

describe("context-menu FTL uses attribute syntax (issue #67)", () => {
  const ftl = readFileSync(new URL("../addon/locale/en-US/citegeist.ftl", import.meta.url), "utf8");
  const MENU_MESSAGES = [FETCH, CITING, REFS, FETCH_ALL];

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
    expect(block(FETCH)).toMatch(/\.accesskey\s*=\s*G/);
    expect(block(FETCH_ALL)).toMatch(/\.accesskey\s*=\s*I/);
    expect(block(CITING)).not.toMatch(/\.accesskey/);
    expect(block(REFS)).not.toMatch(/\.accesskey/);
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

// Zotero 7 DOM fallback: delete with registerViaDOM (U9)
describe("DOM fallback registration", () => {
  const itemEntriesHidden = (w: FakeWindow) =>
    ["citegeist-menu-separator", FETCH, CITING, REFS, RESOLVE].map(
      (id) => w.document.getElementById(id)!.hidden,
    );

  it("registers the DOM entries when Zotero.MenuManager does not exist", () => {
    installZotero(false);
    register();
    for (const id of [FETCH, CITING, FETCH_ALL]) {
      expect(win.document.getElementById(id), id).not.toBeNull();
    }
  });

  it("registers the DOM entries after MenuManager rejects the collection menu", () => {
    mm.outcomes.push("citegeist-item-menu", false);
    register();
    expect(win.document.getElementById(FETCH)).not.toBeNull();
    expect(win.document.getElementById(FETCH_ALL)).not.toBeNull();
  });

  it("once MenuManager refused, a later window gets the DOM entries without asking MenuManager again", () => {
    mm.outcomes.push(false);
    register();
    const later = fakeWindow();
    menu.registerMenus(later);

    expect(mm.registerMenu).toHaveBeenCalledTimes(1);
    expect(later.document.getElementById(FETCH)).not.toBeNull();
  });

  it.each(SELECTIONS)(
    "for %s, the item popup shows the entries the shared visibility rule says",
    (_label, items) => {
      installZotero(false);
      selectedItems = items();
      register();
      win.document.getElementById("zotero-itemmenu")!.dispatch("popupshowing");

      const rule = itemMenuVisibility(items());
      expect(itemEntriesHidden(win)).toEqual(
        [rule.separator, rule.fetch, rule.citing, rule.references, rule.resolveAuthors].map(
          (shown) => !shown,
        ),
      );
    },
  );
});

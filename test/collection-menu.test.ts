/**
 * Tests for the collection menu's batch commands, "Fetch All Citation Counts"
 * and "Resolve All Author Identities", through their MenuManager handlers with
 * the contexts Zotero 8 and 9, and Zotero 10, build: gathering every item under a
 * collection or library, each once; keeping only items Citegeist can resolve; the
 * progress window while a large selection loads; repainting columns as data
 * lands; the summary and alerts; and where they open once the menu's window has
 * closed. Every test ends by checking that no handler read a context the way
 * Zotero 10 forbids.
 *
 * The selection rules are in hostSelection.test.ts and menu.test.ts. The DOM
 * fallback's own tests (reading the pane, popupshowing, listener teardown) sit at
 * the end, marked for deletion with it.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { CACHE_READ_ONLY_HEADLINE, PROGRESS_WINDOW_DONE_CLOSE_MS } from "../src/constants";
import {
  COLLECTION_MENU_HOSTS,
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
  progressWindows,
  recordedFailures,
  selectionUnreadableReports,
  type FakeMenuDocument,
  type FakeMenuManager,
  type FakeWindow,
} from "./_helpers/menuHarness";

const mocks = vi.hoisted(() => ({
  fetchAndCacheItems: vi.fn(),
  resolveAuthorsForItems: vi.fn(),
  canResolveWork: vi.fn(),
  invalidateColumnCache: vi.fn(),
  showCitationNetwork: vi.fn(),
}));

vi.mock("../src/modules/citationService", () => ({
  fetchAndCacheItems: mocks.fetchAndCacheItems,
  resolveAuthorsForItems: mocks.resolveAuthorsForItems,
  canResolveWork: mocks.canResolveWork,
}));
vi.mock("../src/modules/citationColumn", () => ({
  invalidateColumnCache: mocks.invalidateColumnCache,
}));
vi.mock("../src/modules/citationNetwork", () => ({
  showCitationNetwork: mocks.showCitationNetwork,
}));

const FETCH_ALL = "citegeist-menu-fetch-collection";
const RESOLVE_ALL = "citegeist-menu-resolve-collection";

import type * as RegistrationModule from "../src/modules/menu/registration";

type Registration = typeof RegistrationModule;
type Row = _ZoteroTypes.CollectionTreeRow | false | 0;

let menu: Registration;
/** The window the menu opened in. */
let win: FakeWindow;
/** What Zotero.getMainWindow() returns: a different window, so a fallback to it shows. */
let mainWin: FakeWindow;
let libraryItems: _ZoteroTypes.Item[];
let alertSpy: Mock;
let mm: FakeMenuManager;
let getActiveZoteroPane: Mock;
/** The row the active pane has focused, for the DOM fallback. */
let focusedRow: Row;
let activeSelection: _ZoteroTypes.Item[];

function resolvable(item: { isRegularItem?: () => boolean; hasIdentifier?: boolean }): boolean {
  return item.isRegularItem?.() !== false && item.hasIdentifier !== false;
}

function installZotero(withMenuManager: boolean): void {
  mm = fakeMenuManager();
  alertSpy = vi.fn();
  // Only getCollectionTreeRow: a call to getSelectedCollection or
  // getSelectedLibraryID would fail, which pins that neither path reads them.
  // `win` has no pane of its own, so DOM reads fall back to this one.
  getActiveZoteroPane = vi.fn(() => ({
    getSelectedItems: () => activeSelection,
    getCollectionTreeRow: () => focusedRow,
  }));
  vi.stubGlobal("Zotero", {
    debug: vi.fn(),
    getMainWindow: vi.fn(() => mainWin),
    getActiveZoteroPane,
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
  mocks.fetchAndCacheItems.mockReset().mockResolvedValue(batchResult({ fresh: 2 }));
  mocks.resolveAuthorsForItems.mockReset().mockResolvedValue(backfillResult({ resolved: 1 }));
  mocks.invalidateColumnCache.mockReset();
  mocks.showCitationNetwork.mockReset().mockResolvedValue(undefined);
  win = fakeWindow();
  mainWin = fakeWindow();
  libraryItems = [makeItem(1), makeItem(2)];
  focusedRow = libraryRow(1);
  activeSelection = [];
  vi.resetModules();
  menu = await import("../src/modules/menu/registration");
  menu.setMenuPluginID("citegeist@opusvita.org");
  await clearRecordedFailures();
}, MODULE_LOAD_TIMEOUT_MS);

afterEach(expectHostContractKept);

const getAll = () => Zotero.Items.getAll as Mock;
const fetchedItems = (): _ZoteroTypes.Item[] => mocks.fetchAndCacheItems.mock.calls[0][0];
const resolvedItems = (): _ZoteroTypes.Item[] => mocks.resolveAuthorsForItems.mock.calls[0][0];

function expectNothingStarted(): void {
  expect(mocks.fetchAndCacheItems).not.toHaveBeenCalled();
  expect(mocks.resolveAuthorsForItems).not.toHaveBeenCalled();
  expect(getAll()).not.toHaveBeenCalled();
  expect(alertSpy).not.toHaveBeenCalled();
  expect(Zotero.ProgressWindow).not.toHaveBeenCalled();
}

/** A batch fake that reports each item done with `status(item)`, the way the real loop does. */
function reportingEachItem(status: (index: number) => string) {
  return async (
    items: Array<{ id: number }>,
    _onProgress: unknown,
    onItemDone?: (id: number, status: string) => void,
  ) => {
    items.forEach((item, index) => onItemDone?.(item.id, status(index)));
    return batchResult({ fresh: items.length });
  };
}

describe.each(COLLECTION_MENU_HOSTS)("collection commands on $name", (host) => {
  beforeEach(() => {
    installZotero(true);
    menu.registerMenus(win);
  });

  /** Run an entry's command for a right-click on `row` in `win`, and let the batch finish. */
  async function run(l10nID: string, row: unknown): Promise<void> {
    mm.entry("collection", l10nID).onCommand!(
      {} as Event,
      host.context(row, { menuElem: menuElementIn(win) }),
    );
    await flushAsync();
  }
  const fetchAll = (row: unknown) => run(FETCH_ALL, row);
  const resolveAll = (row: unknown) => run(RESOLVE_ALL, row);
  const COMMANDS = [
    ["Fetch All", fetchAll, "menu fetch-collection"],
    ["Resolve All", resolveAll, "menu resolve-authors-collection"],
  ] as const;

  describe("a library row", () => {
    it("fetches the library the row names", async () => {
      await fetchAll(libraryRow(42));
      expect(getAll()).toHaveBeenCalledWith(42, false);
    });

    it("fetches a group library through its own libraryID", async () => {
      await fetchAll(libraryRow(7, "group"));
      expect(getAll()).toHaveBeenCalledWith(7, false);
    });

    it("opens the progress window in the menu's window and fetches every item in the library", async () => {
      await fetchAll(libraryRow(1));
      expect(alertSpy).not.toHaveBeenCalled();
      expect(progressWindowParents()).toHaveLength(1);
      expect(progressWindowParents()[0]).toBe(win);
      expect(mocks.fetchAndCacheItems).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 1 }),
          expect.objectContaining({ id: 2 }),
        ]),
        expect.any(Function),
        expect.any(Function),
      );
    });

    it("says the library is empty when it has no items", async () => {
      libraryItems = [];
      await fetchAll(libraryRow(1));
      expect(alertSpy).toHaveBeenCalledWith(
        win,
        "Citegeist: Nothing to fetch",
        "This library is empty.",
      );
      expect(mocks.fetchAndCacheItems).not.toHaveBeenCalled();
    });

    it("names the library, not a collection, when no item has an identifier", async () => {
      libraryItems = [makeItem(10, false), makeItem(11, false)];
      await fetchAll(libraryRow(1));
      expect(alertSpy).toHaveBeenCalledWith(
        win,
        "Citegeist: Nothing to fetch",
        expect.stringContaining("None of the 2 items in this library"),
      );
      expect(alertSpy.mock.calls[0][2]).not.toContain("in this collection");
    });

    it("leaves out attachments and notes", async () => {
      const attachment = { ...makeItem(99), isRegularItem: () => false };
      libraryItems = [makeItem(1), attachment as unknown as _ZoteroTypes.Item];
      await fetchAll(libraryRow(1));
      expect(idsOf(fetchedItems())).toEqual([1]);
    });

    it("fetches an item Zotero lists twice once", async () => {
      const item = makeItem(1);
      libraryItems = [item, item];
      await fetchAll(libraryRow(1));
      expect(fetchedItems()).toHaveLength(1);
    });
  });

  describe("a collection row", () => {
    it("fetches that collection's items, not a library", async () => {
      await fetchAll(collectionRow(makeCollection([makeItem(5)])));
      expect(getAll()).not.toHaveBeenCalled();
      expect(idsOf(fetchedItems())).toEqual([5]);
    });

    it("says the collection is empty", async () => {
      await fetchAll(collectionRow(makeCollection([])));
      expect(alertSpy).toHaveBeenCalledWith(
        win,
        "Citegeist: Nothing to fetch",
        "This collection is empty.",
      );
    });

    it("names the collection, not a library, when no item has an identifier", async () => {
      await fetchAll(collectionRow(makeCollection([makeItem(20, false)])));
      expect(alertSpy).toHaveBeenCalledWith(
        win,
        "Citegeist: Nothing to fetch",
        expect.stringContaining("None of the 1 item in this collection"),
      );
      expect(alertSpy.mock.calls[0][2]).not.toContain("in this library");
    });

    it("gathers the items of nested subcollections", async () => {
      const sub = makeCollection([makeItem(11), makeItem(12)]);
      await fetchAll(collectionRow(makeCollection([makeItem(10)], [sub])));
      expect(idsOf(fetchedItems())).toEqual([10, 11, 12]);
    });

    it("fetches an item that sits in several subcollections once", async () => {
      const shared = makeItem(99);
      const sub1 = makeCollection([shared]);
      const sub2 = makeCollection([shared, makeItem(98)]);
      await fetchAll(collectionRow(makeCollection([shared], [sub1, sub2])));
      expect(fetchedItems().map((i) => i.id)).toHaveLength(2);
      expect(idsOf(fetchedItems())).toEqual([98, 99]);
    });
  });

  describe("Resolve All Author Identities", () => {
    it("resolves exactly the collection's items, nested ones included, and never reads a whole library", async () => {
      const sub = makeCollection([makeItem(7)]);
      await resolveAll(collectionRow(makeCollection([makeItem(5), makeItem(6)], [sub])));
      expect(mocks.resolveAuthorsForItems).toHaveBeenCalledTimes(1);
      expect(idsOf(resolvedItems())).toEqual([5, 6, 7]);
      expect(getAll()).not.toHaveBeenCalled();
    });

    it("resolves the library a group library row names", async () => {
      await resolveAll(libraryRow(7, "group"));
      expect(getAll()).toHaveBeenCalledTimes(1);
      expect(getAll()).toHaveBeenCalledWith(7, false);
      expect(idsOf(resolvedItems())).toEqual([1, 2]);
    });

    it("starts nothing, and records nothing, for a Trash row", async () => {
      await resolveAll(otherRow("trash"));
      expectNothingStarted();
    });
  });

  describe("progress while a large selection is gathered", () => {
    it.each(COMMANDS)(
      "%s shows 'Gathering items…' before it reads the library",
      async (_l, command) => {
        let shownBeforeGathering = false;
        getAll().mockImplementation(async () => {
          const [first] = progressWindows();
          shownBeforeGathering = first?.show.mock.calls.length === 1;
          return libraryItems;
        });
        await command(libraryRow(1));
        expect(shownBeforeGathering).toBe(true);
        expect(progressWindows()).toHaveLength(1);
        expect(progressWindows()[0].lines[0].initialText).toBe("Gathering items…");
      },
    );

    it.each(COMMANDS)(
      "%s closes that window before an empty-selection alert",
      async (_l, command) => {
        libraryItems = [];
        await command(libraryRow(1));
        expect(progressWindows()[0].close).toHaveBeenCalledTimes(1);
        expect(alertSpy).toHaveBeenCalledTimes(1);
      },
    );

    it.each(COMMANDS)(
      "%s reports a failed gather in the window and starts nothing",
      async (_l, command, context) => {
        getAll().mockRejectedValue(new Error("database is locked"));
        await command(libraryRow(1));
        expect(progressWindows()[0].startCloseTimer).toHaveBeenCalledTimes(1);
        expect(mocks.fetchAndCacheItems).not.toHaveBeenCalled();
        expect(mocks.resolveAuthorsForItems).not.toHaveBeenCalled();
        expect((await recordedFailures()).map((d) => d.context)).toEqual([`${context} gather`]);
      },
    );

    it.each(COMMANDS)(
      "%s closes the 'Gathering items…' window when the eligibility check throws, and records the failure",
      async (_l, command, context) => {
        mocks.canResolveWork.mockImplementationOnce(() => {
          throw new Error("item is gone");
        });
        await command(libraryRow(1));

        const [gathering] = progressWindows();
        expect(gathering.lines[0].initialText).toBe("Gathering items…");
        expect(gathering.close).toHaveBeenCalledTimes(1);
        expect(mocks.fetchAndCacheItems).not.toHaveBeenCalled();
        expect(mocks.resolveAuthorsForItems).not.toHaveBeenCalled();
        expect((await recordedFailures()).map((d) => [d.code, d.context])).toEqual([
          ["CG-BUG01", context],
        ]);
      },
    );

    it.each(COMMANDS)(
      "%s leaves a finished window to its close timer, and closes it only once",
      async (_l, command) => {
        await command(libraryRow(1));
        const [finished] = progressWindows();
        expect(finished.startCloseTimer).toHaveBeenCalledTimes(1);
        expect(finished.startCloseTimer).toHaveBeenCalledWith(PROGRESS_WINDOW_DONE_CLOSE_MS);
        expect(finished.close).not.toHaveBeenCalled();
      },
    );
  });

  describe("column repaint", () => {
    const threeItems = () => collectionRow(makeCollection([makeItem(1), makeItem(2), makeItem(3)]));

    it("repaints each row as its fetch lands, not only at the end", async () => {
      mocks.fetchAndCacheItems.mockImplementationOnce(reportingEachItem(() => "ok"));
      await fetchAll(threeItems());
      for (const id of [1, 2, 3]) expect(mocks.invalidateColumnCache).toHaveBeenCalledWith(id);
    });

    it("repaints a row that landed as a suggestion, and not a row whose fetch failed", async () => {
      mocks.fetchAndCacheItems.mockImplementationOnce(
        reportingEachItem((index) => ["ok", "suggestion", "error"][index]),
      );
      await fetchAll(threeItems());
      expect(mocks.invalidateColumnCache).toHaveBeenCalledWith(1);
      expect(mocks.invalidateColumnCache).toHaveBeenCalledWith(2);
      expect(mocks.invalidateColumnCache).not.toHaveBeenCalledWith(3);
    });

    it("repaints every fetched row once the batch ends", async () => {
      await fetchAll(threeItems());
      expect(mocks.invalidateColumnCache.mock.calls.at(-1)).toEqual([[1, 2, 3]]);
    });

    it("records a failed final repaint and still reports the fetch", async () => {
      mocks.fetchAndCacheItems.mockResolvedValueOnce(batchResult({ fresh: 3 }));
      mocks.invalidateColumnCache.mockImplementation(async (ids: unknown) => {
        if (Array.isArray(ids)) throw new Error("item tree is gone");
      });
      await fetchAll(threeItems());
      expect(lastProgressLine()).toBe("Done — 3 updated");
      expect((await recordedFailures()).map((d) => d.context)).toEqual([
        "batch fetch column repaint",
      ]);
    });
  });

  it("names the items a read-only cache skipped instead of reporting success", async () => {
    mocks.fetchAndCacheItems.mockResolvedValueOnce(
      batchResult({ cached: 1, unwritableStopped: 2, code: "CG-DB03" }),
    );
    await fetchAll(collectionRow(makeCollection([makeItem(1), makeItem(2), makeItem(3)])));
    expect(lastProgressLine()).toBe(
      `Done — 1 already up to date, 2 skipped (${CACHE_READ_ONLY_HEADLINE})`,
    );
  });

  describe("once the menu's window has closed", () => {
    it.each(COMMANDS)("%s opens its progress window in the main window", async (_l, command) => {
      win.closed = true;
      await command(libraryRow(1));
      expect(progressWindowParents()).toHaveLength(1);
      expect(progressWindowParents()[0]).toBe(mainWin);
    });

    it.each(COMMANDS)(
      "%s shows the alert in the main window when the window closed while items were gathered",
      async (_l, command) => {
        getAll().mockImplementation(async () => {
          win.closed = true;
          return [];
        });
        await command(libraryRow(1));
        expect(progressWindowParents()[0]).toBe(win);
        expect(alertSpy).toHaveBeenCalledTimes(1);
        expect(alertSpy.mock.calls[0][0]).toBe(mainWin);
      },
    );
  });
});

// Zotero 7 DOM fallback: delete with registerViaDOM (U9)
describe("DOM fallback", () => {
  let doc: FakeMenuDocument;

  beforeEach(() => {
    installZotero(false);
    mainWin = win;
    doc = win.document;
  });

  async function command(id: string, d: FakeMenuDocument = doc): Promise<void> {
    d.getElementById(id)!.dispatch("command");
    await flushAsync();
  }

  function openCollectionMenu(): void {
    menu.registerMenus(win);
    doc.getElementById("zotero-collectionmenu")!.dispatch("popupshowing");
  }

  /** Hidden state of the collection separator, Fetch All, and Resolve All, in that order. */
  const entriesHidden = (d: FakeMenuDocument = doc) =>
    ["citegeist-collection-menu-separator", FETCH_ALL, RESOLVE_ALL].map(
      (id) => d.getElementById(id)!.hidden,
    );

  /** Hidden state of the item separator, Fetch, Citing, References, and Resolve, in that order. */
  const itemEntriesHidden = (d: FakeMenuDocument = doc) =>
    [
      "citegeist-menu-separator",
      "citegeist-menu-fetch",
      "citegeist-menu-citing",
      "citegeist-menu-refs",
      "citegeist-menu-resolve-authors",
    ].map((id) => d.getElementById(id)!.hidden);

  describe("reading the pane's rows", () => {
    it("Fetch All runs on the library the focused row names", async () => {
      focusedRow = libraryRow(42);
      menu.registerMenus(win);
      await command(FETCH_ALL);
      expect(getAll()).toHaveBeenCalledWith(42, false);
      expect(progressWindowParents()[0]).toBe(win);
    });

    it("Resolve All runs on the focused collection's items", async () => {
      focusedRow = collectionRow(makeCollection([makeItem(5), makeItem(6)]));
      menu.registerMenus(win);
      await command(RESOLVE_ALL);
      expect(idsOf(resolvedItems())).toEqual([5, 6]);
      expect(getAll()).not.toHaveBeenCalled();
    });

    it("starts nothing, and records CG-UI02, when the pane's row getter throws", async () => {
      getActiveZoteroPane.mockReturnValue({
        getSelectedItems: () => [],
        getCollectionTreeRow: () => {
          throw new Error("collectionsView is gone");
        },
      });
      menu.registerMenus(win);
      await command(RESOLVE_ALL);
      expectNothingStarted();
      expect(await selectionUnreadableReports()).toHaveLength(1);
    });
  });

  describe("rows Citegeist does not act on", () => {
    it.each(UNSUPPORTED_ROW_TYPES)(
      "a focused %s row hides the entries, and neither command starts anything",
      async (type) => {
        focusedRow = otherRow(type);
        openCollectionMenu();
        expect(entriesHidden()).toEqual([true, true, true]);

        await command(FETCH_ALL);
        await command(RESOLVE_ALL);
        expectNothingStarted();
      },
    );

    it("hides the entries and starts nothing when no row is focused", async () => {
      focusedRow = 0;
      openCollectionMenu();
      expect(entriesHidden()).toEqual([true, true, true]);
      await command(FETCH_ALL);
      expectNothingStarted();
    });

    it("hides the entries, and records CG-UI02, when the pane has neither getCollectionTreeRows nor getCollectionTreeRow", async () => {
      getActiveZoteroPane.mockReturnValue({ getSelectedItems: () => [] });
      openCollectionMenu();
      expect(entriesHidden()).toEqual([true, true, true]);
      await command(RESOLVE_ALL);
      expectNothingStarted();
      expect(await selectionUnreadableReports()).toHaveLength(1);
    });

    it("shows the entries again for a collection or library row", () => {
      focusedRow = otherRow("trash");
      openCollectionMenu();
      focusedRow = collectionRow(makeCollection([makeItem(1)]));
      openCollectionMenu();
      expect(entriesHidden()).toEqual([false, false, false]);
    });
  });

  describe("Zotero 10 pane (getCollectionTreeRows)", () => {
    const removedSingular = () =>
      vi.fn(() => {
        throw new Error(
          "ZoteroPane.getCollectionTreeRow() was removed -- use ZoteroPane.getCollectionTreeRows()",
        );
      });

    it("fetches every selected collection's items, each once, and never calls getCollectionTreeRow", async () => {
      const getCollectionTreeRow = removedSingular();
      getActiveZoteroPane.mockReturnValue({
        getSelectedItems: () => [],
        getCollectionTreeRows: () => [
          collectionRow(makeCollection([makeItem(1), makeItem(2)])),
          collectionRow(makeCollection([makeItem(2), makeItem(3)])),
        ],
        getCollectionTreeRow,
      });

      openCollectionMenu();
      expect(entriesHidden()).toEqual([false, false, false]);

      await command(FETCH_ALL);
      expect(idsOf(fetchedItems())).toEqual([1, 2, 3]);
      expect(getCollectionTreeRow).not.toHaveBeenCalled();
    });

    it.each([
      ["after", () => [collectionRow(makeCollection([makeItem(1)])), otherRow("search")]],
      ["before", () => [otherRow("search"), collectionRow(makeCollection([makeItem(1)]))]],
    ])(
      "hides the entries and starts nothing when a saved search is selected %s a collection",
      async (_order, rows) => {
        getActiveZoteroPane.mockReturnValue({
          getSelectedItems: () => [],
          getCollectionTreeRows: rows,
          getCollectionTreeRow: removedSingular(),
        });

        openCollectionMenu();
        expect(entriesHidden()).toEqual([true, true, true]);

        await command(FETCH_ALL);
        await command(RESOLVE_ALL);
        expectNothingStarted();
      },
    );

    it("hides the entries and starts nothing for a library row selected with one of its collections", async () => {
      getActiveZoteroPane.mockReturnValue({
        getSelectedItems: () => [],
        getCollectionTreeRows: () => [libraryRow(1), collectionRow(makeCollection([makeItem(1)]))],
      });

      openCollectionMenu();
      expect(entriesHidden()).toEqual([true, true, true]);

      await command(FETCH_ALL);
      await command(RESOLVE_ALL);
      expectNothingStarted();
    });

    it("hides the entries, starts nothing, and records CG-UI02 when getCollectionTreeRows throws", async () => {
      getActiveZoteroPane.mockReturnValue({
        getSelectedItems: () => [],
        getCollectionTreeRows: () => {
          throw new Error("collectionsView is gone");
        },
        getCollectionTreeRow: removedSingular(),
      });

      openCollectionMenu();
      expect(entriesHidden()).toEqual([true, true, true]);

      await command(FETCH_ALL);
      expectNothingStarted();
      expect(await selectionUnreadableReports()).toHaveLength(1);
      // Recorded once, and no CG-BUG01: nothing threw past the selection read.
      expect(await recordedFailures()).toHaveLength(1);
    });
  });

  describe("popupshowing hides the entries before it reads the selection", () => {
    it("a row that throws when read hides entries that were showing and records CG-UI02", async () => {
      let rows: unknown[] = [collectionRow(makeCollection([makeItem(1)]))];
      getActiveZoteroPane.mockReturnValue({
        getSelectedItems: () => [],
        getCollectionTreeRows: () => rows,
      });
      openCollectionMenu();
      expect(entriesHidden()).toEqual([false, false, false]);

      rows = [
        {
          get type(): never {
            throw new Error("row is gone");
          },
          ref: {},
        },
      ];
      openCollectionMenu();
      expect(entriesHidden()).toEqual([true, true, true]);
      expect(await selectionUnreadableReports()).toHaveLength(1);
      expect(await recordedFailures()).toHaveLength(1);
    });

    it("a pane lookup that throws past the selection module still leaves no stale collection entries", async () => {
      focusedRow = collectionRow(makeCollection([makeItem(1)]));
      openCollectionMenu();
      expect(entriesHidden()).toEqual([false, false, false]);

      getActiveZoteroPane.mockImplementation(() => {
        throw new Error("no main window");
      });
      openCollectionMenu();
      expect(entriesHidden()).toEqual([true, true, true]);
      // The listener's guard caught it: recorded, not thrown into Zotero.
      expect((await recordedFailures()).map((d) => d.code)).toEqual(["CG-BUG01"]);
    });

    it("a pane lookup that throws leaves no stale item entries either", async () => {
      activeSelection = [makeItem(1)];
      menu.registerMenus(win);
      doc.getElementById("zotero-itemmenu")!.dispatch("popupshowing");
      expect(itemEntriesHidden()).toEqual([false, false, false, false, false]);

      getActiveZoteroPane.mockImplementation(() => {
        throw new Error("no main window");
      });
      doc.getElementById("zotero-itemmenu")!.dispatch("popupshowing");
      expect(itemEntriesHidden()).toEqual([true, true, true, true, true]);
      expect((await recordedFailures()).map((d) => d.code)).toEqual(["CG-BUG01"]);
    });
  });

  describe("the DOM menus act on their own window's selection, not the most recent window's", () => {
    let win2: FakeWindow;

    beforeEach(() => {
      // The most recent window (the active pane) has Trash focused and item 1 selected.
      focusedRow = otherRow("trash");
      activeSelection = [makeItem(1)];

      win2 = fakeWindow({
        getSelectedItems: () => [makeItem(8)],
        getCollectionTreeRows: () => [collectionRow(makeCollection([makeItem(30), makeItem(31)]))],
      });
      menu.registerMenus(win2);
    });

    it("the collection popup shows the entries for the second window's collection", () => {
      win2.document.getElementById("zotero-collectionmenu")!.dispatch("popupshowing");
      expect(entriesHidden(win2.document)).toEqual([false, false, false]);
      expect(getActiveZoteroPane).not.toHaveBeenCalled();
    });

    it("Fetch All and Resolve All gather the second window's collection, in that window", async () => {
      await command(FETCH_ALL, win2.document);
      await command(RESOLVE_ALL, win2.document);
      expect(idsOf(fetchedItems())).toEqual([30, 31]);
      expect(idsOf(resolvedItems())).toEqual([30, 31]);
      expect(getAll()).not.toHaveBeenCalled();
      expect(progressWindowParents()).toHaveLength(2);
      for (const parent of progressWindowParents()) expect(parent).toBe(win2);
    });

    it("Fetch Citation Counts, Resolve Author Identities and both View entries act on the second window's items, in that window", async () => {
      await command("citegeist-menu-fetch", win2.document);
      await command("citegeist-menu-resolve-authors", win2.document);
      await command("citegeist-menu-citing", win2.document);
      await command("citegeist-menu-refs", win2.document);
      expect(idsOf(fetchedItems())).toEqual([8]);
      expect(idsOf(resolvedItems())).toEqual([8]);
      const opens = mocks.showCitationNetwork.mock.calls as unknown as Array<
        [_ZoteroTypes.Item, string, Window]
      >;
      expect(opens.map(([item, mode]) => [item.id, mode])).toEqual([
        [8, "citing"],
        [8, "references"],
      ]);
      for (const [, , opener] of opens) expect(opener).toBe(win2);
      expect(getActiveZoteroPane).not.toHaveBeenCalled();
    });

    it("the item popup decides from the second window's selection", () => {
      activeSelection = [makeItem(1, false)];
      win2.document.getElementById("zotero-itemmenu")!.dispatch("popupshowing");
      expect(itemEntriesHidden(win2.document)).toEqual([false, false, false, false, false]);
    });
  });

  describe("unregisterMenus removes the DOM menus' listeners from Zotero's popups", () => {
    const popups = () => [
      doc.getElementById("zotero-itemmenu")!,
      doc.getElementById("zotero-collectionmenu")!,
    ];

    it("leaves no popupshowing listener behind, so a later popup runs no Citegeist code", () => {
      menu.registerMenus(win);
      expect(popups().map((p) => p.listenerCount("popupshowing"))).toEqual([1, 1]);
      popups()[1].dispatch("popupshowing");
      expect(getActiveZoteroPane).toHaveBeenCalled(); // positive control
      getActiveZoteroPane.mockClear();

      menu.unregisterMenus(win);
      expect(popups().map((p) => p.listenerCount("popupshowing"))).toEqual([0, 0]);
      for (const popup of popups()) popup.dispatch("popupshowing");
      expect(getActiveZoteroPane).not.toHaveBeenCalled();
      expect(doc.getElementById("citegeist-menu-fetch")).toBeNull();
      expect(popups().map((p) => p.children.length)).toEqual([0, 0]);
    });

    it("binds exactly one listener per popup when the window registers again", () => {
      menu.registerMenus(win);
      menu.unregisterMenus(win);
      menu.registerMenus(win);
      menu.registerMenus(win); // a repeat for a window that already has the entries is skipped
      expect(popups().map((p) => p.listenerCount("popupshowing"))).toEqual([1, 1]);
    });

    it("builds the listener signal from the window's own AbortController and aborts it on unregister", () => {
      const controllers: AbortController[] = [];
      win.AbortController = class extends AbortController {
        constructor() {
          super();
          controllers.push(this);
        }
      };

      menu.registerMenus(win);
      expect(controllers).toHaveLength(1);
      expect(controllers[0].signal.aborted).toBe(false);

      menu.unregisterMenus(win);
      expect(controllers[0].signal.aborted).toBe(true);
      expect(popups().map((p) => p.listenerCount("popupshowing"))).toEqual([0, 0]);
    });
  });
});

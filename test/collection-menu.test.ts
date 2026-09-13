/**
 * Tests for the DOM menu path — Zotero 7, and Zotero 8+ when MenuManager rejects
 * the registration — which has no MenuManager context: the collection menu's
 * "Fetch All Citation Counts" and "Resolve All Author Identities" entries end to
 * end, plus the DOM item menu's window routing and teardown.
 *
 * The DOM path reads the registering window's pane rows through
 * getCollectionTreeRows() on Zotero 10, or getCollectionTreeRow() where the
 * plural getter does not exist, and hands them to the same target helper as the
 * MenuManager path (src/modules/host/selection.ts). The helper's own rules are
 * covered in hostSelection.test.ts and the MenuManager path in menu.test.ts.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { registerMenus, unregisterMenus } from "../src/modules/menu";
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
  progressWindows,
  recordedFailures,
  selectionUnreadableReports,
} from "./_helpers/menuHarness";

const mocks = vi.hoisted(() => ({
  fetchAndCacheItems: vi.fn(
    async (): Promise<{ fresh: number; cached: number; suggestion: number; errors: number }> => ({
      fresh: 2,
      cached: 0,
      suggestion: 0,
      errors: 0,
    }),
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
  canResolveWork: vi.fn(
    (item: { isRegularItem?: () => boolean; hasIdentifier?: boolean }) =>
      item.isRegularItem?.() !== false && item.hasIdentifier !== false,
  ),
  invalidateColumnCache: vi.fn(),
  showCitationNetwork: vi.fn(async () => {}),
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

// ─── Shared setup ────────────────────────────────────────────────────────────

let doc: FakeDocument;
let win: Window;
let focusedRow: _ZoteroTypes.CollectionTreeRow | false | 0;
let activeSelection: _ZoteroTypes.Item[];
let alertSpy: Mock;
let getActiveZoteroPane: Mock;
let libraryItems: _ZoteroTypes.Item[];

beforeEach(async () => {
  vi.clearAllMocks();
  await clearRecordedFailures();

  doc = new FakeDocument();
  win = { document: doc } as unknown as Window;
  focusedRow = libraryRow(1);
  activeSelection = [];
  alertSpy = vi.fn();
  libraryItems = [makeItem(1), makeItem(2)];

  // Only getCollectionTreeRow: a call to getSelectedCollection or
  // getSelectedLibraryID would throw, which pins that the DOM path does not
  // read them. `win` has no ZoteroPane of its own, so reads fall back to this
  // pane, the most recent window's.
  getActiveZoteroPane = vi.fn(() => ({
    getSelectedItems: () => activeSelection,
    getCollectionTreeRow: () => focusedRow,
  }));

  vi.stubGlobal("Zotero", {
    debug: vi.fn(),
    getMainWindow: vi.fn(() => null),
    getActiveZoteroPane,
    Items: {
      getAll: vi.fn(async () => libraryItems),
    },
    Libraries: {
      userLibraryID: 1,
    },
    ProgressWindow: fakeProgressWindowClass(),
  });

  vi.stubGlobal("Services", {
    prompt: { alert: alertSpy },
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function command(id: string, d: FakeDocument = doc): Promise<void> {
  d.getElementById(id)!.dispatch("command");
  await flushAsync();
}

async function triggerFetchAll(): Promise<void> {
  registerMenus(win);
  await command("citegeist-menu-fetch-collection");
}

async function triggerResolveAll(): Promise<void> {
  registerMenus(win);
  await command("citegeist-menu-resolve-collection");
}

function openCollectionMenu(): void {
  registerMenus(win);
  doc.getElementById("zotero-collectionmenu")!.dispatch("popupshowing");
}

const getAll = () => Zotero.Items.getAll as Mock;
const fetchedItems = (): _ZoteroTypes.Item[] => mocks.fetchAndCacheItems.mock.calls[0][0];
const resolvedItems = (): _ZoteroTypes.Item[] => mocks.resolveAuthorsForItems.mock.calls[0][0];

/** Hidden state of the collection separator, Fetch All, and Resolve All, in that order. */
const entriesHidden = (d: FakeDocument = doc) =>
  [
    "citegeist-collection-menu-separator",
    "citegeist-menu-fetch-collection",
    "citegeist-menu-resolve-collection",
  ].map((id) => d.getElementById(id)!.hidden);

/** Hidden state of the item separator, Fetch, Citing, References, and Resolve, in that order. */
const itemEntriesHidden = (d: FakeDocument = doc) =>
  [
    "citegeist-menu-separator",
    "citegeist-menu-fetch",
    "citegeist-menu-citing",
    "citegeist-menu-refs",
    "citegeist-menu-resolve-authors",
  ].map((id) => d.getElementById(id)!.hidden);

function expectNothingStarted(): void {
  expect(mocks.fetchAndCacheItems).not.toHaveBeenCalled();
  expect(mocks.resolveAuthorsForItems).not.toHaveBeenCalled();
  expect(getAll()).not.toHaveBeenCalled();
  expect(alertSpy).not.toHaveBeenCalled();
  expect(Zotero.ProgressWindow).not.toHaveBeenCalled();
}

// ─── Library row ─────────────────────────────────────────────────────────────

describe("library row focused", () => {
  it("fetches the library the row names", async () => {
    focusedRow = libraryRow(42);
    await triggerFetchAll();
    expect(getAll()).toHaveBeenCalledWith(42, false);
  });

  it("fetches a group library through its own libraryID", async () => {
    focusedRow = libraryRow(7, "group");
    await triggerFetchAll();
    expect(getAll()).toHaveBeenCalledWith(7, false);
  });

  it("opens the progress window in the menu's own window and calls fetchAndCacheItems", async () => {
    await triggerFetchAll();
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

  it("shows 'library is empty' alert when library has no items", async () => {
    libraryItems = [];
    await triggerFetchAll();
    expect(alertSpy).toHaveBeenCalledWith(
      win,
      "Citegeist: Nothing to fetch",
      "This library is empty.",
    );
    expect(mocks.fetchAndCacheItems).not.toHaveBeenCalled();
  });

  it("shows 'library' (not 'collection') in no-identifier alert", async () => {
    libraryItems = [makeItem(10, false), makeItem(11, false)];
    await triggerFetchAll();
    expect(alertSpy).toHaveBeenCalledWith(
      win,
      "Citegeist: Nothing to fetch",
      expect.stringContaining("in this library"),
    );
    const msg: string = alertSpy.mock.calls[0][2];
    expect(msg).not.toContain("in this collection");
  });

  it("filters out non-regular items (attachments, notes) from Items.getAll results", async () => {
    const attachment = { ...makeItem(99), isRegularItem: () => false };
    libraryItems = [makeItem(1), attachment as unknown as _ZoteroTypes.Item];
    await triggerFetchAll();
    expect(fetchedItems()).toHaveLength(1);
    expect(fetchedItems()[0].id).toBe(1);
  });

  it("deduplicates items that somehow appear twice in Items.getAll results", async () => {
    const item1 = makeItem(1);
    libraryItems = [item1, item1]; // same object/id twice
    await triggerFetchAll();
    expect(fetchedItems()).toHaveLength(1);
  });
});

// ─── Collection row ──────────────────────────────────────────────────────────

describe("collection row focused", () => {
  it("runs the fetch on that collection's items, not Items.getAll", async () => {
    focusedRow = collectionRow(makeCollection([makeItem(5)]));
    await triggerFetchAll();
    expect(getAll()).not.toHaveBeenCalled();
    expect(mocks.fetchAndCacheItems).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 5 })]),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("shows 'collection is empty' alert for empty collection", async () => {
    focusedRow = collectionRow(makeCollection([]));
    await triggerFetchAll();
    expect(alertSpy).toHaveBeenCalledWith(
      win,
      "Citegeist: Nothing to fetch",
      "This collection is empty.",
    );
  });

  it("shows 'in this collection' (not 'library') in no-identifier alert", async () => {
    focusedRow = collectionRow(makeCollection([makeItem(20, false)]));
    await triggerFetchAll();
    expect(alertSpy).toHaveBeenCalledWith(
      win,
      "Citegeist: Nothing to fetch",
      expect.stringContaining("in this collection"),
    );
    const msg: string = alertSpy.mock.calls[0][2];
    expect(msg).not.toContain("in this library");
  });

  it("recursively gathers items from nested subcollections", async () => {
    const sub = makeCollection([makeItem(11), makeItem(12)]);
    focusedRow = collectionRow(makeCollection([makeItem(10)], [sub]));
    await triggerFetchAll();
    expect(idsOf(fetchedItems())).toEqual([10, 11, 12]);
  });

  it("deduplicates items that appear in multiple subcollections", async () => {
    const shared = makeItem(99);
    const sub1 = makeCollection([shared]);
    const sub2 = makeCollection([shared]);
    focusedRow = collectionRow(makeCollection([shared], [sub1, sub2]));
    await triggerFetchAll();
    const ids = fetchedItems().map((i) => i.id);
    expect(ids.filter((id) => id === 99)).toHaveLength(1);
  });
});

// ─── Resolve All ─────────────────────────────────────────────────────────────

describe("Resolve All Author Identities", () => {
  it("resolves exactly the focused collection's items and never reads a whole library", async () => {
    focusedRow = collectionRow(makeCollection([makeItem(5), makeItem(6)]));
    await triggerResolveAll();
    expect(mocks.resolveAuthorsForItems).toHaveBeenCalledTimes(1);
    expect(idsOf(resolvedItems())).toEqual([5, 6]);
    expect(getAll()).not.toHaveBeenCalled();
    expect(await recordedFailures()).toEqual([]);
  });

  it("resolves the library a focused group library row names", async () => {
    focusedRow = libraryRow(7, "group");
    await triggerResolveAll();
    expect(getAll()).toHaveBeenCalledTimes(1);
    expect(getAll()).toHaveBeenCalledWith(7, false);
    expect(idsOf(resolvedItems())).toEqual([1, 2]);
  });

  it("starts nothing, and records nothing, for a focused Trash row", async () => {
    focusedRow = otherRow("trash");
    await triggerResolveAll();
    expectNothingStarted();
    expect(await recordedFailures()).toEqual([]);
  });

  it("starts nothing, and records CG-UI02, when the pane's row getter throws", async () => {
    getActiveZoteroPane.mockReturnValue({
      getSelectedItems: () => [],
      getCollectionTreeRow: () => {
        throw new Error("collectionsView is gone");
      },
    });
    await triggerResolveAll();
    expectNothingStarted();
    expect(await selectionUnreadableReports()).toHaveLength(1);
  });
});

// ─── Progress while gathering ────────────────────────────────────────────────

describe("progress while a large selection is gathered", () => {
  it.each([
    ["Fetch All", triggerFetchAll],
    ["Resolve All", triggerResolveAll],
  ])("%s shows 'Gathering items…' before it reads the library", async (_label, trigger) => {
    let shownBeforeGathering = false;
    getAll().mockImplementation(async () => {
      const [first] = progressWindows();
      shownBeforeGathering = first?.show.mock.calls.length === 1;
      return libraryItems;
    });
    await trigger();
    expect(shownBeforeGathering).toBe(true);
    expect(progressWindows()).toHaveLength(1);
    expect(progressWindows()[0].lines[0].initialText).toBe("Gathering items…");
  });

  it.each([
    ["Fetch All", triggerFetchAll],
    ["Resolve All", triggerResolveAll],
  ])("%s closes that window before an empty-selection alert", async (_label, trigger) => {
    libraryItems = [];
    await trigger();
    expect(progressWindows()[0].close).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Fetch All", triggerFetchAll, "menu fetch-collection gather"],
    ["Resolve All", triggerResolveAll, "menu resolve-authors-collection gather"],
  ])(
    "%s reports a failed gather in the window and starts nothing",
    async (_l, trigger, context) => {
      getAll().mockRejectedValue(new Error("database is locked"));
      await trigger();
      expect(progressWindows()[0].startCloseTimer).toHaveBeenCalledTimes(1);
      expect(mocks.fetchAndCacheItems).not.toHaveBeenCalled();
      expect(mocks.resolveAuthorsForItems).not.toHaveBeenCalled();
      expect((await recordedFailures()).map((d) => d.context)).toEqual([context]);
    },
  );
});

// ─── Rows Citegeist does not act on ──────────────────────────────────────────

describe("rows Citegeist does not act on", () => {
  it.each(UNSUPPORTED_ROW_TYPES)(
    "a focused %s row hides the entries, and neither command starts anything",
    async (type) => {
      focusedRow = otherRow(type);
      openCollectionMenu();
      expect(entriesHidden()).toEqual([true, true, true]);

      await command("citegeist-menu-fetch-collection");
      await command("citegeist-menu-resolve-collection");
      expectNothingStarted();
      expect(await recordedFailures()).toEqual([]);
    },
  );

  it("hides the entries and starts nothing when no row is focused", async () => {
    focusedRow = 0;
    openCollectionMenu();
    expect(entriesHidden()).toEqual([true, true, true]);
    await command("citegeist-menu-fetch-collection");
    expectNothingStarted();
    expect(await recordedFailures()).toEqual([]);
  });

  it("hides the entries, and records CG-UI02, when the pane has neither getCollectionTreeRows nor getCollectionTreeRow", async () => {
    getActiveZoteroPane.mockReturnValue({ getSelectedItems: () => [] });
    openCollectionMenu();
    expect(entriesHidden()).toEqual([true, true, true]);
    await command("citegeist-menu-resolve-collection");
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

// ─── Zotero 10 pane: getCollectionTreeRows ───────────────────────────────────

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

    await command("citegeist-menu-fetch-collection");
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

      await command("citegeist-menu-fetch-collection");
      await command("citegeist-menu-resolve-collection");
      expectNothingStarted();
      expect(await recordedFailures()).toEqual([]);
    },
  );

  it("hides the entries and starts nothing for a library row selected with one of its collections", async () => {
    getActiveZoteroPane.mockReturnValue({
      getSelectedItems: () => [],
      getCollectionTreeRows: () => [libraryRow(1), collectionRow(makeCollection([makeItem(1)]))],
    });

    openCollectionMenu();
    expect(entriesHidden()).toEqual([true, true, true]);

    await command("citegeist-menu-fetch-collection");
    await command("citegeist-menu-resolve-collection");
    expectNothingStarted();
    expect(await recordedFailures()).toEqual([]);
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

    await command("citegeist-menu-fetch-collection");
    expectNothingStarted();
    expect(await selectionUnreadableReports()).toHaveLength(1);
    // Recorded once, and no CG-BUG01: nothing threw past the selection read.
    expect(await recordedFailures()).toHaveLength(1);
  });
});

// ─── Hide first ──────────────────────────────────────────────────────────────

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

  it("a pane lookup that throws leaves no stale item entries either", () => {
    activeSelection = [makeItem(1)];
    registerMenus(win);
    doc.getElementById("zotero-itemmenu")!.dispatch("popupshowing");
    expect(itemEntriesHidden()).toEqual([false, false, false, false, false]);

    getActiveZoteroPane.mockImplementation(() => {
      throw new Error("no main window");
    });
    doc.getElementById("zotero-itemmenu")!.dispatch("popupshowing");
    expect(itemEntriesHidden()).toEqual([true, true, true, true, true]);
  });
});

// ─── Window routing ──────────────────────────────────────────────────────────

describe("the DOM menus act on their own window's selection, not the most recent window's", () => {
  let doc2: FakeDocument;
  let win2: Window;

  beforeEach(() => {
    // The most recent window (the active pane) has Trash focused and item 1 selected.
    focusedRow = otherRow("trash");
    activeSelection = [makeItem(1)];

    doc2 = new FakeDocument();
    win2 = {
      document: doc2,
      ZoteroPane: {
        getSelectedItems: () => [makeItem(8)],
        getCollectionTreeRows: () => [collectionRow(makeCollection([makeItem(30), makeItem(31)]))],
      },
    } as unknown as Window;
    registerMenus(win2);
  });

  it("the collection popup shows the entries for the second window's collection", () => {
    doc2.getElementById("zotero-collectionmenu")!.dispatch("popupshowing");
    expect(entriesHidden(doc2)).toEqual([false, false, false]);
    expect(getActiveZoteroPane).not.toHaveBeenCalled();
  });

  it("Fetch All and Resolve All gather the second window's collection, in that window", async () => {
    await command("citegeist-menu-fetch-collection", doc2);
    await command("citegeist-menu-resolve-collection", doc2);
    expect(idsOf(fetchedItems())).toEqual([30, 31]);
    expect(idsOf(resolvedItems())).toEqual([30, 31]);
    expect(getAll()).not.toHaveBeenCalled();
    expect(progressWindowParents()).toHaveLength(2);
    for (const parent of progressWindowParents()) expect(parent).toBe(win2);
  });

  it("Fetch Citation Counts, Resolve Author Identities and View Citing Works act on the second window's items", async () => {
    await command("citegeist-menu-fetch", doc2);
    await command("citegeist-menu-resolve-authors", doc2);
    await command("citegeist-menu-citing", doc2);
    expect(idsOf(fetchedItems())).toEqual([8]);
    expect(idsOf(resolvedItems())).toEqual([8]);
    expect(mocks.showCitationNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ id: 8 }),
      "citing",
    );
    expect(getActiveZoteroPane).not.toHaveBeenCalled();
  });

  it("the item popup decides from the second window's selection", () => {
    activeSelection = [makeItem(1, false)];
    doc2.getElementById("zotero-itemmenu")!.dispatch("popupshowing");
    expect(itemEntriesHidden(doc2)).toEqual([false, false, false, false, false]);
  });
});

// ─── Teardown ────────────────────────────────────────────────────────────────

describe("unregisterMenus removes the DOM menus' listeners from Zotero's popups", () => {
  const popups = () => [
    doc.getElementById("zotero-itemmenu")!,
    doc.getElementById("zotero-collectionmenu")!,
  ];

  it("leaves no popupshowing listener behind, so a later popup runs no Citegeist code", () => {
    registerMenus(win);
    expect(popups().map((p) => p.listenerCount("popupshowing"))).toEqual([1, 1]);
    popups()[1].dispatch("popupshowing");
    expect(getActiveZoteroPane).toHaveBeenCalled(); // positive control
    getActiveZoteroPane.mockClear();

    unregisterMenus(win);
    expect(popups().map((p) => p.listenerCount("popupshowing"))).toEqual([0, 0]);
    for (const popup of popups()) popup.dispatch("popupshowing");
    expect(getActiveZoteroPane).not.toHaveBeenCalled();
    expect(doc.getElementById("citegeist-menu-fetch")).toBeNull();
  });

  it("binds exactly one listener per popup when the window registers again", () => {
    registerMenus(win);
    unregisterMenus(win);
    registerMenus(win);
    registerMenus(win); // a repeat for a window that already has the entries is skipped
    expect(popups().map((p) => p.listenerCount("popupshowing"))).toEqual([1, 1]);
  });
});

describe("progressive column repaint", () => {
  it("invalidates each row's columns as its fetch lands, not just at the end", async () => {
    focusedRow = collectionRow(makeCollection([makeItem(1), makeItem(2), makeItem(3)]));
    // Drive the per-item callback the way the real batch loop does.
    mocks.fetchAndCacheItems.mockImplementationOnce(
      async (
        items: Array<{ id: number }>,
        _onProgress: unknown,
        onItemDone?: (id: number, status: string) => void,
      ) => {
        for (const it of items) onItemDone?.(it.id, "ok");
        return { fresh: items.length, cached: 0, suggestion: 0, errors: 0 };
      },
    );
    await triggerFetchAll();
    // Each item's row was invalidated individually (progressive), not only via
    // a single end-of-batch array invalidation.
    expect(mocks.invalidateColumnCache).toHaveBeenCalledWith(1);
    expect(mocks.invalidateColumnCache).toHaveBeenCalledWith(2);
    expect(mocks.invalidateColumnCache).toHaveBeenCalledWith(3);
  });

  it("does not invalidate rows whose fetch errored", async () => {
    focusedRow = collectionRow(makeCollection([makeItem(1), makeItem(2)]));
    mocks.fetchAndCacheItems.mockImplementationOnce(
      async (
        items: Array<{ id: number }>,
        _onProgress: unknown,
        onItemDone?: (id: number, status: string) => void,
      ) => {
        onItemDone?.(items[0].id, "ok");
        onItemDone?.(items[1].id, "error");
        return { fresh: 1, cached: 0, suggestion: 0, errors: 1 };
      },
    );
    await triggerFetchAll();
    expect(mocks.invalidateColumnCache).toHaveBeenCalledWith(1);
    expect(mocks.invalidateColumnCache).not.toHaveBeenCalledWith(2);
  });
});

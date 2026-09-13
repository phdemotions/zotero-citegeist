/**
 * Tests for the DOM collection menu's "Fetch All Citation Counts" entry — the
 * Zotero 7 path, which has no MenuManager context.
 *
 * The DOM path reads the pane's rows through getCollectionTreeRows() on Zotero
 * 10, or getCollectionTreeRow() where the plural getter does not exist, and hands
 * them to the same target helper as the MenuManager path
 * (src/modules/host/selection.ts). The helper's own rules are covered in
 * hostSelection.test.ts and the MenuManager path in menu.test.ts; this file
 * checks the DOM handler end to end.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMenus } from "../src/modules/menu";
import {
  FakeDocument,
  UNSUPPORTED_ROW_TYPES,
  collectionRow,
  flushAsync,
  libraryRow,
  makeCollection,
  makeItem,
  otherRow,
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
  canResolveWork: vi.fn(
    (item: { isRegularItem?: () => boolean; hasIdentifier?: boolean }) =>
      item.isRegularItem?.() !== false && item.hasIdentifier !== false,
  ),
  invalidateColumnCache: vi.fn(),
}));

vi.mock("../src/modules/citationService", () => ({
  fetchAndCacheItems: mocks.fetchAndCacheItems,
  canResolveWork: mocks.canResolveWork,
}));
vi.mock("../src/modules/citationColumn", () => ({
  invalidateColumnCache: mocks.invalidateColumnCache,
}));
vi.mock("../src/modules/citationNetwork", () => ({
  showCitationNetwork: vi.fn(),
}));

// ─── Shared setup ────────────────────────────────────────────────────────────

let doc: FakeDocument;
let win: Window;
let focusedRow: _ZoteroTypes.CollectionTreeRow | false | 0;
let alertSpy: ReturnType<typeof vi.fn>;
let getActiveZoteroPane: ReturnType<typeof vi.fn>;
let libraryItems: _ZoteroTypes.Item[];

beforeEach(() => {
  vi.clearAllMocks();

  doc = new FakeDocument();
  win = { document: doc } as unknown as Window;
  focusedRow = libraryRow(1);
  alertSpy = vi.fn();
  libraryItems = [makeItem(1), makeItem(2)];

  // Only getCollectionTreeRow: a call to getSelectedCollection or
  // getSelectedLibraryID would throw a TypeError and fail the test, which pins
  // that the DOM path no longer reads them.
  getActiveZoteroPane = vi.fn(() => ({
    getSelectedItems: () => [],
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
    // Arrow functions can't be used as constructors — use regular function
    // so `new Zotero.ProgressWindow(...)` works in the handler.
    ProgressWindow: vi.fn(function () {
      return {
        changeHeadline: vi.fn(),
        show: vi.fn(),
        startCloseTimer: vi.fn(),
        ItemProgress: function () {
          return { setProgress: vi.fn(), setText: vi.fn() };
        },
      };
    }),
  });

  vi.stubGlobal("Services", {
    prompt: { alert: alertSpy },
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function triggerFetchAll(): Promise<void> {
  registerMenus(win);
  await doc.getElementById("citegeist-menu-fetch-collection")!.dispatch("command");
  await flushAsync();
}

async function openCollectionMenu(): Promise<void> {
  registerMenus(win);
  await doc.getElementById("zotero-collectionmenu")!.dispatch("popupshowing");
}

const fetchedItems = (): _ZoteroTypes.Item[] => mocks.fetchAndCacheItems.mock.calls[0][0];

/** Hidden state of the collection separator, Fetch All, and Resolve All, in that order. */
const entriesHidden = () =>
  [
    "citegeist-collection-menu-separator",
    "citegeist-menu-fetch-collection",
    "citegeist-menu-resolve-collection",
  ].map((id) => doc.getElementById(id)!.hidden);

// ─── Library row ─────────────────────────────────────────────────────────────

describe("library row focused", () => {
  it("fetches the library the row names", async () => {
    focusedRow = libraryRow(42);
    await triggerFetchAll();
    expect(Zotero.Items.getAll as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(42, false);
  });

  it("fetches a group library through its own libraryID", async () => {
    focusedRow = libraryRow(7, "group");
    await triggerFetchAll();
    expect(Zotero.Items.getAll as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(7, false);
  });

  it("opens the progress window in the menu's own window and calls fetchAndCacheItems", async () => {
    await triggerFetchAll();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(Zotero.ProgressWindow).toHaveBeenCalledWith(expect.objectContaining({ window: win }));
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
    expect(Zotero.Items.getAll as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
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
    expect(
      fetchedItems()
        .map((i) => i.id)
        .sort(),
    ).toEqual([10, 11, 12]);
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

// ─── Rows Citegeist does not act on ──────────────────────────────────────────

describe("rows Citegeist does not act on", () => {
  it.each(UNSUPPORTED_ROW_TYPES)(
    "a focused %s row hides the entries and a command starts no fetch",
    async (type) => {
      focusedRow = otherRow(type);
      await openCollectionMenu();
      expect(entriesHidden()).toEqual([true, true, true]);

      await doc.getElementById("citegeist-menu-fetch-collection")!.dispatch("command");
      await flushAsync();
      expect(mocks.fetchAndCacheItems).not.toHaveBeenCalled();
      expect(Zotero.Items.getAll as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
      expect(alertSpy).not.toHaveBeenCalled();
    },
  );

  it("hides the entries and fetches nothing when no row is focused", async () => {
    focusedRow = 0;
    await openCollectionMenu();
    expect(entriesHidden()).toEqual([true, true, true]);
    await doc.getElementById("citegeist-menu-fetch-collection")!.dispatch("command");
    await flushAsync();
    expect(mocks.fetchAndCacheItems).not.toHaveBeenCalled();
  });

  it("hides the entries when the pane has neither getCollectionTreeRows nor getCollectionTreeRow", async () => {
    getActiveZoteroPane.mockReturnValue({ getSelectedItems: () => [] });
    await openCollectionMenu();
    expect(entriesHidden()).toEqual([true, true, true]);
  });

  it("shows the entries again for a collection or library row", async () => {
    focusedRow = otherRow("trash");
    await openCollectionMenu();
    focusedRow = collectionRow(makeCollection([makeItem(1)]));
    await doc.getElementById("zotero-collectionmenu")!.dispatch("popupshowing");
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

    await openCollectionMenu();
    expect(entriesHidden()).toEqual([false, false, false]);

    await doc.getElementById("citegeist-menu-fetch-collection")!.dispatch("command");
    await flushAsync();
    expect(
      fetchedItems()
        .map((i) => i.id)
        .sort(),
    ).toEqual([1, 2, 3]);
    expect(getCollectionTreeRow).not.toHaveBeenCalled();
  });

  it("hides the entries and starts no fetch when a saved search is selected with a collection", async () => {
    getActiveZoteroPane.mockReturnValue({
      getSelectedItems: () => [],
      getCollectionTreeRows: () => [
        collectionRow(makeCollection([makeItem(1)])),
        otherRow("search"),
      ],
      getCollectionTreeRow: removedSingular(),
    });

    await openCollectionMenu();
    expect(entriesHidden()).toEqual([true, true, true]);

    await doc.getElementById("citegeist-menu-fetch-collection")!.dispatch("command");
    await flushAsync();
    expect(mocks.fetchAndCacheItems).not.toHaveBeenCalled();
    expect(Zotero.Items.getAll as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("hides the entries, starts no fetch, and records CG-UI02 when getCollectionTreeRows throws", async () => {
    // Fresh module graph: CG-UI02 is recorded once per session, and an earlier
    // test in this file has already recorded it on the shared instance.
    vi.resetModules();
    const { registerMenus: registerFresh } = await import("../src/modules/menu");
    const diagnostics = await import("../src/modules/diagnostics");
    diagnostics.clearDiagnostics();
    getActiveZoteroPane.mockReturnValue({
      getSelectedItems: () => [],
      getCollectionTreeRows: () => {
        throw new Error("collectionsView is gone");
      },
      getCollectionTreeRow: removedSingular(),
    });

    registerFresh(win);
    await doc.getElementById("zotero-collectionmenu")!.dispatch("popupshowing");
    expect(entriesHidden()).toEqual([true, true, true]);

    await doc.getElementById("citegeist-menu-fetch-collection")!.dispatch("command");
    await flushAsync();
    expect(mocks.fetchAndCacheItems).not.toHaveBeenCalled();
    expect(Zotero.Items.getAll as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    // Recorded once, and no CG-BUG01: nothing threw past the selection read.
    expect(diagnostics.recentDiagnostics().map((d) => d.code)).toEqual(["CG-UI02"]);
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

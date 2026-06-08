/**
 * Tests for the collection/library-root "Fetch All Citation Counts" handler.
 *
 * The existing menu.test.ts targets a future MenuManager API that isn't
 * implemented yet. This file tests the current DOM-based handler directly,
 * focusing on the library-root path (where getSelectedCollection() === null)
 * and the collection path.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMenus } from "../src/modules/menu";
import { FakeDocument, makeItem, makeCollection, flushAsync } from "./_helpers/menuHarness";

const mocks = vi.hoisted(() => ({
  fetchAndCacheItems: vi.fn(
    async (): Promise<{ fresh: number; cached: number; suggestion: number; errors: number }> => ({
      fresh: 2,
      cached: 0,
      suggestion: 0,
      errors: 0,
    }),
  ),
  extractIdentifier: vi.fn((item: { hasIdentifier?: boolean }) =>
    item.hasIdentifier !== false ? { type: "doi", value: "10.1/test" } : null,
  ),
  invalidateColumnCache: vi.fn(),
}));

vi.mock("../src/modules/citationService", () => ({
  fetchAndCacheItems: mocks.fetchAndCacheItems,
  extractIdentifier: mocks.extractIdentifier,
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
let selectedCollection: _ZoteroTypes.Collection | null;
let alertSpy: ReturnType<typeof vi.fn>;
let getSelectedLibraryID: ReturnType<typeof vi.fn>;
let getActiveZoteroPane: ReturnType<typeof vi.fn>;
let libraryItems: _ZoteroTypes.Item[];

const USER_LIBRARY_ID = 1;

beforeEach(() => {
  vi.clearAllMocks();

  doc = new FakeDocument();
  win = { document: doc } as unknown as Window;
  selectedCollection = null;
  alertSpy = vi.fn();
  getSelectedLibraryID = vi.fn(() => USER_LIBRARY_ID);
  libraryItems = [makeItem(1), makeItem(2)];

  getActiveZoteroPane = vi.fn(() => ({
    getSelectedItems: () => [],
    getSelectedCollection: () => selectedCollection,
    getSelectedLibraryID,
  }));

  vi.stubGlobal("Zotero", {
    debug: vi.fn(),
    getMainWindow: vi.fn(() => null),
    getActiveZoteroPane,
    Items: {
      getAll: vi.fn(async () => libraryItems),
    },
    Libraries: {
      userLibraryID: USER_LIBRARY_ID,
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
  const el = doc.getElementById("citegeist-menu-fetch-collection")!;
  await el.dispatch("command");
  await flushAsync();
}

// ─── Library root path ───────────────────────────────────────────────────────

describe("library root (getSelectedCollection returns null)", () => {
  it("calls Items.getAll with the libraryID from getSelectedLibraryID", async () => {
    getSelectedLibraryID.mockReturnValue(42);
    await triggerFetchAll();
    expect(Zotero.Items.getAll as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(42, false);
  });

  it("falls back to Libraries.userLibraryID when getSelectedLibraryID returns 0", async () => {
    getSelectedLibraryID.mockReturnValue(0);
    await triggerFetchAll();
    expect(Zotero.Items.getAll as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      USER_LIBRARY_ID,
      false,
    );
  });

  it("falls back to Libraries.userLibraryID when pane has no getSelectedLibraryID", async () => {
    getActiveZoteroPane.mockReturnValue({
      getSelectedItems: () => [],
      getSelectedCollection: () => null,
      // no getSelectedLibraryID
    });
    await triggerFetchAll();
    expect(Zotero.Items.getAll as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      USER_LIBRARY_ID,
      false,
    );
  });

  it("shows progress window and calls fetchAndCacheItems when eligible items exist", async () => {
    await triggerFetchAll();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mocks.fetchAndCacheItems).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 1 }),
        expect.objectContaining({ id: 2 }),
      ]),
      expect.any(Function),
    );
  });

  it("shows 'library is empty' alert when library has no items", async () => {
    libraryItems = [];
    await triggerFetchAll();
    expect(alertSpy).toHaveBeenCalledWith(
      win,
      "Citegeist: Nothing to fetch",
      expect.stringContaining("library is empty"),
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
    const calledWith: _ZoteroTypes.Item[] = mocks.fetchAndCacheItems.mock.calls[0][0];
    expect(calledWith).toHaveLength(1);
    expect(calledWith[0].id).toBe(1);
  });

  it("deduplicates items that somehow appear twice in Items.getAll results", async () => {
    const item1 = makeItem(1);
    libraryItems = [item1, item1]; // same object/id twice
    await triggerFetchAll();
    const calledWith: _ZoteroTypes.Item[] = mocks.fetchAndCacheItems.mock.calls[0][0];
    expect(calledWith).toHaveLength(1);
  });
});

// ─── Collection path ─────────────────────────────────────────────────────────

describe("collection selected (getSelectedCollection returns a collection)", () => {
  it("uses collection items, not Items.getAll", async () => {
    const item = makeItem(5);
    selectedCollection = makeCollection([item]);
    await triggerFetchAll();
    expect(Zotero.Items.getAll as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(mocks.fetchAndCacheItems).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 5 })]),
      expect.any(Function),
    );
  });

  it("shows 'collection is empty' alert for empty collection", async () => {
    selectedCollection = makeCollection([]);
    await triggerFetchAll();
    expect(alertSpy).toHaveBeenCalledWith(
      win,
      "Citegeist: Nothing to fetch",
      expect.stringContaining("collection is empty"),
    );
  });

  it("shows 'in this collection' (not 'library') in no-identifier alert", async () => {
    selectedCollection = makeCollection([makeItem(20, false)]);
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
    const child1 = makeItem(10);
    const child2 = makeItem(11);
    const grandchild = makeItem(12);
    const sub = makeCollection([child2, grandchild]);
    selectedCollection = makeCollection([child1], [sub]);
    await triggerFetchAll();
    const calledWith: _ZoteroTypes.Item[] = mocks.fetchAndCacheItems.mock.calls[0][0];
    expect(calledWith.map((i) => i.id).sort()).toEqual([10, 11, 12]);
  });

  it("deduplicates items that appear in multiple subcollections", async () => {
    const shared = makeItem(99);
    const sub1 = makeCollection([shared]);
    const sub2 = makeCollection([shared]);
    selectedCollection = makeCollection([shared], [sub1, sub2]);
    await triggerFetchAll();
    const calledWith: _ZoteroTypes.Item[] = mocks.fetchAndCacheItems.mock.calls[0][0];
    const ids = calledWith.map((i) => i.id);
    expect(ids.filter((id) => id === 99)).toHaveLength(1);
  });
});

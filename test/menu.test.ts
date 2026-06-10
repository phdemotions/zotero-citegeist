/**
 * Tests for the Zotero 8+ `Zotero.MenuManager` registration path and its
 * fallback to the DOM path (Zotero 7.0.x). The DOM handler behaviour itself is
 * covered by collection-menu.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMenus, unregisterMenus, setMenuPluginID } from "../src/modules/menu";
import { FakeDocument, makeItem, flushAsync } from "./_helpers/menuHarness";

const mocks = vi.hoisted(() => ({
  fetchAndCacheItems: vi.fn(async () => ({ fresh: 1, cached: 0, suggestion: 0, errors: 0 })),
  extractIdentifier: vi.fn((item: { hasIdentifier?: boolean }) =>
    item.hasIdentifier !== false ? { type: "doi", value: "10.1/test" } : null,
  ),
  canResolveWork: vi.fn((item: { hasIdentifier?: boolean }) => item.hasIdentifier !== false),
  invalidateColumnCache: vi.fn(),
  showCitationNetwork: vi.fn(async () => {}),
}));

vi.mock("../src/modules/citationService", () => ({
  fetchAndCacheItems: mocks.fetchAndCacheItems,
  extractIdentifier: mocks.extractIdentifier,
  canResolveWork: mocks.canResolveWork,
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
    onShowing?: (e: Event, ctx: unknown) => void;
    onCommand?: (e: Event, ctx: unknown) => void;
  }>;
}

let doc: FakeDocument;
let win: Window;
let selectedItems: _ZoteroTypes.Item[];
let registerReturns: Array<string | false>;
let registerMenu: ReturnType<typeof vi.fn>;
let unregisterMenu: ReturnType<typeof vi.fn>;
let captured: CapturedMenu[];

function installZotero(withMenuManager: boolean): void {
  captured = [];
  registerMenu = vi.fn((opts: CapturedMenu) => {
    captured.push(opts);
    return registerReturns.length ? registerReturns.shift()! : opts.menuID;
  });
  unregisterMenu = vi.fn(() => true);

  const zotero: Record<string, unknown> = {
    debug: vi.fn(),
    getMainWindow: vi.fn(() => win),
    getActiveZoteroPane: vi.fn(() => ({
      getSelectedItems: () => selectedItems,
      getSelectedCollection: () => null,
      getSelectedLibraryID: () => 1,
    })),
    Items: { getAll: vi.fn(async () => selectedItems) },
    Libraries: { userLibraryID: 1 },
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
  };
  if (withMenuManager) {
    zotero.MenuManager = { registerMenu, unregisterMenu };
  }
  vi.stubGlobal("Zotero", zotero);
  vi.stubGlobal("Services", { prompt: { alert: vi.fn() } });
}

beforeEach(() => {
  vi.clearAllMocks();
  doc = new FakeDocument();
  win = { document: doc } as unknown as Window;
  selectedItems = [makeItem(1)];
  registerReturns = [];
  setMenuPluginID(PLUGIN_ID);
});

const findMenu = (target: string) => captured.find((c) => c.target === target)!;

describe("MenuManager path (Zotero 8+)", () => {
  it("registers item + collection menus via MenuManager, not the DOM", () => {
    installZotero(true);
    registerMenus(win);

    expect(registerMenu).toHaveBeenCalledTimes(2);
    const item = findMenu("main/library/item");
    const collection = findMenu("main/library/collection");
    expect(item.pluginID).toBe(PLUGIN_ID);
    expect(collection.pluginID).toBe(PLUGIN_ID);
    // Labels come from the injected FTL.
    expect(item.menus.map((m) => m.l10nID)).toEqual([
      "citegeist-menu-fetch",
      "citegeist-menu-citing",
      "citegeist-menu-refs",
    ]);
    expect(collection.menus[0].l10nID).toBe("citegeist-menu-fetch-collection");
    // No DOM nodes were injected — the MenuManager path returned first.
    expect(doc.getElementById("citegeist-menu-fetch")).toBeNull();
  });

  it("decides item-menu visibility from context.items in onShowing", () => {
    installZotero(true);
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

    // Citing is single-item only
    const visCiting2 = vi.fn();
    citingShowing({} as Event, { items: [makeItem(1), makeItem(2)], setVisible: visCiting2 });
    expect(visCiting2).toHaveBeenCalledWith(false);

    const visCiting1 = vi.fn();
    citingShowing({} as Event, { items: [makeItem(1)], setVisible: visCiting1 });
    expect(visCiting1).toHaveBeenCalledWith(true);
  });

  it("runs the View Citing action from onCommand", () => {
    installZotero(true);
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
    registerMenus(win);
    const collection = findMenu("main/library/collection");
    selectedItems = [makeItem(1), makeItem(2)];
    collection.menus[0].onCommand!({} as Event, {});
    await flushAsync();
    expect(mocks.fetchAndCacheItems).toHaveBeenCalled();
  });

  it("rolls back the item menu and falls back to DOM when the collection registration is rejected", () => {
    installZotero(true);
    registerReturns = ["citegeist-item-menu", false]; // item ok, collection rejected
    registerMenus(win);

    // Item menu rolled back…
    expect(unregisterMenu).toHaveBeenCalledWith("citegeist-item-menu");
    // …and the DOM fallback ran instead.
    expect(doc.getElementById("citegeist-menu-fetch")).not.toBeNull();
    expect(doc.getElementById("citegeist-menu-fetch-collection")).not.toBeNull();
  });

  it("unregisters both MenuManager menus on teardown", () => {
    installZotero(true);
    registerMenus(win);
    unregisterMenus(win);
    const ids = unregisterMenu.mock.calls.map((c) => c[0]);
    expect(ids).toContain("citegeist-item-menu");
    expect(ids).toContain("citegeist-collection-menu");
  });
});

describe("DOM fallback (Zotero 7.0.x, no MenuManager)", () => {
  it("registers menus via the DOM when Zotero.MenuManager is absent", () => {
    installZotero(false);
    registerMenus(win);
    expect(doc.getElementById("citegeist-menu-fetch")).not.toBeNull();
    expect(doc.getElementById("citegeist-menu-citing")).not.toBeNull();
    expect(doc.getElementById("citegeist-menu-fetch-collection")).not.toBeNull();
  });
});

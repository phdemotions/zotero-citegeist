/**
 * Startup and shutdown with more than one main window open (File > New Window).
 *
 * Runs the real menu module against fake windows, so the assertions are what a
 * user would see: after startup each window has one set of Citegeist menu
 * entries, after shutdown no window has any and no Citegeist listener is left on
 * Zotero's popups, and a restart (disable then enable, or an upgrade) does not
 * leave a second set behind. hooks.test.ts covers the rest of the lifecycle with
 * the menu module mocked.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { PREF_AUTHOR_RELATIONS_PURGED } from "../src/constants";
import { makeFakePrefs } from "./_helpers/fakePrefs";
import { MODULE_LOAD_TIMEOUT_MS, fakeWindow, type FakeWindow } from "./_helpers/menuHarness";

vi.mock("../src/modules/cache", () => ({
  initCache: vi.fn(async () => {}),
  migrateFromExtraV1: vi.fn(async () => false),
  garbageCollectOrphans: vi.fn(async () => {}),
  purgeAllAuthorRelations: vi.fn(async () => ({ cleaned: 0, failures: 0 })),
  closeCache: vi.fn(async () => {}),
  cacheWriteRefusalCode: vi.fn(() => null),
}));
vi.mock("../src/modules/citationColumn", () => ({
  registerCitationColumn: vi.fn(async () => {}),
  unregisterCitationColumn: vi.fn(),
  invalidateColumnCache: vi.fn(),
}));
vi.mock("../src/modules/citationPane", () => ({
  registerCitationPane: vi.fn(),
  unregisterCitationPane: vi.fn(),
}));
vi.mock("../src/modules/openalex", () => ({ clearSourceStatsCache: vi.fn() }));
vi.mock("../src/modules/openalexAuthors", () => ({ clearAuthorProfileCache: vi.fn() }));
vi.mock("../src/modules/citationService", () => ({
  canResolveWork: vi.fn(() => true),
  fetchAndCacheItems: vi.fn(),
  resolveAuthorsForItems: vi.fn(),
}));
vi.mock("../src/modules/citationNetwork", () => ({ showCitationNetwork: vi.fn(async () => {}) }));

import type * as HooksModule from "../src/hooks";

type Hooks = typeof HooksModule;

const STARTUP = { id: "citegeist@opusvita.org", version: "3.0.0", rootURI: "root/", reason: 1 };

const ITEM_ENTRIES = [
  "citegeist-menu-separator",
  "citegeist-menu-fetch",
  "citegeist-menu-citing",
  "citegeist-menu-refs",
  "citegeist-menu-resolve-authors",
];
const COLLECTION_ENTRIES = [
  "citegeist-collection-menu-separator",
  "citegeist-menu-fetch-collection",
  "citegeist-menu-resolve-collection",
];

let windows: FakeWindow[];
let registerMenu: Mock;
let unregisterMenu: Mock;
/** The hooks module loaded in beforeEach, as a fresh bundle is on each plugin start. */
let hooks: Hooks;
let closeCache: Mock;

function stubZotero(withMenuManager: boolean): void {
  registerMenu = vi.fn((options: { menuID: string }) => options.menuID);
  unregisterMenu = vi.fn(() => true);
  vi.stubGlobal("Services", { prompt: { alert: vi.fn() } });
  vi.stubGlobal("Zotero", {
    debug: vi.fn(),
    Prefs: makeFakePrefs({ user: { [PREF_AUTHOR_RELATIONS_PURGED]: true } }),
    PreferencePanes: { register: vi.fn() },
    // The most recent window is the last one opened.
    getMainWindow: vi.fn(() => windows.at(-1) ?? null),
    getMainWindows: vi.fn(() => [...windows]),
    ...(withMenuManager ? { MenuManager: { registerMenu, unregisterMenu } } : {}),
  });
}

/** A fresh bundle, as a restart or an upgrade loads one. */
async function loadHooks(): Promise<Hooks> {
  vi.resetModules();
  const loaded = await import("../src/hooks");
  closeCache = vi.mocked((await import("../src/modules/cache")).closeCache);
  return loaded;
}

const popupIds = ["zotero-itemmenu", "zotero-collectionmenu"] as const;
const popup = (win: FakeWindow, id: (typeof popupIds)[number]) => win.document.getElementById(id)!;

function menuState(win: FakeWindow) {
  return {
    item: popup(win, "zotero-itemmenu").children.map((child) => child.id),
    collection: popup(win, "zotero-collectionmenu").children.map((child) => child.id),
    listeners: popupIds.map((id) => popup(win, id).listenerCount("popupshowing")),
  };
}

const ONE_SET = { item: ITEM_ENTRIES, collection: COLLECTION_ENTRIES, listeners: [1, 1] };
const NONE = { item: [], collection: [], listeners: [0, 0] };

beforeEach(async () => {
  vi.clearAllMocks();
  windows = [fakeWindow(), fakeWindow()];
  hooks = await loadHooks();
}, MODULE_LOAD_TIMEOUT_MS);

// Zotero 7 DOM fallback: delete with registerViaDOM (U9)
describe("two main windows on the DOM menu path", () => {
  beforeEach(() => stubZotero(false));

  it("startup gives each window one set of menus, not only the most recent", async () => {
    await hooks.onStartup(STARTUP);
    expect(windows.map(menuState)).toEqual([ONE_SET, ONE_SET]);
  });

  it("shutdown removes the entries and their popup listeners from every window", async () => {
    await hooks.onStartup(STARTUP);
    await hooks.onShutdown(STARTUP);
    expect(windows.map(menuState)).toEqual([NONE, NONE]);
  });

  it("a restart leaves one set in each window, not two", async () => {
    await hooks.onStartup(STARTUP);
    await hooks.onShutdown(STARTUP);

    const second = await loadHooks();
    await second.onStartup(STARTUP);

    expect(windows.map(menuState)).toEqual([ONE_SET, ONE_SET]);
  });

  it("a load event for a window startup already wired adds nothing", async () => {
    await hooks.onStartup(STARTUP);
    for (const win of windows) hooks.onMainWindowLoad(win);
    expect(windows.map(menuState)).toEqual([ONE_SET, ONE_SET]);
  });

  it("a window opened after startup gets its own set, and closing it leaves the others alone", async () => {
    await hooks.onStartup(STARTUP);

    const late = fakeWindow();
    windows.push(late);
    hooks.onMainWindowLoad(late);
    expect(menuState(late)).toEqual(ONE_SET);

    windows.pop();
    hooks.onMainWindowUnload(late);
    expect(menuState(late)).toEqual(NONE);
    expect(windows.map(menuState)).toEqual([ONE_SET, ONE_SET]);
  });

  it("a window whose teardown throws does not keep the other window's menus", async () => {
    await hooks.onStartup(STARTUP);
    const [closing, open] = windows;
    const itemMenu = popup(closing, "zotero-itemmenu");
    Object.defineProperty(closing, "document", {
      value: {
        getElementById: () => {
          throw new Error("window is closing");
        },
      },
    });

    await hooks.onShutdown(STARTUP);

    expect(menuState(open)).toEqual(NONE);
    // The closing window's controller was still aborted before its document threw.
    expect(itemMenu.listenerCount("popupshowing")).toBe(0);
    expect(Zotero.debug).toHaveBeenCalledWith(
      expect.stringContaining("[Citegeist] ERROR shutdown unregisterMenus"),
    );
  });

  it("a window whose menus fail to register at startup takes the earlier window's menus down with the cache", async () => {
    const [first, second] = windows;
    Object.defineProperty(second, "document", {
      value: {
        getElementById: () => {
          throw new Error("the popups are not built yet");
        },
        querySelector: () => null,
      },
    });

    await hooks.onStartup(STARTUP);

    expect(menuState(first)).toEqual(NONE);
    expect(closeCache).toHaveBeenCalledTimes(1);
    expect((Zotero as unknown as { Citegeist: { ready: boolean } }).Citegeist.ready).toBe(false);
  });
});

describe("two main windows on the MenuManager path", () => {
  beforeEach(() => stubZotero(true));

  it("startup registers the menus once for the process and adds no DOM entries", async () => {
    await hooks.onStartup(STARTUP);
    expect(registerMenu).toHaveBeenCalledTimes(2);
    expect(windows.map(menuState)).toEqual([NONE, NONE]);
  });

  it("shutdown unregisters them, and a restart registers them once more", async () => {
    await hooks.onStartup(STARTUP);
    await hooks.onShutdown(STARTUP);
    expect(unregisterMenu.mock.calls.map(([id]) => id)).toEqual([
      "citegeist-item-menu",
      "citegeist-collection-menu",
    ]);

    const second = await loadHooks();
    await second.onStartup(STARTUP);
    expect(registerMenu).toHaveBeenCalledTimes(4);
    expect(windows.map(menuState)).toEqual([NONE, NONE]);
  });
});

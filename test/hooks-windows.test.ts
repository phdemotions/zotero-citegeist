/**
 * Startup and shutdown with more than one main window open (File > New Window).
 *
 * Runs the real menu module against fake windows and a MenuManager that keeps
 * Zotero's registry rules, so the assertions are what a user would see: after
 * startup each window has one set of Citegeist menu entries, after shutdown no
 * window has any, holds Citegeist's localization link, or keeps a Citegeist
 * listener on Zotero's popups, and a restart (disable then enable, or an
 * upgrade) does not leave a second set behind. hooks.test.ts covers the rest of
 * the lifecycle with the menu module mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { PREF_AUTHOR_RELATIONS_PURGED } from "../src/constants";
import { makeFakePrefs } from "./_helpers/fakePrefs";
import {
  MENU_RENDERING_HOSTS,
  MODULE_LOAD_TIMEOUT_MS,
  cssEscape,
  deferred,
  fakeMenuManager,
  fakeWindow,
  menuKey,
  renderOtherPluginEntry,
  renderedEntryL10nIDs,
  takeMenuManagerWarnings,
  type FakeMenuManager,
  type FakeWindow,
} from "./_helpers/menuHarness";

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
const FTL = "citegeist.ftl";
const MENU_KEYS = [
  menuKey(STARTUP.id, "citegeist-item-menu"),
  menuKey(STARTUP.id, "citegeist-collection-menu"),
];

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
let mm: FakeMenuManager;
/** The hooks module loaded in beforeEach, as a fresh bundle is on each plugin start. */
let hooks: Hooks;
let initCache: Mock;
let closeCache: Mock;

function stubZotero(withMenuManager: boolean): void {
  mm = fakeMenuManager();
  // The plugin sandbox has Gecko's CSS.escape at every supported Zotero.
  vi.stubGlobal("CSS", { escape: cssEscape });
  vi.stubGlobal("Services", { prompt: { alert: vi.fn() } });
  vi.stubGlobal("Zotero", {
    debug: vi.fn(),
    Prefs: makeFakePrefs({ user: { [PREF_AUTHOR_RELATIONS_PURGED]: true } }),
    PreferencePanes: { register: vi.fn() },
    // The most recent window is the last one opened.
    getMainWindow: vi.fn(() => windows.at(-1) ?? null),
    getMainWindows: vi.fn(() => [...windows]),
    ...(withMenuManager ? { MenuManager: mm } : {}),
  });
}

/** A fresh bundle, as a restart or an upgrade loads one. */
async function loadHooks(): Promise<Hooks> {
  vi.resetModules();
  const loaded = await import("../src/hooks");
  const cache = await import("../src/modules/cache");
  initCache = vi.mocked(cache.initCache);
  closeCache = vi.mocked(cache.closeCache);
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

/** How many of Citegeist's localization links each window holds. */
const ftlLinks = () => windows.map((win) => win.document.localizationLinks(FTL).length);

const ONE_SET = { item: ITEM_ENTRIES, collection: COLLECTION_ENTRIES, listeners: [1, 1] };
const NONE = { item: [], collection: [], listeners: [0, 0] };

beforeEach(async () => {
  vi.clearAllMocks();
  windows = [fakeWindow(), fakeWindow()];
  hooks = await loadHooks();
}, MODULE_LOAD_TIMEOUT_MS);

// Zotero logs a warning for an unregister by a key it does not hold and for a
// duplicate registration, and Zotero 8 to 10 file those as errors.
afterEach(() => {
  expect(takeMenuManagerWarnings(), "Zotero's MenuManager logged a warning").toEqual([]);
});

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
    expect(late.document.localizationLinks(FTL)).toHaveLength(1);

    windows.pop();
    hooks.onMainWindowUnload(late);
    expect(menuState(late)).toEqual(NONE);
    expect(late.document.localizationLinks(FTL)).toEqual([]);
    expect(windows.map(menuState)).toEqual([ONE_SET, ONE_SET]);
    expect(ftlLinks()).toEqual([1, 1]);
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
    expect(open.document.localizationLinks(FTL)).toEqual([]);
    // The closing window's controller was still aborted before its document threw.
    expect(itemMenu.listenerCount("popupshowing")).toBe(0);
    expect(Zotero.debug).toHaveBeenCalledWith(
      expect.stringContaining("[Citegeist] ERROR shutdown unregisterMenus"),
    );
    expect(closeCache).toHaveBeenCalledTimes(1);
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
    expect(mm.registerMenu).toHaveBeenCalledTimes(2);
    expect([...mm.registered.keys()]).toEqual(MENU_KEYS);
    expect(windows.map(menuState)).toEqual([NONE, NONE]);
    expect(ftlLinks()).toEqual([1, 1]);
  });

  it("shutdown unregisters them by the keys Zotero returned, and a restart registers them once more", async () => {
    await hooks.onStartup(STARTUP);
    await hooks.onShutdown(STARTUP);
    expect(mm.unregisterMenu.mock.calls.map(([key]) => key)).toEqual(MENU_KEYS);
    expect(mm.registered.size).toBe(0);

    const second = await loadHooks();
    await second.onStartup(STARTUP);
    expect(mm.registerMenu).toHaveBeenCalledTimes(4);
    expect([...mm.registered.keys()]).toEqual(MENU_KEYS);
    expect(windows.map(menuState)).toEqual([NONE, NONE]);
    expect(ftlLinks()).toEqual([1, 1]);
  });
});

/**
 * BUG-DISABLE-L10N. On a disable, Zotero calls the bootstrap `shutdown`, which
 * does not wait for `onShutdown`, runs its plugin-shutdown observers, and then
 * unregisters Citegeist's translations (plugins.js `onDisabled`, @10.0.2
 * 916-917). A window still holding Citegeist's localization link, or a rendered
 * entry that uses Citegeist's translations, then fails every translation of the
 * item popup, so the right-click menu never builds. Both must be gone by the
 * time `onShutdown` reaches its first await.
 */
describe.each(MENU_RENDERING_HOSTS)("disabling Citegeist on $name", (host) => {
  beforeEach(() => stubZotero(true));

  /** Startup, then open both popups in every window, beside another plugin's link and entry. */
  async function startWithMenusOpened(): Promise<void> {
    await hooks.onStartup(STARTUP);
    for (const win of windows) {
      mm.render(win, host);
      renderOtherPluginEntry(win, "zotero-itemmenu");
      win.MozXULElement.insertFTLIfNeeded("other-plugin.ftl");
    }
    expect(ftlLinks()).toEqual([1, 1]);
    for (const win of windows) expect(renderedEntryL10nIDs(win)).toHaveLength(7);
  }

  it("takes the localization link and the rendered entries out of every window before its first await", async () => {
    await startWithMenusOpened();
    const close = deferred();
    closeCache.mockImplementationOnce(() => close.promise);

    // bootstrap.js drops this promise; what Zotero does next runs as soon as the call returns.
    const shutdown = hooks.onShutdown(STARTUP);

    expect(closeCache, "shutdown has reached its first await").toHaveBeenCalledTimes(1);
    expect(ftlLinks()).toEqual([0, 0]);
    for (const win of windows) {
      expect(renderedEntryL10nIDs(win)).toEqual(["other-plugin-menu-entry"]);
      expect(win.document.localizationLinks("other-plugin.ftl")).toHaveLength(1);
    }
    expect(mm.registered.size).toBe(0);

    // Zotero's shutdown observer finds nothing left, and warns about nothing.
    mm.shutdownPlugin(STARTUP.id, windows, host);
    close.resolve();
    await shutdown;
    expect(ftlLinks()).toEqual([0, 0]);
  });

  it("removes each of them before shutdown's first await resolves", async () => {
    await startWithMenusOpened();
    const events: string[] = [];
    for (const win of windows) {
      const citegeistEntries = win.document
        .querySelectorAll(".zotero-custom-menu-item")
        .filter((entry) => entry.getAttribute("data-l10n-id")?.startsWith("citegeist-"));
      for (const element of [...win.document.localizationLinks(FTL), ...citegeistEntries]) {
        const remove = element.remove.bind(element);
        element.remove = () => {
          events.push(`removed ${element.getAttribute("data-l10n-id") ?? "link"}`);
          remove();
        };
      }
    }
    closeCache.mockImplementationOnce(() =>
      Promise.resolve().then(() => {
        events.push("first await resolved");
      }),
    );

    await hooks.onShutdown(STARTUP);

    const firstAwait = events.indexOf("first await resolved");
    expect(firstAwait, "shutdown awaited the cache close").toBeGreaterThan(0);
    expect(events.slice(0, firstAwait).filter((e) => e === "removed link")).toHaveLength(2);
    expect(events.slice(0, firstAwait)).toHaveLength(2 * 7);
    expect(events.slice(firstAwait + 1), "removed after the first await").toEqual([]);
  });

  it("re-enabling brings back one link and one set of entries per window", async () => {
    await startWithMenusOpened();
    await hooks.onShutdown(STARTUP);
    mm.shutdownPlugin(STARTUP.id, windows, host);

    const second = await loadHooks();
    await second.onStartup(STARTUP);
    for (const win of windows) mm.render(win, host);

    expect(ftlLinks()).toEqual([1, 1]);
    for (const win of windows) {
      expect(renderedEntryL10nIDs(win)).toEqual([
        "citegeist-menu-fetch",
        "citegeist-menu-citing",
        "citegeist-menu-refs",
        "citegeist-menu-resolve-authors",
        "citegeist-menu-fetch-collection",
        "citegeist-menu-resolve-collection",
      ]);
    }
  });
});

/**
 * A disable that lands while startup waits on the cache: Zotero's shutdown
 * observer runs before startup resumes, so whatever startup registers after that
 * stays registered for a disabled plugin. A menu left that way made the next
 * copy's registration a refused duplicate, and the DOM fallback then added a
 * second set (ADV-B1).
 */
describe("a disable that lands while startup waits on the cache", () => {
  beforeEach(() => stubZotero(true));

  it("leaves nothing registered for the disabled plugin, and the next copy registers once", async () => {
    const init = deferred();
    initCache.mockImplementationOnce(() => init.promise);
    const startup = hooks.onStartup(STARTUP);

    await hooks.onShutdown(STARTUP);
    mm.shutdownPlugin(STARTUP.id, windows, MENU_RENDERING_HOSTS[1]);
    init.resolve();
    await startup;

    expect(mm.registerMenu).not.toHaveBeenCalled();
    expect(mm.registered.size).toBe(0);
    expect(windows.map(menuState)).toEqual([NONE, NONE]);
    expect(ftlLinks()).toEqual([0, 0]);
    expect(Zotero.PreferencePanes.register).not.toHaveBeenCalled();

    const second = await loadHooks();
    await second.onStartup(STARTUP);
    expect([...mm.registered.keys()]).toEqual(MENU_KEYS);
    expect(windows.map(menuState), "no DOM fallback set beside MenuManager's").toEqual([
      NONE,
      NONE,
    ]);
  });
});

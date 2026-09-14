import { beforeEach, describe, expect, it, vi } from "vitest";
import { PREF_AUTHOR_RELATIONS_PURGED, PREF_LAST_BACKUP_PATH } from "../src/constants";
import { ZOTERO_PREF_BRANCH, makeFakePrefs, type FakePrefs } from "./_helpers/fakePrefs";

const cacheMocks = vi.hoisted(() => ({
  initCache: vi.fn(async () => {}),
  migrateFromExtraV1: vi.fn(async () => false),
  garbageCollectOrphans: vi.fn(async () => {}),
  purgeAllAuthorRelations: vi.fn(async () => ({ cleaned: 0, failures: 0 })),
  closeCache: vi.fn(async () => {}),
  cacheWriteRefusalCode: vi.fn((): string | null => null),
}));

const columnMocks = vi.hoisted(() => ({
  registerCitationColumn: vi.fn(async () => {}),
  unregisterCitationColumn: vi.fn(),
  invalidateColumnCache: vi.fn(async (_ids?: number | number[]) => {}),
}));

const paneMocks = vi.hoisted(() => ({
  registerCitationPane: vi.fn(),
  unregisterCitationPane: vi.fn(),
}));

const menuMocks = vi.hoisted(() => ({
  registerMenus: vi.fn((_win: Window) => {}),
  unregisterMenus: vi.fn((_win: Window) => {}),
  unregisterGlobalMenus: vi.fn(),
  setMenuPluginID: vi.fn(),
  setMenuRootURI: vi.fn(),
}));

const openAlexMocks = vi.hoisted(() => ({
  clearSourceStatsCache: vi.fn(),
}));

const openAlexAuthorsMocks = vi.hoisted(() => ({
  clearAuthorProfileCache: vi.fn(),
}));

const BATCH = {
  fresh: 1,
  cached: 0,
  suggestion: 0,
  errors: 0,
  budgetStopped: 0,
  authStopped: 0,
  unwritableStopped: 0,
};
const BACKFILL = {
  resolved: 1,
  already: 0,
  unresolved: 0,
  budgetStopped: 0,
  authStopped: 0,
  unwritableStopped: 0,
  errors: 0,
  cancelled: false,
};

type FakeItem = { id: number; resolvable: boolean };

const serviceMocks = vi.hoisted(() => ({
  canResolveWork: vi.fn((item: { resolvable: boolean }) => item.resolvable),
  fetchAndCacheItems: vi.fn(
    async (
      _items: unknown[],
      _onProgress?: unknown,
      _onItemDone?: (itemId: number, status: string) => void,
    ): Promise<unknown> => undefined,
  ),
  resolveAuthorsForItems: vi.fn(async (_items: unknown[]): Promise<unknown> => undefined),
}));

vi.mock("../src/modules/cache", () => cacheMocks);
vi.mock("../src/modules/citationColumn", () => columnMocks);
vi.mock("../src/modules/citationPane", () => paneMocks);
vi.mock("../src/modules/menu", () => menuMocks);
vi.mock("../src/modules/openalex", () => openAlexMocks);
vi.mock("../src/modules/openalexAuthors", () => openAlexAuthorsMocks);
vi.mock("../src/modules/citationService", () => serviceMocks);

const STARTUP = { id: "citegeist@opusvita.org", version: "2.0.0", rootURI: "root/", reason: 1 };

describe("hooks", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("Services", {
      prompt: { alert: vi.fn() },
    });
    const mainWindow = {
      setTimeout: (fn: () => void) => fn(),
      document: {
        getElementById: vi.fn(() => null),
        createElement: vi.fn(() => ({
          id: "",
          rel: "",
          href: "",
        })),
        documentElement: { appendChild: vi.fn() },
      },
    };
    vi.stubGlobal("Zotero", {
      debug: vi.fn(),
      Prefs: makeFakePrefs(),
      PreferencePanes: { register: vi.fn() },
      getMainWindow: vi.fn(() => mainWindow),
      getMainWindows: vi.fn(() => [mainWindow]),
    });
  });

  it("shows one non-modal coded notice when the cache opened read-only, and no alert", async () => {
    cacheMocks.cacheWriteRefusalCode.mockReturnValueOnce("CG-DB03");
    const notice = {
      changeHeadline: vi.fn(),
      addDescription: vi.fn(),
      show: vi.fn(),
      startCloseTimer: vi.fn(),
    };
    const ProgressWindow = vi.fn(function () {
      return notice;
    });
    (Zotero as unknown as { ProgressWindow: unknown }).ProgressWindow = ProgressWindow;
    const { onStartup } = await import("../src/hooks");

    await onStartup(STARTUP);

    expect(ProgressWindow).toHaveBeenCalledTimes(1);
    expect(notice.changeHeadline).toHaveBeenCalledWith(expect.stringContaining("CG-DB03"));
    expect(notice.addDescription).toHaveBeenCalledWith(
      expect.stringContaining("written by a newer version of Citegeist"),
    );
    expect(notice.show).toHaveBeenCalledTimes(1);
    expect(Services.prompt.alert).not.toHaveBeenCalled();
    // Reads still work, so the cache-dependent UI still registers.
    expect(paneMocks.registerCitationPane).toHaveBeenCalled();
  });

  it("does not show a migration-complete alert on fresh installs with no candidates", async () => {
    const { onStartup } = await import("../src/hooks");

    await onStartup(STARTUP);

    expect(cacheMocks.migrateFromExtraV1).toHaveBeenCalled();
    expect(Services.prompt.alert).not.toHaveBeenCalled();
  });

  it("keeps cache-dependent UI disabled when cache startup fails", async () => {
    cacheMocks.initCache.mockRejectedValueOnce(new Error("locked"));
    const { onStartup, onMainWindowLoad } = await import("../src/hooks");

    await onStartup(STARTUP);
    onMainWindowLoad({ document: { getElementById: vi.fn() } } as unknown as Window);

    expect(Zotero.PreferencePanes.register).toHaveBeenCalled();
    expect(columnMocks.registerCitationColumn).not.toHaveBeenCalled();
    expect(paneMocks.registerCitationPane).not.toHaveBeenCalled();
    expect(menuMocks.registerMenus).not.toHaveBeenCalled();
    expect(Services.prompt.alert).toHaveBeenCalledWith(
      expect.anything(),
      "Citegeist: cache unavailable",
      expect.stringContaining("could not open its local cache database"),
    );
  });

  it("fails closed when Zotero rejects runtime UI registration", async () => {
    columnMocks.registerCitationColumn.mockRejectedValueOnce(new Error("column failed"));
    const { onStartup, onMainWindowLoad } = await import("../src/hooks");

    await onStartup(STARTUP);
    onMainWindowLoad({ document: { getElementById: vi.fn() } } as unknown as Window);

    expect(cacheMocks.closeCache).toHaveBeenCalled();
    expect(columnMocks.unregisterCitationColumn).toHaveBeenCalled();
    expect(paneMocks.registerCitationPane).not.toHaveBeenCalled();
    expect(menuMocks.registerMenus).not.toHaveBeenCalled();
    expect(Services.prompt.alert).toHaveBeenCalledWith(
      expect.anything(),
      "Citegeist: UI unavailable",
      expect.stringContaining("Zotero rejected one of the UI registrations"),
    );
  });

  it("closes the cache even when UI unregister throws", async () => {
    columnMocks.unregisterCitationColumn.mockImplementationOnce(() => {
      throw new Error("column unregister failed");
    });
    const { onShutdown } = await import("../src/hooks");

    await onShutdown(STARTUP);

    expect(cacheMocks.closeCache).toHaveBeenCalled();
  });

  it("wires the FTL and the menus in every main window open at startup, not only the most recent", async () => {
    const insertFTLIfNeeded = vi.fn();
    const windows = [1, 2].map(() => ({ MozXULElement: { insertFTLIfNeeded } }));
    vi.mocked(Zotero.getMainWindows).mockReturnValue(windows as unknown as Window[]);
    const { onStartup } = await import("../src/hooks");

    await onStartup(STARTUP);

    expect(menuMocks.registerMenus).toHaveBeenCalledTimes(2);
    expect(menuMocks.registerMenus.mock.calls[0][0]).toBe(windows[0]);
    expect(menuMocks.registerMenus.mock.calls[1][0]).toBe(windows[1]);
    expect(insertFTLIfNeeded).toHaveBeenCalledTimes(2);
  });

  it("unregisters the menus in every main window at shutdown, carrying on past one that throws", async () => {
    const windows = [{}, {}, {}] as unknown as Window[];
    vi.mocked(Zotero.getMainWindows).mockReturnValue(windows);
    menuMocks.unregisterMenus.mockImplementationOnce(() => {
      throw new Error("window is closing");
    });
    const { onShutdown } = await import("../src/hooks");

    await onShutdown(STARTUP);

    expect(menuMocks.unregisterMenus.mock.calls.map(([w]) => windows.indexOf(w))).toEqual([
      0, 1, 2,
    ]);
    expect(menuMocks.unregisterGlobalMenus).toHaveBeenCalledTimes(1);
    expect(cacheMocks.closeCache).toHaveBeenCalled();
  });

  it("still tears the menus down globally and closes the cache when the window list can't be read", async () => {
    vi.mocked(Zotero.getMainWindows).mockImplementation(() => {
      throw new Error("no window mediator");
    });
    const { onShutdown } = await import("../src/hooks");

    await onShutdown(STARTUP);

    expect(menuMocks.unregisterMenus).not.toHaveBeenCalled();
    expect(menuMocks.unregisterGlobalMenus).toHaveBeenCalledTimes(1);
    expect(cacheMocks.closeCache).toHaveBeenCalled();
  });
});

/**
 * `Zotero.Citegeist` is the real-Zotero suite's only handle on the plugin: its
 * `ready` flag gates every spec (scaffold's waitForPlugin) and its entry points
 * drive the fetch and resolve commands. A flag that lies or an entry point that
 * throws would make that suite pass or hang for the wrong reason.
 */
describe("Zotero.Citegeist bridge", () => {
  type Bridge = {
    ready: boolean;
    fetchItems(itemIDs: unknown): Promise<unknown>;
    resolveAuthors(itemIDs: unknown): Promise<unknown>;
    buildDiagnosticReport: unknown;
    clearDiagnostics: unknown;
  };
  const bridge = () => (Zotero as unknown as { Citegeist?: Bridge }).Citegeist;
  const fakeItem = (id: number): FakeItem => ({ id, resolvable: id !== 99 });

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    serviceMocks.fetchAndCacheItems.mockResolvedValue(BATCH);
    serviceMocks.resolveAuthorsForItems.mockResolvedValue(BACKFILL);
    vi.stubGlobal("Services", { prompt: { alert: vi.fn() } });
    vi.stubGlobal("Zotero", {
      debug: vi.fn(),
      Prefs: makeFakePrefs({ user: { [PREF_AUTHOR_RELATIONS_PURGED]: true } }),
      PreferencePanes: { register: vi.fn() },
      Items: { getAsync: vi.fn(async (ids: number[]) => ids.map(fakeItem)) },
      getMainWindow: vi.fn(() => null),
      getMainWindows: vi.fn(() => []),
    });
  });

  it("keeps the diagnostics API the settings pane calls", async () => {
    const { onStartup } = await import("../src/hooks");
    await onStartup(STARTUP);

    expect(typeof bridge()?.buildDiagnosticReport).toBe("function");
    expect(typeof bridge()?.clearDiagnostics).toBe("function");
  });

  it("reports ready only once startup has completed, and is removed on shutdown", async () => {
    let readyMidStartup: boolean | undefined;
    columnMocks.registerCitationColumn.mockImplementationOnce(async () => {
      readyMidStartup = bridge()?.ready;
    });
    const { onStartup, onShutdown } = await import("../src/hooks");

    await onStartup(STARTUP);
    expect(readyMidStartup).toBe(false);
    expect(bridge()?.ready).toBe(true);

    await onShutdown(STARTUP);
    expect(bridge()).toBeUndefined();
  });

  it("never reports ready when the cache fails to open", async () => {
    cacheMocks.initCache.mockRejectedValueOnce(new Error("locked"));
    const { onStartup } = await import("../src/hooks");

    await onStartup(STARTUP);

    expect(bridge()?.ready).toBe(false);
  });

  it("never reports ready when Zotero rejects a UI registration", async () => {
    columnMocks.registerCitationColumn.mockRejectedValueOnce(new Error("column failed"));
    const { onStartup } = await import("../src/hooks");

    await onStartup(STARTUP);

    expect(bridge()?.ready).toBe(false);
  });

  it("cannot be flipped or rewired by a caller", async () => {
    const { onStartup } = await import("../src/hooks");
    await onStartup(STARTUP);
    const b = bridge() as Bridge;

    expect(Object.isFrozen(b)).toBe(true);
    expect(() => {
      b.ready = false;
    }).toThrow(TypeError);
    expect(() => {
      b.fetchItems = async () => undefined;
    }).toThrow(TypeError);
    expect(b.ready).toBe(true);
  });

  it("fetchItems fetches the resolvable items and repaints their columns", async () => {
    const { onStartup } = await import("../src/hooks");
    await onStartup(STARTUP);

    const result = await bridge()?.fetchItems([11, 12, 99]);

    expect(Zotero.Items.getAsync).toHaveBeenCalledWith([11, 12, 99]);
    expect(serviceMocks.fetchAndCacheItems).toHaveBeenCalledWith(
      [fakeItem(11), fakeItem(12)],
      undefined,
      expect.any(Function),
    );
    expect(columnMocks.invalidateColumnCache).toHaveBeenCalledWith([11, 12]);
    expect(result).toEqual(BATCH);
  });

  it("fetchItems repaints a row as soon as its data lands, not for failures", async () => {
    const { onStartup } = await import("../src/hooks");
    await onStartup(STARTUP);
    await bridge()?.fetchItems([11]);
    const onItemDone = serviceMocks.fetchAndCacheItems.mock.calls[0][2];
    columnMocks.invalidateColumnCache.mockClear();

    onItemDone?.(11, "ok");
    onItemDone?.(12, "suggestion");
    onItemDone?.(13, "error");

    expect(columnMocks.invalidateColumnCache.mock.calls).toEqual([[11], [12]]);
  });

  it("fetchItems drops IDs that are not positive integers before asking Zotero", async () => {
    const { onStartup } = await import("../src/hooks");
    await onStartup(STARTUP);

    await bridge()?.fetchItems([11, 11, "12", -3, 0, 1.5, null]);
    expect(Zotero.Items.getAsync).toHaveBeenCalledWith([11]);

    vi.mocked(Zotero.Items.getAsync).mockClear();
    await bridge()?.fetchItems("11");
    expect(Zotero.Items.getAsync).not.toHaveBeenCalled();
    expect(serviceMocks.fetchAndCacheItems).toHaveBeenLastCalledWith(
      [],
      undefined,
      expect.any(Function),
    );
  });

  it("resolveAuthors runs the author backfill for the resolvable items", async () => {
    const { onStartup } = await import("../src/hooks");
    await onStartup(STARTUP);

    const result = await bridge()?.resolveAuthors([21, 99]);

    expect(serviceMocks.resolveAuthorsForItems).toHaveBeenCalledWith([fakeItem(21)]);
    expect(result).toEqual(BACKFILL);
  });

  it("does nothing before startup completes", async () => {
    let pending: Promise<unknown[]> | undefined;
    columnMocks.registerCitationColumn.mockImplementationOnce(async () => {
      pending = Promise.all([bridge()?.fetchItems([11]), bridge()?.resolveAuthors([11])]);
    });
    const { onStartup } = await import("../src/hooks");

    await onStartup(STARTUP);

    expect(await pending).toEqual([undefined, undefined]);
    expect(serviceMocks.fetchAndCacheItems).not.toHaveBeenCalled();
    expect(serviceMocks.resolveAuthorsForItems).not.toHaveBeenCalled();
  });

  it("contains a failing command: resolves undefined and logs instead of throwing", async () => {
    serviceMocks.fetchAndCacheItems.mockRejectedValueOnce(new Error("boom"));
    const { onStartup } = await import("../src/hooks");
    await onStartup(STARTUP);

    await expect(bridge()?.fetchItems([11])).resolves.toBeUndefined();
    expect(Zotero.debug).toHaveBeenCalledWith(
      expect.stringContaining("[Citegeist] ERROR bridge fetchItems"),
    );
  });
});

/**
 * U18: earlier builds stored Citegeist's one-shot flags under a doubled pref
 * name (`extensions.zotero.extensions.zotero.citegeist.*`). Startup must still
 * see them, or every existing profile repeats work that was meant to happen once.
 */
describe("startup with flags under the doubled pref name (U18)", () => {
  let prefs: FakePrefs;
  const doubled = (name: string) => ZOTERO_PREF_BRANCH + name;
  const ready = () => (Zotero as unknown as { Citegeist?: { ready: boolean } }).Citegeist?.ready;

  function stubZotero(fake: FakePrefs): void {
    prefs = fake;
    vi.stubGlobal("Zotero", {
      debug: vi.fn(),
      Prefs: fake,
      PreferencePanes: { register: vi.fn() },
      getMainWindow: vi.fn(() => ({ setTimeout: (fn: () => void) => fn() })),
      getMainWindows: vi.fn(() => []),
    });
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("Services", { prompt: { alert: vi.fn() } });
  });

  it("skips the relation purge when its flag exists only under the doubled name", async () => {
    stubZotero(makeFakePrefs({ user: { [doubled(PREF_AUTHOR_RELATIONS_PURGED)]: true } }));
    const { onStartup } = await import("../src/hooks");

    await onStartup(STARTUP);

    expect(cacheMocks.purgeAllAuthorRelations).not.toHaveBeenCalled();
    expect(prefs.user.get(PREF_AUTHOR_RELATIONS_PURGED), "copied to the real name").toBe(true);
  });

  it("runs the purge when the real name says it has not completed, whatever the doubled name says", async () => {
    stubZotero(
      makeFakePrefs({
        user: {
          [PREF_AUTHOR_RELATIONS_PURGED]: false,
          [doubled(PREF_AUTHOR_RELATIONS_PURGED)]: true,
        },
      }),
    );
    const { onStartup } = await import("../src/hooks");

    await onStartup(STARTUP);

    expect(cacheMocks.purgeAllAuthorRelations).toHaveBeenCalledTimes(1);
    expect(prefs.user.get(PREF_AUTHOR_RELATIONS_PURGED)).toBe(true);
  });

  it("finishes startup when the flag cannot be copied to its real name", async () => {
    stubZotero(makeFakePrefs({ user: { [doubled(PREF_AUTHOR_RELATIONS_PURGED)]: true } }));
    prefs.set.mockImplementation(() => {
      throw new Error("prefs.js is locked");
    });
    const { onStartup } = await import("../src/hooks");

    await expect(onStartup(STARTUP)).resolves.toBeUndefined();

    expect(
      cacheMocks.purgeAllAuthorRelations,
      "the doubled flag still answered",
    ).not.toHaveBeenCalled();
    expect(ready()).toBe(true);
    expect(Zotero.debug).toHaveBeenCalledWith(
      expect.stringContaining("[Citegeist] ERROR copy legacy pref forward"),
    );
  });

  it("names the backup a migration recorded under the doubled name", async () => {
    const legacyPath = "/tmp/zotero-test-data/citegeist-migration-backup-legacy.json";
    stubZotero(
      makeFakePrefs({
        user: {
          [PREF_AUTHOR_RELATIONS_PURGED]: true,
          [doubled(PREF_LAST_BACKUP_PATH)]: legacyPath,
        },
      }),
    );
    cacheMocks.migrateFromExtraV1.mockResolvedValueOnce(true);
    const { onStartup } = await import("../src/hooks");

    await onStartup(STARTUP);

    expect(Services.prompt.alert).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("one-time migration complete"),
      expect.stringContaining(legacyPath),
    );
  });

  it("names the backup recorded under the real name over an older doubled-name one", async () => {
    const legacyPath = "/tmp/zotero-test-data/citegeist-migration-backup-legacy.json";
    const currentPath = "/tmp/zotero-test-data/citegeist-migration-backup-current.json";
    stubZotero(
      makeFakePrefs({
        user: {
          [PREF_AUTHOR_RELATIONS_PURGED]: true,
          [PREF_LAST_BACKUP_PATH]: currentPath,
          [doubled(PREF_LAST_BACKUP_PATH)]: legacyPath,
        },
      }),
    );
    cacheMocks.migrateFromExtraV1.mockResolvedValueOnce(true);
    const { onStartup } = await import("../src/hooks");

    await onStartup(STARTUP);

    const body = vi.mocked(Services.prompt.alert).mock.calls[0]?.[2];
    expect(body).toContain(currentPath);
    expect(body).not.toContain(legacyPath);
  });
});

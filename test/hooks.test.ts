import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => ({
  initCache: vi.fn(async () => {}),
  migrateFromExtraV1: vi.fn(async () => false),
  garbageCollectOrphans: vi.fn(async () => {}),
  closeCache: vi.fn(async () => {}),
}));

const columnMocks = vi.hoisted(() => ({
  registerCitationColumn: vi.fn(async () => {}),
  unregisterCitationColumn: vi.fn(),
}));

const paneMocks = vi.hoisted(() => ({
  registerCitationPane: vi.fn(),
  unregisterCitationPane: vi.fn(),
}));

const menuMocks = vi.hoisted(() => ({
  registerMenus: vi.fn(),
  unregisterMenus: vi.fn(),
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

vi.mock("../src/modules/cache", () => cacheMocks);
vi.mock("../src/modules/citationColumn", () => columnMocks);
vi.mock("../src/modules/citationPane", () => paneMocks);
vi.mock("../src/modules/menu", () => menuMocks);
vi.mock("../src/modules/openalex", () => openAlexMocks);
vi.mock("../src/modules/openalexAuthors", () => openAlexAuthorsMocks);

describe("hooks", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("Services", {
      prompt: { alert: vi.fn() },
    });
    vi.stubGlobal("Zotero", {
      debug: vi.fn(),
      Prefs: {
        get: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
      },
      PreferencePanes: { register: vi.fn() },
      getMainWindow: vi.fn(() => ({
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
      })),
    });
  });

  it("does not show a migration-complete alert on fresh installs with no candidates", async () => {
    const { onStartup } = await import("../src/hooks");

    await onStartup({
      id: "citegeist@opusvita.org",
      version: "2.0.0",
      rootURI: "root/",
      reason: 1,
    });

    expect(cacheMocks.migrateFromExtraV1).toHaveBeenCalled();
    expect(Services.prompt.alert).not.toHaveBeenCalled();
  });

  it("keeps cache-dependent UI disabled when cache startup fails", async () => {
    cacheMocks.initCache.mockRejectedValueOnce(new Error("locked"));
    const { onStartup, onMainWindowLoad } = await import("../src/hooks");

    await onStartup({
      id: "citegeist@opusvita.org",
      version: "2.0.0",
      rootURI: "root/",
      reason: 1,
    });
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

    await onStartup({
      id: "citegeist@opusvita.org",
      version: "2.0.0",
      rootURI: "root/",
      reason: 1,
    });
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

    await onShutdown({
      id: "citegeist@opusvita.org",
      version: "2.0.0",
      rootURI: "root/",
      reason: 1,
    });

    expect(cacheMocks.closeCache).toHaveBeenCalled();
  });
});

import { vi } from "vitest";
import { makeFakeDb } from "./fakeDb";

export const items: Map<string, { extra: string }> = new Map();

export function mockItem(key: string, extra: string = ""): _ZoteroTypes.Item {
  items.set(key, { extra });
  return {
    id: parseInt(key, 36) || 1,
    key,
    libraryID: 1,
    isRegularItem: () => true,
    getField: vi.fn((field: string) => {
      if (field === "extra") return items.get(key)?.extra ?? "";
      return "";
    }),
    setField: vi.fn((field: string, value: string | number) => {
      if (field === "extra") items.set(key, { extra: String(value) });
    }),
    saveTx: vi.fn(async () => 1),
  } as unknown as _ZoteroTypes.Item;
}

export let fakeDb: ReturnType<typeof makeFakeDb>;

// Captured calls to Zotero.File.putContentsAsync — tests assert backup contents here.
export const fileWrites: Array<{ path: string; contents: string }> = [];

vi.stubGlobal("PathUtils", {
  join: (...parts: string[]) => parts.join("/"),
});

vi.stubGlobal("IOUtils", {
  getChildren: vi.fn(async () => [] as string[]),
  remove: vi.fn(async () => {}),
  move: vi.fn(async () => {}),
  exists: vi.fn(async () => false),
  makeDirectory: vi.fn(async () => {}),
  setPermissions: vi.fn(async () => {}),
});

export const mockZotero = {
  version: "7.0.10",
  debug: vi.fn(),
  DataDirectory: { dir: "/tmp/zotero-test-data" },
  File: {
    putContentsAsync: vi.fn(async (path: string, contents: string) => {
      fileWrites.push({ path, contents });
    }),
  },
  Prefs: {
    get: vi.fn().mockImplementation((pref: string) => {
      if (pref === "extensions.zotero.citegeist.cacheLifetimeDays") return 7;
      if (pref === "extensions.zotero.citegeist.migrationV1Complete") return false;
      return null;
    }),
    set: vi.fn(),
    clearUserPref: vi.fn(),
  },
  Libraries: {
    userLibraryID: 1,
    getAll: vi.fn(
      () => [{ libraryID: 1, libraryType: "user", editable: true }] as _ZoteroTypes.Library[],
    ),
  },
  Items: {
    getAll: vi.fn(async () => [] as _ZoteroTypes.Item[]),
  },
  Sync: {
    Runner: {
      delaySync: vi.fn(async (fn: () => Promise<unknown>) => await fn()),
    },
  },
  ProgressWindow: vi.fn(),
  DBConnection: vi.fn(),
};

vi.stubGlobal("Zotero", mockZotero);

export async function resetCacheHarness(
  initCache: () => Promise<void>,
  resetForTesting: () => void,
): Promise<void> {
  items.clear();
  fileWrites.length = 0;
  fakeDb = makeFakeDb();
  // Replace DBConnection with a constructor that returns the fake.
  // vi.fn() with new-call returns whatever its body returns.
  mockZotero.DBConnection = vi.fn(function (this: unknown) {
    return fakeDb;
  }) as unknown as typeof mockZotero.DBConnection;
  mockZotero.Prefs.get.mockImplementation((pref: string) => {
    if (pref === "extensions.zotero.citegeist.cacheLifetimeDays") return 7;
    if (pref === "extensions.zotero.citegeist.migrationV1Complete") return false;
    return null;
  });
  mockZotero.Items.getAll.mockResolvedValue([]);
  // Reset Libraries.getAll to the default single editable user library —
  // prior tests may have overridden via mockImplementation.
  mockZotero.Libraries.getAll.mockImplementation(
    () => [{ libraryID: 1, libraryType: "user", editable: true }] as _ZoteroTypes.Library[],
  );
  resetForTesting();
  await initCache();
}

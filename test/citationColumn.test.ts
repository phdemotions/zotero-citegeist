import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakePrefs } from "./_helpers/fakePrefs";

vi.mock("../src/modules/cache", () => ({
  cacheWriteRefusalCode: vi.fn(() => null),
  getCachedMetrics: vi.fn(),
  isNoMatchSuppressed: vi.fn(),
}));

vi.mock("../src/modules/citationService", () => ({
  canResolveWork: vi.fn(),
  fetchAndCacheItem: vi.fn(),
  fetchStopFor: vi.fn(() => null),
}));

vi.mock("../src/modules/openalex", () => ({
  getCachedSourceISSNs: vi.fn(() => []),
}));

vi.mock("../src/data/journalRankings", () => ({
  lookupRanking: vi.fn(),
  RANKING_VERSIONS: { abdc: "2022", ajg: "2021" },
}));

vi.mock("../src/modules/utils", () => ({
  isBookType: vi.fn(() => false),
  logError: vi.fn(),
}));

async function loadCitationColumn() {
  vi.resetModules();
  return await import("../src/modules/citationColumn");
}

describe("citation columns", () => {
  let registeredKeys: string[];
  let unregisterColumn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registeredKeys = [];
    unregisterColumn = vi.fn();
    // Stub CSS.escape as identity so namespacedColumnKey is predictable:
    // `${pluginID}-${dataKey}`. Rollback unregisters the namespaced key
    // (the form Zotero actually stores), not the bare dataKey.
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    vi.stubGlobal("Zotero", {
      debug: vi.fn(),
      Prefs: makeFakePrefs(),
      ItemTreeManager: {
        registerColumn: vi.fn(async (options: { dataKey: string }) => {
          registeredKeys.push(options.dataKey);
          if (registeredKeys.length === 3) throw new Error("column rejected");
        }),
        unregisterColumn,
      },
      getActiveZoteroPane: vi.fn(() => ({
        itemsView: { refreshAndMaintainSelection: vi.fn() },
      })),
    });
  });

  it("rolls back columns already registered before a later registration failure", async () => {
    const { registerCitationColumn } = await loadCitationColumn();

    await expect(registerCitationColumn("citegeist@opusvita.org")).rejects.toThrow(
      "column rejected",
    );

    expect(unregisterColumn).toHaveBeenCalledWith(
      "citegeist@opusvita.org-citegeist-citation-count",
    );
    expect(unregisterColumn).toHaveBeenCalledWith("citegeist@opusvita.org-citegeist-fwci");
    expect(unregisterColumn).toHaveBeenCalledWith("citegeist@opusvita.org-citegeist-percentile");
  });
});

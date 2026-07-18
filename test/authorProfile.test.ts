/**
 * Tests for the pure author-profile data + view-model layer (U7). Covers metric
 * formatting (the ≥ lower-bound labels), the header + row view-models, the
 * error→state mapping, and the fetch→state orchestration (against mocked
 * openalexAuthors). No DOM — the pane/dialog rendering is verified in Zotero.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const oaMocks = vi.hoisted(() => ({
  fetchAuthorProfile: vi.fn(),
  fetchAuthorWorks: vi.fn(),
}));
vi.mock("../src/modules/openalexAuthors", () => oaMocks);

const cacheMocks = vi.hoisted(() => ({
  updateAuthorMetrics: vi.fn(async () => {}),
  reconcileAuthorMerge: vi.fn(async () => {}),
}));
vi.mock("../src/modules/cache/authors", () => cacheMocks);

vi.stubGlobal("Zotero", { debug: vi.fn() });

import { OpenAlexBudgetError, OpenAlexAuthError } from "../src/modules/utils";
import {
  formatMetric,
  buildProfileViewModel,
  buildAuthorRowViewModels,
  compactTrend,
  getAuthorCreators,
  profileErrorState,
  maybeReconcileMerge,
} from "../src/modules/authorProfile";

type AnyProfile = Parameters<typeof buildProfileViewModel>[0];

function profile(over: Partial<AnyProfile> = {}): AnyProfile {
  return {
    id: "A1",
    displayName: "Jane Q. Researcher",
    orcid: null,
    worksCount: 42,
    citedByCount: 900,
    hIndex: 20,
    i10Index: 15,
    metricsAreLowerBound: false,
    metricsSource: "aggregates",
    redirectedFrom: null,
    ...over,
  } as AnyProfile;
}

beforeEach(() => {
  oaMocks.fetchAuthorProfile.mockReset();
  oaMocks.fetchAuthorWorks.mockReset();
  cacheMocks.updateAuthorMetrics.mockClear();
  cacheMocks.reconcileAuthorMerge.mockClear();
});

describe("formatMetric", () => {
  it("renders null as an em dash", () => {
    expect(formatMetric(null, false)).toBe("—");
    expect(formatMetric(undefined, false)).toBe("—");
  });
  it("formats with thousands separators", () => {
    expect(formatMetric(214853, false)).toBe("214,853");
  });
  it("prefixes a lower-bound value with ≥", () => {
    expect(formatMetric(164, true)).toBe("≥ 164");
  });
});

describe("buildProfileViewModel", () => {
  it("strips the ORCID prefix and builds the id URLs", () => {
    const vm = buildProfileViewModel(
      profile({ id: "A5", orcid: "https://orcid.org/0000-0002-1825-0097" }),
    );
    expect(vm.orcid).toBe("0000-0002-1825-0097");
    expect(vm.orcidUrl).toBe("https://orcid.org/0000-0002-1825-0097");
    expect(vm.openAlexUrl).toBe("https://openalex.org/A5");
  });

  it("applies ≥ to h-index / i10 and em-dashes a null cited count when lower-bound", () => {
    const vm = buildProfileViewModel(
      profile({ metricsAreLowerBound: true, citedByCount: null, hIndex: 40, i10Index: 12 }),
    );
    expect(vm.hIndex).toBe("≥ 40");
    expect(vm.i10Index).toBe("≥ 12");
    expect(vm.worksCount).toBe("42"); // works is always exact
    expect(vm.citedByCount).toBe("—");
    expect(vm.lowerBound).toBe(true);
  });

  it("falls back to a placeholder name", () => {
    expect(buildProfileViewModel(profile({ displayName: null })).name).toBe("Unknown author");
  });
});

describe("buildAuthorRowViewModels", () => {
  const byId = new Map<string, never>([
    ["A1", { author_id: "A1", display_name: "Jane", h_index: 20 } as never],
    ["A2", null as never],
  ]);

  it("matches creators to resolved authors by position, keeping no-match rows (authorId null)", () => {
    const creators = [
      { name: "Doe, Jane", position: 0 },
      { name: "Roe, R.", position: 1 },
      { name: "Poe, P.", position: 2 },
    ];
    const itemAuthors = [
      { library_id: 1, item_key: "K", author_id: "A1", author_position: 0, is_curated: 1 as const },
      { library_id: 1, item_key: "K", author_id: "A2", author_position: 1, is_curated: 0 as const },
    ];
    expect(buildAuthorRowViewModels(creators, itemAuthors, byId)).toEqual([
      { position: 0, name: "Jane", authorId: "A1", hIndexLabel: "h 20" },
      { position: 1, name: "Roe, R.", authorId: "A2", hIndexLabel: null },
      { position: 2, name: "Poe, P.", authorId: null, hIndexLabel: null },
    ]);
  });

  it("still shows a resolved author with no matching creator slot", () => {
    const itemAuthors = [
      { library_id: 1, item_key: "K", author_id: "A1", author_position: 3, is_curated: 0 as const },
    ];
    expect(buildAuthorRowViewModels([], itemAuthors, byId)).toEqual([
      { position: 3, name: "Jane", authorId: "A1", hIndexLabel: "h 20" },
    ]);
  });
});

describe("profileErrorState", () => {
  it("maps error types to states", () => {
    expect(profileErrorState(new OpenAlexBudgetError("x")).kind).toBe("budget");
    expect(profileErrorState(new OpenAlexAuthError("x")).kind).toBe("auth");
    expect(profileErrorState(new Error("x")).kind).toBe("network");
  });
});

describe("maybeReconcileMerge", () => {
  it("reconciles to the survivor on a 301 redirect, and no-ops otherwise", () => {
    maybeReconcileMerge(profile({ redirectedFrom: null }));
    expect(cacheMocks.reconcileAuthorMerge).not.toHaveBeenCalled();

    maybeReconcileMerge(profile({ id: "A2", redirectedFrom: "A1" }));
    expect(cacheMocks.reconcileAuthorMerge).toHaveBeenCalledWith("A1", "A2");
  });
});

describe("compactTrend", () => {
  // counts_by_year is the only field compactTrend reads.
  const trendWork = (cby: Array<{ year: number; cited_by_count: number }>) =>
    ({ counts_by_year: cby }) as unknown as Parameters<typeof compactTrend>[0];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T00:00:00Z")); // most-recent-complete year = 2024
  });
  afterEach(() => vi.useRealTimers());

  it("returns null when there is no year data or fewer than two years", () => {
    expect(compactTrend(undefined)).toBeNull();
    expect(compactTrend(trendWork([]))).toBeNull();
    expect(compactTrend(trendWork([{ year: 2024, cited_by_count: 10 }]))).toBeNull();
  });

  it("reports growth, decline, and flat against the prior year", () => {
    expect(
      compactTrend(
        trendWork([
          { year: 2024, cited_by_count: 118 },
          { year: 2023, cited_by_count: 100 },
        ]),
      ),
    ).toBe("↗ +18% 2024");
    expect(
      compactTrend(
        trendWork([
          { year: 2024, cited_by_count: 80 },
          { year: 2023, cited_by_count: 100 },
        ]),
      ),
    ).toBe("↘ -20% 2024");
    expect(
      compactTrend(
        trendWork([
          { year: 2024, cited_by_count: 100 },
          { year: 2023, cited_by_count: 100 },
        ]),
      ),
    ).toBe("→ flat 2024");
  });

  it("does NOT divide by zero when the prior year has zero citations (regression: no 'Infinity%')", () => {
    const out = compactTrend(
      trendWork([
        { year: 2024, cited_by_count: 5 },
        { year: 2023, cited_by_count: 0 },
      ]),
    );
    expect(out).toBe("5 in 2024");
    expect(out).not.toMatch(/Infinity|NaN/);
  });

  it("falls back to a bare count when the immediately-prior year is absent", () => {
    expect(
      compactTrend(
        trendWork([
          { year: 2024, cited_by_count: 5 },
          { year: 2022, cited_by_count: 3 },
        ]),
      ),
    ).toBe("5 in 2024");
  });

  it("returns null when the most recent year and its prior are both zero", () => {
    expect(
      compactTrend(
        trendWork([
          { year: 2024, cited_by_count: 0 },
          { year: 2023, cited_by_count: 0 },
        ]),
      ),
    ).toBeNull();
  });

  it("uses the newest available year when last-complete-year data is missing", () => {
    // 2024 absent -> recent = sorted[0] = 2023, prior = 2022.
    expect(
      compactTrend(
        trendWork([
          { year: 2023, cited_by_count: 50 },
          { year: 2022, cited_by_count: 40 },
        ]),
      ),
    ).toBe("↗ +25% 2023");
  });
});

describe("getAuthorCreators", () => {
  type Creator = { creatorTypeID?: number; lastName?: string; firstName?: string; name?: string };
  const mkItem = (creators: Creator[]) =>
    ({ getCreators: () => creators }) as unknown as _ZoteroTypes.Item;
  const AUTHOR = 1;
  const EDITOR = 2;

  beforeEach(() => {
    vi.stubGlobal("Zotero", {
      debug: vi.fn(),
      CreatorTypes: { getID: (n: string) => (n === "author" ? AUTHOR : EDITOR) },
    });
  });

  it("indexes positions among AUTHORS only — an interleaved editor does not shift later authors", () => {
    const out = getAuthorCreators(
      mkItem([
        { creatorTypeID: AUTHOR, lastName: "Smith", firstName: "J" },
        { creatorTypeID: EDITOR, lastName: "Doe", firstName: "A" },
        { creatorTypeID: AUTHOR, lastName: "Lee", firstName: "K" },
      ]),
    );
    expect(out).toEqual([
      { name: "Smith, J", position: 0 },
      { name: "Lee, K", position: 1 }, // position 1, NOT 2 — the editor was skipped without advancing
    ]);
  });

  it("treats every creator as an author when CreatorTypes.getID throws (best-effort fallback)", () => {
    vi.stubGlobal("Zotero", {
      debug: vi.fn(),
      CreatorTypes: {
        getID: () => {
          throw new Error("no CreatorTypes");
        },
      },
    });
    const out = getAuthorCreators(
      mkItem([
        { creatorTypeID: AUTHOR, lastName: "Smith", firstName: "J" },
        { creatorTypeID: EDITOR, lastName: "Doe", firstName: "A" },
      ]),
    );
    expect(out.map((c) => c.position)).toEqual([0, 1]);
    expect(out.map((c) => c.name)).toEqual(["Smith, J", "Doe, A"]);
  });

  it("falls back to 'Author N' when a creator has no usable name", () => {
    const out = getAuthorCreators(mkItem([{ creatorTypeID: AUTHOR }]));
    expect(out).toEqual([{ name: "Author 1", position: 0 }]);
  });

  it("uses a single-field name when only the institutional/last name is present", () => {
    const out = getAuthorCreators(
      mkItem([{ creatorTypeID: AUTHOR, name: "World Health Organization" }]),
    );
    expect(out).toEqual([{ name: "World Health Organization", position: 0 }]);
  });
});

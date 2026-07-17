/**
 * Tests for the pure author-profile data + view-model layer (U7). Covers metric
 * formatting (the ≥ lower-bound labels), the header + row view-models, the
 * error→state mapping, and the fetch→state orchestration (against mocked
 * openalexAuthors). No DOM — the pane/dialog rendering is verified in Zotero.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const oaMocks = vi.hoisted(() => ({
  fetchAuthorProfile: vi.fn(),
  fetchAuthorWorks: vi.fn(),
}));
vi.mock("../src/modules/openalexAuthors", () => oaMocks);

const cacheMocks = vi.hoisted(() => ({
  updateAuthorMetrics: vi.fn(async () => {}),
}));
vi.mock("../src/modules/cache/authors", () => cacheMocks);

vi.stubGlobal("Zotero", { debug: vi.fn() });

import { OpenAlexBudgetError, OpenAlexAuthError } from "../src/modules/utils";
import {
  formatMetric,
  buildProfileViewModel,
  buildAuthorRowViewModels,
  profileErrorState,
  loadAuthorProfile,
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

function work(citedBy: number, i: number) {
  return { id: `https://openalex.org/W${i}`, cited_by_count: citedBy } as never;
}

beforeEach(() => {
  oaMocks.fetchAuthorProfile.mockReset();
  oaMocks.fetchAuthorWorks.mockReset();
  cacheMocks.updateAuthorMetrics.mockClear();
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
  it("maps names + h-index hints, falling back to the id when uncached", () => {
    const itemAuthors = [
      { library_id: 1, item_key: "K", author_id: "A1", author_position: 0, is_curated: 1 as const },
      { library_id: 1, item_key: "K", author_id: "A2", author_position: 1, is_curated: 0 as const },
    ];
    const byId = new Map<string, never>([
      ["A1", { author_id: "A1", display_name: "Jane", h_index: 20 } as never],
      ["A2", null as never],
    ]);
    const rows = buildAuthorRowViewModels(itemAuthors, byId);
    expect(rows[0]).toEqual({
      authorId: "A1",
      name: "Jane",
      hIndexLabel: "h 20",
      isCurated: true,
    });
    expect(rows[1]).toEqual({
      authorId: "A2",
      name: "A2", // falls back to the id
      hIndexLabel: null,
      isCurated: false,
    });
  });
});

describe("profileErrorState", () => {
  it("maps error types to states", () => {
    expect(profileErrorState(new OpenAlexBudgetError("x")).kind).toBe("budget");
    expect(profileErrorState(new OpenAlexAuthError("x")).kind).toBe("auth");
    expect(profileErrorState(new Error("x")).kind).toBe("network");
  });
});

describe("loadAuthorProfile", () => {
  it("returns a ready state with works + cursor and persists exact metrics", async () => {
    oaMocks.fetchAuthorProfile.mockResolvedValue(profile());
    oaMocks.fetchAuthorWorks.mockResolvedValue({
      meta: { count: 2, per_page: 100, next_cursor: "c2" },
      results: [work(30, 0), work(10, 1)],
    });
    const state = await loadAuthorProfile("A1");
    expect(state.kind).toBe("ready");
    if (state.kind === "ready") {
      expect(state.works).toHaveLength(2);
      expect(state.nextCursor).toBe("c2");
    }
    expect(cacheMocks.updateAuthorMetrics).toHaveBeenCalledWith(
      "A1",
      expect.objectContaining({ hIndex: 20, i10Index: 15, worksCount: 42 }),
    );
  });

  it("returns empty when the author has no works", async () => {
    oaMocks.fetchAuthorProfile.mockResolvedValue(profile());
    oaMocks.fetchAuthorWorks.mockResolvedValue({
      meta: { count: 0, per_page: 100, next_cursor: null },
      results: [],
    });
    expect((await loadAuthorProfile("A1")).kind).toBe("empty");
  });

  it("returns not-found without fetching works when the profile is null", async () => {
    oaMocks.fetchAuthorProfile.mockResolvedValue(null);
    expect((await loadAuthorProfile("A1")).kind).toBe("not-found");
    expect(oaMocks.fetchAuthorWorks).not.toHaveBeenCalled();
  });

  it("maps a budget error to the budget state", async () => {
    oaMocks.fetchAuthorProfile.mockRejectedValue(new OpenAlexBudgetError("spent"));
    expect((await loadAuthorProfile("A1")).kind).toBe("budget");
  });

  it("does not persist lower-bound (derived, capped) metrics", async () => {
    oaMocks.fetchAuthorProfile.mockResolvedValue(profile({ metricsAreLowerBound: true }));
    oaMocks.fetchAuthorWorks.mockResolvedValue({
      meta: { count: 1, per_page: 100, next_cursor: null },
      results: [work(5, 0)],
    });
    await loadAuthorProfile("A1");
    expect(cacheMocks.updateAuthorMetrics).not.toHaveBeenCalled();
  });
});

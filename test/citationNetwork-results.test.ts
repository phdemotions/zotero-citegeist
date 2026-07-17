import { describe, expect, it } from "vitest";
import {
  compareNetworkWorks,
  emptyStateHTML,
  getVisibleNetworkWorks,
  isWorkInLibrary,
  type NetworkSortContext,
} from "../src/modules/citationNetwork/results";
import type { NetworkSortKey } from "../src/modules/citationNetwork/types";
import type { OpenAlexWork } from "../src/modules/openalex";

function author(display_name: string) {
  return { author: { id: "", display_name }, institutions: [] };
}

function work(p: Partial<OpenAlexWork> & { id: string }): OpenAlexWork {
  return {
    id: p.id,
    doi: p.doi ?? null,
    display_name: p.display_name ?? "",
    title: p.title ?? p.display_name ?? "",
    publication_year: p.publication_year ?? null,
    cited_by_count: p.cited_by_count ?? 0,
    fwci: p.fwci ?? null,
    citation_normalized_percentile: p.citation_normalized_percentile ?? null,
    authorships: p.authorships ?? [],
    ...p,
  } as OpenAlexWork;
}

function titlesFor(
  sortBy: NetworkSortKey,
  works: OpenAlexWork[],
  existingDOIs = new Set<string>(),
  addedThisSession = new Set<string>(),
  existingWorkIds = new Set<string>(),
): string[] {
  return getVisibleNetworkWorks(works, "", {
    sortBy,
    hideInLibrary: false,
    existingDOIs,
    existingWorkIds,
    addedThisSession,
  }).map((w) => w.display_name);
}

describe("citation network sorting", () => {
  it("sorts by citation count (default) descending", () => {
    const works = [
      work({ id: "W1", display_name: "low", cited_by_count: 5 }),
      work({ id: "W2", display_name: "high", cited_by_count: 500 }),
      work({ id: "W3", display_name: "mid", cited_by_count: 50 }),
    ];
    expect(titlesFor("citations", works)).toEqual(["high", "mid", "low"]);
  });

  it("sorts by FWCI desc, nulls last", () => {
    const works = [
      work({ id: "W1", display_name: "none", fwci: null }),
      work({ id: "W2", display_name: "big", fwci: 3.2 }),
      work({ id: "W3", display_name: "small", fwci: 0.4 }),
    ];
    expect(titlesFor("fwci-desc", works)).toEqual(["big", "small", "none"]);
  });

  it("sorts by percentile desc, nulls last", () => {
    const works = [
      work({ id: "W1", display_name: "p10", citation_normalized_percentile: { value: 0.1 } }),
      work({ id: "W2", display_name: "none", citation_normalized_percentile: null }),
      work({ id: "W3", display_name: "p99", citation_normalized_percentile: { value: 0.99 } }),
    ];
    expect(titlesFor("percentile-desc", works)).toEqual(["p99", "p10", "none"]);
  });

  it("keeps unknown publication dates last for BOTH year directions", () => {
    const works = [
      work({ id: "W1", display_name: "unknown", publication_year: null }),
      work({ id: "W2", display_name: "older", publication_year: 2010 }),
      work({ id: "W3", display_name: "newer", publication_year: 2020 }),
    ];
    expect(titlesFor("year-asc", works)).toEqual(["older", "newer", "unknown"]);
    expect(titlesFor("year-desc", works)).toEqual(["newer", "older", "unknown"]);
  });

  it("sorts by first-author surname, folding multi-word prefixes, no-author last", () => {
    const works = [
      work({
        id: "W1",
        display_name: "Later Smith",
        publication_year: 2022,
        authorships: [author("Alice Smith")],
      }),
      work({
        id: "W2",
        display_name: "Earlier Smith",
        publication_year: 2020,
        authorships: [author("Bob Smith")],
      }),
      work({
        id: "W3",
        display_name: "Cruz Paper",
        publication_year: 2019,
        authorships: [author("Maria de la Cruz")],
      }),
      work({
        id: "W4",
        display_name: "Berg Paper",
        publication_year: 2021,
        authorships: [author("Jan van der Berg")],
      }),
      work({ id: "W5", display_name: "No Author", publication_year: 2018, authorships: [] }),
    ];
    // de la Cruz < Smith(Bob 2020) < Smith(Alice 2022) < van der Berg < (no author)
    expect(titlesFor("author-asc", works)).toEqual([
      "Cruz Paper",
      "Earlier Smith",
      "Later Smith",
      "Berg Paper",
      "No Author",
    ]);
  });

  it("floats works not in the library first, then by citation count", () => {
    const works = [
      work({
        id: "W1",
        display_name: "Already",
        doi: "https://doi.org/10.1/in",
        cited_by_count: 100,
      }),
      work({ id: "W2", display_name: "Missing higher", cited_by_count: 50 }),
      work({ id: "W3", display_name: "Missing lower", cited_by_count: 5 }),
      work({ id: "W4", display_name: "Added", cited_by_count: 200 }),
    ];
    const order = titlesFor("not-in-library", works, new Set(["10.1/in"]), new Set(["W4"]));
    expect(order).toEqual(["Missing higher", "Missing lower", "Added", "Already"]);
  });
});

describe("getVisibleNetworkWorks filtering", () => {
  const ctx = (over: Partial<NetworkSortContext & { hideInLibrary: boolean }> = {}) => ({
    sortBy: "citations" as NetworkSortKey,
    hideInLibrary: false,
    existingDOIs: new Set<string>(),
    existingWorkIds: new Set<string>(),
    addedThisSession: new Set<string>(),
    ...over,
  });

  it("matches the free-text filter against title and author names", () => {
    const works = [
      work({
        id: "W1",
        display_name: "Brand love and loyalty",
        authorships: [author("Ada Smith")],
      }),
      work({ id: "W2", display_name: "Unrelated topic", authorships: [author("Bo Jones")] }),
      work({ id: "W3", display_name: "Something else", authorships: [author("Brandon Cole")] }),
    ];
    // "brand" matches W1 title and W3 author "Brandon"
    expect(
      getVisibleNetworkWorks(works, "brand", ctx())
        .map((w) => w.id)
        .sort(),
    ).toEqual(["W1", "W3"]);
  });

  it("hides works already in the library when hideInLibrary is on", () => {
    const works = [
      work({ id: "W1", display_name: "in via doi", doi: "https://doi.org/10.1/in" }),
      work({ id: "W2", display_name: "Missing" }),
      work({ id: "W3", display_name: "in via session" }),
    ];
    const visible = getVisibleNetworkWorks(
      works,
      "",
      ctx({
        hideInLibrary: true,
        existingDOIs: new Set(["10.1/in"]),
        addedThisSession: new Set(["W3"]),
      }),
    );
    expect(visible.map((w) => w.display_name)).toEqual(["Missing"]);
  });

  it("does not mutate the input array", () => {
    const works = [work({ id: "W1", cited_by_count: 1 }), work({ id: "W2", cited_by_count: 9 })];
    const before = works.map((w) => w.id);
    getVisibleNetworkWorks(works, "", ctx());
    expect(works.map((w) => w.id)).toEqual(before);
  });
});

describe("isWorkInLibrary", () => {
  it("is true when the DOI is in existingDOIs (case-insensitive, prefix-stripped)", () => {
    const w = work({ id: "W1", doi: "https://doi.org/10.1/ABC" });
    expect(isWorkInLibrary(w, new Set(["10.1/abc"]), new Set(), new Set())).toBe(true);
  });

  it("is true when the work id is in existingWorkIds (DOI-less dedup)", () => {
    const w = work({ id: "https://openalex.org/W7" }); // no DOI
    expect(isWorkInLibrary(w, new Set(), new Set(["W7"]), new Set())).toBe(true);
  });

  it("is true when the short work id was added this session", () => {
    const w = work({ id: "https://openalex.org/W42" });
    expect(isWorkInLibrary(w, new Set(), new Set(), new Set(["W42"]))).toBe(true);
  });

  it("is false otherwise", () => {
    const w = work({ id: "W1", doi: "https://doi.org/10.1/x" });
    expect(isWorkInLibrary(w, new Set(["10.1/y"]), new Set(["W9"]), new Set(["W2"]))).toBe(false);
  });
});

describe("compareNetworkWorks is a stable pure comparator", () => {
  it("returns 0 for equal-by-metric works without throwing", () => {
    const ctx: NetworkSortContext = {
      sortBy: "citations",
      existingDOIs: new Set(),
      existingWorkIds: new Set(),
      addedThisSession: new Set(),
    };
    const a = work({ id: "W1", cited_by_count: 10 });
    const b = work({ id: "W2", cited_by_count: 10 });
    expect(compareNetworkWorks(a, b, ctx)).toBe(0);
  });
});

describe("emptyStateHTML", () => {
  it("uses book-aware copy for an empty references list on a book source", () => {
    const html = emptyStateHTML({
      mode: "references",
      hasFilter: false,
      hideInLibraryWithResults: false,
      sourceWorkType: "book",
    });
    expect(html).toContain("No references found");
    expect(html).toContain("doesn't index a reference list");
    expect(html).not.toContain("has no references in OpenAlex");
  });

  it("applies the book copy to book-chapter and monograph types too", () => {
    for (const t of ["book-chapter", "monograph"]) {
      expect(
        emptyStateHTML({
          mode: "references",
          hasFilter: false,
          hideInLibraryWithResults: false,
          sourceWorkType: t,
        }),
      ).toContain("No references found");
    }
  });

  it("uses the generic references copy for a non-book source", () => {
    const html = emptyStateHTML({
      mode: "references",
      hasFilter: false,
      hideInLibraryWithResults: false,
      sourceWorkType: "article",
    });
    expect(html).toContain("This work has no references in OpenAlex");
  });

  it("does not apply book copy in citing mode even for a book source", () => {
    const html = emptyStateHTML({
      mode: "citing",
      hasFilter: false,
      hideInLibraryWithResults: false,
      sourceWorkType: "book",
    });
    expect(html).toContain("This work has no citing works in OpenAlex");
  });

  it("prioritizes the filter empty-state over everything else", () => {
    const html = emptyStateHTML({
      mode: "references",
      hasFilter: true,
      hideInLibraryWithResults: false,
      sourceWorkType: "book",
    });
    expect(html).toContain("No matches");
  });

  it("shows the hide-in-library empty-state when toggled with results present", () => {
    const html = emptyStateHTML({
      mode: "citing",
      hasFilter: false,
      hideInLibraryWithResults: true,
      sourceWorkType: "article",
    });
    expect(html).toContain("Nothing new here");
  });

  it("uses author copy for an empty author-works list", () => {
    const html = emptyStateHTML({
      mode: "author",
      hasFilter: false,
      hideInLibraryWithResults: false,
    });
    expect(html).toContain("This author has no works in OpenAlex");
    expect(html).not.toContain("This work has no");
  });
});

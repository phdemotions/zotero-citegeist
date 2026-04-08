import { describe, it, expect } from "vitest";
import {
  formatAuthors,
  getSourceName,
  reconstructAbstract,
  normalizeDOI,
  type OpenAlexWork,
} from "../src/modules/openalex";

function makeAuthorship(name: string) {
  return {
    author_position: "first",
    author: { id: "A1", display_name: name, orcid: null },
    institutions: [],
    is_corresponding: false,
  };
}

function makeWork(overrides: Partial<OpenAlexWork> = {}): OpenAlexWork {
  return {
    id: "https://openalex.org/W000",
    doi: "10.1234/test",
    title: "Test",
    display_name: "Test",
    publication_year: 2024,
    publication_date: "2024-01-01",
    cited_by_count: 10,
    referenced_works_count: 5,
    fwci: 1.5,
    citation_normalized_percentile: {
      value: 0.85,
      is_in_top_1_percent: false,
      is_in_top_10_percent: true,
    },
    counts_by_year: [{ year: 2024, cited_by_count: 10 }],
    open_access: { is_oa: false, oa_status: "closed", oa_url: null },
    authorships: [makeAuthorship("Alice Smith")],
    primary_location: {
      source: {
        id: "S1",
        display_name: "Journal of Testing",
        issn_l: "1234-5678",
        type: "journal",
      },
    },
    biblio: { volume: "1", issue: "2", first_page: "10", last_page: "20" },
    type: "article",
    is_retracted: false,
    referenced_works: [],
    abstract_inverted_index: null,
    ...overrides,
  };
}

describe("formatAuthors", () => {
  it("returns single author name", () => {
    const authorships = [makeAuthorship("Alice Smith")];
    expect(formatAuthors(authorships)).toBe("Alice Smith");
  });

  it("joins two authors with ampersand", () => {
    const authorships = [makeAuthorship("Alice Smith"), makeAuthorship("Bob Jones")];
    expect(formatAuthors(authorships)).toBe("Alice Smith & Bob Jones");
  });

  it("joins three authors with comma and ampersand", () => {
    const authorships = [
      makeAuthorship("Alice Smith"),
      makeAuthorship("Bob Jones"),
      makeAuthorship("Carol Lee"),
    ];
    expect(formatAuthors(authorships)).toBe("Alice Smith, Bob Jones & Carol Lee");
  });

  it("uses et al. for more than three authors", () => {
    const authorships = [
      makeAuthorship("Alice Smith"),
      makeAuthorship("Bob Jones"),
      makeAuthorship("Carol Lee"),
      makeAuthorship("David Park"),
    ];
    expect(formatAuthors(authorships)).toBe("Alice Smith et al.");
  });

  it("returns 'Unknown' for empty authorships", () => {
    expect(formatAuthors([])).toBe("Unknown");
  });

  it("returns 'Unknown' for null/undefined authorships", () => {
    expect(formatAuthors(null as any)).toBe("Unknown");
    expect(formatAuthors(undefined as any)).toBe("Unknown");
  });

  it("respects custom maxAuthors parameter", () => {
    const authorships = [makeAuthorship("Alice Smith"), makeAuthorship("Bob Jones")];
    expect(formatAuthors(authorships, 1)).toBe("Alice Smith et al.");
  });

  it("preserves complex names like 'van der Berg'", () => {
    const authorships = [makeAuthorship("Jan van der Berg")];
    expect(formatAuthors(authorships)).toBe("Jan van der Berg");
  });
});

describe("reconstructAbstract", () => {
  it("reconstructs abstract from inverted index", () => {
    const index = { This: [0], is: [1], a: [2], test: [3] };
    expect(reconstructAbstract(index)).toBe("This is a test");
  });

  it("handles words appearing at multiple positions", () => {
    const index = { the: [0, 4], cat: [1], sat: [2], on: [3], mat: [5] };
    expect(reconstructAbstract(index)).toBe("the cat sat on the mat");
  });

  it("returns null for null input", () => {
    expect(reconstructAbstract(null)).toBeNull();
  });

  it("returns null for empty object", () => {
    expect(reconstructAbstract({})).toBeNull();
  });

  it("handles sparse inverted index (gaps in positions)", () => {
    const index = { hello: [0], world: [5] };
    expect(reconstructAbstract(index)).toBe("hello world");
  });

  it("handles single-word abstract", () => {
    const index = { Abstract: [0] };
    expect(reconstructAbstract(index)).toBe("Abstract");
  });

  it("handles real-world OpenAlex inverted index", () => {
    const index = {
      We: [0],
      study: [1],
      the: [2, 7],
      effect: [3],
      of: [4],
      brand: [5],
      love: [6],
      consumer: [8],
    };
    expect(reconstructAbstract(index)).toBe("We study the effect of brand love the consumer");
  });

  it("skips empty-string keys", () => {
    const index = { "": [0], hello: [1], world: [2] };
    expect(reconstructAbstract(index)).toBe("hello world");
  });

  it("skips non-array position values", () => {
    // Malformed upstream response — function must not throw.
    const index = { hello: [0], bogus: "not-an-array" as unknown as number[] };
    expect(reconstructAbstract(index)).toBe("hello");
  });

  it("skips non-integer / negative / NaN positions", () => {
    const index = {
      valid: [0],
      skipFloat: [1.5 as number],
      skipNeg: [-3],
      skipNaN: [Number.NaN],
      tail: [1],
    };
    expect(reconstructAbstract(index)).toBe("valid tail");
  });

  it("rejects absurdly large positions to cap memory use", () => {
    const index = { hello: [0], bomb: [1e9] };
    expect(reconstructAbstract(index)).toBe("hello");
  });

  it("caps final text length", () => {
    const index: Record<string, number[]> = {};
    for (let i = 0; i < 50_000; i++) index[`w${i}`] = [i];
    const out = reconstructAbstract(index);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(100_000);
  });
});

describe("normalizeDOI", () => {
  it("returns a bare DOI unchanged", () => {
    expect(normalizeDOI("10.1234/foo.bar")).toBe("10.1234/foo.bar");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeDOI("  10.1234/foo  ")).toBe("10.1234/foo");
  });

  it("strips https://doi.org/ prefix", () => {
    expect(normalizeDOI("https://doi.org/10.1038/nature12373")).toBe("10.1038/nature12373");
  });

  it("strips http:// prefix", () => {
    expect(normalizeDOI("http://doi.org/10.1/x")).toBe("10.1/x");
  });

  it("strips dx.doi.org prefix", () => {
    expect(normalizeDOI("https://dx.doi.org/10.1/y")).toBe("10.1/y");
  });

  it("strips case-insensitive doi: scheme", () => {
    expect(normalizeDOI("DOI:10.1/z")).toBe("10.1/z");
    expect(normalizeDOI("doi: 10.1/z")).toBe("10.1/z");
  });

  it("decodes %2F slashes", () => {
    expect(normalizeDOI("10.1234%2Ffoo%2fbar")).toBe("10.1234/foo/bar");
  });

  it("strips trailing slashes", () => {
    expect(normalizeDOI("10.1/x///")).toBe("10.1/x");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeDOI("")).toBe("");
    expect(normalizeDOI("   ")).toBe("");
  });
});

describe("getSourceName", () => {
  it("returns source display name", () => {
    const work = makeWork();
    expect(getSourceName(work)).toBe("Journal of Testing");
  });

  it("returns 'Unknown source' when primary_location is null", () => {
    const work = makeWork({ primary_location: null });
    expect(getSourceName(work)).toBe("Unknown source");
  });

  it("returns 'Unknown source' when source is null", () => {
    const work = makeWork({
      primary_location: { source: null },
    });
    expect(getSourceName(work)).toBe("Unknown source");
  });
});

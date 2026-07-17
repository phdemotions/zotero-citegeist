/**
 * Tests for the U6 OpenAlex authors client: identity + canonical-id (301)
 * resolution, the aggregates-vs-derived metrics hybrid (KTD2), derived
 * h-index / i10 with the page-cap lower-bound flag, cursor paging, session
 * caching, and three-way error propagation. Exercises the real fetch path
 * against a mocked Zotero.HTTP.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAlexBudgetError } from "../src/modules/utils";

let apiKeyPref = "";
const httpRequest = vi.fn();

const mockZotero = {
  Prefs: {
    get: vi.fn((pref: string) => {
      if (pref === "extensions.zotero.citegeist.openAlexApiKey") return apiKeyPref;
      return undefined;
    }),
  },
  HTTP: { request: httpRequest },
  debug: vi.fn(),
};
vi.stubGlobal("Zotero", mockZotero);

// Import after the global is stubbed so module-level code sees it.
import {
  fetchAuthorProfile,
  fetchAuthorWorks,
  clearAuthorProfileCache,
  resolveAuthorInput,
  parseOrcid,
} from "../src/modules/openalexAuthors";

function httpResponse(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return {
    status,
    responseText: JSON.stringify(body),
    getResponseHeader: (name: string) => headers[name] ?? null,
  };
}

/** An `/authors/{id}` singleton response. */
function authorBody(id: string, extra: Record<string, unknown> = {}) {
  return {
    id: `https://openalex.org/${id}`,
    display_name: "Jane Q. Researcher",
    orcid: null,
    ...extra,
  };
}

/** A `/works` list page. `citations` is one entry per work. */
function worksPage(citations: number[], nextCursor: string | null, count?: number) {
  return {
    meta: { count: count ?? citations.length, per_page: 100, next_cursor: nextCursor },
    results: citations.map((c, i) => ({
      id: `https://openalex.org/W${i}`,
      cited_by_count: c,
      authorships: [],
    })),
  };
}

/** Advance the rate limiter's timers, then resolve the pending call. */
async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

beforeEach(() => {
  apiKeyPref = "";
  httpRequest.mockReset();
  mockZotero.debug.mockReset();
  clearAuthorProfileCache();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchAuthorProfile — identity + 301", () => {
  it("resolves identity and flags a 301 redirect via redirectedFrom", async () => {
    httpRequest.mockResolvedValue(
      httpResponse(
        200,
        authorBody("A200", {
          works_count: 42,
          cited_by_count: 900,
          summary_stats: { h_index: 15, i10_index: 20 },
        }),
      ),
    );
    const profile = await settle(fetchAuthorProfile("A100"));
    expect(profile?.id).toBe("A200");
    expect(profile?.redirectedFrom).toBe("A100");
    expect(profile?.displayName).toBe("Jane Q. Researcher");
  });

  it("leaves redirectedFrom null when the requested id is already canonical", async () => {
    httpRequest.mockResolvedValue(
      httpResponse(200, authorBody("A1", { works_count: 5, cited_by_count: 9 })),
    );
    const profile = await settle(fetchAuthorProfile("A1"));
    expect(profile?.id).toBe("A1");
    expect(profile?.redirectedFrom).toBeNull();
  });
});

describe("fetchAuthorProfile — metrics hybrid (KTD2)", () => {
  it("uses author aggregates when works_count is non-zero (no works fetch)", async () => {
    httpRequest.mockResolvedValue(
      httpResponse(
        200,
        authorBody("A1", {
          works_count: 42,
          cited_by_count: 900,
          summary_stats: { h_index: 15, i10_index: 20 },
        }),
      ),
    );
    const profile = await settle(fetchAuthorProfile("A1"));
    expect(profile?.metricsSource).toBe("aggregates");
    expect(profile?.hIndex).toBe(15);
    expect(profile?.i10Index).toBe(20);
    expect(profile?.worksCount).toBe(42);
    expect(profile?.citedByCount).toBe(900);
    expect(profile?.metricsAreLowerBound).toBe(false);
    expect(httpRequest).toHaveBeenCalledTimes(1); // only /authors, no /works
  });

  it("derives metrics from works when aggregates are zero", async () => {
    httpRequest.mockImplementation((_method: string, url: string) => {
      if (url.includes("/authors/")) {
        return Promise.resolve(
          httpResponse(
            200,
            authorBody("A1", {
              works_count: 0,
              cited_by_count: 0,
              summary_stats: { h_index: 0, i10_index: 0 },
            }),
          ),
        );
      }
      return Promise.resolve(httpResponse(200, worksPage([30, 20, 10, 4, 2], null)));
    });
    const profile = await settle(fetchAuthorProfile("A1"));
    expect(profile?.metricsSource).toBe("derived");
    expect(profile?.worksCount).toBe(5); // meta.count
    expect(profile?.hIndex).toBe(4); // 30,20,10,4 >= rank; 2 < 5
    expect(profile?.i10Index).toBe(3); // 30,20,10 >= 10
    expect(profile?.citedByCount).toBe(66); // fetchedAll → exact sum
    expect(profile?.metricsAreLowerBound).toBe(false);
  });

  it("labels derived metrics as lower bounds when the page cap is hit", async () => {
    httpRequest.mockImplementation((_method: string, url: string) => {
      if (url.includes("/authors/")) {
        return Promise.resolve(
          httpResponse(200, authorBody("A1", { works_count: 0, cited_by_count: 0 })),
        );
      }
      // Every page: 100 highly-cited works, always another cursor → never settles.
      return Promise.resolve(
        httpResponse(200, worksPage(new Array(100).fill(1000), "MORE", 100000)),
      );
    });
    const profile = await settle(fetchAuthorProfile("A1"));
    expect(profile?.metricsSource).toBe("derived");
    expect(profile?.metricsAreLowerBound).toBe(true);
    expect(profile?.worksCount).toBe(100000);
    expect(profile?.citedByCount).toBeNull(); // never fetchedAll → not summable
    expect(httpRequest).toHaveBeenCalledTimes(1 + 5); // /authors + CAP works pages
  });
});

describe("fetchAuthorProfile — errors + caching", () => {
  it("propagates OpenAlexBudgetError from the author lookup", async () => {
    httpRequest.mockResolvedValue(httpResponse(429, {}, { "X-RateLimit-Remaining": "0" }));
    const p = fetchAuthorProfile("A1");
    const assertion = expect(p).rejects.toBeInstanceOf(OpenAlexBudgetError);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("returns null when the author is not found (404)", async () => {
    httpRequest.mockResolvedValue(httpResponse(404));
    const profile = await settle(fetchAuthorProfile("A1"));
    expect(profile).toBeNull();
  });

  it("returns null without a request for an unparseable author id", async () => {
    const profile = await settle(fetchAuthorProfile("not-an-id"));
    expect(profile).toBeNull();
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it("caches the profile for the session and re-derives redirectedFrom per call", async () => {
    httpRequest.mockResolvedValue(
      httpResponse(
        200,
        authorBody("A200", {
          works_count: 5,
          cited_by_count: 9,
          summary_stats: { h_index: 2, i10_index: 1 },
        }),
      ),
    );
    const first = await settle(fetchAuthorProfile("A100")); // 301: A100 → A200
    expect(first?.redirectedFrom).toBe("A100");
    expect(httpRequest).toHaveBeenCalledTimes(1);

    // Canonical id was aliased into the cache → no new fetch, no redirect.
    const second = await settle(fetchAuthorProfile("A200"));
    expect(second?.redirectedFrom).toBeNull();
    expect(httpRequest).toHaveBeenCalledTimes(1);
  });
});

describe("fetchAuthorWorks", () => {
  it("passes the cursor + filter and normalizes results", async () => {
    httpRequest.mockResolvedValue(httpResponse(200, worksPage([5, 3], "NEXT", 2)));
    const page = await settle(fetchAuthorWorks("A1", "CUR"));
    const url = httpRequest.mock.calls[0][1] as string;
    expect(url).toContain("filter=authorships.author.id%3AA1");
    expect(url).toContain("cursor=CUR");
    expect(url).toContain("sort=cited_by_count%3Adesc");
    expect(page.meta.next_cursor).toBe("NEXT");
    expect(page.results).toHaveLength(2);
    expect(Array.isArray(page.results[0].authorships)).toBe(true); // normalizeWork ran
  });

  it("returns an empty response without a request for an unparseable id", async () => {
    const page = await settle(fetchAuthorWorks("garbage"));
    expect(page.results).toEqual([]);
    expect(page.meta.count).toBe(0);
    expect(httpRequest).not.toHaveBeenCalled();
  });
});

describe("parseOrcid", () => {
  it("accepts bare + URL ORCIDs (incl. the X check digit) and rejects the rest", () => {
    expect(parseOrcid("0000-0002-1825-0097")).toBe("0000-0002-1825-0097");
    expect(parseOrcid("https://orcid.org/0000-0002-1825-0097")).toBe("0000-0002-1825-0097");
    expect(parseOrcid("0000-0002-1825-009X")).toBe("0000-0002-1825-009X");
    expect(parseOrcid("A123")).toBeNull();
    expect(parseOrcid("not an orcid")).toBeNull();
  });
});

describe("resolveAuthorInput", () => {
  it("parses an OpenAlex id or URL offline (no request)", async () => {
    expect(await settle(resolveAuthorInput("A5023888391"))).toBe("A5023888391");
    expect(await settle(resolveAuthorInput("https://openalex.org/A42"))).toBe("A42");
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it("resolves an ORCID (bare or URL) via the singleton lookup", async () => {
    httpRequest.mockResolvedValue(httpResponse(200, { id: "https://openalex.org/A99" }));
    expect(await settle(resolveAuthorInput("0000-0002-1825-0097"))).toBe("A99");
    expect(httpRequest.mock.calls[0][1] as string).toContain("authors/orcid:0000-0002-1825-0097");
  });

  it("returns null for an ORCID with no OpenAlex record (404)", async () => {
    httpRequest.mockResolvedValue(httpResponse(404));
    expect(await settle(resolveAuthorInput("0000-0002-1825-0097"))).toBeNull();
  });

  it("returns null for a name or garbage (no request)", async () => {
    expect(await settle(resolveAuthorInput("Jane Q. Researcher"))).toBeNull();
    expect(httpRequest).not.toHaveBeenCalled();
  });
});

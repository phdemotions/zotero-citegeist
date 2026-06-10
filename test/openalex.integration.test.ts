/**
 * Integration test: validates live communication with the OpenAlex API.
 *
 * Uses a well-known, stable DOI (Garfield 1955, "Citation indexes for science")
 * which has been cited thousands of times and is unlikely to change or disappear.
 *
 * Purpose: catch OpenAlex API *contract* changes that would break Citegeist.
 * It is therefore resilient to network conditions — it uses the polite pool
 * (mailto), like the plugin does at runtime, plus a generous timeout, and it
 * SKIPS rather than fails when OpenAlex is unreachable or returns a transient
 * error. A network blip is not a contract regression and must not red the
 * build; the test only fails if the response shape Citegeist depends on changed.
 */
import { describe, it, expect } from "vitest";

const OPENALEX_BASE = "https://api.openalex.org";
const KNOWN_DOI = "10.1126/science.122.3159.108"; // Garfield 1955

// Polite pool: the same courtesy the plugin extends at runtime — faster, more
// reliable responses than the anonymous common pool. Override via the
// OPENALEX_MAILTO env var in CI if a different contact is preferred.
const MAILTO = process.env.OPENALEX_MAILTO || "citegeist@opusvita.org";

const SELECT_FIELDS =
  "id,doi,title,display_name,publication_year,cited_by_count," +
  "fwci,citation_normalized_percentile,counts_by_year,authorships," +
  "primary_location,is_retracted";

describe("OpenAlex API integration", () => {
  it("returns expected fields for a known DOI", async (ctx) => {
    const url =
      `${OPENALEX_BASE}/works/doi:${encodeURIComponent(KNOWN_DOI)}` +
      `?select=${SELECT_FIELDS}&mailto=${encodeURIComponent(MAILTO)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": `Citegeist/test (integration; mailto:${MAILTO})`,
        },
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      // Network error / timeout — OpenAlex unreachable, not a contract change.
      // Skip rather than fail so a transient CI network issue can't block merges.
      ctx.skip();
      return;
    }

    // Transient server-side error (5xx / 429) is likewise not a contract change.
    if (response.status !== 200) {
      ctx.skip();
      return;
    }

    const work = await response.json();

    // Verify the response has the shape Citegeist depends on
    expect(work.id).toMatch(/^https:\/\/openalex\.org\/W/);
    expect(work.doi).toContain("10.1126/science.122.3159.108");
    expect(work.display_name).toMatch(/citation index/i);
    expect(work.publication_year).toBe(1955);
    expect(typeof work.cited_by_count).toBe("number");
    expect(work.cited_by_count).toBeGreaterThan(100); // Garfield 1955 is heavily cited

    // FWCI should be present and numeric (or null for very old papers)
    if (work.fwci !== null) {
      expect(typeof work.fwci).toBe("number");
    }

    // Percentile object shape
    if (work.citation_normalized_percentile !== null) {
      expect(typeof work.citation_normalized_percentile.value).toBe("number");
      expect(typeof work.citation_normalized_percentile.is_in_top_1_percent).toBe("boolean");
      expect(typeof work.citation_normalized_percentile.is_in_top_10_percent).toBe("boolean");
    }

    // Counts by year should be an array
    expect(Array.isArray(work.counts_by_year)).toBe(true);
    if (work.counts_by_year.length > 0) {
      expect(typeof work.counts_by_year[0].year).toBe("number");
      expect(typeof work.counts_by_year[0].cited_by_count).toBe("number");
    }

    // Authorships shape
    expect(Array.isArray(work.authorships)).toBe(true);
    expect(work.authorships.length).toBeGreaterThan(0);
    expect(typeof work.authorships[0].author.display_name).toBe("string");

    // Retraction flag
    expect(typeof work.is_retracted).toBe("boolean");
    expect(work.is_retracted).toBe(false);
  }, 30000); // generous overall timeout; fetch itself aborts at 20s
});

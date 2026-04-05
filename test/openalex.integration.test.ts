/**
 * Integration test: validates live communication with the OpenAlex API.
 *
 * Uses a well-known, stable DOI (Garfield 1955, "Citation indexes for science")
 * which has been cited thousands of times and is unlikely to change or disappear.
 *
 * This test makes a real HTTP request. It is included in CI to verify that
 * the OpenAlex API contract has not changed in ways that would break Citegeist.
 */
import { describe, it, expect } from "vitest";

const OPENALEX_BASE = "https://api.openalex.org";
const KNOWN_DOI = "10.1126/science.122.3159.108"; // Garfield 1955

const SELECT_FIELDS =
  "id,doi,title,display_name,publication_year,cited_by_count," +
  "fwci,citation_normalized_percentile,counts_by_year,authorships," +
  "primary_location,is_retracted";

describe("OpenAlex API integration", () => {
  it("returns expected fields for a known DOI", async () => {
    const url = `${OPENALEX_BASE}/works/doi:${encodeURIComponent(KNOWN_DOI)}?select=${SELECT_FIELDS}`;
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Citegeist/test (integration test)",
      },
    });

    expect(response.status).toBe(200);

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
  }, 15000); // generous timeout for network request
});

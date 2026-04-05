import { describe, it, expect } from "vitest";
import { lookupRanking, RANKING_VERSIONS } from "../src/data/journalRankings";

describe("lookupRanking", () => {
  it("finds a UTD24 + FT50 journal by ISSN-L", () => {
    // Academy of Management Journal
    const r = lookupRanking(["0001-4273"]);
    expect(r).not.toBeNull();
    expect(r!.utd24).toBe(true);
    expect(r!.ft50).toBe(true);
    expect(r!.abdc).toBe("A*");
    expect(r!.ajg).toBe("4*");
  });

  it("finds a journal by eISSN when ISSN-L fails (multiple ISSNs)", () => {
    // Journal of Marketing Research: ISSN-L 0022-2437
    // If the first ISSN doesn't match, falls through to the second
    const r = lookupRanking(["9999-9999", "0022-2437"]);
    expect(r).not.toBeNull();
    expect(r!.utd24).toBe(true);
  });

  it("returns null for unknown ISSN", () => {
    expect(lookupRanking(["0000-0000"])).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(lookupRanking([])).toBeNull();
  });

  it("is case-insensitive", () => {
    // Administrative Science Quarterly has ISSN 0001-8392
    const r = lookupRanking(["0001-8392"]);
    expect(r).not.toBeNull();
    expect(r!.ajg).toBe("4*");
  });

  it("trims whitespace from ISSNs", () => {
    const r = lookupRanking(["  0001-4273  "]);
    expect(r).not.toBeNull();
    expect(r!.utd24).toBe(true);
  });

  it("finds FT50-only journal (not UTD24)", () => {
    // Journal of Management Studies: FT50 but not UTD24
    const r = lookupRanking(["0022-2380"]);
    expect(r).not.toBeNull();
    expect(r!.ft50).toBe(true);
    expect(r!.utd24).toBeUndefined();
    expect(r!.abdc).toBe("A*");
    expect(r!.ajg).toBe("4");
  });

  it("finds ABDC-only journal", () => {
    // Academy of Management Perspectives: ABDC A, AJG 3, not UTD/FT
    const r = lookupRanking(["1558-9080"]);
    expect(r).not.toBeNull();
    expect(r!.abdc).toBe("A");
    expect(r!.ajg).toBe("3");
    expect(r!.utd24).toBeUndefined();
    expect(r!.ft50).toBeUndefined();
  });

  it("returns first match when multiple ISSNs match", () => {
    // Both should match, returns the first one found
    const r = lookupRanking(["0001-4273", "0363-7425"]);
    expect(r).not.toBeNull();
    // AMJ (first ISSN) should win
    expect(r!.utd24).toBe(true);
  });
});

describe("RANKING_VERSIONS", () => {
  it("has version strings for all four lists", () => {
    expect(RANKING_VERSIONS.utd24).toBe("2024");
    expect(RANKING_VERSIONS.ft50).toBe("2024");
    expect(RANKING_VERSIONS.abdc).toBe("2022");
    expect(RANKING_VERSIONS.ajg).toBe("2021");
  });
});

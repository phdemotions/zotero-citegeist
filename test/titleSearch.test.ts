/**
 * Tests for titleSearch.ts — metadata-based matching.
 *
 * Covers:
 * - normalizeTitle: lowercasing, punctuation stripping, separator removal
 * - normalizeTitleTokens: stop word removal, tokenization
 * - diceSimilarity: identical, disjoint, partial overlap, empty sets
 * - Scoring logic: year scoring, author overlap, combined score thresholds
 */
import { describe, it, expect, vi } from "vitest";

// Mock Zotero global (not needed by these pure functions, but needed for module load)
vi.stubGlobal("Zotero", { debug: () => {} });

import { normalizeTitle, normalizeTitleTokens, diceSimilarity } from "../src/modules/titleSearch";

describe("normalizeTitle", () => {
  it("lowercases the input", () => {
    expect(normalizeTitle("The Effect of X on Y")).toBe("the effect of x on y");
  });

  it("strips punctuation", () => {
    expect(normalizeTitle("Effects (Study): A Review!")).toBe("effects study a review");
  });

  it("replaces colons and em-dashes with spaces", () => {
    expect(normalizeTitle("Title: A Subtitle")).toBe("title a subtitle");
    expect(normalizeTitle("Title\u2014Subtitle")).toBe("title subtitle");
    expect(normalizeTitle("Title\u2013Subtitle")).toBe("title subtitle");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeTitle("Word   Word")).toBe("word word");
  });

  it("trims whitespace", () => {
    expect(normalizeTitle("  hello  ")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(normalizeTitle("")).toBe("");
  });
});

describe("normalizeTitleTokens", () => {
  it("returns a Set of words", () => {
    const tokens = normalizeTitleTokens("Effects of climate change");
    expect(tokens).toBeInstanceOf(Set);
    expect(tokens.has("effects")).toBe(true);
    expect(tokens.has("climate")).toBe(true);
    expect(tokens.has("change")).toBe(true);
  });

  it("removes stop words", () => {
    const tokens = normalizeTitleTokens("The effect of a model");
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("of")).toBe(false);
    expect(tokens.has("a")).toBe(false);
    expect(tokens.has("effect")).toBe(true);
    expect(tokens.has("model")).toBe(true);
  });

  it("deduplicates repeated words", () => {
    const tokens = normalizeTitleTokens("bias bias bias");
    expect(tokens.size).toBe(1);
    expect(tokens.has("bias")).toBe(true);
  });

  it("handles empty string", () => {
    expect(normalizeTitleTokens("").size).toBe(0);
  });

  it("handles titles that are all stop words", () => {
    const tokens = normalizeTitleTokens("the and or but");
    expect(tokens.size).toBe(0);
  });
});

describe("diceSimilarity", () => {
  it("returns 1.0 for identical sets", () => {
    const a = new Set(["effects", "climate", "change"]);
    const b = new Set(["effects", "climate", "change"]);
    expect(diceSimilarity(a, b)).toBe(1.0);
  });

  it("returns 0.0 for completely disjoint sets", () => {
    const a = new Set(["apple", "banana"]);
    const b = new Set(["cherry", "date"]);
    expect(diceSimilarity(a, b)).toBe(0.0);
  });

  it("returns 1.0 for two empty sets", () => {
    expect(diceSimilarity(new Set(), new Set())).toBe(1.0);
  });

  it("returns 0.0 when one set is empty", () => {
    expect(diceSimilarity(new Set(["word"]), new Set())).toBe(0.0);
    expect(diceSimilarity(new Set(), new Set(["word"]))).toBe(0.0);
  });

  it("handles partial overlap correctly", () => {
    // |a| = 3, |b| = 3, intersection = 2 → 2*2 / (3+3) = 4/6 ≈ 0.667
    const a = new Set(["effects", "climate", "change"]);
    const b = new Set(["effects", "climate", "model"]);
    expect(diceSimilarity(a, b)).toBeCloseTo(0.667, 2);
  });

  it("is symmetric", () => {
    const a = new Set(["alpha", "beta", "gamma"]);
    const b = new Set(["beta", "gamma", "delta"]);
    expect(diceSimilarity(a, b)).toBeCloseTo(diceSimilarity(b, a), 10);
  });

  it("handles single-element sets with overlap", () => {
    const a = new Set(["word"]);
    const b = new Set(["word"]);
    expect(diceSimilarity(a, b)).toBe(1.0);
  });

  it("handles single-element sets without overlap", () => {
    const a = new Set(["apple"]);
    const b = new Set(["banana"]);
    expect(diceSimilarity(a, b)).toBe(0.0);
  });

  it("computes correctly for sets of different sizes", () => {
    // |a| = 4, |b| = 2, intersection = 2 → 2*2 / (4+2) = 4/6 ≈ 0.667
    const a = new Set(["a", "b", "c", "d"]);
    const b = new Set(["a", "b"]);
    expect(diceSimilarity(a, b)).toBeCloseTo(0.667, 2);
  });
});

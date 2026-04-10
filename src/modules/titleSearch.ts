/**
 * Metadata-based matching for Zotero items without a recognized identifier.
 *
 * When direct identifier lookup fails, this module searches OpenAlex by title
 * and year, scores the top candidates, and returns the best match above a
 * confidence threshold.
 *
 * Scoring weights (per DESIGN.md):
 *   Title similarity  60%  — word-level Dice coefficient on normalized tokens
 *   Year match        25%  — exact=1.0, ±1=0.8, ±2=0.5, else=0.0
 *   Author overlap    15%  — fraction of Zotero authors matched; 0.5 if no authors
 */

import { searchWorksByTitle, type OpenAlexWork } from "./openalex";
import {
  TITLE_MATCH_HIGH_THRESHOLD,
  TITLE_MATCH_MEDIUM_THRESHOLD,
  TITLE_SEARCH_RESULTS,
} from "../constants";

export interface TitleMatchResult {
  work: OpenAlexWork;
  confidence: number;
  tier: "high" | "medium";
}

/**
 * Search OpenAlex by metadata and return the best-scoring match, or null
 * if no candidate exceeds the medium-confidence threshold.
 *
 * @throws {@link OpenAlexNetworkError} when the service is unreachable.
 */
export async function searchByMetadata(item: _ZoteroTypes.Item): Promise<TitleMatchResult | null> {
  const rawTitle = (item.getField("title") as string) || "";
  if (!rawTitle.trim()) return null;

  const rawDate = (item.getField("date") as string) || "";
  const year = parseYear(rawDate);

  const candidates = await searchWorksByTitle(normalizeTitle(rawTitle), year, TITLE_SEARCH_RESULTS);
  if (candidates.length === 0) return null;

  let best: { work: OpenAlexWork; score: number } | null = null;

  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, item, year);
    if (!best || score > best.score) {
      best = { work: candidate, score };
    }
  }

  if (!best || best.score < TITLE_MATCH_MEDIUM_THRESHOLD) return null;

  const tier: "high" | "medium" = best.score >= TITLE_MATCH_HIGH_THRESHOLD ? "high" : "medium";

  return { work: best.work, confidence: best.score, tier };
}

// ── Scoring ──────────────────────────────────────────────────────────────────

function scoreCandidate(
  candidate: OpenAlexWork,
  item: _ZoteroTypes.Item,
  itemYear: number | null,
): number {
  const itemTokens = normalizeTitleTokens((item.getField("title") as string) || "");
  const candidateTokens = normalizeTitleTokens(candidate.display_name || candidate.title || "");
  const titleScore = diceSimilarity(itemTokens, candidateTokens);

  const yearScore = scoreYear(candidate.publication_year, itemYear);

  const authorScore = scoreAuthors(candidate, item);

  return titleScore * 0.6 + yearScore * 0.25 + authorScore * 0.15;
}

function scoreYear(candidateYear: number, itemYear: number | null): number {
  if (itemYear === null) return 0.5; // neutral when item has no year
  const diff = Math.abs(candidateYear - itemYear);
  if (diff === 0) return 1.0;
  if (diff === 1) return 0.8;
  if (diff === 2) return 0.5;
  return 0.0;
}

function scoreAuthors(candidate: OpenAlexWork, item: _ZoteroTypes.Item): number {
  let zoteroLastNames: string[] = [];
  try {
    const creators = item.getCreators() as Array<{ lastName?: string; firstName?: string }>;
    zoteroLastNames = creators
      .filter((c) => c.lastName)
      .map((c) => c.lastName!.toLowerCase().trim());
  } catch {
    // getCreators may not be available on all item types
  }

  if (zoteroLastNames.length === 0) return 0.5; // neutral

  const candidateLastNames = (candidate.authorships || []).map((a) => {
    // display_name is "First Last" — take last word as last name heuristic
    const parts = a.author.display_name.trim().split(/\s+/);
    return (parts[parts.length - 1] || "").toLowerCase();
  });

  if (candidateLastNames.length === 0) return 0.5;

  const matched = zoteroLastNames.filter((ln) => candidateLastNames.includes(ln)).length;
  return matched / zoteroLastNames.length;
}

// ── String utilities ──────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "with",
  "from",
  "by",
  "as",
  "its",
  "it",
  "this",
  "that",
  "these",
  "those",
]);

/**
 * Normalize a title string for search: lowercase, strip punctuation,
 * remove common subtitle separators.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[:\u2014\u2013]/g, " ") // colon, em-dash, en-dash as separators
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tokenize a normalized title into a Set of words, excluding common
 * stop words that add noise without discriminating power.
 */
export function normalizeTitleTokens(title: string): Set<string> {
  const normalized = normalizeTitle(title);
  const tokens = new Set<string>();
  for (const word of normalized.split(/\s+/)) {
    if (word && !STOP_WORDS.has(word)) {
      tokens.add(word);
    }
  }
  return tokens;
}

/**
 * Word-level Dice similarity coefficient between two token sets.
 * Returns 0.0–1.0; 1.0 is identical.
 */
export function diceSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  return (2 * intersection) / (a.size + b.size);
}

function parseYear(dateStr: string): number | null {
  const m = dateStr.match(/\b(\d{4})\b/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  return y >= 1000 && y <= 2100 ? y : null;
}

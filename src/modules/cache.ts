/**
 * Cache layer for Citegeist.
 *
 * Stores OpenAlex citation data in Zotero item "Extra" fields
 * using a namespaced format:
 *   Citegeist.citedByCount: 42
 *   Citegeist.openAlexId: W1234567890
 *   Citegeist.fwci: 2.31
 *   Citegeist.lastFetched: 2026-04-04T12:00:00Z
 *
 * IMPORTANT: The Extra field may contain arbitrary user data, CSL variables,
 * PMIDs, and other plugin data. We only touch lines prefixed with "Citegeist.".
 */

import type { OpenAlexWork, OpenAlexSourceStats } from "./openalex";
import { safeParseInt, safeParseFloat } from "./utils";

const PREFIX = "Citegeist.";

/** Strip characters that would break the Extra field line format. */
function sanitizeCacheValue(s: string): string {
  return s.replace(/[\r\n]/g, " ").trim();
}

export interface CachedData {
  openAlexId: string;
  citedByCount: number;
  fwci: number | null;
  percentile: number | null;
  isTop1Percent: boolean;
  isTop10Percent: boolean;
  isRetracted: boolean;
  lastFetched: string;
  /** OpenAlex source ID (e.g., "S1234") for journal-level lookups */
  sourceId: string | null;
  /** Journal 2-year mean citedness (OpenAlex's JIF equivalent) */
  citedness2yr: number | null;
  /** Journal h-index */
  journalHIndex: number | null;
}

/**
 * Parse the Extra field, separating Citegeist fields from everything else.
 * Preserves ALL non-Citegeist content exactly as-is.
 */
function parseExtra(item: _ZoteroTypes.Item): {
  citegeistFields: Map<string, string>;
  otherLines: string[];
} {
  const extra = item.getField("extra");
  const citegeistFields = new Map<string, string>();
  const otherLines: string[] = [];

  if (!extra) return { citegeistFields, otherLines };

  for (const line of extra.split("\n")) {
    if (line.startsWith(PREFIX)) {
      const idx = line.indexOf(": ");
      if (idx > 0) {
        citegeistFields.set(line.substring(0, idx), line.substring(idx + 2));
      } else {
        otherLines.push(line);
      }
    } else {
      otherLines.push(line);
    }
  }

  return { citegeistFields, otherLines };
}

/**
 * Write Citegeist fields back to Extra, preserving all non-Citegeist content.
 * Citegeist lines go at the end so they don't interfere with CSL parsing.
 */
function writeExtra(
  item: _ZoteroTypes.Item,
  citegeistFields: Map<string, string>,
  otherLines: string[],
): void {
  const cgLines: string[] = [];
  for (const [key, value] of citegeistFields) {
    cgLines.push(`${key}: ${value}`);
  }
  const allLines = [...otherLines, ...cgLines];
  while (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }
  item.setField("extra", allLines.join("\n"));
}

/**
 * Combined read: returns citation count + staleness in one parse.
 * Used by the column dataProvider to avoid double-parsing.
 */
export function getCachedCountAndStaleness(item: _ZoteroTypes.Item): {
  count: number | null;
  isStale: boolean;
} {
  const { citegeistFields } = parseExtra(item);
  const countStr = citegeistFields.get(`${PREFIX}citedByCount`);
  const count = countStr !== undefined ? safeParseInt(countStr) : null;

  return { count, isStale: isLastFetchedStale(citegeistFields) };
}

/**
 * Read FWCI and percentile alongside count and staleness in one parse.
 * Used by columns to avoid parsing Extra multiple times per item.
 */
export interface AllMetrics {
  count: number | null;
  fwci: number | null;
  percentile: number | null;
  isStale: boolean;
  sourceId: string | null;
  citedness2yr: number | null;
  journalHIndex: number | null;
  /** All known ISSNs from OpenAlex (for ranking lookups) */
  sourceISSNs: string[];
  /** Pending unconfirmed title match, if any */
  suggestion: { count: number; fwci: number | null; tier: "high" | "medium" } | null;
}

export function getCachedMetrics(item: _ZoteroTypes.Item): AllMetrics {
  const { citegeistFields } = parseExtra(item);
  const countStr = citegeistFields.get(`${PREFIX}citedByCount`);
  const count = countStr !== undefined ? safeParseInt(countStr) : null;
  const fwci = safeParseFloat(citegeistFields.get(`${PREFIX}fwci`));
  const percentile = safeParseFloat(citegeistFields.get(`${PREFIX}percentile`));
  const sourceId = citegeistFields.get(`${PREFIX}sourceId`) || null;
  const citedness2yr = safeParseFloat(citegeistFields.get(`${PREFIX}citedness2yr`));
  const journalHIndex = safeParseInt(citegeistFields.get(`${PREFIX}journalHIndex`)) || null;
  const issnRaw =
    citegeistFields.get(`${PREFIX}sourceISSNs`) || citegeistFields.get(`${PREFIX}issnL`) || "";
  const sourceISSNs = issnRaw ? issnRaw.split(",").filter(Boolean) : [];
  // Pending suggestion (unconfirmed title match)
  const suggestionId = citegeistFields.get(`${PREFIX}pendingSuggestionId`);
  let suggestion: AllMetrics["suggestion"] = null;
  if (suggestionId && count === null) {
    const sCount = safeParseInt(citegeistFields.get(`${PREFIX}pendingSuggestionCount`));
    const sFwci = safeParseFloat(citegeistFields.get(`${PREFIX}pendingSuggestionFwci`));
    const rawTier = citegeistFields.get(`${PREFIX}pendingSuggestionTier`);
    const sTier: MatchTier = isMatchTier(rawTier) ? rawTier : "medium";
    suggestion = { count: sCount, fwci: sFwci, tier: sTier };
  }

  return {
    count,
    fwci,
    percentile,
    isStale: isLastFetchedStale(citegeistFields),
    sourceId,
    citedness2yr,
    journalHIndex,
    sourceISSNs,
    suggestion,
  };
}

export function getCachedCitationCount(item: _ZoteroTypes.Item): number | null {
  const { citegeistFields } = parseExtra(item);
  const val = citegeistFields.get(`${PREFIX}citedByCount`);
  return val !== undefined ? safeParseInt(val) : null;
}

export function getCachedOpenAlexId(item: _ZoteroTypes.Item): string | null {
  const { citegeistFields } = parseExtra(item);
  return citegeistFields.get(`${PREFIX}openAlexId`) || null;
}

export function getCachedData(item: _ZoteroTypes.Item): CachedData | null {
  const { citegeistFields } = parseExtra(item);
  const openAlexId = citegeistFields.get(`${PREFIX}openAlexId`);
  if (!openAlexId) return null;

  return {
    openAlexId,
    citedByCount: safeParseInt(citegeistFields.get(`${PREFIX}citedByCount`)),
    fwci: safeParseFloat(citegeistFields.get(`${PREFIX}fwci`)),
    percentile: safeParseFloat(citegeistFields.get(`${PREFIX}percentile`)),
    isTop1Percent: citegeistFields.get(`${PREFIX}isTop1Percent`) === "true",
    isTop10Percent: citegeistFields.get(`${PREFIX}isTop10Percent`) === "true",
    isRetracted: citegeistFields.get(`${PREFIX}isRetracted`) === "true",
    lastFetched: citegeistFields.get(`${PREFIX}lastFetched`) || "",
    sourceId: citegeistFields.get(`${PREFIX}sourceId`) || null,
    citedness2yr: safeParseFloat(citegeistFields.get(`${PREFIX}citedness2yr`)),
    journalHIndex: safeParseInt(citegeistFields.get(`${PREFIX}journalHIndex`)) || null,
  };
}

export async function cacheWorkData(
  item: _ZoteroTypes.Item,
  work: OpenAlexWork,
  sourceStats?: OpenAlexSourceStats | null,
): Promise<void> {
  const { citegeistFields, otherLines } = parseExtra(item);

  citegeistFields.set(`${PREFIX}openAlexId`, work.id.replace("https://openalex.org/", ""));
  citegeistFields.set(`${PREFIX}citedByCount`, String(work.cited_by_count));

  if (work.fwci !== null && work.fwci !== undefined && work.cited_by_count > 0) {
    citegeistFields.set(`${PREFIX}fwci`, work.fwci.toFixed(2));
  } else {
    citegeistFields.delete(`${PREFIX}fwci`);
  }
  if (work.citation_normalized_percentile && work.cited_by_count > 0) {
    citegeistFields.set(
      `${PREFIX}percentile`,
      (work.citation_normalized_percentile.value * 100).toFixed(1),
    );
    citegeistFields.set(
      `${PREFIX}isTop1Percent`,
      String(work.citation_normalized_percentile.is_in_top_1_percent),
    );
    citegeistFields.set(
      `${PREFIX}isTop10Percent`,
      String(work.citation_normalized_percentile.is_in_top_10_percent),
    );
  } else {
    citegeistFields.delete(`${PREFIX}percentile`);
    citegeistFields.delete(`${PREFIX}isTop1Percent`);
    citegeistFields.delete(`${PREFIX}isTop10Percent`);
  }
  citegeistFields.set(`${PREFIX}isRetracted`, String(work.is_retracted));
  citegeistFields.set(`${PREFIX}lastFetched`, new Date().toISOString());

  // Source/journal data
  const sourceId = work.primary_location?.source?.id?.replace("https://openalex.org/", "");
  if (sourceId) {
    citegeistFields.set(`${PREFIX}sourceId`, sanitizeCacheValue(sourceId));
  }
  if (sourceStats) {
    citegeistFields.set(`${PREFIX}citedness2yr`, sourceStats.citedness2yr.toFixed(2));
    citegeistFields.set(`${PREFIX}journalHIndex`, String(sourceStats.hIndex));
    if (sourceStats.issns.length > 0) {
      citegeistFields.set(`${PREFIX}sourceISSNs`, sourceStats.issns.map(sanitizeCacheValue).join(","));
    }
  }
  // Also store the issn_l from the work's primary location as fallback
  const issnL = work.primary_location?.source?.issn_l;
  if (issnL) {
    citegeistFields.set(`${PREFIX}issnL`, sanitizeCacheValue(issnL));
  }

  writeExtra(item, citegeistFields, otherLines);
  await item.saveTx();
}

/**
 * Check staleness from already-parsed Citegeist fields.
 */
function isLastFetchedStale(citegeistFields: Map<string, string>): boolean {
  const lastFetched = citegeistFields.get(`${PREFIX}lastFetched`);
  if (!lastFetched) return true;

  const rawLifetime = Zotero.Prefs.get("extensions.zotero.citegeist.cacheLifetimeDays");
  const lifetimeDays =
    typeof rawLifetime === "number" && Number.isFinite(rawLifetime) && rawLifetime > 0
      ? rawLifetime
      : 7;
  const fetchedTime = new Date(lastFetched).getTime();
  if (Number.isNaN(fetchedTime)) return true; // corrupted date → treat as stale
  const ageMs = Date.now() - fetchedTime;
  return ageMs > lifetimeDays * 24 * 60 * 60 * 1000;
}

export function isCacheStale(item: _ZoteroTypes.Item): boolean {
  const { citegeistFields } = parseExtra(item);
  return isLastFetchedStale(citegeistFields);
}

export async function clearCache(item: _ZoteroTypes.Item): Promise<void> {
  const { otherLines } = parseExtra(item);
  writeExtra(item, new Map(), otherLines);
  await item.saveTx();
}

// ── Title-match metadata ──────────────────────────────────────────────────────

export type MatchMethod = "doi" | "pmid" | "arxiv" | "isbn" | "title-match";
export type MatchTier = "high" | "medium";

function isMatchTier(v: unknown): v is MatchTier {
  return v === "high" || v === "medium";
}

function isMatchMethod(v: unknown): v is MatchMethod {
  return (
    v === "doi" || v === "pmid" || v === "arxiv" || v === "isbn" || v === "title-match"
  );
}

export interface TitleMatchMeta {
  noMatch: boolean;
  noMatchTimestamp: string | null;
  matchMethod: MatchMethod | null;
  matchConfidence: MatchTier | null;
  /** Stored after researcher confirms a title match — bypasses title search on refresh. */
  confirmedOpenAlexId: string | null;
}

export function getTitleMatchMeta(item: _ZoteroTypes.Item): TitleMatchMeta {
  const { citegeistFields } = parseExtra(item);
  return {
    noMatch: citegeistFields.get(`${PREFIX}noMatch`) === "true",
    noMatchTimestamp: citegeistFields.get(`${PREFIX}noMatchTimestamp`) || null,
    matchMethod: ((): MatchMethod | null => {
      const v = citegeistFields.get(`${PREFIX}matchMethod`);
      return isMatchMethod(v) ? v : null;
    })(),
    matchConfidence: ((): MatchTier | null => {
      const v = citegeistFields.get(`${PREFIX}matchConfidence`);
      return isMatchTier(v) ? v : null;
    })(),
    confirmedOpenAlexId: citegeistFields.get(`${PREFIX}confirmedOpenAlexId`) || null,
  };
}

/** Write a no-match flag (auto or dismissed). Preserves all other Citegeist data. */
export async function writeNoMatch(item: _ZoteroTypes.Item): Promise<void> {
  const { citegeistFields, otherLines } = parseExtra(item);
  citegeistFields.set(`${PREFIX}noMatch`, "true");
  citegeistFields.set(`${PREFIX}noMatchTimestamp`, new Date().toISOString());
  writeExtra(item, citegeistFields, otherLines);
  await item.saveTx();
}

/**
 * Confirm a title match: mark matchMethod/Confidence and store confirmedOpenAlexId
 * so future fetches go directly to the work by ID, bypassing title search.
 *
 * Uses pendingSuggestionId as the source of truth — cacheWorkData has not run yet
 * at the point of confirmation, so Citegeist.openAlexId is not set.
 */
export async function confirmTitleMatch(item: _ZoteroTypes.Item, tier: MatchTier): Promise<void> {
  const { citegeistFields, otherLines } = parseExtra(item);
  citegeistFields.delete(`${PREFIX}noMatch`);
  citegeistFields.delete(`${PREFIX}noMatchTimestamp`);
  citegeistFields.set(`${PREFIX}matchMethod`, "title-match");
  citegeistFields.set(`${PREFIX}matchConfidence`, tier);
  // pendingSuggestionId is the OpenAlex work ID — promote it so the next fetch goes direct
  const pendingId =
    citegeistFields.get(`${PREFIX}pendingSuggestionId`) ||
    citegeistFields.get(`${PREFIX}openAlexId`);
  if (pendingId) {
    citegeistFields.set(`${PREFIX}confirmedOpenAlexId`, pendingId);
  }
  writeExtra(item, citegeistFields, otherLines);
  await item.saveTx();
}

/**
 * Check if a no-match flag is still within the retry suppression window.
 */
export function isNoMatchSuppressed(item: _ZoteroTypes.Item, retryDays: number): boolean {
  const { citegeistFields } = parseExtra(item);
  if (citegeistFields.get(`${PREFIX}noMatch`) !== "true") return false;
  const ts = citegeistFields.get(`${PREFIX}noMatchTimestamp`);
  if (!ts) return true; // flag exists but no timestamp — suppress
  const age = Date.now() - new Date(ts).getTime();
  return age < retryDays * 24 * 60 * 60 * 1000;
}

/**
 * Write the pending suggestion candidate to Extra so the pane can render
 * the confirmation card without re-fetching. Stores minimal fields only.
 */
export async function writePendingSuggestion(
  item: _ZoteroTypes.Item,
  work: {
    id: string;
    display_name: string;
    cited_by_count: number;
    fwci: number | null;
    publication_year: number;
    doi: string | null;
  },
  tier: MatchTier,
  confidence: number,
): Promise<void> {
  const { citegeistFields, otherLines } = parseExtra(item);
  citegeistFields.set(`${PREFIX}pendingSuggestionId`, sanitizeCacheValue(work.id.replace("https://openalex.org/", "")));
  citegeistFields.set(`${PREFIX}pendingSuggestionTitle`, sanitizeCacheValue(work.display_name));
  citegeistFields.set(`${PREFIX}pendingSuggestionCount`, String(work.cited_by_count));
  citegeistFields.set(
    `${PREFIX}pendingSuggestionFwci`,
    work.fwci !== null ? work.fwci.toFixed(2) : "",
  );
  citegeistFields.set(`${PREFIX}pendingSuggestionYear`, String(work.publication_year));
  citegeistFields.set(`${PREFIX}pendingSuggestionTier`, tier);
  citegeistFields.set(`${PREFIX}pendingSuggestionConfidence`, confidence.toFixed(3));
  if (work.doi) {
    citegeistFields.set(`${PREFIX}pendingSuggestionDoi`, sanitizeCacheValue(work.doi));
  }
  writeExtra(item, citegeistFields, otherLines);
  await item.saveTx();
}

export interface PendingSuggestion {
  openAlexId: string;
  title: string;
  citedByCount: number;
  fwci: number | null;
  year: number | null;
  tier: MatchTier;
  confidence: number;
  /** DOI from the matched work — offered to the researcher on confirm to permanently graduate the item. */
  doi: string | null;
}

export function getPendingSuggestion(item: _ZoteroTypes.Item): PendingSuggestion | null {
  const { citegeistFields } = parseExtra(item);
  const openAlexId = citegeistFields.get(`${PREFIX}pendingSuggestionId`);
  if (!openAlexId) return null;
  return {
    openAlexId,
    title: citegeistFields.get(`${PREFIX}pendingSuggestionTitle`) || "",
    citedByCount: safeParseInt(citegeistFields.get(`${PREFIX}pendingSuggestionCount`)),
    fwci: safeParseFloat(citegeistFields.get(`${PREFIX}pendingSuggestionFwci`)),
    year: ((): number | null => {
      const s = citegeistFields.get(`${PREFIX}pendingSuggestionYear`);
      if (!s) return null;
      const n = safeParseInt(s);
      return n > 0 ? n : null;
    })(),
    tier: ((): MatchTier => {
      const t = citegeistFields.get(`${PREFIX}pendingSuggestionTier`);
      return isMatchTier(t) ? t : "medium";
    })(),
    confidence: safeParseFloat(citegeistFields.get(`${PREFIX}pendingSuggestionConfidence`)) ?? 0,
    doi: citegeistFields.get(`${PREFIX}pendingSuggestionDoi`) || null,
  };
}

export async function clearPendingSuggestion(item: _ZoteroTypes.Item): Promise<void> {
  const { citegeistFields, otherLines } = parseExtra(item);
  for (const key of [
    `${PREFIX}pendingSuggestionId`,
    `${PREFIX}pendingSuggestionTitle`,
    `${PREFIX}pendingSuggestionCount`,
    `${PREFIX}pendingSuggestionFwci`,
    `${PREFIX}pendingSuggestionYear`,
    `${PREFIX}pendingSuggestionTier`,
    `${PREFIX}pendingSuggestionConfidence`,
    `${PREFIX}pendingSuggestionDoi`,
  ]) {
    citegeistFields.delete(key);
  }
  writeExtra(item, citegeistFields, otherLines);
  await item.saveTx();
}

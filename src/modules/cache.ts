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

import type { OpenAlexWork } from "./openalex";
import { safeParseInt, safeParseFloat } from "./utils";

const PREFIX = "Citegeist.";

export interface CachedData {
  openAlexId: string;
  citedByCount: number;
  fwci: number | null;
  percentile: number | null;
  isTop1Percent: boolean;
  isTop10Percent: boolean;
  isRetracted: boolean;
  lastFetched: string;
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
export function getCachedCountAndStaleness(
  item: _ZoteroTypes.Item,
): { count: number | null; isStale: boolean } {
  const { citegeistFields } = parseExtra(item);
  const countStr = citegeistFields.get(`${PREFIX}citedByCount`);
  const count = countStr !== undefined ? safeParseInt(countStr) : null;

  return { count, isStale: isLastFetchedStale(citegeistFields) };
}

/**
 * Read FWCI and percentile alongside count and staleness in one parse.
 * Used by columns to avoid parsing Extra multiple times per item.
 */
export function getCachedMetrics(
  item: _ZoteroTypes.Item,
): { count: number | null; fwci: number | null; percentile: number | null; isStale: boolean } {
  const { citegeistFields } = parseExtra(item);
  const countStr = citegeistFields.get(`${PREFIX}citedByCount`);
  const count = countStr !== undefined ? safeParseInt(countStr) : null;
  const fwci = safeParseFloat(citegeistFields.get(`${PREFIX}fwci`));
  const percentile = safeParseFloat(citegeistFields.get(`${PREFIX}percentile`));
  return { count, fwci, percentile, isStale: isLastFetchedStale(citegeistFields) };
}

export function getCachedCitationCount(
  item: _ZoteroTypes.Item,
): number | null {
  const { citegeistFields } = parseExtra(item);
  const val = citegeistFields.get(`${PREFIX}citedByCount`);
  return val !== undefined ? safeParseInt(val) : null;
}

export function getCachedOpenAlexId(
  item: _ZoteroTypes.Item,
): string | null {
  const { citegeistFields } = parseExtra(item);
  return citegeistFields.get(`${PREFIX}openAlexId`) || null;
}

export function getCachedData(
  item: _ZoteroTypes.Item,
): CachedData | null {
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
  };
}

export async function cacheWorkData(
  item: _ZoteroTypes.Item,
  work: OpenAlexWork,
): Promise<void> {
  const { citegeistFields, otherLines } = parseExtra(item);

  citegeistFields.set(`${PREFIX}openAlexId`, work.id.replace("https://openalex.org/", ""));
  citegeistFields.set(`${PREFIX}citedByCount`, String(work.cited_by_count));

  if (work.fwci !== null && work.fwci !== undefined) {
    citegeistFields.set(`${PREFIX}fwci`, work.fwci.toFixed(2));
  }
  if (work.citation_normalized_percentile) {
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
  }
  citegeistFields.set(`${PREFIX}isRetracted`, String(work.is_retracted));
  citegeistFields.set(`${PREFIX}lastFetched`, new Date().toISOString());

  writeExtra(item, citegeistFields, otherLines);
  await item.saveTx();
}

/**
 * Check staleness from already-parsed Citegeist fields.
 */
function isLastFetchedStale(citegeistFields: Map<string, string>): boolean {
  const lastFetched = citegeistFields.get(`${PREFIX}lastFetched`);
  if (!lastFetched) return true;

  const lifetimeDays =
    (Zotero.Prefs.get("extensions.zotero.citegeist.cacheLifetimeDays") as number) || 7;
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

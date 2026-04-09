/**
 * Orchestrates fetching citation data from OpenAlex and caching it.
 * Used by column, pane, and batch operations.
 *
 * Identifier resolution order (first match wins):
 *   1. DOI          — item.getField("DOI")
 *   2. PMID         — "PMID: 12345678" line in Extra field
 *   3. arXiv ID     — "arXiv: 2205.01833" line in Extra field
 *   4. arXiv ID     — item.getField("archiveID") (Zotero preprint field)
 *   5. arXiv ID     — arxiv.org URL in item.getField("url")
 */

import {
  getWorkByDOI,
  getWorkByPMID,
  getWorkByArxivId,
  getWorkByISBN,
  getSourceStats,
  normalizeDOI,
  normalizePMID,
  normalizeArxivId,
  normalizeISBN,
  type OpenAlexWork,
} from "./openalex";
import { cacheWorkData, isCacheStale, getCachedData } from "./cache";
import { OpenAlexNetworkError, logError } from "./utils";
import { BULK_FETCH_DELAY_MS } from "../constants";

/** Reason a fetch didn't produce a work. */
export type FetchError = "no-identifier" | "not-found" | "network" | "invalid-item";

export interface FetchResult {
  success: boolean;
  work: OpenAlexWork | null;
  /** Present when `success` is false — lets UI render a targeted message. */
  error?: FetchError;
}

/** A resolved identifier ready for an OpenAlex lookup. */
export interface ItemIdentifier {
  type: "doi" | "pmid" | "arxiv" | "isbn";
  value: string;
}

/**
 * Extract the best available identifier from a Zotero item.
 *
 * Returns the first non-empty identifier found in priority order,
 * or `null` if the item has no usable identifier.
 */
export function extractIdentifier(item: _ZoteroTypes.Item): ItemIdentifier | null {
  // 1. DOI — highest fidelity, always preferred
  const doi = normalizeDOI((item.getField("DOI") as string) || "");
  if (doi) return { type: "doi", value: doi };

  const extra = (item.getField("extra") as string) || "";

  // 2. PMID from Extra field (Zotero convention: "PMID: 12345678")
  for (const line of extra.split("\n")) {
    const m = line.match(/^pmid:\s*(\d{1,10})\s*$/i);
    if (m) {
      const pmid = normalizePMID(m[1]);
      if (pmid) return { type: "pmid", value: pmid };
    }
  }

  // 3. arXiv from Extra field (Zotero convention: "arXiv: 2205.01833")
  for (const line of extra.split("\n")) {
    const m = line.match(/^arxiv:\s*(\S+)\s*$/i);
    if (m) {
      const id = normalizeArxivId(m[1]);
      if (id) return { type: "arxiv", value: id };
    }
  }

  // 4. arXiv from Zotero's archiveID field (set on preprint item type)
  try {
    const archiveId = ((item.getField("archiveID") as string) || "").trim();
    if (archiveId) {
      const id = normalizeArxivId(archiveId);
      if (id) return { type: "arxiv", value: id };
    }
  } catch {
    // Field may not exist for this item type
  }

  // 5. arXiv from URL (e.g., https://arxiv.org/abs/2205.01833)
  const url = (item.getField("url") as string) || "";
  const urlMatch = url.match(/arxiv\.org\/(?:abs|pdf)\/([\w./][\w./-]*)/i);
  if (urlMatch) {
    const id = normalizeArxivId(urlMatch[1]);
    if (id) return { type: "arxiv", value: id };
  }

  // 6. ISBN — for books and book chapters (Zotero: "book", "bookSection")
  const isbn = normalizeISBN((item.getField("ISBN") as string) || "");
  if (isbn) return { type: "isbn", value: isbn };

  return null;
}

/**
 * Fetch citation data for a single Zotero item and cache it.
 * Returns the work data on success so callers can use it without a second API call.
 */
export async function fetchAndCacheItem(item: _ZoteroTypes.Item): Promise<FetchResult> {
  if (!item.isRegularItem()) {
    return { success: false, work: null, error: "invalid-item" };
  }

  const identifier = extractIdentifier(item);
  if (!identifier) {
    return { success: false, work: null, error: "no-identifier" };
  }

  // Skip if cache is fresh
  if (!isCacheStale(item)) return { success: true, work: null };

  let work: OpenAlexWork | null;
  try {
    switch (identifier.type) {
      case "doi":
        work = await getWorkByDOI(identifier.value);
        break;
      case "pmid":
        work = await getWorkByPMID(identifier.value);
        break;
      case "arxiv":
        work = await getWorkByArxivId(identifier.value);
        break;
      case "isbn":
        work = await getWorkByISBN(identifier.value);
        break;
    }
  } catch (e) {
    if (e instanceof OpenAlexNetworkError) {
      logError(`fetchAndCacheItem(${item.id})`, e);
      return { success: false, work: null, error: "network" };
    }
    throw e;
  }
  if (!work) return { success: false, work: null, error: "not-found" };

  // Fetch journal-level stats (best-effort — `null` on failure is fine).
  const sourceId = work.primary_location?.source?.id;
  const sourceStats = sourceId ? await getSourceStats(sourceId) : null;

  await cacheWorkData(item, work, sourceStats);
  return { success: true, work };
}

/**
 * Batch fetch citation data for multiple items.
 * Returns count of successfully fetched items.
 */
export async function fetchAndCacheItems(
  items: _ZoteroTypes.Item[],
  onProgress?: (current: number, total: number) => void,
): Promise<number> {
  const eligible = items.filter((item) => item.isRegularItem() && extractIdentifier(item));

  let fetched = 0;

  for (let i = 0; i < eligible.length; i++) {
    try {
      const result = await fetchAndCacheItem(eligible[i]);
      if (result.success) fetched++;
    } catch (e) {
      logError(`fetchAndCacheItems item ${eligible[i].id}`, e);
    }

    onProgress?.(i + 1, eligible.length);

    if (i < eligible.length - 1) {
      await new Promise((r) => setTimeout(r, BULK_FETCH_DELAY_MS));
    }
  }

  return fetched;
}

export { getCachedData };

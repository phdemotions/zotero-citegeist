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
 *   6. ISBN         — item.getField("ISBN") (books, book sections)
 */

import {
  getWorkByDOI,
  getWorkByPMID,
  getWorkByArxivId,
  getWorkByISBN,
  getWorkById,
  getSourceStats,
  normalizeDOI,
  normalizePMID,
  normalizeArxivId,
  normalizeISBN,
  type OpenAlexWork,
} from "./openalex";
import {
  cacheItemAuthors,
  cacheWorkData,
  isCacheStale,
  getCachedData,
  getCachedOpenAlexId,
  getItemAuthors,
  isNoMatchSuppressed,
  writeNoMatch,
  writePendingSuggestion,
  getTitleMatchMeta,
} from "./cache";
import { searchByMetadata, type TitleMatchResult } from "./titleSearch";
import { OpenAlexNetworkError, OpenAlexBudgetError, logError } from "./utils";
import { BULK_FETCH_DELAY_MS, NO_MATCH_RETRY_DAYS } from "../constants";

/** Reason a fetch didn't produce a work. */
export type FetchError = "no-identifier" | "not-found" | "network" | "invalid-item" | "no-match";

/**
 * Discriminated union for fetch results. Five states:
 *   "ok"         — fresh data fetched; `work` is the OpenAlex record
 *   "cached"     — cache is still fresh; nothing was fetched
 *   "error"      — fetch failed; `error` describes why
 *   "suggestion" — title match found but unconfirmed; `candidate` holds the work
 */
export type FetchResult =
  | { status: "ok"; work: OpenAlexWork }
  | { status: "cached" }
  | { status: "error"; error: FetchError }
  | { status: "suggestion"; candidate: OpenAlexWork; tier: "high" | "medium"; confidence: number };

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

  const extraLines = extra.split("\n");

  // 2. PMID from Extra field (Zotero convention: "PMID: 12345678")
  for (const line of extraLines) {
    const m = line.match(/^pmid:\s*(\d{1,10})\s*$/i);
    if (m) {
      const pmid = normalizePMID(m[1]);
      if (pmid) return { type: "pmid", value: pmid };
    }
  }

  // 3. arXiv from Extra field (Zotero convention: "arXiv: 2205.01833")
  for (const line of extraLines) {
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
 * True when the citation-network browser can resolve this item to an
 * OpenAlex work — i.e. the item has a user-confirmed title-match id, or any
 * recognized identifier (DOI / PMID / arXiv / ISBN).
 *
 * This is the single predicate the menu and citation-network dialog gate on, so
 * the "View citing works / references" affordance is not offered for an item with
 * no recognized identifier. (Previously the menu gated on `extractIdentifier`
 * while the dialog hard-required a DOI, so a PMID/arXiv/ISBN-only item showed
 * an enabled menu entry that dead-ended on a "no DOI" alert.) One residual
 * corner: an item whose only link is a confirmed match id that has since been
 * de-indexed from OpenAlex still passes here, then lands on the dialog's
 * graceful "Not found" state rather than an alert — the intended UX.
 */
export function canResolveWork(item: _ZoteroTypes.Item): boolean {
  if (!item.isRegularItem()) return false;
  if (getTitleMatchMeta(item).confirmedOpenAlexId) return true;
  return extractIdentifier(item) !== null;
}

/**
 * Map a resolved identifier to its OpenAlex client call. The single place that
 * switches on `ItemIdentifier.type` — shared by `resolveWorkForItem` and
 * `fetchAndCacheItem` so the mapping (and its exhaustiveness) lives in exactly
 * one spot. Returns `null` when the work isn't on OpenAlex; throws
 * `OpenAlexNetworkError` when the service is unreachable. The `default` arm is
 * an exhaustiveness guard: adding a new identifier type fails to compile here,
 * pointing at the unhandled case, rather than silently returning `undefined`.
 */
function fetchWorkByIdentifier(identifier: ItemIdentifier): Promise<OpenAlexWork | null> {
  switch (identifier.type) {
    case "doi":
      return getWorkByDOI(identifier.value);
    case "pmid":
      return getWorkByPMID(identifier.value);
    case "arxiv":
      return getWorkByArxivId(identifier.value);
    case "isbn":
      return getWorkByISBN(identifier.value);
    default: {
      const unhandled: never = identifier.type;
      throw new Error(`Unhandled identifier type: ${String(unhandled)}`);
    }
  }
}

/**
 * Resolve a Zotero item to its OpenAlex work for the citation-network browser.
 * Tries the user-confirmed title-match id first, then the best available
 * identifier (DOI → PMID → arXiv → ISBN), mirroring `fetchAndCacheItem`'s
 * resolution order.
 *
 * Unlike `fetchAndCacheItem`, this never short-circuits on cache freshness: the
 * browser always needs the live work object, whose `id` drives the citing and
 * referenced-works queries. Returns `null` when the item has no resolvable
 * identifier or the work isn't on OpenAlex; throws `OpenAlexNetworkError` when
 * the service is unreachable (callers render the "OpenAlex unavailable" state).
 */
export async function resolveWorkForItem(item: _ZoteroTypes.Item): Promise<OpenAlexWork | null> {
  const matchMeta = getTitleMatchMeta(item);
  if (matchMeta.confirmedOpenAlexId) {
    const confirmed = await getWorkById(matchMeta.confirmedOpenAlexId);
    if (confirmed) return confirmed;
    // Confirmed id no longer resolves — fall through to identifier lookup.
  }

  const identifier = extractIdentifier(item);
  if (!identifier) return null;

  return fetchWorkByIdentifier(identifier);
}

/**
 * Fetch citation data for a single Zotero item and cache it.
 * Returns the work data on success so callers can use it without a second API call.
 */
export async function fetchAndCacheItem(item: _ZoteroTypes.Item): Promise<FetchResult> {
  if (!item.isRegularItem() || item.deleted) {
    return { status: "error", error: "invalid-item" };
  }

  // If researcher previously confirmed a title match, use the stored OpenAlex ID directly.
  const matchMeta = getTitleMatchMeta(item);
  if (matchMeta.confirmedOpenAlexId) {
    if (!isCacheStale(item)) return { status: "cached" };
    try {
      const work = await getWorkById(matchMeta.confirmedOpenAlexId);
      if (work) {
        const sourceStats = work.primary_location?.source?.id
          ? await getSourceStats(work.primary_location.source.id)
          : null;
        await cacheWorkData(item, work, sourceStats);
        // Piggyback author identity on the same fetched work (no new API call).
        // Failure-isolated: an author-write error must not fail the metrics
        // result that already persisted. No column repaint — authors have no
        // v1 column (KTD5); the pane reads them async.
        await cacheItemAuthors(item, work.authorships).catch((e) =>
          logError("cacheItemAuthors(confirmed)", e),
        );
        return { status: "ok", work };
      }
    } catch (e) {
      if (e instanceof OpenAlexNetworkError) {
        logError(`fetchAndCacheItem(confirmed id ${matchMeta.confirmedOpenAlexId})`, e);
        return { status: "error", error: "network" };
      }
      throw e;
    }
    // Confirmed ID no longer found — fall through to title search
  }

  const identifier = extractIdentifier(item);

  if (!identifier) {
    // No identifier — try title search (unless suppressed)
    return attemptTitleSearch(item);
  }

  // Skip if cache is fresh
  if (!isCacheStale(item)) return { status: "cached" };

  let work: OpenAlexWork | null;
  try {
    work = await fetchWorkByIdentifier(identifier);
  } catch (e) {
    if (e instanceof OpenAlexNetworkError) {
      logError(`fetchAndCacheItem(${item.id})`, e);
      return { status: "error", error: "network" };
    }
    throw e;
  }

  if (!work) {
    // Identifier found but not in OpenAlex — try title search as fallback
    return attemptTitleSearch(item);
  }

  // Fetch journal-level stats (best-effort — `null` on failure is fine).
  const sourceId = work.primary_location?.source?.id;
  const sourceStats = sourceId ? await getSourceStats(sourceId) : null;

  await cacheWorkData(item, work, sourceStats);
  await cacheItemAuthors(item, work.authorships).catch((e) => logError("cacheItemAuthors", e));
  return { status: "ok", work };
}

/**
 * Attempt a title-based metadata search after direct lookup failed.
 * Handles the no-match suppression window and writes the result to cache.
 */
async function attemptTitleSearch(item: _ZoteroTypes.Item): Promise<FetchResult> {
  // Don't re-search if researcher dismissed or we already found no match recently
  if (isNoMatchSuppressed(item, NO_MATCH_RETRY_DAYS)) {
    return { status: "error", error: "no-match" };
  }

  let match: TitleMatchResult | null;
  try {
    match = await searchByMetadata(item);
  } catch (e) {
    if (e instanceof OpenAlexNetworkError) {
      logError(`attemptTitleSearch(${item.id})`, e);
      return { status: "error", error: "network" };
    }
    throw e;
  }

  if (!match) {
    await writeNoMatch(item);
    return { status: "error", error: "no-match" };
  }

  // Store the suggestion so the pane can render the card without re-fetching
  await writePendingSuggestion(
    item,
    { ...match.work, doi: match.work.doi ?? null },
    match.tier,
    match.confidence,
  );

  return {
    status: "suggestion",
    candidate: match.work,
    tier: match.tier,
    confidence: match.confidence,
  };
}

/**
 * Breakdown returned by `fetchAndCacheItems` — lets the UI describe
 * what actually happened instead of conflating "no work needed" with
 * "failed". User reported the old "Done — 0 items updated" message
 * after running Fetch Citations on a library that had already been
 * auto-fetched: every item came back `"cached"` (data still fresh)
 * but the menu copy implied total failure.
 */
export interface FetchBatchResult {
  /** Items where a new OpenAlex fetch landed fresh data. */
  fresh: number;
  /** Items whose cache was still within the lifetime window — no API call. */
  cached: number;
  /** Items with an unconfirmed title-match suggestion now pending. */
  suggestion: number;
  /** Items the fetch attempt couldn't resolve (network / not-found / no-match). */
  errors: number;
}

/**
 * Batch fetch citation data for multiple items. Returns a breakdown
 * so callers can show a useful summary.
 */
export async function fetchAndCacheItems(
  items: _ZoteroTypes.Item[],
  onProgress?: (current: number, total: number) => void,
  /**
   * Fired right after each item's fetch resolves, with the item id and the
   * result status. Lets callers repaint that row's columns AS data lands
   * (progressive updates over a long collection/library fetch) instead of
   * waiting for the whole batch to finish.
   */
  onItemDone?: (itemId: number, status: string) => void,
): Promise<FetchBatchResult> {
  const eligible = items.filter((item) => item.isRegularItem());

  const out: FetchBatchResult = { fresh: 0, cached: 0, suggestion: 0, errors: 0 };

  for (let i = 0; i < eligible.length; i++) {
    let status = "error";
    try {
      const result = await fetchAndCacheItem(eligible[i]);
      status = result.status;
      if (result.status === "ok") out.fresh++;
      else if (result.status === "cached") out.cached++;
      else if (result.status === "suggestion") out.suggestion++;
      else out.errors++;
    } catch (e) {
      out.errors++;
      logError(`fetchAndCacheItems item ${eligible[i].id}`, e);
    }

    onItemDone?.(eligible[i].id, status);
    onProgress?.(i + 1, eligible.length);

    if (i < eligible.length - 1) {
      await new Promise((r) => setTimeout(r, BULK_FETCH_DELAY_MS));
    }
  }

  return out;
}

// ── Author identity backfill (U4) ────────────────────────────────────────────

/** Outcome of resolving one item's author identity in the backfill pass. */
export type AuthorResolveStatus = "resolved" | "already" | "unresolved" | "budget" | "error";

/**
 * Ensure a single item's authors are resolved into the SQLite item_authors
 * table. Idempotent + resumable: an item that already has resolved authors is
 * skipped. Re-fetch is via `getWorkById` — a free OpenAlex singleton lookup — so
 * a whole-library pass costs no metered budget for identity. Writes no native
 * Zotero relation (the `openalex:author` predicate breaks Zotero sync — see the
 * NOTE in the body and relations.ts).
 */
export async function resolveAuthorsForItem(item: _ZoteroTypes.Item): Promise<AuthorResolveStatus> {
  if (!item.isRegularItem() || item.deleted) return "unresolved";

  try {
    // Read inside the try so a cache/DB read rejection returns "error" instead of
    // throwing out of this function — the batch pass (resolveAuthorsForItems)
    // relies on the no-throw status contract to stay per-item isolated and
    // resumable; a bare throw here would abort the entire "Resolve all" pass.
    // NOTE: authors are persisted ONLY to the SQLite item_authors table (the
    // source of truth + the external/Obsidian handoff via citegeist.sqlite). We
    // deliberately do NOT write a native Zotero `openalex:author` item relation:
    // Zotero's sync SERVER rejects that custom predicate ("Error 400 ...
    // Unsupported predicate 'openalex:author'") and halts the user's entire
    // library sync ("Made no progress during upload"). The relation handoff is
    // disabled until a sync-safe mechanism exists — see relations.ts.
    const existing = await getItemAuthors(item.libraryID, item.key);
    if (existing.length > 0) return "already";

    const workId = getCachedOpenAlexId({ libraryID: item.libraryID, key: item.key });
    if (!workId) {
      // Never resolved to a work — do the full fetch (free identifier lookups),
      // which piggybacks author identity via the normal cacheWorkData path.
      const r = await fetchAndCacheItem(item);
      if (r.status === "ok") return "resolved";
      return r.status === "cached" ? "already" : "unresolved";
    }

    const work = await getWorkById(workId);
    if (!work) return "unresolved";
    await cacheItemAuthors(item, work.authorships);
    const after = await getItemAuthors(item.libraryID, item.key);
    return after.length > 0 ? "resolved" : "unresolved";
  } catch (e) {
    if (e instanceof OpenAlexBudgetError) return "budget";
    logError(`resolveAuthorsForItem(${item.id})`, e);
    return "error";
  }
}

/**
 * Breakdown of the explicit "Resolve author identities" pass. A distinct
 * `budgetStopped` count keeps a daily-budget stop from being reported as a
 * genuine no-match (the miscount class `summarizeBatch` already had to fix).
 */
export interface AuthorBackfillResult {
  resolved: number;
  already: number;
  unresolved: number;
  budgetStopped: number;
  errors: number;
  cancelled: boolean;
}

/**
 * Resolve author identity across many items — resumable and rate-limited. Stops
 * cleanly on budget exhaustion (this item and all remaining are counted as
 * `budgetStopped`, not attempted) and on a cancel request. Items already
 * resolved are skipped.
 */
export async function resolveAuthorsForItems(
  items: _ZoteroTypes.Item[],
  onProgress?: (current: number, total: number) => void,
  onItemDone?: (itemId: number, status: AuthorResolveStatus) => void,
  shouldCancel?: () => boolean,
): Promise<AuthorBackfillResult> {
  const eligible = items.filter((i) => i.isRegularItem() && !i.deleted);
  const out: AuthorBackfillResult = {
    resolved: 0,
    already: 0,
    unresolved: 0,
    budgetStopped: 0,
    errors: 0,
    cancelled: false,
  };

  for (let i = 0; i < eligible.length; i++) {
    if (shouldCancel?.()) {
      out.cancelled = true;
      break;
    }

    const status = await resolveAuthorsForItem(eligible[i]);
    if (status === "budget") {
      out.budgetStopped = eligible.length - i;
      break;
    }

    if (status === "resolved") out.resolved++;
    else if (status === "already") out.already++;
    else if (status === "error") out.errors++;
    else out.unresolved++;

    onItemDone?.(eligible[i].id, status);
    onProgress?.(i + 1, eligible.length);

    if (i < eligible.length - 1) {
      await new Promise((r) => setTimeout(r, BULK_FETCH_DELAY_MS));
    }
  }

  return out;
}

export { getCachedData };

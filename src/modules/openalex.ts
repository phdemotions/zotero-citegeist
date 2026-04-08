/**
 * OpenAlex API client for Citegeist.
 *
 * Uses Zotero.HTTP for requests. Implements polite pool via mailto,
 * field selection for minimal payloads, and cursor-based pagination.
 *
 * Error semantics: lookup helpers return `null` when a work is not found
 * on OpenAlex, and throw {@link OpenAlexNetworkError} when the API is
 * unreachable or returns a non-200 after retries. This lets callers
 * distinguish "no data" from "service unavailable" to render a helpful
 * message to users.
 */

import {
  OPENALEX_RATE_LIMIT_MS,
  OPENALEX_REQUEST_TIMEOUT_MS,
  OPENALEX_RETRY_DELAYS_MS,
  MAX_ABSTRACT_LENGTH,
  MAX_ABSTRACT_POSITION,
} from "../constants";
import { OpenAlexNetworkError, normalizeError, logError } from "./utils";

const OPENALEX_BASE = "https://api.openalex.org";

export interface OpenAlexWork {
  id: string;
  doi: string | null;
  title: string;
  display_name: string;
  publication_year: number;
  publication_date: string | null;
  cited_by_count: number;
  referenced_works_count: number;
  fwci: number | null;
  citation_normalized_percentile: {
    value: number;
    is_in_top_1_percent: boolean;
    is_in_top_10_percent: boolean;
  } | null;
  counts_by_year: Array<{ year: number; cited_by_count: number }>;
  open_access: {
    is_oa: boolean;
    oa_status: string;
    oa_url: string | null;
  } | null;
  authorships: Array<{
    author_position: string;
    author: {
      id: string;
      display_name: string;
      orcid: string | null;
    };
    institutions: Array<{
      id: string;
      display_name: string;
      country_code: string | null;
    }>;
    is_corresponding: boolean;
  }>;
  primary_location: {
    source: {
      id: string;
      display_name: string;
      issn_l: string | null;
      type: string;
    } | null;
  } | null;
  biblio: {
    volume: string | null;
    issue: string | null;
    first_page: string | null;
    last_page: string | null;
  } | null;
  type: string;
  is_retracted: boolean;
  referenced_works: string[];
  abstract_inverted_index: Record<string, number[]> | null;
}

export interface OpenAlexListResponse {
  meta: {
    count: number;
    per_page: number;
    next_cursor: string | null;
  };
  results: OpenAlexWork[];
}

function getMailto(): string {
  try {
    const mailto = Zotero.Prefs.get("extensions.zotero.citegeist.mailto") as string;
    return mailto || "";
  } catch {
    return "";
  }
}

function buildUrl(path: string, params: Record<string, string> = {}): string {
  const mailto = getMailto();
  if (mailto) {
    params.mailto = mailto;
  }
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${OPENALEX_BASE}${path}${query ? "?" + query : ""}`;
}

// ── Centralized rate limiter ──
// OpenAlex polite pool allows 10 req/s. We target 8 to stay safe.
let lastRequestTime = 0;

async function rateLimitedFetch<T>(url: string, label: string, attempt = 0): Promise<T> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < OPENALEX_RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, OPENALEX_RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();
  return fetchJson<T>(url, label, attempt);
}

async function fetchJson<T>(url: string, label: string, attempt: number): Promise<T> {
  let response: { status: number; responseText: string };
  try {
    response = await Zotero.HTTP.request("GET", url, {
      headers: {
        Accept: "application/json",
        "User-Agent": `Citegeist/1.0 (Zotero plugin; ${getMailto() || "no-mailto"})`,
      },
      responseType: "text",
      timeout: OPENALEX_REQUEST_TIMEOUT_MS,
    });
  } catch (e) {
    // Network-level failure (timeout, DNS, offline) — retry then bubble up.
    if (attempt < OPENALEX_RETRY_DELAYS_MS.length) {
      const delay = OPENALEX_RETRY_DELAYS_MS[attempt];
      Zotero.debug(
        `[Citegeist] Network error on ${label} (${normalizeError(e)}), retrying in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
      return fetchJson<T>(url, label, attempt + 1);
    }
    throw new OpenAlexNetworkError(`OpenAlex unreachable while fetching ${label}`, e);
  }

  // Retry with backoff on rate limiting / transient 5xx.
  if (
    (response.status === 429 || response.status >= 500) &&
    attempt < OPENALEX_RETRY_DELAYS_MS.length
  ) {
    const delay = OPENALEX_RETRY_DELAYS_MS[attempt];
    Zotero.debug(`[Citegeist] ${response.status} on ${label}, retrying in ${delay}ms`);
    await new Promise((r) => setTimeout(r, delay));
    return fetchJson<T>(url, label, attempt + 1);
  }

  if (response.status === 404) {
    // Let callers distinguish "not found" from other errors.
    throw new OpenAlexNotFoundError(label);
  }

  if (response.status !== 200) {
    throw new OpenAlexNetworkError(`OpenAlex ${response.status} while fetching ${label}`);
  }

  try {
    return JSON.parse(response.responseText) as T;
  } catch (e) {
    throw new OpenAlexNetworkError(`OpenAlex returned invalid JSON for ${label}`, e);
  }
}

/** Thrown internally when OpenAlex responds 404. Callers convert to `null`. */
class OpenAlexNotFoundError extends Error {
  constructor(label: string) {
    super(`OpenAlex 404: ${label}`);
    this.name = "OpenAlexNotFoundError";
  }
}

/**
 * Normalize a DOI string for safe use in an OpenAlex path segment.
 * Handles URL prefixes (http/https, with or without `dx.`), the `doi:`
 * scheme, mixed case, trailing slashes, and URL-encoded forward slashes.
 */
export function normalizeDOI(doi: string): string {
  return doi
    .trim()
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/%2[Ff]/g, "/")
    .replace(/\/+$/, "");
}

/** Full select fields for single-work lookups. */
const FULL_SELECT =
  "id,doi,title,display_name,publication_year,publication_date,cited_by_count," +
  "referenced_works_count,fwci,citation_normalized_percentile,counts_by_year," +
  "open_access,authorships,primary_location,biblio,type,is_retracted," +
  "referenced_works,abstract_inverted_index";

/** Lighter select for list results (no abstract, no full references). */
const LIST_SELECT =
  "id,doi,title,display_name,publication_year,publication_date,cited_by_count," +
  "fwci,citation_normalized_percentile," +
  "authorships,primary_location,biblio,open_access,type,is_retracted";

/**
 * Look up a work by DOI.
 *
 * @param doi Raw DOI ("10.1234/foo"), URL, or `doi:` scheme — see
 *            {@link normalizeDOI} for accepted forms.
 * @returns The OpenAlex work, or `null` if the DOI is blank or the work
 *          is not indexed on OpenAlex (404).
 * @throws {@link OpenAlexNetworkError} when OpenAlex is unreachable,
 *         rate-limiting persists past retries, or returns invalid JSON.
 */
export async function getWorkByDOI(doi: string): Promise<OpenAlexWork | null> {
  const cleanDOI = normalizeDOI(doi);
  if (!cleanDOI) return null;

  // Encode the DOI in the path segment — DOIs can contain parens, angles, etc.
  const url = buildUrl(`/works/doi:${encodeURIComponent(cleanDOI)}`, {
    select: FULL_SELECT,
  });

  try {
    const work = await rateLimitedFetch<OpenAlexWork>(url, `work doi:${cleanDOI}`);
    return normalizeWork(work);
  } catch (e) {
    if (e instanceof OpenAlexNotFoundError) return null;
    // Surface network errors so UI can render a distinct message.
    throw e;
  }
}

/**
 * Fetch works that cite a given work (pagination via OpenAlex cursor).
 *
 * @throws {@link OpenAlexNetworkError} on unreachable/5xx/invalid responses.
 */
export async function getCitingWorks(
  openAlexId: string,
  cursor: string = "*",
  perPage: number = 25,
): Promise<OpenAlexListResponse> {
  const shortId = openAlexId.replace("https://openalex.org/", "");
  const url = buildUrl("/works", {
    filter: `cites:${shortId}`,
    select: LIST_SELECT,
    sort: "cited_by_count:desc",
    per_page: String(perPage),
    cursor,
  });

  return rateLimitedFetch<OpenAlexListResponse>(url, `citing works for ${shortId}`);
}

/**
 * Fetch the works cited by a given work.
 *
 * Uses the `cited_by` filter ("works whose reference list includes X"),
 * which returns X's references with cursor pagination — reliable even
 * when the reference list is very long.
 *
 * @throws {@link OpenAlexNetworkError} on unreachable/5xx/invalid responses.
 */
export async function getReferencedWorks(
  parentOpenAlexId: string,
  cursor: string = "*",
  perPage: number = 25,
): Promise<OpenAlexListResponse> {
  const shortId = parentOpenAlexId.replace("https://openalex.org/", "");
  const url = buildUrl("/works", {
    filter: `cited_by:${shortId}`,
    select: LIST_SELECT,
    sort: "cited_by_count:desc",
    per_page: String(perPage),
    cursor,
  });

  return rateLimitedFetch<OpenAlexListResponse>(url, `references for ${shortId}`);
}

/**
 * Reconstruct an abstract from OpenAlex's inverted index.
 *
 * Defends against malformed indices: non-finite or out-of-range positions
 * are dropped, empty words are skipped, and the result is capped at
 * {@link MAX_ABSTRACT_LENGTH} characters so a runaway index can't exhaust
 * memory or blow up the UI.
 */
export function reconstructAbstract(invertedIndex: Record<string, number[]> | null): string | null {
  if (!invertedIndex || typeof invertedIndex !== "object") return null;
  const words: string[] = [];

  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (typeof word !== "string" || word.length === 0) continue;
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (
        typeof pos !== "number" ||
        !Number.isFinite(pos) ||
        pos < 0 ||
        pos > MAX_ABSTRACT_POSITION ||
        !Number.isInteger(pos)
      ) {
        continue;
      }
      words[pos] = word;
    }
  }

  const text = words
    .filter((w) => w !== undefined)
    .join(" ")
    .trim();
  if (!text) return null;
  if (text.length > MAX_ABSTRACT_LENGTH) {
    return text.slice(0, MAX_ABSTRACT_LENGTH);
  }
  return text;
}

/**
 * Sanitize an OpenAlex work response so downstream code can assume
 * required array/object fields are present.
 */
function normalizeWork(work: OpenAlexWork): OpenAlexWork {
  if (!Array.isArray(work.authorships)) work.authorships = [];
  if (!Array.isArray(work.counts_by_year)) work.counts_by_year = [];
  if (!Array.isArray(work.referenced_works)) work.referenced_works = [];
  return work;
}

/**
 * Look up a work by its OpenAlex ID (e.g., "W1234567890" or the full URL).
 * Returns full data including the inverted-index abstract.
 *
 * @returns The work, or `null` if not found (404).
 * @throws {@link OpenAlexNetworkError} on unreachable/5xx/invalid responses.
 */
export async function getWorkById(openAlexId: string): Promise<OpenAlexWork | null> {
  const shortId = openAlexId.replace("https://openalex.org/", "");
  const url = buildUrl(`/works/${encodeURIComponent(shortId)}`, {
    select: FULL_SELECT,
  });

  try {
    const work = await rateLimitedFetch<OpenAlexWork>(url, `work ${shortId}`);
    return normalizeWork(work);
  } catch (e) {
    if (e instanceof OpenAlexNotFoundError) return null;
    logError(`getWorkById(${shortId})`, e);
    throw e;
  }
}

// ────────────────────────────────────────────────────────
// Source (journal) stats
// ────────────────────────────────────────────────────────

export interface OpenAlexSourceStats {
  /** OpenAlex's JIF equivalent (mean citations for works published in last 2 years) */
  citedness2yr: number;
  /** Journal-level h-index */
  hIndex: number;
  /** Number of works with >= 10 citations */
  i10Index: number;
  /** All ISSNs for this source (for ranking lookups) */
  issns: string[];
}

/** In-memory cache for source stats to avoid repeated API calls within a session. */
const sourceStatsCache = new Map<string, OpenAlexSourceStats | null>();

/**
 * Fetch summary stats for a source/journal by its OpenAlex source ID.
 * Returns null if the source doesn't exist or has no stats.
 */
export async function getSourceStats(sourceId: string): Promise<OpenAlexSourceStats | null> {
  const shortId = sourceId.replace("https://openalex.org/", "");
  if (!shortId) return null;

  if (sourceStatsCache.has(shortId)) {
    return sourceStatsCache.get(shortId) ?? null;
  }

  try {
    const url = buildUrl(`/sources/${encodeURIComponent(shortId)}`, {
      select: "id,issn_l,issn,summary_stats",
    });
    const data = await rateLimitedFetch<{
      id: string;
      issn_l: string | null;
      issn: string[] | null;
      summary_stats: {
        "2yr_mean_citedness": number;
        h_index: number;
        i10_index: number;
      } | null;
    }>(url, `source ${shortId}`);

    if (!data.summary_stats) {
      sourceStatsCache.set(shortId, null);
      return null;
    }

    const result: OpenAlexSourceStats = {
      citedness2yr: data.summary_stats["2yr_mean_citedness"],
      hIndex: data.summary_stats.h_index,
      i10Index: data.summary_stats.i10_index,
      issns: [...(data.issn_l ? [data.issn_l] : []), ...(data.issn ?? [])],
    };
    sourceStatsCache.set(shortId, result);
    return result;
  } catch (e) {
    if (e instanceof OpenAlexNotFoundError) {
      sourceStatsCache.set(shortId, null);
      return null;
    }
    // For network issues, don't poison the cache — let the next call retry.
    logError(`getSourceStats(${shortId})`, e);
    return null;
  }
}

/** Clear the session-level source stats cache (call on shutdown). */
export function clearSourceStatsCache(): void {
  sourceStatsCache.clear();
}

/** Get cached ISSNs for a source (if previously fetched). Synchronous. */
export function getCachedSourceISSNs(sourceId: string): string[] {
  const shortId = sourceId.replace("https://openalex.org/", "");
  const cached = sourceStatsCache.get(shortId);
  return cached?.issns ?? [];
}

/**
 * Format authors for display: "Smith, Jones & Lee" or "Smith et al."
 */
export function formatAuthors(
  authorships: OpenAlexWork["authorships"],
  maxAuthors: number = 3,
): string {
  if (!authorships || authorships.length === 0) return "Unknown";
  const names = authorships.map((a) => {
    // Use the full display_name as-is — splitting on space breaks
    // names like "van der Berg" or "de la Cruz"
    return a.author.display_name;
  });
  if (names.length <= maxAuthors) {
    if (names.length === 1) return names[0];
    return names.slice(0, -1).join(", ") + " & " + names[names.length - 1];
  }
  return names[0] + " et al.";
}

/**
 * Extract a short source/journal name.
 */
export function getSourceName(work: OpenAlexWork): string {
  return work.primary_location?.source?.display_name || "Unknown source";
}

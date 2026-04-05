/**
 * OpenAlex API client for Citegeist.
 *
 * Uses Zotero.HTTP for requests. Implements polite pool via mailto,
 * field selection for minimal payloads, and cursor-based pagination.
 */

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
    const mailto = Zotero.Prefs.get(
      "extensions.zotero.citegeist.mailto",
    ) as string;
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
const RATE_LIMIT_INTERVAL_MS = 125; // 8 req/s
let lastRequestTime = 0;

async function rateLimitedFetch<T>(url: string, retries = 2): Promise<T> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
  return fetchJson<T>(url, retries);
}

async function fetchJson<T>(url: string, retries = 2): Promise<T> {
  const response = await Zotero.HTTP.request("GET", url, {
    headers: {
      Accept: "application/json",
      "User-Agent": `Citegeist/1.0 (Zotero plugin; ${getMailto() || "no-mailto"})`,
    },
    responseType: "text",
    timeout: 30000,
  });

  // Retry with backoff on rate limiting
  if (response.status === 429 && retries > 0) {
    const delay = (3 - retries) * 2000; // 2s, 4s
    Zotero.debug(`[Citegeist] Rate limited (429), retrying in ${delay}ms…`);
    await new Promise((r) => setTimeout(r, delay));
    return fetchJson<T>(url, retries - 1);
  }

  if (response.status !== 200) {
    throw new Error(`OpenAlex API error: ${response.status} for ${url}`);
  }

  try {
    return JSON.parse(response.responseText) as T;
  } catch {
    throw new Error(`OpenAlex returned invalid JSON for ${url}`);
  }
}

/**
 * Normalize a DOI string: strip URL prefix, trim whitespace.
 * Encodes the DOI for safe use in URLs.
 */
function normalizeDOI(doi: string): string {
  return doi
    .trim()
    .replace(/^https?:\/\/doi\.org\//i, "")
    .replace(/^doi:/i, "");
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
  "authorships,primary_location,biblio,open_access,type,is_retracted";

/**
 * Look up a work by DOI.
 */
export async function getWorkByDOI(
  doi: string,
): Promise<OpenAlexWork | null> {
  const cleanDOI = normalizeDOI(doi);
  if (!cleanDOI) return null;

  // Encode the DOI in the path segment — DOIs can contain parens, angles, etc.
  const url = buildUrl(`/works/doi:${encodeURIComponent(cleanDOI)}`, {
    select: FULL_SELECT,
  });

  try {
    return await rateLimitedFetch<OpenAlexWork>(url);
  } catch (e) {
    Zotero.debug(`[Citegeist] Failed to fetch work for DOI ${cleanDOI}: ${e}`);
    return null;
  }
}

/**
 * Get works that cite a given work (by OpenAlex ID).
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

  return rateLimitedFetch<OpenAlexListResponse>(url);
}

/**
 * Get works referenced by a given work.
 * Uses the `cited_by` filter which means "works whose reference list includes X"
 * — effectively returning X's references.
 *
 * For papers with many references, this uses cursor pagination properly
 * since it's a single filter query, not a batch ID lookup.
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

  return rateLimitedFetch<OpenAlexListResponse>(url);
}

/**
 * Reconstruct an abstract from OpenAlex's inverted index format.
 * The inverted index maps each word to its position(s) in the text.
 */
export function reconstructAbstract(
  invertedIndex: Record<string, number[]> | null,
): string | null {
  if (!invertedIndex) return null;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words[pos] = word;
    }
  }
  const text = words.filter((w) => w !== undefined).join(" ").trim();
  return text || null;
}

/**
 * Look up a work by its OpenAlex ID (e.g., "W1234567890" or full URL).
 * Returns full data including abstract.
 */
export async function getWorkById(
  openAlexId: string,
): Promise<OpenAlexWork | null> {
  const shortId = openAlexId.replace("https://openalex.org/", "");
  const url = buildUrl(`/works/${encodeURIComponent(shortId)}`, {
    select: FULL_SELECT,
  });

  try {
    return await rateLimitedFetch<OpenAlexWork>(url);
  } catch (e) {
    Zotero.debug(`[Citegeist] Failed to fetch work ${shortId}: ${e}`);
    return null;
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
export async function getSourceStats(
  sourceId: string,
): Promise<OpenAlexSourceStats | null> {
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
    }>(url);

    if (!data.summary_stats) {
      sourceStatsCache.set(shortId, null);
      return null;
    }

    const result: OpenAlexSourceStats = {
      citedness2yr: data.summary_stats["2yr_mean_citedness"],
      hIndex: data.summary_stats.h_index,
      i10Index: data.summary_stats.i10_index,
      issns: [
        ...(data.issn_l ? [data.issn_l] : []),
        ...(data.issn ?? []),
      ],
    };
    sourceStatsCache.set(shortId, result);
    return result;
  } catch (e) {
    Zotero.debug(`[Citegeist] Failed to fetch source stats for ${shortId}: ${e}`);
    sourceStatsCache.set(shortId, null);
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

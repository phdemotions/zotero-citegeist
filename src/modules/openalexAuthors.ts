/**
 * OpenAlex Authors client for Citegeist (U6 of the author-identity layer).
 *
 * Distinct from the works client (`openalex.ts`) but deliberately shares its
 * single rate limiter, URL builder (opt-in `api_key` + centralized redaction),
 * list select, work normalizer, and 404 sentinel — so the 8 req/s global budget
 * and key-safety guarantees hold across both clients. Never hit `Zotero.HTTP`
 * for OpenAlex directly; always route through the shared `rateLimitedFetch`.
 *
 * Metrics policy (KTD2): the `/authors` aggregates were observed returning zero
 * in July 2026 while the Works index stayed healthy. Prefer the free, exact
 * author aggregates when present and non-zero; derive from the works list only
 * when they're zero/absent. Identity (canonical id, display_name, orcid) always
 * comes from the singleton `/authors` lookup.
 *
 * 301 merges (KTD3): OpenAlex churns author ids; a stored `A…` can redirect to a
 * survivor. This client SURFACES that via `redirectedFrom` on the returned
 * profile but does NOT mutate storage — reconciliation (rewrite `item_authors`,
 * GC the orphaned `authors` row, re-assert the relation) is orchestration that
 * needs cache + item context and is wired where the profile is fetched (U7/U8).
 */

import { OPENALEX_AUTHOR_WORKS_PAGE_SIZE, OPENALEX_AUTHOR_HINDEX_PAGE_CAP } from "../constants";
import {
  rateLimitedFetch,
  buildUrl,
  resolveCanonicalId,
  normalizeWork,
  LIST_SELECT,
  OpenAlexNotFoundError,
  type OpenAlexListResponse,
} from "./openalex";
import { parseAuthorId } from "./cache/authors";
import { logError } from "./utils";

/** Fields fetched from the `/authors/{id}` singleton (identity + aggregates). */
const AUTHOR_SELECT = "id,display_name,orcid,works_count,cited_by_count,summary_stats";

/** Raw `/authors/{id}` response shape (only the fields we select). */
interface AuthorApiResponse {
  id?: string | null;
  display_name?: string | null;
  orcid?: string | null;
  works_count?: number | null;
  cited_by_count?: number | null;
  summary_stats?: {
    h_index?: number | null;
    i10_index?: number | null;
    "2yr_mean_citedness"?: number | null;
  } | null;
}

/** How an author profile's metrics were obtained. */
export type AuthorMetricsSource = "aggregates" | "derived";

/** The metric fields of a profile, shared by both derivation paths. */
type AuthorMetrics = Pick<
  OpenAlexAuthorProfile,
  "worksCount" | "citedByCount" | "hIndex" | "i10Index" | "metricsAreLowerBound" | "metricsSource"
>;

/** A resolved OpenAlex author: identity + metrics, with provenance flags. */
export interface OpenAlexAuthorProfile {
  /** Canonical OpenAlex author id (short form, e.g. "A5023888391"). */
  id: string;
  displayName: string | null;
  orcid: string | null;
  worksCount: number | null;
  citedByCount: number | null;
  hIndex: number | null;
  i10Index: number | null;
  /**
   * True when h-index / i10 are lower bounds — metrics were derived from works
   * and the page cap was hit before the crossover was observed. UI should render
   * the affected values with a "≥" prefix. Always false for aggregate metrics.
   */
  metricsAreLowerBound: boolean;
  /** Whether metrics came from the free aggregates or were derived from works. */
  metricsSource: AuthorMetricsSource;
  /**
   * Set to the REQUESTED id when it differed from the canonical `id` — i.e. the
   * lookup 301-redirected to a merged survivor (KTD3). The caller (U7/U8) is
   * responsible for reconciling stored `item_authors` rows + the relation URI.
   * Null when the requested id was already canonical.
   */
  redirectedFrom: string | null;
}

/**
 * Session cache of resolved profiles, keyed by BOTH the requested short id and
 * the canonical id (aliased on a 301) so a later lookup of either hits. Mirrors
 * `getSourceStats`'s session cache. `null` memoizes a 404. `redirectedFrom` is
 * recomputed per call (relative to what was asked), so caching the canonical
 * form is safe.
 */
const authorProfileCache = new Map<string, OpenAlexAuthorProfile | null>();

/** Attach the per-call redirect signal relative to the requested id. */
function withRedirect(profile: OpenAlexAuthorProfile, requestedId: string): OpenAlexAuthorProfile {
  return {
    ...profile,
    redirectedFrom: requestedId !== profile.id ? requestedId : null,
  };
}

/** h-index, i10-index, and total citations over a set of works. */
function computeWorksMetrics(works: ReadonlyArray<{ cited_by_count: number }>): {
  hIndex: number;
  i10Index: number;
  citationSum: number;
} {
  // Sort citations descending (the API sorts, but recompute defensively — the
  // h-index definition depends strictly on descending order).
  const cited = works.map((w) => w.cited_by_count ?? 0).sort((a, b) => b - a);
  let hIndex = 0;
  for (let i = 0; i < cited.length; i++) {
    if (cited[i] >= i + 1) hIndex = i + 1;
    else break;
  }
  const i10Index = cited.filter((c) => c >= 10).length;
  const citationSum = cited.reduce((sum, c) => sum + c, 0);
  return { hIndex, i10Index, citationSum };
}

/** Aggregate-path metrics (free + exact) straight off the author object. */
function metricsFromAggregates(body: AuthorApiResponse): AuthorMetrics {
  return {
    worksCount: body.works_count ?? null,
    citedByCount: body.cited_by_count ?? null,
    hIndex: body.summary_stats?.h_index ?? null,
    i10Index: body.summary_stats?.i10_index ?? null,
    metricsAreLowerBound: false,
    metricsSource: "aggregates",
  };
}

/**
 * Fetch works authored by a given OpenAlex author, one page at a time
 * (cursor-based). Sorted by citation count descending. Returns an empty
 * response for an unparseable id rather than firing a malformed metered query.
 *
 * @throws {@link OpenAlexBudgetError} / {@link OpenAlexAuthError} /
 *         {@link OpenAlexNetworkError} — same three-way discrimination as the
 *         works client.
 */
export async function fetchAuthorWorks(
  authorId: string,
  cursor: string = "*",
  perPage: number = OPENALEX_AUTHOR_WORKS_PAGE_SIZE,
): Promise<OpenAlexListResponse> {
  const shortId = parseAuthorId(authorId);
  if (!shortId) {
    return { meta: { count: 0, per_page: perPage, next_cursor: null }, results: [] };
  }
  const url = buildUrl("/works", {
    filter: `authorships.author.id:${shortId}`,
    select: LIST_SELECT,
    sort: "cited_by_count:desc",
    per_page: String(perPage),
    cursor,
  });
  const resp = await rateLimitedFetch<OpenAlexListResponse>(url, "works by author");
  return { ...resp, results: (resp.results ?? []).map(normalizeWork) };
}

/**
 * Derive metrics from the author's works when the aggregates are zeroed (KTD2).
 * Pages works (sorted by citations desc) until the h-index + i10 crossover is
 * observed, the works are exhausted, or {@link OPENALEX_AUTHOR_HINDEX_PAGE_CAP}
 * pages are read — whichever comes first. `worksCount` is always exact
 * (`meta.count`); h-index / i10 are exact once the crossover is seen and flagged
 * as lower bounds otherwise; `citedByCount` is the exact sum only when every work
 * was fetched (else null — a partial sum would misrepresent it).
 */
async function metricsFromWorks(authorId: string): Promise<AuthorMetrics> {
  const works: Array<{ cited_by_count: number }> = [];
  let worksCount = 0;
  let cursor = "*";
  let fetchedAll = false;

  for (let page = 0; page < OPENALEX_AUTHOR_HINDEX_PAGE_CAP; page++) {
    const resp = await fetchAuthorWorks(authorId, cursor);
    if (page === 0) worksCount = resp.meta?.count ?? 0;
    for (const w of resp.results ?? []) works.push({ cited_by_count: w.cited_by_count ?? 0 });
    cursor = resp.meta?.next_cursor ?? "";
    if (!cursor) {
      fetchedAll = true;
      break;
    }
    // Early stop: once a work ranks below both its citation count and 10, more
    // (lower-cited) works can't raise h-index or i10 — so both are already exact.
    const settled = computeWorksMetrics(works);
    if (works.length > settled.hIndex && works.length > settled.i10Index) break;
  }

  const { hIndex, i10Index, citationSum } = computeWorksMetrics(works);
  const hExact = fetchedAll || works.length > hIndex;
  const i10Exact = fetchedAll || works.length > i10Index;

  return {
    worksCount,
    citedByCount: fetchedAll ? citationSum : null,
    hIndex,
    i10Index,
    metricsAreLowerBound: !(hExact && i10Exact),
    metricsSource: "derived",
  };
}

/**
 * Fetch an author's identity + metrics from OpenAlex.
 *
 * Named `fetchAuthorProfile` (not `getAuthor`) to avoid colliding with the cache
 * read `getAuthor` (`cache/authors`), which returns a stored `AuthorRow`.
 *
 * @returns the profile, or `null` if the author id is unparseable or not found
 *          (404). Budget / auth / network failures propagate so the pane (U7)
 *          can render distinct states.
 */
export interface FetchAuthorProfileOptions {
  /**
   * Skip the metered works-derivation fallback when OpenAlex's author aggregates
   * are zeroed (KTD2). The item pane sets this to fill in h-indexes for a WHOLE
   * byline: the `/authors/{id}` singleton is free, but deriving from works pages
   * metered `/works` queries, and doing that for a dozen authors on every item
   * click would burn the daily budget. The dialog (one author, explicit user
   * action) leaves it off and pays for the exact figure.
   */
  aggregatesOnly?: boolean;
}

export async function fetchAuthorProfile(
  authorId: string,
  opts: FetchAuthorProfileOptions = {},
): Promise<OpenAlexAuthorProfile | null> {
  const shortId = parseAuthorId(authorId);
  if (!shortId) return null;

  if (authorProfileCache.has(shortId)) {
    const cached = authorProfileCache.get(shortId) ?? null;
    return cached ? withRedirect(cached, shortId) : null;
  }

  try {
    const url = buildUrl(`/authors/${encodeURIComponent(shortId)}`, { select: AUTHOR_SELECT });
    const body = await rateLimitedFetch<AuthorApiResponse>(url, "author lookup");

    const canonicalId = resolveCanonicalId(body) ?? shortId;
    // Aggregates are trustworthy only when non-zero (KTD2 degradation guard).
    const useAggregates = typeof body.works_count === "number" && body.works_count > 0;

    if (!useAggregates && opts.aggregatesOnly) {
      // Aggregates are zeroed and the caller has opted out of paying for the
      // metered derivation. Return identity with null metrics (the pane simply
      // shows no h-index for this author) and deliberately DO NOT populate the
      // session cache — a later dialog call must still be able to derive the
      // real numbers rather than inherit these nulls.
      return withRedirect(
        {
          id: canonicalId,
          displayName: body.display_name ?? null,
          orcid: body.orcid ?? null,
          worksCount: null,
          citedByCount: null,
          hIndex: null,
          i10Index: null,
          metricsAreLowerBound: false,
          metricsSource: "aggregates",
          redirectedFrom: null,
        },
        shortId,
      );
    }

    const metrics = useAggregates
      ? metricsFromAggregates(body)
      : await metricsFromWorks(canonicalId);

    const profile: OpenAlexAuthorProfile = {
      id: canonicalId,
      displayName: body.display_name ?? null,
      orcid: body.orcid ?? null,
      ...metrics,
      redirectedFrom: null,
    };

    authorProfileCache.set(shortId, profile);
    if (canonicalId !== shortId) authorProfileCache.set(canonicalId, profile);
    return withRedirect(profile, shortId);
  } catch (e) {
    if (e instanceof OpenAlexNotFoundError) {
      authorProfileCache.set(shortId, null);
      return null;
    }
    // Budget / auth / network — don't poison the cache; let the pane retry.
    logError(`fetchAuthorProfile(${shortId})`, e);
    throw e;
  }
}

/** Clear the session author-profile cache (call on plugin shutdown). */
export function clearAuthorProfileCache(): void {
  authorProfileCache.clear();
}

// ────────────────────────────────────────────────────────
// ORCID parsing (reusable primitive)
// ────────────────────────────────────────────────────────

/** Parse a bare or URL ORCID to its canonical `0000-0000-0000-000X` form, or null. */
export function parseOrcid(raw: string): string | null {
  const s = (raw ?? "")
    .replace(/^https?:\/\/orcid\.org\//i, "")
    .trim()
    .toUpperCase();
  return /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(s) ? s : null;
}

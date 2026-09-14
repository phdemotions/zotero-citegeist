/**
 * The OpenAlex records the loopback stub serves.
 *
 * Shared by the Node-side stub server (`harness/openalexStub.ts`) and the specs
 * running inside Zotero, so both agree on the identifiers and numbers a spec
 * asserts. Pure data with no Node or Zotero imports, which is why it lives in
 * shared/: esbuild bundles it into the in-Zotero spec files, and harness/ holds
 * only code for the scaffold Node process.
 */

/** DOI of the one work the stub knows. A spec item carrying it resolves to STUB_WORK. */
export const STUB_DOI = "10.5555/citegeist.real-zotero.1";
export const STUB_WORK_ID = "W4242424242";
export const STUB_SOURCE_ID = "S4242424242";
/** Distinctive enough that a column cell showing it can only have come from the stub. */
export const STUB_CITED_BY_COUNT = 4242;
/** Where the stub reports the requests it has received. Never an OpenAlex route. */
export const STUB_REQUEST_LOG_PATH = "/__citegeist_stub/requests";

export const STUB_WORK = {
  id: `https://openalex.org/${STUB_WORK_ID}`,
  doi: `https://doi.org/${STUB_DOI}`,
  title: "Citegeist real-Zotero fixture",
  display_name: "Citegeist real-Zotero fixture",
  publication_year: 2020,
  publication_date: "2020-01-01",
  cited_by_count: STUB_CITED_BY_COUNT,
  referenced_works_count: 0,
  fwci: 1.5,
  citation_normalized_percentile: {
    value: 0.95,
    is_in_top_1_percent: false,
    is_in_top_10_percent: true,
  },
  counts_by_year: [{ year: 2020, cited_by_count: STUB_CITED_BY_COUNT }],
  open_access: { is_oa: false, oa_status: "closed", oa_url: null },
  authorships: [],
  primary_location: {
    source: {
      id: `https://openalex.org/${STUB_SOURCE_ID}`,
      display_name: "Journal of Stubs",
      issn_l: null,
      type: "journal",
    },
  },
  biblio: { volume: "1", issue: "1", first_page: "1", last_page: "2" },
  type: "article",
  is_retracted: false,
  referenced_works: [],
  abstract_inverted_index: null,
};

export const STUB_SOURCE = {
  id: `https://openalex.org/${STUB_SOURCE_ID}`,
  issn_l: null,
  issn: null,
  summary_stats: { "2yr_mean_citedness": 3.5, h_index: 42, i10_index: 420 },
};

/** An empty page, for list and filter queries (title search, citing works). */
export const STUB_EMPTY_LIST = {
  meta: { count: 0, per_page: 25, next_cursor: null },
  results: [],
};

export interface StubResponse {
  status: number;
  body: unknown;
}

/**
 * Answer one OpenAlex request by path and query. Knows exactly one work (by DOI
 * or id) and its source; list queries get an empty page and everything else is
 * a 404, which Citegeist reads as "not on OpenAlex". Used by the loopback server
 * and by specs that intercept `Zotero.HTTP.request` directly.
 */
export function routeOpenAlexRequest(pathAndQuery: string): StubResponse {
  const pathname = decodeURIComponent(new URL(pathAndQuery, "http://stub.invalid").pathname);
  if (pathname.toLowerCase() === `/works/doi:${STUB_DOI}`.toLowerCase()) {
    return { status: 200, body: STUB_WORK };
  }
  if (pathname === `/works/${STUB_WORK_ID}`) return { status: 200, body: STUB_WORK };
  if (pathname === `/sources/${STUB_SOURCE_ID}`) return { status: 200, body: STUB_SOURCE };
  if (pathname === "/works") return { status: 200, body: STUB_EMPTY_LIST };
  return { status: 404, body: { error: "Not found" } };
}

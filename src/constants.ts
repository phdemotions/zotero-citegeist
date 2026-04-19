/**
 * Centralized constants for Citegeist.
 *
 * Keep all magic numbers here so behavior is tunable in one place and
 * reviewers can audit limits without grepping the codebase.
 */

// ── OpenAlex rate limiting ──
/** Polite pool target: 8 req/s (cap is 10 req/s). */
export const OPENALEX_RATE_LIMIT_MS = 125;
/** Request timeout for single OpenAlex calls. */
export const OPENALEX_REQUEST_TIMEOUT_MS = 30_000;
/** Exponential backoff delays on 429 / 5xx (ms). */
export const OPENALEX_RETRY_DELAYS_MS = [2000, 4000];

// ── Cache lifetimes ──
/** Default cache lifetime in days when the pref is unset or invalid. */
export const DEFAULT_CACHE_LIFETIME_DAYS = 7;
/** TTL (ms) for the in-memory auto-fetch pref cache. */
export const AUTO_FETCH_PREF_TTL_MS = 5000;

// ── Column fetch queue ──
/** Max items we'll remember as "already attempted" before clearing. */
export const MAX_ATTEMPTED_FETCH_CACHE = 10_000;
/** Debounce before a column fetch batch kicks off. */
export const FETCH_QUEUE_DEBOUNCE_MS = 500;
/** Column fetch batch size (parallel requests). */
export const FETCH_BATCH_SIZE = 2;
/** Delay between column fetch batches. */
export const FETCH_BATCH_DELAY_MS = 500;
/** Delay between calls in a bulk batch fetch (menu-triggered). */
export const BULK_FETCH_DELAY_MS = 100;

// ── Citation network dialog ──
/** Max results rendered in the dialog (soft cap for performance). */
export const MAX_RENDERED_RESULTS = 200;
/** Undo timeout after adding an item to the library. */
export const UNDO_TIMEOUT_MS = 3000;
/** Default per-page size for citation network queries. */
export const DEFAULT_NETWORK_PAGE_SIZE = 25;
/** Debounce for the dialog search input. */
export const SEARCH_DEBOUNCE_MS = 200;
/** Infinite-scroll threshold in px from bottom. */
export const INFINITE_SCROLL_THRESHOLD_PX = 100;

// ── Abstract reconstruction safety ──
/** Max position index we'll accept from an inverted index (sanity bound). */
export const MAX_ABSTRACT_POSITION = 10_000;
/** Max reconstructed abstract length (characters). */
export const MAX_ABSTRACT_LENGTH = 100_000;

// ── Title-based metadata matching ──
/** Score threshold for high-confidence title match (data shown with ~ prefix). */
export const TITLE_MATCH_HIGH_THRESHOLD = 0.92;
/** Score threshold for medium-confidence title match (suggestion card, no data). */
export const TITLE_MATCH_MEDIUM_THRESHOLD = 0.72;
/** Number of candidates to fetch from OpenAlex title search. */
export const TITLE_SEARCH_RESULTS = 5;
/** Days before retrying a dismissed or no-match item. */
export const NO_MATCH_RETRY_DAYS = 30;

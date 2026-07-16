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
/**
 * OpenAlex `work.type` values treated as books. OpenAlex rarely indexes a
 * machine-readable reference list for these, so the network browser shows a
 * book-aware empty state rather than implying the work cites nothing. These are
 * OpenAlex work types, distinct from the Zotero item types in `isBookType`.
 */
export const OPENALEX_BOOK_WORK_TYPES: readonly string[] = ["book", "book-chapter", "monograph"];

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
/**
 * Debounce for the coalesced column repaint. A burst of per-item cache
 * invalidations (a collection/library fetch resolving item by item) collapses
 * into ONE `refreshAndMaintainSelection()` shortly after the last one, so rows
 * fill in progressively without thrashing the item tree.
 */
export const COLUMN_REPAINT_DEBOUNCE_MS = 150;

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

// ── SQLite cache + migration ──
/** Library size threshold above which migration shows progress UI. */
export const SHOW_PROGRESS_UI_THRESHOLD = 500;
/** Update progress UI every N items during migration. */
export const MIGRATION_PROGRESS_TICK = 50;
/** Max item_keys per `DELETE … WHERE item_key IN (…)` chunk during orphan GC. */
export const ORPHAN_GC_CHUNK_SIZE = 200;
/** Max migration-backup JSON files to keep in the data dir. Older files removed. */
export const MAX_BACKUP_FILES = 5;
/** Minimum interval between orphan-GC sweeps at startup. */
export const ORPHAN_GC_MIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Timeouts ──
/** Per-item saveTx timeout during migration. A single locked item must
 *  not stall the entire migration loop. */
export const MIGRATION_ITEM_TIMEOUT_MS = 30_000;
/** Max wait for pending writes to drain during cache shutdown. Beyond
 *  this we abandon stragglers rather than block Zotero shutdown. */
export const CLOSE_CACHE_DRAIN_TIMEOUT_MS = 5_000;

// ── Preference keys ──
// Centralized to prevent typos: a misspelled pref name silently fails
// (Zotero.Prefs.get returns `undefined`) and corrupts state lookups.
export const PREF_MIGRATION_COMPLETE = "extensions.zotero.citegeist.migrationV1Complete";
export const PREF_LAST_BACKUP_PATH = "extensions.zotero.citegeist.lastBackupPath";
export const PREF_LAST_ORPHAN_GC_AT = "extensions.zotero.citegeist.lastOrphanGcAt";
export const PREF_CACHE_LIFETIME_DAYS = "extensions.zotero.citegeist.cacheLifetimeDays";
export const PREF_AUTO_FETCH = "extensions.zotero.citegeist.autoFetch";
/**
 * @deprecated OpenAlex dropped the `mailto` polite pool (July 2026). The client
 * no longer sends it; use {@link PREF_OPENALEX_API_KEY} instead. The pref key is
 * retained only so the legacy preferences field has a home until U9 removes it.
 */
export const PREF_MAILTO = "extensions.zotero.citegeist.mailto";
/**
 * Optional, opt-in OpenAlex API key. OpenAlex is metered as of July 2026
 * ($0.10/day anonymous, $1/day with a free key). Stored locally; never synced;
 * never logged (redacted via {@link redactApiKey}). Empty/unset → anonymous.
 */
export const PREF_OPENALEX_API_KEY = "extensions.zotero.citegeist.openAlexApiKey";
export const PREF_NETWORK_PAGE_SIZE = "extensions.zotero.citegeist.networkPageSize";

/**
 * Response header OpenAlex sets to the caller's remaining daily request quota.
 * A `429` carrying `0` here is budget exhaustion (persistent — prompt for a
 * key), distinct from a transient per-second rate-limit `429` (retry).
 */
export const OPENALEX_RATE_REMAINING_HEADER = "X-RateLimit-Remaining";

/**
 * Settings pane id — registered via `Zotero.PreferencePanes.register` and
 * opened from the item pane's settings button via
 * `Zotero.Utilities.Internal.openPreferences`.
 */
export const SETTINGS_PANE_ID = "citegeist-prefpane";

// ── Title-based metadata matching ──
/** Score threshold for high-confidence title match (data shown with ~ prefix). */
export const TITLE_MATCH_HIGH_THRESHOLD = 0.92;
/** Score threshold for medium-confidence title match (suggestion card, no data). */
export const TITLE_MATCH_MEDIUM_THRESHOLD = 0.72;
/** Number of candidates to fetch from OpenAlex title search. */
export const TITLE_SEARCH_RESULTS = 5;
/** Days before retrying a dismissed or no-match item. */
export const NO_MATCH_RETRY_DAYS = 30;

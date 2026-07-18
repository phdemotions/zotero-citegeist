/**
 * Public surface for the cache module.
 *
 * Internal structure:
 *   types.ts       — public types + internal row shape + column list
 *   db.ts          — connection, in-memory mirror, lifecycle (init/close)
 *   read.ts        — sync read API (hits the mirror only)
 *   write.ts       — async write API (SQLite first, then mirror)
 *   migration.ts   — one-shot Extra→SQLite migration + orphan GC
 *
 * Callers import from `"../cache"` (this index). The split is invisible to
 * them — every name they used in v1.3.x is still here.
 */

// ── Types ──
export type {
  AllMetrics,
  CachedData,
  MatchMethod,
  MatchTier,
  PendingSuggestion,
  TitleMatchMeta,
} from "./types";

// ── Lifecycle ──
// Note: `_resetForTesting` is intentionally NOT re-exported. Tests import
// it from the deep `cache/db` path so production callers can't accidentally
// nuke the cache layer via the public surface.
export { closeCache, initCache } from "./db";

// ── Read ──
export {
  findCachedItemKeyByOpenAlexId,
  getAllCachedOpenAlexIds,
  getCachedCitationCount,
  getCachedCountAndStaleness,
  getCachedData,
  getCachedMetrics,
  getCachedOpenAlexId,
  getPendingSuggestion,
  getTitleMatchMeta,
  isCacheStale,
  isNoMatchSuppressed,
} from "./read";

// ── Write ──
export {
  cacheWorkData,
  clearCache,
  clearPendingSuggestion,
  confirmTitleMatch,
  dismissAsNoMatch,
  writeNoMatch,
  writePendingSuggestion,
} from "./write";

// ── Data hygiene ──
export { garbageCollectOrphans, migrateFromExtraV1 } from "./migration";

// ── Author identity ──
export type { AuthorRow, ItemAuthorRow } from "./authors";
export {
  cacheItemAuthors,
  getAuthor,
  getItemAuthors,
  parseAuthorId,
  updateAuthorMetrics,
  AUTHOR_RELATION_PREDICATE,
  setItemAuthorRelations,
  syncItemAuthorRelations,
} from "./authors";

/**
 * Public surface for the author identity sub-module.
 *
 * Internal structure mirrors the parent cache module:
 *   types.ts  — row shapes, column tuples + compile-time gates, id validation
 *   db.ts     — schema creation + orphan GC statements (on the caller's transaction)
 *   read.ts   — async SQLite reads (no sync mirror in v1)
 *   write.ts  — identity + curation writes under the shared per-key lock
 */

export type { AuthorRow, ItemAuthorRow } from "./types";
export { parseAuthorId } from "./types";
export { getAuthor, getItemAuthors } from "./read";
export {
  cacheItemAuthors,
  setCuratedItemAuthor,
  updateAuthorMetrics,
  reconcileAuthorMerge,
  type CacheAuthorshipInput,
  type AuthorMetricsInput,
} from "./write";
export { AUTHOR_RELATION_PREDICATE, purgeAllAuthorRelations } from "./relations";

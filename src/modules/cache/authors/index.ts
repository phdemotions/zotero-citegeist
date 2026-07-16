/**
 * Public surface for the author identity sub-module.
 *
 * Internal structure mirrors the parent cache module:
 *   types.ts  — row shapes, column tuples + compile-time gates, id validation
 *   db.ts     — schema creation + two-level orphan GC
 *   read.ts   — async SQLite reads (no sync mirror in v1)
 *   write.ts  — identity + curation writes under the shared per-key lock
 */

export type { AuthorRow, ItemAuthorRow } from "./types";
export { parseAuthorId } from "./types";
export { createAuthorSchema, garbageCollectOrphanAuthors } from "./db";
export { getAuthor, getItemAuthors } from "./read";
export {
  cacheItemAuthors,
  setCuratedItemAuthor,
  updateAuthorMetrics,
  type CacheAuthorshipInput,
  type AuthorMetricsInput,
} from "./write";

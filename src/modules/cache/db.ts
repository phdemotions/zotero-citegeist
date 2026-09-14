/**
 * Connection + in-memory mirror lifecycle.
 *
 * The mirror is required because Zotero's column `dataProvider` callback
 * is synchronous (return type `string`, not `Promise<string>`) but the
 * SQLite API is async-only. We load all rows into a `Map` at startup so
 * read functions can stay sync; writes update SQLite first, then the map.
 *
 * Concurrency model
 * ─────────────────
 * • `initCache` is idempotent and races-safe: simultaneous calls share
 *   the same in-flight promise (Zotero may re-fire `onStartup` during a
 *   plugin-update restart sequence).
 * • Writes to the same `(libraryID, itemKey)` are serialized via a small
 *   per-key promise chain so that mirror state never diverges from SQLite.
 * • `closeCache` refuses new writes, then waits for pending ones before closing.
 *
 * Schema stamp and write state (plan KTD11)
 * ─────────────────────────────────────────
 * • The database records the schema that wrote it in `PRAGMA user_version`
 *   (major × 1000 + minor). Init stamps an unstamped or older database, leaves
 *   a newer minor alone, and opens a newer major (CG-DB03) or a stamp no release
 *   writes (CG-DB04) read-only.
 * • `requireWritableDb` is the only source of a connection for a write. It
 *   throws a coded `CacheWriteRefusedError` unless the cache is writable, and
 *   every helper that issues a write takes the `WritableDb` it returns, so the
 *   compiler tracks that each write passed the check.
 *   test/cache-write-invariants.test.ts keeps it that way.
 */

import {
  CACHE_SCHEMA_MAJOR,
  CACHE_SCHEMA_MINOR,
  CACHE_SCHEMA_STAMP_MULTIPLIER,
  CACHE_SCHEMA_UNRECOGNISED_MAJOR,
  CLOSE_CACHE_DRAIN_TIMEOUT_MS,
} from "../../constants";
import type { DiagnosticCode } from "../diagnostics/codes";
import { setSessionCondition } from "../diagnostics/status";
import {
  CacheError,
  CacheWriteRefusedError,
  CitegeistError,
  DatabaseOpenError,
  logError,
  normalizeError,
} from "../utils";
import { COLUMNS, type ItemCacheRow, mirrorKey, rowToParams } from "./types";
import { createAuthorSchema } from "./authors/db";

/** Pre-computed UPSERT statement. `COLUMNS` is frozen, so this stays valid. */
const UPSERT_SQL = `INSERT OR REPLACE INTO item_cache (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(
  () => "?",
).join(", ")})`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS item_cache (
  library_id                INTEGER NOT NULL,
  item_key                  TEXT NOT NULL,
  open_alex_id              TEXT,
  cited_by_count            INTEGER,
  fwci                      REAL,
  percentile                REAL,
  is_top_1_percent          INTEGER,
  is_top_10_percent         INTEGER,
  is_retracted              INTEGER,
  last_fetched              TEXT,
  source_id                 TEXT,
  citedness_2yr             REAL,
  journal_h_index           INTEGER,
  source_issns              TEXT,
  issn_l                    TEXT,
  no_match                  INTEGER,
  no_match_timestamp        TEXT,
  match_method              TEXT,
  match_confidence          TEXT,
  confirmed_open_alex_id    TEXT,
  pending_open_alex_id      TEXT,
  pending_title             TEXT,
  pending_cited_by_count    INTEGER,
  pending_fwci              REAL,
  pending_year              INTEGER,
  pending_tier              TEXT,
  pending_confidence        REAL,
  pending_doi               TEXT,
  PRIMARY KEY (library_id, item_key)
);
`;

const CREATE_PROGRESS_TABLE = `
CREATE TABLE IF NOT EXISTS migration_progress (
  library_id  INTEGER NOT NULL,
  item_key    TEXT NOT NULL,
  migrated_at TEXT NOT NULL,
  PRIMARY KEY (library_id, item_key)
);
`;

/** The `PRAGMA user_version` this build writes. Schema 1.0 is 1000. */
export const CURRENT_SCHEMA_STAMP =
  CACHE_SCHEMA_MAJOR * CACHE_SCHEMA_STAMP_MULTIPLIER + CACHE_SCHEMA_MINOR;

/**
 * What init does with the schema stamp it finds:
 * - `stamp`: unstamped (0, which every v2.0.x database holds) or an older
 *   schema. Ensure the schema, then write the current stamp.
 * - `compatible`: this schema, or a newer minor of the same major. Ensure the
 *   schema and leave the stamp alone, so a newer minor is never lowered.
 * - `newer-major`: written by a build whose changes this one can't know. Open
 *   read-only (CG-DB03).
 * - `unrecognised`: negative, unreadable, or a major no release could have
 *   reached. Open read-only (CG-DB04), because the file, not this build, is the
 *   likely problem.
 */
export type SchemaStampVerdict = "stamp" | "compatible" | "newer-major" | "unrecognised";

export function classifySchemaStamp(stored: number): SchemaStampVerdict {
  if (!Number.isSafeInteger(stored) || stored < 0) return "unrecognised";
  const major = Math.floor(stored / CACHE_SCHEMA_STAMP_MULTIPLIER);
  if (major >= CACHE_SCHEMA_UNRECOGNISED_MAJOR) return "unrecognised";
  if (major > CACHE_SCHEMA_MAJOR) return "newer-major";
  return stored < CURRENT_SCHEMA_STAMP ? "stamp" : "compatible";
}

/**
 * Whether the cache takes writes. `closed` before the first init and from the
 * moment `closeCache` starts; init sets `writable` or `read-only`.
 */
export type CacheWriteState = "writable" | "read-only" | "closed";

/** Why a read-only session refuses writes, for its notice and the report. */
interface ReadOnlyCause {
  readonly code: "CG-DB03" | "CG-DB04";
  /** What the stamp said, e.g. "schema major 2" or "schema stamp -5 not recognised". */
  readonly found: string;
}

declare const writableBrand: unique symbol;
/**
 * A connection handed out by `requireWritableDb`, the only kind a write helper
 * accepts. Outside this module nothing can mint one without a cast, and the
 * write invariants test forbids those casts elsewhere.
 */
export type WritableDb = _ZoteroTypes.DBConnection & { readonly [writableBrand]: true };

/** The report line this module owns in `diagnostics/status`. */
const CACHE_CONDITION_KEY = "cache";

let db: _ZoteroTypes.DBConnection | null = null;
let mirror: Map<string, ItemCacheRow> = new Map();
let initialized = false;
let writeState: CacheWriteState = "closed";
/** Set together with `writeState = "read-only"`, cleared with every other state. */
let readOnlyCause: ReadOnlyCause | null = null;
let initPromise: Promise<void> | null = null;

/** Per-(libraryID,itemKey) write tail. Each new write awaits the prior tail. */
const writeTails: Map<string, Promise<void>> = new Map();
/** Outstanding write promises tracked for `closeCache` to drain. */
const pendingWrites: Set<Promise<void>> = new Set();
/**
 * `operation:code` pairs already logged as refused. A read-only session can see
 * thousands of refused writes; one debug line per kind says everything.
 */
const refusalsLogged = new Set<string>();

/**
 * Initialize the cache: open the DB, check the schema stamp, ensure schema,
 * load the in-memory mirror. Must be called from `onStartup` before any read
 * function runs.
 *
 * Race-safe: concurrent callers share the same in-flight promise instead of
 * each opening their own `DBConnection`.
 */
export function initCache(): Promise<void> {
  if (initialized) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = doInit().finally(() => {
    initPromise = null;
  });
  return initPromise;
}

async function doInit(): Promise<void> {
  // Build the connection in a local. Don't assign to the module's `db`
  // until schema + mirror load have all succeeded, so a `closeCache()`
  // racing against init can't null-out a half-initialized connection.
  let conn: _ZoteroTypes.DBConnection;
  let stored: number;
  try {
    // A corrupt/quarantined citegeist.sqlite fails here — code it CG-DB02 so
    // the startup path records the actionable "couldn't open the database"
    // guidance rather than the generic CG-BUG01. The stamp is read before any
    // CREATE runs, because a newer major must not receive even idempotent DDL.
    conn = new Zotero.DBConnection("citegeist");
    stored = await readSchemaStamp(conn);
  } catch (e) {
    throw new DatabaseOpenError("could not open the Citegeist database", e);
  }

  const verdict = classifySchemaStamp(stored);
  const cause = readOnlyCauseFor(verdict, stored);
  // The one place outside requireWritableDb that treats a connection as
  // writable: the stamp was just classified as this build's, and the module
  // state that requireWritableDb reads isn't committed until init finishes.
  const rows = cause
    ? await openReadOnly(conn, cause)
    : await openWritable(conn as WritableDb, verdict === "stamp");

  const nextMirror = new Map(rows.map((r) => [mirrorKey(r.library_id, r.item_key), r]));

  db = conn;
  mirror = nextMirror;
  readOnlyCause = cause;
  writeState = cause ? "read-only" : "writable";
  refusalsLogged.clear();
  setSessionCondition(CACHE_CONDITION_KEY, cause ? readOnlyReportLine(cause) : null);
  initialized = true;
  Zotero.debug(
    `[Citegeist] cache initialized: ${mirror.size} rows, schema stamp ${stored}${cause ? ` (read-only, ${cause.code})` : ""}`,
  );
}

function readOnlyCauseFor(verdict: SchemaStampVerdict, stored: number): ReadOnlyCause | null {
  if (verdict === "newer-major") {
    return {
      code: "CG-DB03",
      found: `schema major ${Math.floor(stored / CACHE_SCHEMA_STAMP_MULTIPLIER)}`,
    };
  }
  if (verdict === "unrecognised") {
    const found = Number.isNaN(stored)
      ? "schema stamp unreadable"
      : `schema stamp ${stored} not recognised`;
    return { code: "CG-DB04", found };
  }
  return null;
}

/** The report line a read-only session keeps in every diagnostic report. */
function readOnlyReportLine(cause: ReadOnlyCause): string {
  return `Cache: read-only, ${cause.code} (${cause.found}; this build supports schema major ${CACHE_SCHEMA_MAJOR})`;
}

/** Ensure the schema, stamp it when asked, and load the mirror rows. */
async function openWritable(conn: WritableDb, needsStamp: boolean): Promise<ItemCacheRow[]> {
  try {
    await runQuery(conn, SCHEMA);
    await runQuery(conn, CREATE_PROGRESS_TABLE);
    // Author identity tables (additive, idempotent — plan KTD4). No mirror is
    // loaded for them: author reads query SQLite async in the pane.
    await createAuthorSchema(conn);
    // After the DDL, so the stamp never names tables the file doesn't hold yet.
    if (needsStamp) await stampSchema(conn);
    // The initial mirror load is part of "opening the database": a corrupt
    // item_cache fails this SELECT too, and it must code CG-DB02, not CG-BUG01.
    return await runQuery<ItemCacheRow>(conn, `SELECT * FROM item_cache`);
  } catch (e) {
    throw new DatabaseOpenError("could not open the Citegeist database", e);
  }
}

/**
 * Open a database whose stamp this build must not write under. Nothing here
 * writes: no DDL, no stamp. CG-DB03 or CG-DB04 is recorded first, then
 * `query_only` is set so SQLite itself refuses a write that got past
 * requireWritableDb, and the mirror still loads so reads serve what the file
 * already holds.
 */
async function openReadOnly(
  conn: _ZoteroTypes.DBConnection,
  cause: ReadOnlyCause,
): Promise<ItemCacheRow[]> {
  logError(
    "cache schema check",
    new CitegeistError(
      `${cause.found}; this build writes schema major ${CACHE_SCHEMA_MAJOR}; cache writes disabled`,
      cause.code,
    ),
  );
  await applyQueryOnly(conn);
  // Zotero 9.0.6+ closes and reopens a plugin database around its idle backup,
  // and the reopened connection starts without query_only. Re-apply it on every
  // reopen for as long as this connection is the read-only cache.
  try {
    conn.onConnect?.(async () => {
      if (writeState === "read-only" && db === conn) await applyQueryOnly(conn);
    });
  } catch (e) {
    Zotero.debug(
      `[Citegeist] onConnect unavailable; query_only covers this connection only until Zotero reopens it: ${normalizeError(e)}`,
    );
  }
  try {
    return await runQuery<ItemCacheRow>(conn, `SELECT * FROM item_cache`);
  } catch (e) {
    // A newer major may have reshaped item_cache. CG-DB03 or CG-DB04 already
    // names the cause, so start with an empty mirror rather than report CG-DB02.
    Zotero.debug(
      `[Citegeist] read-only cache: item_cache unreadable, mirror left empty: ${normalizeError(queryCause(e))}`,
    );
    return [];
  }
}

/** `PRAGMA query_only = ON`, as a backstop behind requireWritableDb. Never throws. */
async function applyQueryOnly(conn: _ZoteroTypes.DBConnection): Promise<void> {
  try {
    await runQuery(conn, "PRAGMA query_only = ON");
  } catch (e) {
    Zotero.debug(
      `[Citegeist] PRAGMA query_only failed; requireWritableDb still refuses every write: ${normalizeError(queryCause(e))}`,
    );
  }
}

/**
 * Read `PRAGMA user_version`. A query failure propagates, because a database
 * that can't answer it can't be opened; so does reading a column the row lacks,
 * which Zotero's row Proxy turns into a throw. The host returns a number today;
 * a bigint or a numeric string is read as the number it spells. Anything else
 * comes back as NaN, which classifySchemaStamp treats as unrecognised, so the
 * database opens read-only and nothing is stamped over a value this build
 * couldn't read.
 */
async function readSchemaStamp(conn: _ZoteroTypes.DBConnection): Promise<number> {
  const rows = await runQuery<{ user_version: unknown }>(conn, "PRAGMA user_version");
  const raw = rows.length > 0 ? rows[0].user_version : undefined;
  const stamp = coerceSchemaStamp(raw);
  if (Number.isNaN(stamp)) {
    Zotero.debug(`[Citegeist] PRAGMA user_version returned an unreadable ${typeof raw}`);
  }
  return stamp;
}

function coerceSchemaStamp(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "string" && /^\s*-?\d+\s*$/.test(raw)) return Number(raw);
  return Number.NaN;
}

/**
 * Write the current stamp. A failure is logged, never thrown: the database is
 * compatible either way, and the next startup stamps it.
 */
async function stampSchema(conn: WritableDb): Promise<void> {
  try {
    // PRAGMA takes no bound parameters; the value is a build-time integer.
    await runQuery(conn, `PRAGMA user_version = ${CURRENT_SCHEMA_STAMP}`);
  } catch (e) {
    logError("cache schema stamp", e);
  }
}

/**
 * Close the DB connection on shutdown. Awaits any in-flight init, refuses new
 * writes, drains pending writes, then closes. The init-await is what prevents
 * doInit from observing a null `db` after we cleared module state.
 *
 * `closeDatabase(true)` requests a permanent close — Zotero runs a WAL
 * checkpoint + truncate on the way out so we don't leave a multi-MB
 * `-wal` sidecar file behind across the Zotero process shutdown.
 */
export async function closeCache(): Promise<void> {
  if (initPromise) {
    await initPromise.catch(() => {});
  }
  // From here a write that hasn't got its connection yet is refused with
  // CG-DB02 instead of racing the close. Writes already holding one drain below.
  writeState = "closed";
  readOnlyCause = null;
  setSessionCondition(CACHE_CONDITION_KEY, null);
  if (pendingWrites.size > 0) {
    // Cap the drain at CLOSE_CACHE_DRAIN_TIMEOUT_MS so a hung writer can't
    // block Zotero's whole shutdown. Losing a few in-flight writes is
    // preferable to leaving a multi-MB un-checkpointed WAL behind because
    // the user had to force-kill the parent process.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const drain = Promise.allSettled([...pendingWrites]);
      const deadline = new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(resolve, CLOSE_CACHE_DRAIN_TIMEOUT_MS);
      });
      await Promise.race([drain, deadline]);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
    if (pendingWrites.size > 0) {
      Zotero.debug(
        `[Citegeist] closeCache: ${pendingWrites.size} write(s) still pending after ${CLOSE_CACHE_DRAIN_TIMEOUT_MS}ms — abandoning to unblock shutdown`,
      );
    }
  }
  if (db) {
    await db.closeDatabase(true);
    db = null;
  }
  mirror = new Map();
  writeTails.clear();
  pendingWrites.clear();
  initialized = false;
}

/**
 * Test-only: inject a fake DBConnection and reset the mirror.
 */
export function _resetForTesting(fakeDb?: _ZoteroTypes.DBConnection): void {
  db = fakeDb ?? null;
  mirror = new Map();
  writeTails.clear();
  pendingWrites.clear();
  refusalsLogged.clear();
  writeState = "closed";
  readOnlyCause = null;
  setSessionCondition(CACHE_CONDITION_KEY, null);
  initialized = false;
  initPromise = null;
}

/**
 * Returns the live DB connection for a READ. Throws if init hasn't completed —
 * callers should accept the throw as a signal that the cache layer is
 * genuinely broken (e.g., disk full, locked DB). A write gets its connection
 * from {@link requireWritableDb} instead.
 */
export function requireDb(): _ZoteroTypes.DBConnection {
  if (!db || !initialized) {
    throw new Error("[Citegeist] cache not initialized — call initCache() first");
  }
  return db;
}

/**
 * The code a cache write would be refused with right now, or null when the
 * cache takes writes: CG-DB03 or CG-DB04 on a read-only cache, CG-DB02 once it
 * is closed. The pane and the fetch service ask before starting work that only
 * matters if it can be saved, and render this code instead.
 */
export function cacheWriteRefusalCode(): DiagnosticCode | null {
  switch (writeState) {
    case "writable":
      return null;
    case "read-only":
      return readOnlyCause?.code ?? "CG-DB03";
    case "closed":
      return "CG-DB02";
  }
}

/** True when init opened a database this build must not write (CG-DB03, CG-DB04). */
export function isCacheReadOnly(): boolean {
  return writeState === "read-only";
}

/**
 * The single writable choke point. Every write path gets its connection here
 * and nowhere else; a cache that isn't writable throws a
 * {@link CacheWriteRefusedError} carrying {@link cacheWriteRefusalCode}, so a
 * refused write is never mistaken for one that landed. Call it before the
 * write's first await: a write that started before `closeCache` holds its
 * connection and drains, and one that starts after is refused.
 */
export function requireWritableDb(operation: string): WritableDb {
  const code = cacheWriteRefusalCode();
  if (code === null && db) return db as WritableDb;
  const refusal = code ?? "CG-DB02";
  logRefusalOnce(operation, refusal);
  throw new CacheWriteRefusedError(operation, refusal);
}

/**
 * True on a read-only cache, for maintenance that has nothing to do there
 * (migration, orphan GC): it returns quietly rather than calling
 * requireWritableDb and recording a refusal the startup notice already covers.
 * It gates no write by itself; the writes inside still go through
 * requireWritableDb.
 */
export function cacheWriteRefused(operation: string): boolean {
  if (writeState !== "read-only") return false;
  logRefusalOnce(operation, readOnlyCause?.code ?? "CG-DB03");
  return true;
}

function logRefusalOnce(operation: string, code: DiagnosticCode): void {
  const key = `${operation}:${code}`;
  if (refusalsLogged.has(key)) return;
  refusalsLogged.add(key);
  Zotero.debug(
    `[Citegeist] ${operation} refused: the cache is ${writeState} (${code}); later refusals of ${operation} are not logged`,
  );
}

export function getRow(libraryID: number, itemKey: string): ItemCacheRow | undefined {
  const key = mirrorKey(libraryID, itemKey);
  const row = mirror.get(key);
  // One-shot debug — fires once per unique key per session so logs
  // don't explode. Lets us verify the column read path matches what
  // upsertRow wrote.
  if (!getRowLoggedKeys.has(key)) {
    getRowLoggedKeys.add(key);
    Zotero.debug(
      `[Citegeist] getRow: lib=${libraryID} key=${itemKey} -> ${row ? `count=${row.cited_by_count}` : "MISS"} (mirror.size=${mirror.size})`,
    );
  }
  return row;
}

// Keys we've already logged once via getRow — prevents the log
// firing on every dataProvider invocation (Zotero calls dataProvider
// multiple times per item per redraw).
const getRowLoggedKeys = new Set<string>();

/** Test-only: clear the getRow log dedup. */
export function _resetGetRowLog(): void {
  getRowLoggedKeys.clear();
}

/**
 * Snapshot of mirror entries as an array — safe to iterate while concurrent
 * writes mutate the underlying Map. Used by orphan GC.
 */
export function mirrorSnapshot(): Array<[string, ItemCacheRow]> {
  return [...mirror.entries()];
}

export function deleteMirrorEntries(keys: Iterable<string>): void {
  for (const k of keys) mirror.delete(k);
}

const noop = (): void => {};

/**
 * Serialize `fn` against any prior write to the same `(libraryID, itemKey)`.
 * Different keys run in parallel; same keys queue. Prevents mirror/SQLite
 * divergence when, e.g., a column refetch races a manual refresh.
 *
 * Tail-tracking note: each call appends a fresh tail and, in `finally`,
 * drops its Map entry if no later writer chained on it. Without that the
 * Map would grow monotonically with the count of distinct keys ever
 * written, leaking memory under sustained workloads.
 */
export async function withKeyLock<T>(
  libraryID: number,
  itemKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = mirrorKey(libraryID, itemKey);
  const prev = writeTails.get(key) ?? Promise.resolve();

  let releaseTicket: () => void = noop;
  const ticket = new Promise<void>((r) => {
    releaseTicket = r;
  });
  const newTail = prev.then(() => ticket);
  writeTails.set(key, newTail);
  // Tracked from the moment it queues, not from when it starts: a write waiting
  // on this key already holds its connection, so closeCache must drain it too.
  const tracker = newTail.then(noop, noop);
  pendingWrites.add(tracker);

  try {
    await prev;
    // `fn()` runs inside the try so a synchronous throw still hits `finally`
    // and releases the ticket — without that, a sync throw would leave the
    // next waiter awaiting an unresolved promise forever.
    return await fn();
  } finally {
    releaseTicket();
    pendingWrites.delete(tracker);
    if (writeTails.get(key) === newTail) writeTails.delete(key);
  }
}

/**
 * Run a statement, converting any failure into a {@link CacheError} with a
 * STATIC message. Every SQL statement Citegeist issues, read or write, goes
 * through here: it is the only `queryAsync` call in the codebase.
 *
 * Zotero's `DBConnection.queryAsync` throws with the full SQL *and a JSON dump
 * of every bound parameter* in its message — and our bound parameters include
 * the item's title and DOI. That message would otherwise flow through
 * `logError` into the diagnostic ring buffer and out into the report the user
 * pastes into a public GitHub issue, breaking the "no titles, DOIs, or other
 * library content" promise. The original error is kept only as `cause`, which
 * `normalizeError` deliberately does not traverse, so the failure stays
 * debuggable locally while nothing library-derived reaches the shareable
 * buffer. This is also what finally gives CG-DB01 a producer.
 */
export async function runQuery<T = unknown>(
  conn: _ZoteroTypes.DBConnection,
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  try {
    return await conn.queryAsync<T>(sql, params);
  } catch (e) {
    throw new CacheError("cache query failed", e);
  }
}

/**
 * The host's own error behind a runQuery failure, for local debug lines only.
 * Use it only for statements with no bound parameters: the cause's message
 * repeats them.
 */
function queryCause(e: unknown): unknown {
  return e instanceof CacheError && e.cause !== undefined ? e.cause : e;
}

export async function upsertRow(row: ItemCacheRow): Promise<void> {
  const conn = requireWritableDb("upsertRow");
  await withKeyLock(row.library_id, row.item_key, async () => {
    await runQuery(conn, UPSERT_SQL, rowToParams(row));
    mirror.set(mirrorKey(row.library_id, row.item_key), row);
    Zotero.debug(
      `[Citegeist] upsertRow: lib=${row.library_id} key=${row.item_key} count=${row.cited_by_count} mirror.size=${mirror.size}`,
    );
  });
}

export async function deleteRow(libraryID: number, itemKey: string): Promise<void> {
  const conn = requireWritableDb("deleteRow");
  await withKeyLock(libraryID, itemKey, async () => {
    await runQuery(conn, `DELETE FROM item_cache WHERE library_id = ? AND item_key = ?`, [
      libraryID,
      itemKey,
    ]);
    // Also drop the migration checkpoint so a future force-rerun can
    // actually re-process the item. Without this, a `clearCache` followed
    // by `shouldForceRerun` would skip the now-empty row at checkpoint
    // lookup and the user's intentional clear would not trigger re-migration.
    await runQuery(conn, `DELETE FROM migration_progress WHERE library_id = ? AND item_key = ?`, [
      libraryID,
      itemKey,
    ]);
    // Drop the item's resolved-author links too (per-item author GC). The
    // library-wide sweep for items removed while Zotero was closed rides
    // garbageCollectOrphans → garbageCollectOrphanAuthors.
    await runQuery(conn, `DELETE FROM item_authors WHERE library_id = ? AND item_key = ?`, [
      libraryID,
      itemKey,
    ]);
    mirror.delete(mirrorKey(libraryID, itemKey));
  });
}

/**
 * Read-modify-write under the per-key lock. The transform receives the
 * row as it exists AT THE MOMENT the lock is granted, not at call time —
 * so a concurrent `clearCache` between the caller's call and the lock
 * acquisition is observed correctly. Return `null` from `transform` to
 * leave the row unchanged. On a cache that refuses writes the transform never
 * runs and the call rejects with the refusal's code.
 */
export async function mutateRow(
  libraryID: number,
  itemKey: string,
  transform: (existing: ItemCacheRow | undefined) => ItemCacheRow | null,
): Promise<void> {
  const conn = requireWritableDb("mutateRow");
  await withKeyLock(libraryID, itemKey, async () => {
    const existing = mirror.get(mirrorKey(libraryID, itemKey));
    const next = transform(existing);
    if (next === null) return;
    await runQuery(conn, UPSERT_SQL, rowToParams(next));
    mirror.set(mirrorKey(next.library_id, next.item_key), next);
  });
}

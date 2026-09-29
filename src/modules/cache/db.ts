/**
 * Connection, write gate, transactions and the in-memory mirror.
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
 * One path to the database (plan KTD11)
 * ─────────────────────────────────────
 * • `rawQuery` holds the only `queryAsync` call and is private. `runRead` runs a
 *   read and copies each row into a plain object. `runWrite` runs a write, and
 *   takes only a `WriteTransaction`.
 * • `requireWritableDb` is the write gate. It throws a coded
 *   `CacheWriteRefusedError` unless the cache takes writes, and otherwise
 *   returns a `WritableDb`, whose `transaction` method is the only source of a
 *   `WriteTransaction`. Both classes are exported as types only, so the compiler
 *   proves that every write passed the gate and runs inside a transaction.
 *   test/cache-write-invariants.test.ts keeps it that way.
 *
 * Why every write runs in a transaction
 * ─────────────────────────────────────
 * `new Zotero.DBConnection("citegeist")` names a database in Zotero's data
 * directory, which Zotero manages. When the user goes idle, Zotero 10.0.2 backs
 * it up and then vacuums it (db.js `observe`, lines 925-928). `vacuum` writes a
 * compacted copy with `VACUUM INTO`, closes the connection, and moves the copy
 * over the live file unless `_commitCount` changed in between (lines 1029-1058).
 * Only `executeTransaction` advances `_commitCount` (lines 493-494), so a write
 * that commits on its own during the copy is discarded with the old file on the
 * next launch. A write inside a transaction advances the count, which makes
 * Zotero keep the live file, and `vacuum` waits for an open transaction before it
 * starts (lines 981-983).
 */

import { CACHE_SCHEMA_MAJOR, CLOSE_CACHE_DRAIN_TIMEOUT_MS } from "../../constants";
import type { DiagnosticCode } from "../diagnostics/codes";
import { logErrorUnlessBuffered } from "../diagnostics/logOnce";
import { setSessionCondition } from "../diagnostics/status";
import {
  CacheError,
  CacheWriteRefusedError,
  CitegeistError,
  DatabaseOpenError,
  logError,
  normalizeError,
} from "../utils";
import {
  classifySchemaStamp,
  createSchema,
  readOnlyCauseFor,
  readSchemaStamp,
  type ReadOnlyCause,
} from "./schema";
import { COLUMNS, type ItemCacheRow, mirrorKey, rowToParams, type SqliteBindValue } from "./types";

/** Pre-computed UPSERT statement. `COLUMNS` is frozen, so this stays valid. */
const UPSERT_SQL = `INSERT OR REPLACE INTO item_cache (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(
  () => "?",
).join(", ")})`;

/** The mirror load names its columns, so a reshaped table fails the query rather than a row. */
const MIRROR_SQL = `SELECT ${COLUMNS.join(", ")} FROM item_cache`;

/**
 * A statement that changes the file. `runRead` refuses one at run time, as a
 * backstop behind the static guard that sends every write through `runWrite`.
 */
const WRITE_STATEMENT =
  /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|REINDEX|ATTACH|DETACH|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b|^\s*PRAGMA\s+(?:\w+\.)?user_version\s*=/i;

/**
 * Whether the cache takes writes. `closed` before the first init and from the
 * moment `closeCache` starts; init sets `writable` or `read-only`.
 */
export type CacheWriteState = "writable" | "read-only" | "closed";

/** The report line this module owns in `diagnostics/status`. */
const CACHE_CONDITION_KEY = "cache";

// ── Write handles ────────────────────────────────────────────────────────────

/**
 * A connection the write gate let through. Only {@link requireWritableDb}
 * constructs one, and the class is exported as a type only: its private field
 * means no other object satisfies the type, so code holding one can only have
 * passed the gate.
 */
class WritableDb {
  readonly #conn: _ZoteroTypes.DBConnection;

  constructor(conn: _ZoteroTypes.DBConnection) {
    this.#conn = conn;
  }

  /**
   * Run `work` in one Zotero transaction, resolving with its result once the
   * transaction commits. A rejection from `work` rolls back every statement it
   * ran. Zotero runs one transaction at a time on a connection, and one that
   * starts while another is open waits for it (`executeTransaction`'s
   * `while (this._transactionID)`: db.js 8.0.4 line 438, 9.0.6 line 439, 10.0.2
   * line 448), so `work` must never open a transaction of its own: it would wait
   * on itself until Zotero's 30-second timeout rejects it.
   */
  transaction<T>(work: (tx: WriteTransaction) => Promise<T>): Promise<T> {
    return runInTransaction(this.#conn, work);
  }
}

/**
 * An open transaction: the only thing {@link runWrite} accepts. It ends when
 * its transaction settles, and a statement through it after that throws rather
 * than running on its own outside any transaction.
 */
class WriteTransaction {
  readonly #conn: _ZoteroTypes.DBConnection;
  #open = true;

  constructor(conn: _ZoteroTypes.DBConnection) {
    this.#conn = conn;
  }

  static connectionOf(tx: WriteTransaction): _ZoteroTypes.DBConnection {
    if (!tx.#open) {
      throw new CitegeistError("cache statement issued after its transaction ended", "CG-BUG01");
    }
    return tx.#conn;
  }

  static end(tx: WriteTransaction): void {
    tx.#open = false;
  }
}

export type { WritableDb, WriteTransaction };

/**
 * The one place a transaction starts. {@link WritableDb.transaction} calls it,
 * and so does init's schema setup, on a connection that isn't the module's `db`
 * until init finishes, after its stamp was classified as this build's.
 */
async function runInTransaction<T>(
  conn: _ZoteroTypes.DBConnection,
  work: (tx: WriteTransaction) => Promise<T>,
): Promise<T> {
  const tx = new WriteTransaction(conn);
  let failedInWork = false;
  try {
    return await conn.executeTransaction(async () => {
      try {
        return await work(tx);
      } catch (e) {
        failedInWork = true;
        throw e;
      }
    });
  } catch (e) {
    // A failure inside `work` passes through as it is: a statement's failure is
    // already a static-message CacheError. One from Zotero itself (BEGIN or
    // COMMIT failing, a timeout waiting for another transaction) gets a static
    // message too, for the reason rawQuery gives.
    if (failedInWork || e instanceof CitegeistError) throw e;
    throw new CacheError("cache transaction failed", e);
  } finally {
    WriteTransaction.end(tx);
  }
}

// ── Module state ─────────────────────────────────────────────────────────────

let db: _ZoteroTypes.DBConnection | null = null;
let mirror: Map<string, ItemCacheRow> = new Map();
let initialized = false;
let writeState: CacheWriteState = "closed";
/** Set together with `writeState = "read-only"`, cleared with every other state. */
let readOnlyCause: ReadOnlyCause | null = null;
/** Owned by initCache, which clears it when the init it tracks settles. */
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
 * Connections init classified read-only. Their onConnect callback re-applies
 * `query_only` while the connection is in this set: from classification, before
 * the mirror loads, until closeCache or a failed init takes it out.
 */
const queryOnlyConnections = new Set<_ZoteroTypes.DBConnection>();
/**
 * Keys getRow has logged once. Zotero calls dataProvider several times per item
 * per redraw, so the log would otherwise repeat on every one.
 */
const getRowLoggedKeys = new Set<string>();

/**
 * Put every piece of module state back to a closed, uninitialised cache. The
 * one exception is `initPromise`, which initCache clears itself: closeCache
 * awaits it before it gets here.
 */
function resetState(): void {
  db = null;
  mirror = new Map();
  initialized = false;
  writeState = "closed";
  readOnlyCause = null;
  writeTails.clear();
  pendingWrites.clear();
  refusalsLogged.clear();
  queryOnlyConnections.clear();
  getRowLoggedKeys.clear();
  setSessionCondition(CACHE_CONDITION_KEY, null);
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

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

interface OpenedCache {
  readonly rows: ItemCacheRow[];
  readonly cause: ReadOnlyCause | null;
  readonly stamp: number;
}

async function doInit(): Promise<void> {
  // Build the connection in a local. Don't assign to the module's `db`
  // until schema + mirror load have all succeeded, so a `closeCache()`
  // racing against init can't null-out a half-initialized connection.
  let conn: _ZoteroTypes.DBConnection;
  try {
    conn = new Zotero.DBConnection("citegeist");
  } catch (e) {
    throw new DatabaseOpenError("could not open the Citegeist database", e);
  }

  let opened: OpenedCache;
  try {
    opened = await openCache(conn);
  } catch (e) {
    // Close before reporting. Zotero opens a database in its data directory
    // under an EXCLUSIVE lock (`_getConnectionAsync`, db.js 8.0.4 line 1277,
    // 9.0.6 line 1299), so a connection left open here keeps the file locked and
    // every later init fails until Zotero restarts.
    queryOnlyConnections.delete(conn);
    try {
      await conn.closeDatabase(true);
    } catch (closeError) {
      Zotero.debug(
        `[Citegeist] closing the cache after a failed open failed too: ${normalizeError(closeError)}`,
      );
    }
    // A corrupt/quarantined citegeist.sqlite fails in here: code it CG-DB02 so the
    // startup path records the actionable "couldn't open the database" guidance
    // rather than the generic CG-BUG01.
    throw e instanceof DatabaseOpenError
      ? e
      : new DatabaseOpenError("could not open the Citegeist database", e);
  }

  db = conn;
  mirror = new Map(opened.rows.map((r) => [mirrorKey(r.library_id, r.item_key), r]));
  readOnlyCause = opened.cause;
  writeState = opened.cause ? "read-only" : "writable";
  setSessionCondition(CACHE_CONDITION_KEY, opened.cause ? readOnlyReportLine(opened.cause) : null);
  initialized = true;
  Zotero.debug(
    `[Citegeist] cache initialized: ${mirror.size} rows, schema stamp ${opened.stamp}${opened.cause ? ` (read-only, ${opened.cause.code})` : ""}`,
  );
}

/** Read the stamp, then open the database for writing or read-only, as the stamp says. */
async function openCache(conn: _ZoteroTypes.DBConnection): Promise<OpenedCache> {
  // The stamp is read before any CREATE runs, because a newer major must not
  // receive even idempotent DDL.
  const stamp = await readSchemaStamp(conn);
  const verdict = classifySchemaStamp(stamp);
  const cause = readOnlyCauseFor(verdict, stamp);
  const rows = cause
    ? await openReadOnly(conn, cause)
    : await openWritable(conn, verdict === "stamp");
  return { rows, cause, stamp };
}

/** The report line a read-only session keeps in every diagnostic report. */
function readOnlyReportLine(cause: ReadOnlyCause): string {
  return `Cache: read-only, ${cause.code} (${cause.found}; this build supports schema major ${CACHE_SCHEMA_MAJOR})`;
}

/**
 * Create the schema, and stamp it when asked, in one transaction; then load the
 * mirror rows. A corrupt item_cache fails the load too, which doInit codes
 * CG-DB02, not CG-BUG01.
 */
async function openWritable(
  conn: _ZoteroTypes.DBConnection,
  needsStamp: boolean,
): Promise<ItemCacheRow[]> {
  // No gate: requireWritableDb reads module state that init commits only once
  // this returns. The stamp was just classified as this build's, which is the
  // check the gate would make.
  await runInTransaction(conn, (tx) => createSchema(tx, needsStamp));
  return loadMirrorRows(conn);
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
  // Zotero 9.0.6+ closes and reopens a plugin database around its idle backup,
  // and the reopened connection starts without query_only. The callback decides
  // from this connection's classification, which holds from here on, not from
  // module state that init commits only after the mirror loads: Zotero may reopen
  // the connection during that load.
  queryOnlyConnections.add(conn);
  try {
    conn.onConnect?.(async () => {
      if (queryOnlyConnections.has(conn)) await applyQueryOnly(conn);
    });
  } catch (e) {
    Zotero.debug(
      `[Citegeist] onConnect unavailable; query_only covers this connection only until Zotero reopens it: ${normalizeError(e)}`,
    );
  }
  await applyQueryOnly(conn);
  try {
    return await loadMirrorRows(conn);
  } catch (e) {
    // A newer major may have reshaped item_cache. CG-DB03 or CG-DB04 already
    // names the cause, so start with an empty mirror rather than report CG-DB02.
    Zotero.debug(
      `[Citegeist] read-only cache: item_cache unreadable, mirror left empty: ${normalizeError(queryCause(e))}`,
    );
    return [];
  }
}

function loadMirrorRows(conn: _ZoteroTypes.DBConnection): Promise<ItemCacheRow[]> {
  return runRead<ItemCacheRow>(conn, MIRROR_SQL, undefined, COLUMNS);
}

/** `PRAGMA query_only = ON`, as a backstop behind requireWritableDb. Never throws. */
async function applyQueryOnly(conn: _ZoteroTypes.DBConnection): Promise<void> {
  try {
    // A connection setting, neither a read nor a write, so it skips both wrappers.
    await rawQuery(conn, "PRAGMA query_only = ON");
  } catch (e) {
    Zotero.debug(
      `[Citegeist] PRAGMA query_only failed; requireWritableDb still refuses every write: ${normalizeError(queryCause(e))}`,
    );
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
 *
 * Zotero 8.0.4 and 9.0.6 leave the connection's idle observer registered after
 * a permanent close (`closeDatabase`, db.js 8.0.4 lines 967-987, 9.0.6 lines
 * 968-988; 10.0.2 removes it, lines 1206-1211). A later idle backup of this
 * closed connection can call `this._connection.backup` on `false` (8.0.4 line
 * 1112, 9.0.6 line 1134) and log a TypeError to Zotero's console. Nothing is
 * lost. Citegeist does not remove the observer itself: 8.0.4 and 9.0.6 add one
 * on every open of the connection (8.0.4 lines 1291-1297, 9.0.6 lines
 * 1313-1319), so how many remain isn't knowable from here, and removing them
 * would mean passing Zotero's private observer identity and interval to the
 * idle service. See docs/DESIGN.md, "Why Stamp the Cache Schema Version?".
 */
export async function closeCache(): Promise<void> {
  if (initPromise) {
    await initPromise.catch(() => {});
  }
  // From here a write that hasn't passed the gate is refused with CG-DB02
  // instead of racing the close. Writes that already passed it drain below.
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
  const conn = db;
  try {
    if (conn) await conn.closeDatabase(true);
  } finally {
    resetState();
  }
}

/**
 * Test-only: reset every piece of module state, including an init still in
 * flight, and optionally inject a fake DBConnection.
 */
export function _resetForTesting(fakeDb?: _ZoteroTypes.DBConnection): void {
  resetState();
  initPromise = null;
  db = fakeDb ?? null;
}

// ── Connections and the write gate ───────────────────────────────────────────

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
 * cache takes writes: CG-DB03 or CG-DB04 on a read-only cache, CG-DB02 before
 * init and once `closeCache` has started. This is the one question every caller
 * asks before work that only matters if it can be saved.
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

/**
 * The write gate. A cache that doesn't take writes throws a
 * {@link CacheWriteRefusedError} carrying {@link cacheWriteRefusalCode}, so a
 * refused write is never mistaken for one that landed. Call it before the
 * write's first await: a write that passed the gate before `closeCache` started
 * drains, and one that reaches it after is refused.
 */
export function requireWritableDb(operation: string): WritableDb {
  const code = cacheWriteRefusalCode();
  if (code === null && db) return new WritableDb(db);
  const refusal = code ?? "CG-DB02";
  logRefusalOnce(operation, refusal);
  throw new CacheWriteRefusedError(operation, refusal);
}

/**
 * For maintenance that has nothing to do on a cache opened read-only (migration,
 * orphan GC): true on CG-DB03 or CG-DB04, with the refusal logged once and
 * nothing recorded, because the startup notice already says why. Any other
 * refusal returns false, and the maintenance's own requireWritableDb then throws
 * it: a closed cache under maintenance is a lifecycle bug worth a CG-DB02.
 */
export function skipMaintenanceOnReadOnlyCache(operation: string): boolean {
  const code = cacheWriteRefusalCode();
  if (code !== "CG-DB03" && code !== "CG-DB04") return false;
  logRefusalOnce(operation, code);
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

/**
 * What a failed SQL read returns. On a writable or closed cache the failure is
 * rethrown for the caller to handle. On a read-only cache a newer schema may have
 * reshaped the table, and the same read would then fail on every pane render and
 * push real failures out of the diagnostic report: a failure is recorded unless
 * the report still holds the same entry, and every one returns `fallback`.
 */
export function readFailureFallback<T>(operation: string, e: unknown, fallback: T): T {
  const code = cacheWriteRefusalCode();
  if (code !== "CG-DB03" && code !== "CG-DB04") throw e;
  logErrorUnlessBuffered(`${operation} on a read-only cache`, e);
  return fallback;
}

// ── Mirror ───────────────────────────────────────────────────────────────────

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
  // on this key has already passed the gate, so closeCache must drain it too.
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

// ── Statements ───────────────────────────────────────────────────────────────

/**
 * Run a statement, converting any failure into a {@link CacheError} with a
 * STATIC message. The only `queryAsync` call in the codebase; nothing outside
 * this module can reach it.
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
async function rawQuery<T>(
  conn: _ZoteroTypes.DBConnection,
  sql: string,
  params?: readonly SqliteBindValue[],
): Promise<T[]> {
  try {
    // Zotero resolves undefined, not [], for a statement that returns no rows.
    return (await conn.queryAsync<T>(sql, params ? [...params] : undefined)) ?? [];
  } catch (e) {
    throw new CacheError("cache query failed", e);
  }
}

/**
 * Run a read and return its rows as plain objects holding `columns`. A read
 * inside a write transaction passes the transaction. A write statement throws
 * here instead of running.
 */
export async function runRead<T>(
  source: _ZoteroTypes.DBConnection | WriteTransaction,
  sql: string,
  params: readonly SqliteBindValue[] | undefined,
  columns: ReadonlyArray<keyof T & string>,
): Promise<T[]> {
  if (WRITE_STATEMENT.test(sql)) {
    throw new CitegeistError("cache write issued as a read", "CG-BUG01");
  }
  const conn = source instanceof WriteTransaction ? WriteTransaction.connectionOf(source) : source;
  const rows = await rawQuery<Record<string, unknown>>(conn, sql, params);
  return rows.map((row) => plainRow<T>(row, columns));
}

/** Run a write statement inside the transaction `tx` holds open. */
export async function runWrite(
  tx: WriteTransaction,
  sql: string,
  params?: readonly SqliteBindValue[],
): Promise<void> {
  await rawQuery(WriteTransaction.connectionOf(tx), sql, params);
}

/**
 * Copy a host row into a plain object, reading each column by name.
 *
 * Zotero hands each row back as `new Proxy(mozIStorageRow, { get, has })`, and
 * `get` reads a column with `getResultByName`, throwing for a name the row lacks
 * (`queryAsync`, db.js 8.0.4 lines 655-684, 9.0.6 lines 656-685, 10.0.2 lines
 * 667-696). Its column names are not own properties. Without an `ownKeys` trap,
 * spreading or `Object.keys` reports the target's own keys, and the target is
 * the XPConnect wrapper of mozStorage's `Row` (Sqlite.sys.mjs pushes
 * `resultSet.getNextRow()` as is). `Row` keeps names only in its private
 * `mNameHashtable` and has no nsIClassInfo (storage/mozStorageRow.h), so it is
 * wrapped without a prototype (XPCWrappedNative::GetNewOrUsed), which makes
 * `HasMutatedSet()` true (xpcprivate.h). The wrapper's enumerate hook then
 * defines each interface method as an enumerable own property
 * (XPC_WN_Shared_Enumerate and XPC_WN_NoHelper_Resolve,
 * XPCWrappedNativeJSOps.cpp): the keys are names such as `QueryInterface` and
 * `getResultByName`, and the spread's `get` for them throws "DB column not
 * found". A mirror row read back that way would lose every column on the next
 * write, so no host row leaves this module.
 */
function plainRow<T>(row: Record<string, unknown>, columns: ReadonlyArray<keyof T & string>): T {
  const plain: Record<string, unknown> = {};
  for (const column of columns) plain[column] = row[column];
  return plain as T;
}

/**
 * The host's own error behind a failed statement, for local debug lines only.
 * Use it only for statements with no bound parameters: the cause's message
 * repeats them.
 */
function queryCause(e: unknown): unknown {
  return e instanceof CacheError && e.cause !== undefined ? e.cause : e;
}

// ── item_cache writers ───────────────────────────────────────────────────────

export async function upsertRow(row: ItemCacheRow): Promise<void> {
  const writable = requireWritableDb("upsertRow");
  await withKeyLock(row.library_id, row.item_key, async () => {
    await writable.transaction((tx) => runWrite(tx, UPSERT_SQL, rowToParams(row)));
    mirror.set(mirrorKey(row.library_id, row.item_key), row);
    Zotero.debug(
      `[Citegeist] upsertRow: lib=${row.library_id} key=${row.item_key} count=${row.cited_by_count} mirror.size=${mirror.size}`,
    );
  });
}

export async function deleteRow(libraryID: number, itemKey: string): Promise<void> {
  const writable = requireWritableDb("deleteRow");
  await withKeyLock(libraryID, itemKey, async () => {
    await writable.transaction(async (tx) => {
      await runWrite(tx, `DELETE FROM item_cache WHERE library_id = ? AND item_key = ?`, [
        libraryID,
        itemKey,
      ]);
      // Also drop the migration checkpoint so a future force-rerun can
      // actually re-process the item. Without this, a `clearCache` followed
      // by `shouldForceRerun` would skip the now-empty row at checkpoint
      // lookup and the user's intentional clear would not trigger re-migration.
      await runWrite(tx, `DELETE FROM migration_progress WHERE library_id = ? AND item_key = ?`, [
        libraryID,
        itemKey,
      ]);
      // Drop the item's resolved-author links too (per-item author GC). The
      // library-wide sweep for items removed while Zotero was closed rides
      // garbageCollectOrphans.
      await runWrite(tx, `DELETE FROM item_authors WHERE library_id = ? AND item_key = ?`, [
        libraryID,
        itemKey,
      ]);
    });
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
  const writable = requireWritableDb("mutateRow");
  await withKeyLock(libraryID, itemKey, async () => {
    const existing = mirror.get(mirrorKey(libraryID, itemKey));
    const next = transform(existing);
    if (next === null) return;
    await writable.transaction((tx) => runWrite(tx, UPSERT_SQL, rowToParams(next)));
    mirror.set(mirrorKey(next.library_id, next.item_key), next);
  });
}

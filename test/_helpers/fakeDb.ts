/**
 * Shared in-memory fake of `Zotero.DBConnection` for cache-module tests.
 *
 * Decodes the SQL the cache module actually emits — composite-keyed
 * INSERT/SELECT/DELETE against `item_cache`, the `migration_progress`
 * lifecycle, and the `authors` / `item_authors` identity tables. Throws on
 * anything else so a missing handler surfaces loudly.
 *
 * Where the cache depends on how Zotero behaves, the fake behaves the same way:
 * - A result row is a Proxy with no own column keys whose `get` throws for a
 *   column the row lacks ({@link hostRow}), and a statement that returns no rows
 *   resolves undefined.
 * - `executeTransaction` runs one transaction at a time, rolls every table back
 *   when its function rejects, and counts commits as Zotero 10's `_commitCount`
 *   does.
 * - A write outside a transaction throws. Zotero would run it on its own, and
 *   Zotero 10's idle vacuum can then discard it, so no test may pass with one.
 */

import { vi } from "vitest";

export interface FakeRow {
  [col: string]: unknown;
}

export function compositeKey(libraryID: number | string, itemKey: string): string {
  return `${libraryID}:${itemKey}`;
}

function itemAuthorKey(lib: number | string, key: string, authorId: string): string {
  return `${lib}:${key}:${authorId}`;
}

/**
 * A result row the way Zotero's `queryAsync` hands one back (db.js 10.0.2 lines
 * 667-696): a Proxy whose `get` reads a column by name and throws for a column
 * the row doesn't have, over a target that holds no column as an own key, so
 * spreading the row or calling `Object.keys` on it yields no columns. The real
 * target, a wrapped mozIStorageRow, doesn't either: see `plainRow` in
 * src/modules/cache/db.ts.
 */
export function hostRow(columns: Record<string, unknown>): Record<string, unknown> {
  const values = new Map(Object.entries(columns));
  return new Proxy(
    {},
    {
      get(_target, name) {
        // Zotero's handler ignores the promise check.
        if (name === "then" || typeof name !== "string") return undefined;
        if (!values.has(name)) throw new Error(`DB column '${name}' not found`);
        return values.get(name);
      },
      has(_target, name) {
        return typeof name === "string" && Boolean(values.get(name));
      },
    },
  );
}

/**
 * Statements that change the file: CREATE, DELETE, DROP, INSERT and UPDATE
 * (REPLACE and ALTER with them), plus a `user_version` assignment. SQLite's
 * `query_only` refuses them, and the fake refuses them outside a transaction.
 * PRAGMA reads and connection settings run anywhere, and Zotero's close-time WAL
 * checkpoint (closeDatabase) is unaffected.
 */
const WRITE_STATEMENT =
  /^(?:CREATE|DELETE|DROP|INSERT|UPDATE|REPLACE|ALTER)\b|^PRAGMA\s+user_version\s*=/i;

/** Zotero's default wait for another transaction to finish (executeTransaction's `waitTimeout`). */
const TRANSACTION_WAIT_TIMEOUT_MS = 30_000;

/** One statement the fake ran, and the transaction open when it ran (null outside one). */
export interface FakeStatement {
  readonly sql: string;
  readonly transaction: number | null;
}

export function makeFakeDb() {
  // Composite-keyed (`${library_id}:${item_key}`) maps mirroring SQLite.
  const table = new Map<string, FakeRow>();
  const progress = new Map<string, string>();
  // author_id → row
  const authors = new Map<string, FakeRow>();
  // `${library_id}:${item_key}:${author_id}` → row
  const itemAuthors = new Map<string, FakeRow>();

  function emptyAuthor(authorId: string): FakeRow {
    return {
      author_id: authorId,
      display_name: null,
      orcid: null,
      works_count: null,
      cited_by_count: null,
      h_index: null,
      i10_index: null,
      last_fetched: null,
    };
  }

  // Connection/header state set through PRAGMA. `userVersion` persists with the
  // "file" (seed it to model a stamped database, with any value the host could
  // hand back); `queryOnly` is per connection; `column` is the name the PRAGMA
  // row carries its value under, so a test can model a host that renames it.
  const pragma: { userVersion: unknown; queryOnly: boolean; column: string } = {
    userVersion: 0,
    queryOnly: false,
    column: "user_version",
  };
  const connectCallbacks: Array<() => unknown> = [];

  /** Every statement, in order, with the transaction it ran in. */
  const statements: FakeStatement[] = [];
  /** Commits and rollbacks, and the transaction open now. */
  const transactions: { commitCount: number; rollbackCount: number; openID: number | null } = {
    commitCount: 0,
    rollbackCount: 0,
    openID: null,
  };
  let openSettled: Promise<void> = Promise.resolve();
  let lastTransactionID = 0;
  /**
   * Whether closeDatabase(true) ran. Statements still run afterwards, because
   * tests reopen the same fake to model a restart on the same file.
   */
  const connection = { closedPermanently: false };

  function snapshot() {
    const rows = (m: Map<string, FakeRow>) => new Map([...m].map(([k, r]) => [k, { ...r }]));
    return {
      table: rows(table),
      progress: new Map(progress),
      authors: rows(authors),
      itemAuthors: rows(itemAuthors),
      userVersion: pragma.userVersion,
    };
  }

  function restore(saved: ReturnType<typeof snapshot>): void {
    const refill = <K, V>(target: Map<K, V>, source: Map<K, V>) => {
      target.clear();
      for (const [k, v] of source) target.set(k, v);
    };
    refill(table, saved.table);
    refill(progress, saved.progress);
    refill(authors, saved.authors);
    refill(itemAuthors, saved.itemAuthors);
    pragma.userVersion = saved.userVersion;
  }

  async function waitForOpenTransaction(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        openSettled,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Timed out waiting for DB transaction")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The statement's rows, or undefined for a statement that returns none. */
  function run(s: string, p: unknown[]): Array<Record<string, unknown>> | undefined {
    // ── PRAGMA ──
    if (/^PRAGMA\s+user_version\s*$/i.test(s)) {
      return [hostRow({ [pragma.column]: pragma.userVersion })];
    }
    if (/^PRAGMA\s+query_only\s*=\s*ON\s*$/i.test(s)) {
      pragma.queryOnly = true;
      return undefined;
    }
    const stamp = /^PRAGMA\s+user_version\s*=\s*(-?\d+)\s*$/i.exec(s);
    if (stamp) {
      pragma.userVersion = Number(stamp[1]);
      return undefined;
    }

    if (/^CREATE\s+(TABLE|INDEX)/i.test(s)) return undefined;
    if (/^DROP\s+INDEX/i.test(s)) return undefined;

    // ── item_cache ──
    if (/^INSERT\s+OR\s+REPLACE\s+INTO\s+item_cache/i.test(s)) {
      const colsMatch = /\(([^)]+)\)\s+VALUES/i.exec(s);
      if (!colsMatch) throw new Error("bad INSERT statement: " + s);
      const cols = colsMatch[1].split(",").map((c) => c.trim());
      const row: FakeRow = {};
      cols.forEach((c, i) => {
        row[c] = p[i] ?? null;
      });
      table.set(compositeKey(row.library_id as number, row.item_key as string), row);
      return undefined;
    }

    if (/^INSERT\s+OR\s+REPLACE\s+INTO\s+migration_progress/i.test(s)) {
      const [libId, key, at] = p as [number, string, string];
      progress.set(compositeKey(libId, key), at);
      return undefined;
    }

    const mirrorSelect = /^SELECT\s+([\w\s,*]+?)\s+FROM\s+item_cache\s*$/i.exec(s);
    if (mirrorSelect) {
      const list = mirrorSelect[1].trim();
      const cols = list === "*" ? null : list.split(",").map((c) => c.trim());
      return [...table.values()].map((row) =>
        hostRow(cols ? Object.fromEntries(cols.map((c) => [c, row[c] ?? null])) : row),
      );
    }

    if (/^SELECT\s+library_id,\s+item_key\s+FROM\s+migration_progress/i.test(s)) {
      return [...progress.keys()].map((c) => {
        const [lib, key] = c.split(":");
        return hostRow({ library_id: Number(lib), item_key: key });
      });
    }

    if (/^SELECT\s+item_key\s+FROM\s+migration_progress/i.test(s)) {
      const [libId, key] = p as [number, string];
      return progress.has(compositeKey(libId, key)) ? [hostRow({ item_key: key })] : [];
    }

    if (
      /^DELETE\s+FROM\s+item_cache\s+WHERE\s+library_id\s+=\s+\?\s+AND\s+item_key\s+=\s+\?/i.test(s)
    ) {
      const [libId, key] = p as [number, string];
      table.delete(compositeKey(libId, key));
      return undefined;
    }

    if (/^DELETE\s+FROM\s+item_cache\s+WHERE\s+\(library_id,\s+item_key\)\s+IN/i.test(s)) {
      for (let i = 0; i < p.length; i += 2) {
        table.delete(compositeKey(p[i] as number, p[i + 1] as string));
      }
      return undefined;
    }

    if (/^DELETE\s+FROM\s+migration_progress\s+WHERE\s+\(library_id,\s+item_key\)\s+IN/i.test(s)) {
      for (let i = 0; i < p.length; i += 2) {
        progress.delete(compositeKey(p[i] as number, p[i + 1] as string));
      }
      return undefined;
    }

    if (
      /^DELETE\s+FROM\s+migration_progress\s+WHERE\s+library_id\s+=\s+\?\s+AND\s+item_key\s+=\s+\?/i.test(
        s,
      )
    ) {
      const [libId, key] = p as [number, string];
      progress.delete(compositeKey(libId, key));
      return undefined;
    }

    if (/^DELETE\s+FROM\s+migration_progress\s*$/i.test(s)) {
      progress.clear();
      return undefined;
    }

    // ── authors ──
    if (/^INSERT\s+OR\s+IGNORE\s+INTO\s+authors/i.test(s)) {
      const [authorId] = p as [string];
      if (!authors.has(authorId)) authors.set(authorId, emptyAuthor(authorId));
      return undefined;
    }

    if (/^UPDATE\s+authors\s+SET\s+display_name\s*=\s*\?,\s*orcid\s*=\s*\?\s+WHERE/i.test(s)) {
      const [displayName, orcid, authorId] = p as [string | null, string | null, string];
      const row = authors.get(authorId);
      if (row) {
        row.display_name = displayName;
        row.orcid = orcid;
      }
      return undefined;
    }

    if (/^UPDATE\s+authors\s+SET\s+works_count/i.test(s)) {
      const [wc, cc, h, i10, lf, authorId] = p as [
        number | null,
        number | null,
        number | null,
        number | null,
        string | null,
        string,
      ];
      const row = authors.get(authorId);
      if (row) {
        row.works_count = wc;
        row.cited_by_count = cc;
        row.h_index = h;
        row.i10_index = i10;
        row.last_fetched = lf;
      }
      return undefined;
    }

    if (/^SELECT[\s\S]*FROM\s+authors\s+WHERE\s+author_id\s*=\s*\?/i.test(s)) {
      const [authorId] = p as [string];
      const row = authors.get(authorId);
      return row ? [hostRow(row)] : [];
    }

    if (/^DELETE\s+FROM\s+authors\s+WHERE\s+author_id\s+NOT\s+IN/i.test(s)) {
      const referenced = new Set<string>();
      for (const r of itemAuthors.values()) referenced.add(r.author_id as string);
      for (const id of [...authors.keys()]) {
        if (!referenced.has(id)) authors.delete(id);
      }
      return undefined;
    }

    // reconcileAuthorMerge: drop the merged-away author row.
    if (/^DELETE\s+FROM\s+authors\s+WHERE\s+author_id\s*=\s*\?\s*$/i.test(s)) {
      const [id] = p as [string];
      authors.delete(id);
      return undefined;
    }

    // ── item_authors ──
    if (/^INSERT\s+OR\s+REPLACE\s+INTO\s+item_authors/i.test(s)) {
      const colsMatch = /\(([^)]+)\)\s+VALUES/i.exec(s);
      if (!colsMatch) throw new Error("bad INSERT statement: " + s);
      const cols = colsMatch[1].split(",").map((c) => c.trim());
      const row: FakeRow = {};
      cols.forEach((c, i) => {
        row[c] = p[i] ?? null;
      });
      itemAuthors.set(
        itemAuthorKey(row.library_id as number, row.item_key as string, row.author_id as string),
        row,
      );
      return undefined;
    }

    if (/^SELECT\s+author_id,\s*is_curated\s+FROM\s+item_authors/i.test(s)) {
      const [lib, key] = p as [number, string];
      return [...itemAuthors.values()]
        .filter((r) => r.library_id === lib && r.item_key === key)
        .map((r) => hostRow({ author_id: r.author_id, is_curated: r.is_curated }));
    }

    if (/^SELECT[\s\S]*FROM\s+item_authors[\s\S]*ORDER\s+BY\s+author_position/i.test(s)) {
      const [lib, key] = p as [number, string];
      return [...itemAuthors.values()]
        .filter((r) => r.library_id === lib && r.item_key === key)
        .sort((a, b) => ((a.author_position as number) ?? 0) - ((b.author_position as number) ?? 0))
        .map((r) => hostRow(r));
    }

    if (
      /^DELETE\s+FROM\s+item_authors\s+WHERE\s+library_id\s*=\s*\?\s+AND\s+item_key\s*=\s*\?\s+AND\s+\(is_curated/i.test(
        s,
      )
    ) {
      const [lib, key] = p as [number, string];
      for (const [k, r] of [...itemAuthors.entries()]) {
        if (r.library_id === lib && r.item_key === key && r.is_curated !== 1) itemAuthors.delete(k);
      }
      return undefined;
    }

    if (
      /^DELETE\s+FROM\s+item_authors\s+WHERE\s+library_id\s*=\s*\?\s+AND\s+item_key\s*=\s*\?\s*$/i.test(
        s,
      )
    ) {
      const [lib, key] = p as [number, string];
      for (const [k, r] of [...itemAuthors.entries()]) {
        if (r.library_id === lib && r.item_key === key) itemAuthors.delete(k);
      }
      return undefined;
    }

    if (/^DELETE\s+FROM\s+item_authors\s+WHERE\s+\(library_id,\s*item_key\)\s+IN/i.test(s)) {
      const pairs = new Set<string>();
      for (let i = 0; i < p.length; i += 2)
        pairs.add(compositeKey(p[i] as number, p[i + 1] as string));
      for (const [k, r] of [...itemAuthors.entries()]) {
        if (pairs.has(compositeKey(r.library_id as number, r.item_key as string))) {
          itemAuthors.delete(k);
        }
      }
      return undefined;
    }

    // reconcileAuthorMerge: move refs to the survivor where the item doesn't
    // already carry it (IGNORE the collision — step-2 delete cleans it up).
    if (
      /^UPDATE\s+OR\s+IGNORE\s+item_authors\s+SET\s+author_id\s*=\s*\?\s+WHERE\s+author_id\s*=\s*\?/i.test(
        s,
      )
    ) {
      const [to, from] = p as [string, string];
      for (const [k, r] of [...itemAuthors.entries()]) {
        if (r.author_id !== from) continue;
        const newKey = itemAuthorKey(r.library_id as number, r.item_key as string, to);
        if (itemAuthors.has(newKey)) continue; // survivor already present → IGNORE
        itemAuthors.delete(k);
        r.author_id = to;
        itemAuthors.set(newKey, r);
      }
      return undefined;
    }

    if (/^DELETE\s+FROM\s+item_authors\s+WHERE\s+author_id\s*=\s*\?\s*$/i.test(s)) {
      const [id] = p as [string];
      for (const [k, r] of [...itemAuthors.entries()]) {
        if (r.author_id === id) itemAuthors.delete(k);
      }
      return undefined;
    }

    // setCuratedItemAuthor override: clear the other author at this position.
    if (
      /^DELETE\s+FROM\s+item_authors\s+WHERE\s+library_id\s*=\s*\?\s+AND\s+item_key\s*=\s*\?\s+AND\s+author_position\s*=\s*\?\s+AND\s+author_id\s*!=\s*\?/i.test(
        s,
      )
    ) {
      const [lib, key, pos, keepId] = p as [number, string, number, string];
      for (const [k, r] of [...itemAuthors.entries()]) {
        if (
          r.library_id === lib &&
          r.item_key === key &&
          r.author_position === pos &&
          r.author_id !== keepId
        ) {
          itemAuthors.delete(k);
        }
      }
      return undefined;
    }

    throw new Error("unhandled SQL in fake DB: " + s);
  }

  return {
    table,
    progress,
    authors,
    itemAuthors,
    pragma,
    statements,
    transactions,
    /** Zotero 9.0.6+ `DBConnection.onConnect`: runs on every reopen. */
    onConnect: vi.fn((callback: () => unknown) => {
      connectCallbacks.push(callback);
    }),
    /**
     * Model Zotero reopening the connection around its idle backup: the new
     * connection starts without per-connection PRAGMAs, then the onConnect
     * callbacks run.
     */
    async reconnect(): Promise<void> {
      pragma.queryOnly = false;
      for (const callback of connectCallbacks) await callback();
    },
    queryAsync: vi.fn(
      async (
        sql: string,
        params?: unknown[],
      ): Promise<Array<Record<string, unknown>> | undefined> => {
        const s = sql.trim();
        statements.push({ sql: s, transaction: transactions.openID });
        if (WRITE_STATEMENT.test(s)) {
          // Model query_only so a write that gets past requireWritableDb fails
          // loudly here, as SQLite would fail it.
          if (pragma.queryOnly) throw new Error("attempt to write a readonly database");
          if (transactions.openID === null) throw new Error(`write outside a transaction: ${s}`);
        }
        return run(s, (params ?? []) as unknown[]);
      },
    ),
    /**
     * Zotero's `executeTransaction`: one at a time, waiting for an open one;
     * COMMIT counts, and a rejection from `func` rolls every table back.
     */
    executeTransaction: vi.fn(
      async <T>(func: () => Promise<T>, options: { waitTimeout?: number } = {}): Promise<T> => {
        while (transactions.openID !== null) {
          await waitForOpenTransaction(options.waitTimeout ?? TRANSACTION_WAIT_TIMEOUT_MS);
        }
        let settle: () => void = () => {};
        openSettled = new Promise<void>((resolve) => {
          settle = resolve;
        });
        transactions.openID = ++lastTransactionID;
        const saved = snapshot();
        try {
          const result = await func();
          transactions.commitCount++;
          return result;
        } catch (e) {
          restore(saved);
          transactions.rollbackCount++;
          throw e;
        } finally {
          transactions.openID = null;
          settle();
        }
      },
    ),
    connection,
    closeDatabase: vi.fn(async (permanent?: boolean) => {
      if (permanent) connection.closedPermanently = true;
    }),
  };
}

export type FakeDb = ReturnType<typeof makeFakeDb>;

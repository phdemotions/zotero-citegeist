/**
 * Shared in-memory fake of `Zotero.DBConnection` for cache-module tests.
 *
 * Decodes the SQL the cache module actually emits — composite-keyed
 * INSERT/SELECT/DELETE against `item_cache` plus the `migration_progress`
 * lifecycle. Throws on anything else so a missing handler surfaces loudly.
 */

import { vi } from "vitest";

export interface FakeRow {
  [col: string]: unknown;
}

export function compositeKey(libraryID: number | string, itemKey: string): string {
  return `${libraryID}:${itemKey}`;
}

export function makeFakeDb() {
  // Composite-keyed (`${library_id}:${item_key}`) maps mirroring SQLite.
  const table = new Map<string, FakeRow>();
  const progress = new Map<string, string>();

  return {
    table,
    progress,
    queryAsync: vi.fn(async (sql: string, params?: unknown[]) => {
      const s = sql.trim();

      if (/^CREATE\s+(TABLE|INDEX)/i.test(s)) return [];
      if (/^DROP\s+INDEX/i.test(s)) return [];

      if (/^INSERT\s+OR\s+REPLACE\s+INTO\s+item_cache/i.test(s)) {
        const colsMatch = /\(([^)]+)\)\s+VALUES/i.exec(s);
        if (!colsMatch) throw new Error("bad INSERT statement: " + s);
        const cols = colsMatch[1].split(",").map((c) => c.trim());
        const row: FakeRow = {};
        cols.forEach((c, i) => {
          row[c] = params?.[i] ?? null;
        });
        table.set(compositeKey(row.library_id as number, row.item_key as string), row);
        return [];
      }

      if (/^INSERT\s+OR\s+REPLACE\s+INTO\s+migration_progress/i.test(s)) {
        const [libId, key, at] = params as [number, string, string];
        progress.set(compositeKey(libId, key), at);
        return [];
      }

      if (/^SELECT\s+\*\s+FROM\s+item_cache/i.test(s)) {
        return Array.from(table.values());
      }

      if (/^SELECT\s+library_id,\s+item_key\s+FROM\s+migration_progress/i.test(s)) {
        const rows: Array<{ library_id: number; item_key: string }> = [];
        for (const c of progress.keys()) {
          const [lib, key] = c.split(":");
          rows.push({ library_id: Number(lib), item_key: key });
        }
        return rows;
      }

      if (/^SELECT\s+item_key\s+FROM\s+migration_progress/i.test(s)) {
        const [libId, key] = params as [number, string];
        return progress.has(compositeKey(libId, key)) ? [{ item_key: key }] : [];
      }

      if (
        /^DELETE\s+FROM\s+item_cache\s+WHERE\s+library_id\s+=\s+\?\s+AND\s+item_key\s+=\s+\?/i.test(
          s,
        )
      ) {
        const [libId, key] = params as [number, string];
        table.delete(compositeKey(libId, key));
        return [];
      }

      if (/^DELETE\s+FROM\s+item_cache\s+WHERE\s+\(library_id,\s+item_key\)\s+IN/i.test(s)) {
        const p = (params ?? []) as Array<number | string>;
        for (let i = 0; i < p.length; i += 2) {
          table.delete(compositeKey(p[i] as number, p[i + 1] as string));
        }
        return [];
      }

      if (
        /^DELETE\s+FROM\s+migration_progress\s+WHERE\s+\(library_id,\s+item_key\)\s+IN/i.test(s)
      ) {
        const p = (params ?? []) as Array<number | string>;
        for (let i = 0; i < p.length; i += 2) {
          progress.delete(compositeKey(p[i] as number, p[i + 1] as string));
        }
        return [];
      }

      if (
        /^DELETE\s+FROM\s+migration_progress\s+WHERE\s+library_id\s+=\s+\?\s+AND\s+item_key\s+=\s+\?/i.test(
          s,
        )
      ) {
        const [libId, key] = params as [number, string];
        progress.delete(compositeKey(libId, key));
        return [];
      }

      if (/^DELETE\s+FROM\s+migration_progress\s*$/i.test(s)) {
        progress.clear();
        return [];
      }

      throw new Error("unhandled SQL in fake DB: " + s);
    }),
    closeDatabase: vi.fn(async () => {}),
  };
}

export type FakeDb = ReturnType<typeof makeFakeDb>;

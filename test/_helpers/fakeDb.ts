/**
 * Shared in-memory fake of `Zotero.DBConnection` for cache-module tests.
 *
 * Decodes the SQL the cache module actually emits — composite-keyed
 * INSERT/SELECT/DELETE against `item_cache`, the `migration_progress`
 * lifecycle, and the `authors` / `item_authors` identity tables. Throws on
 * anything else so a missing handler surfaces loudly.
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

  return {
    table,
    progress,
    authors,
    itemAuthors,
    queryAsync: vi.fn(async (sql: string, params?: unknown[]) => {
      const s = sql.trim();
      const p = (params ?? []) as unknown[];

      if (/^CREATE\s+(TABLE|INDEX)/i.test(s)) return [];
      if (/^DROP\s+INDEX/i.test(s)) return [];

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
        return [];
      }

      if (/^INSERT\s+OR\s+REPLACE\s+INTO\s+migration_progress/i.test(s)) {
        const [libId, key, at] = p as [number, string, string];
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
        const [libId, key] = p as [number, string];
        return progress.has(compositeKey(libId, key)) ? [{ item_key: key }] : [];
      }

      if (
        /^DELETE\s+FROM\s+item_cache\s+WHERE\s+library_id\s+=\s+\?\s+AND\s+item_key\s+=\s+\?/i.test(
          s,
        )
      ) {
        const [libId, key] = p as [number, string];
        table.delete(compositeKey(libId, key));
        return [];
      }

      if (/^DELETE\s+FROM\s+item_cache\s+WHERE\s+\(library_id,\s+item_key\)\s+IN/i.test(s)) {
        for (let i = 0; i < p.length; i += 2) {
          table.delete(compositeKey(p[i] as number, p[i + 1] as string));
        }
        return [];
      }

      if (
        /^DELETE\s+FROM\s+migration_progress\s+WHERE\s+\(library_id,\s+item_key\)\s+IN/i.test(s)
      ) {
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
        const [libId, key] = p as [number, string];
        progress.delete(compositeKey(libId, key));
        return [];
      }

      if (/^DELETE\s+FROM\s+migration_progress\s*$/i.test(s)) {
        progress.clear();
        return [];
      }

      // ── authors ──
      if (/^INSERT\s+OR\s+IGNORE\s+INTO\s+authors/i.test(s)) {
        const [authorId] = p as [string];
        if (!authors.has(authorId)) authors.set(authorId, emptyAuthor(authorId));
        return [];
      }

      if (/^UPDATE\s+authors\s+SET\s+display_name\s*=\s*\?,\s*orcid\s*=\s*\?\s+WHERE/i.test(s)) {
        const [displayName, orcid, authorId] = p as [string | null, string | null, string];
        const row = authors.get(authorId);
        if (row) {
          row.display_name = displayName;
          row.orcid = orcid;
        }
        return [];
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
        return [];
      }

      if (/^SELECT[\s\S]*FROM\s+authors\s+WHERE\s+author_id\s*=\s*\?/i.test(s)) {
        const [authorId] = p as [string];
        const row = authors.get(authorId);
        return row ? [row] : [];
      }

      if (/^DELETE\s+FROM\s+authors\s+WHERE\s+author_id\s+NOT\s+IN/i.test(s)) {
        const referenced = new Set<string>();
        for (const r of itemAuthors.values()) referenced.add(r.author_id as string);
        for (const id of [...authors.keys()]) {
          if (!referenced.has(id)) authors.delete(id);
        }
        return [];
      }

      // reconcileAuthorMerge: drop the merged-away author row.
      if (/^DELETE\s+FROM\s+authors\s+WHERE\s+author_id\s*=\s*\?\s*$/i.test(s)) {
        const [id] = p as [string];
        authors.delete(id);
        return [];
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
        return [];
      }

      if (/^SELECT\s+author_id,\s*is_curated\s+FROM\s+item_authors/i.test(s)) {
        const [lib, key] = p as [number, string];
        return [...itemAuthors.values()]
          .filter((r) => r.library_id === lib && r.item_key === key)
          .map((r) => ({ author_id: r.author_id, is_curated: r.is_curated }));
      }

      if (/^SELECT[\s\S]*FROM\s+item_authors[\s\S]*ORDER\s+BY\s+author_position/i.test(s)) {
        const [lib, key] = p as [number, string];
        return [...itemAuthors.values()]
          .filter((r) => r.library_id === lib && r.item_key === key)
          .sort(
            (a, b) => ((a.author_position as number) ?? 0) - ((b.author_position as number) ?? 0),
          );
      }

      if (
        /^DELETE\s+FROM\s+item_authors\s+WHERE\s+library_id\s*=\s*\?\s+AND\s+item_key\s*=\s*\?\s+AND\s+\(is_curated/i.test(
          s,
        )
      ) {
        const [lib, key] = p as [number, string];
        for (const [k, r] of [...itemAuthors.entries()]) {
          if (r.library_id === lib && r.item_key === key && r.is_curated !== 1)
            itemAuthors.delete(k);
        }
        return [];
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
        return [];
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
        return [];
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
        return [];
      }

      if (/^DELETE\s+FROM\s+item_authors\s+WHERE\s+author_id\s*=\s*\?\s*$/i.test(s)) {
        const [id] = p as [string];
        for (const [k, r] of [...itemAuthors.entries()]) {
          if (r.author_id === id) itemAuthors.delete(k);
        }
        return [];
      }

      throw new Error("unhandled SQL in fake DB: " + s);
    }),
    closeDatabase: vi.fn(async () => {}),
  };
}

export type FakeDb = ReturnType<typeof makeFakeDb>;

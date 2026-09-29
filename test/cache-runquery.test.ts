/**
 * The cache's statement path, tested directly.
 *
 * Its static failure message keeps Zotero's bound-parameter dump (which includes
 * item titles, DOIs, and co-author names/ORCIDs) out of the shareable diagnostic
 * report. It is the SOLE defense for a free-text title — DOIs/ids/paths have
 * redaction nets, a title does not — so it earns a direct behavioral test, not
 * just the item_cache integration path. `runRead` also copies Zotero's row
 * Proxies into plain objects and refuses to run a write.
 */
import { describe, it, expect, vi } from "vitest";
import { runRead } from "../src/modules/cache/db";
import { CacheError, normalizeError } from "../src/modules/utils";
import { hostRow } from "./_helpers/fakeDb";

vi.stubGlobal("Zotero", { debug: vi.fn() });

// A Zotero DBConnection whose queryAsync rejects the way the real one does on a
// locked/busy file: SQL + a JSON dump of every bound parameter in the message.
function failingConn(message: string): _ZoteroTypes.DBConnection {
  return {
    queryAsync: () => Promise.reject(new Error(message)),
  } as unknown as _ZoteroTypes.DBConnection;
}

function connReturning(result: unknown) {
  const queryAsync = vi.fn(() => Promise.resolve(result));
  return { conn: { queryAsync } as unknown as _ZoteroTypes.DBConnection, queryAsync };
}

describe("runRead", () => {
  const leakyMessage =
    "SQLITE_BUSY [QUERY: SELECT display_name FROM authors WHERE author_id=?] " +
    '[PARAMS: "Jane Q. Researcher", "0000-0002-1825-0097", A5023888391] ' +
    "[cache: 10.1038/nature12373]";

  it("converts a failure into a CacheError with a STATIC message", async () => {
    const err = await runRead(
      failingConn(leakyMessage),
      "SELECT display_name FROM authors WHERE author_id = ?",
      ["x"],
      ["display_name"],
    ).catch((e) => e);
    expect(err).toBeInstanceOf(CacheError);
    expect(err.message).toBe("cache query failed");
    expect(err.code).toBe("CG-DB01");
  });

  it("keeps the param dump out of what reaches the diagnostic buffer", () => {
    const err = new CacheError("cache query failed", new Error(leakyMessage));
    // normalizeError is what logError records; it must not traverse `cause`.
    const recorded = normalizeError(err);
    expect(recorded).not.toContain("Jane Q. Researcher");
    expect(recorded).not.toContain("0000-0002-1825-0097");
    expect(recorded).not.toContain("nature12373");
    expect(recorded).toContain("cache query failed");
  });

  it("copies each host row into a plain object holding exactly the named columns", async () => {
    // Positive control: a host row spreads to nothing, so a copy made by spreading
    // would lose every column.
    expect({ ...hostRow({ n: 1 }) }).toEqual({});
    expect(Object.keys(hostRow({ n: 1 }))).toEqual([]);

    const { conn } = connReturning([hostRow({ n: 1, m: "x" })]);
    const rows = await runRead<{ n: number }>(conn, "SELECT n, m FROM t", [], ["n"]);

    expect(rows).toEqual([{ n: 1 }]);
    expect({ ...rows[0] }).toEqual({ n: 1 });
  });

  it("fails a read that names a column the host row lacks, as Zotero's Proxy does", async () => {
    const { conn } = connReturning([hostRow({ n: 1 })]);
    await expect(runRead<{ m: number }>(conn, "SELECT n FROM t", [], ["m"])).rejects.toThrow(
      /DB column 'm' not found/,
    );
  });

  it("reads no rows when Zotero resolves undefined", async () => {
    const { conn } = connReturning(undefined);
    expect(await runRead(conn, "SELECT n FROM t WHERE 0", [], [])).toEqual([]);
  });

  it.each([
    "delete from item_cache",
    "  INSERT OR REPLACE INTO item_cache (library_id) VALUES (?)",
    "PRAGMA user_version = 5",
    "vacuum",
  ])("refuses to run the write %j as a read, before it reaches the connection", async (sql) => {
    const { conn, queryAsync } = connReturning([]);
    await expect(runRead(conn, sql, [], [])).rejects.toMatchObject({ code: "CG-BUG01" });
    expect(queryAsync).not.toHaveBeenCalled();
  });
});

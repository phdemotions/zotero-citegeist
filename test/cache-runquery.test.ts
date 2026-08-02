/**
 * runQuery is the static-message shield that keeps Zotero's bound-parameter dump
 * (which includes item titles, DOIs, and co-author names/ORCIDs) out of the
 * shareable diagnostic report. It is the SOLE defense for a free-text title —
 * DOIs/ids/paths have redaction nets, a title does not — so it earns a direct
 * behavioral test, not just the item_cache integration path.
 */
import { describe, it, expect, vi } from "vitest";
import { runQuery } from "../src/modules/cache/db";
import { CacheError, normalizeError } from "../src/modules/utils";

vi.stubGlobal("Zotero", { debug: vi.fn() });

// A Zotero DBConnection whose queryAsync rejects the way the real one does on a
// locked/busy file: SQL + a JSON dump of every bound parameter in the message.
function failingConn(message: string): _ZoteroTypes.DBConnection {
  return {
    queryAsync: () => Promise.reject(new Error(message)),
  } as unknown as _ZoteroTypes.DBConnection;
}

describe("runQuery", () => {
  const leakyMessage =
    "SQLITE_BUSY [QUERY: UPDATE authors SET display_name=?, orcid=?] " +
    '[PARAMS: "Jane Q. Researcher", "0000-0002-1825-0097", A5023888391] ' +
    "[cache: 10.1038/nature12373]";

  it("converts a failure into a CacheError with a STATIC message", async () => {
    const err = await runQuery(failingConn(leakyMessage), "UPDATE …", ["x"]).catch((e) => e);
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

  it("passes a successful result straight through", async () => {
    const conn = {
      queryAsync: () => Promise.resolve([{ n: 1 }]),
    } as unknown as _ZoteroTypes.DBConnection;
    expect(await runQuery<{ n: number }>(conn, "SELECT 1", [])).toEqual([{ n: 1 }]);
  });
});

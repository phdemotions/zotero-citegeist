/**
 * An older Citegeist on a database a newer schema major wrote: it keeps reading,
 * refuses to write or fetch, and leaves a code to quote.
 *
 * RESTARTS THE PLUGIN: it disables and re-enables Citegeist, so it is numbered
 * in the 90s (00-root-hooks.spec.ts) and runs after 90-lifecycle. Its after hook
 * puts back the current stamp and a running copy, so a later 9x spec starts from
 * the state every other spec expects.
 *
 * Catches: a build that never stamps (PRAGMA user_version is not the current
 * schema on the profile it opened); a newer-major stamp that still lets a fetch
 * reach OpenAlex or write a row; a stamp overwritten on open; and a refusal that
 * leaves nothing to quote (the report's read-only line missing, or CG-DB03
 * recorded once per item instead of once at startup).
 *
 * While enabled, Citegeist holds citegeist.sqlite under an EXCLUSIVE lock, so
 * the spec reads and rewrites the stamp only while Citegeist is disabled, and
 * only after the "[Citegeist] Shutdown complete" line says its cache has closed.
 *
 * Expected error lines: startup on the newer major logs CG-DB03 once, as the
 * "cache schema check" line, and that one line is allowed. Refused writes and
 * fetches log Debug Output lines without the ERROR mark, so any ERROR line the
 * read-only session adds beyond that one still fails the test.
 */
import {
  CACHE_SCHEMA_MAJOR,
  CACHE_SCHEMA_MINOR,
  CACHE_SCHEMA_STAMP_MULTIPLIER,
} from "../../src/constants";
import { BUDGETS, SHUTDOWN_WAIT_TIMEOUT_MS, STARTUP_WAIT_TIMEOUT_MS } from "./shared/timeouts";
import { READ_ONLY_STARTUP_ERROR, SHUTDOWN_COMPLETE_DEBUG_LINE } from "./support/citegeist";
import { allowCitegeistErrors } from "./support/harnessState";
import {
  debugLinesContaining,
  getCitegeistAddon,
  stubRequestLog,
  stubRequestsSince,
  useStubItem,
  waitFor,
  waitForCitegeistReady,
  waitForNewDebugLine,
} from "./support/zotero";

const CURRENT_STAMP = CACHE_SCHEMA_MAJOR * CACHE_SCHEMA_STAMP_MULTIPLIER + CACHE_SCHEMA_MINOR;
// One major ahead: READ_ONLY_STARTUP_ERROR is the line for exactly this stamp.
const NEWER_MAJOR_STAMP = (CACHE_SCHEMA_MAJOR + 1) * CACHE_SCHEMA_STAMP_MULTIPLIER;

/** The part of Zotero's DBConnection this spec uses on citegeist.sqlite. */
interface CacheFileConnection {
  queryAsync(sql: string): Promise<Array<Record<string, unknown>>>;
  closeDatabase(permanent: boolean): Promise<void>;
}

/** Disable Citegeist and wait until its cache has closed. A no-op when it is already inactive. */
async function disableCitegeist(): Promise<void> {
  const addon = await getCitegeistAddon();
  if (!addon.isActive) return;
  const shutdownsBefore = debugLinesContaining(SHUTDOWN_COMPLETE_DEBUG_LINE);
  await addon.disable();
  await waitForNewDebugLine(
    "Citegeist's shutdown to complete (its cache closed)",
    SHUTDOWN_COMPLETE_DEBUG_LINE,
    shutdownsBefore,
    SHUTDOWN_WAIT_TIMEOUT_MS,
  );
  await waitFor("Zotero to report Citegeist inactive", async () => {
    return !(await getCitegeistAddon()).isActive;
  });
}

/** Enable Citegeist and wait until its bridge reports ready. */
async function enableCitegeist(what: string): Promise<void> {
  const addon = await getCitegeistAddon();
  await addon.enable();
  await waitForCitegeistReady(what, STARTUP_WAIT_TIMEOUT_MS);
}

/** Run `fn` on citegeist.sqlite over the spec's own connection. Citegeist must be disabled. */
async function withCacheFile<T>(fn: (conn: CacheFileConnection) => Promise<T>): Promise<T> {
  const conn: CacheFileConnection = new Zotero.DBConnection("citegeist");
  try {
    return await fn(conn);
  } finally {
    // Release the file before Citegeist opens it again.
    await conn.closeDatabase(true);
  }
}

async function readStamp(conn: CacheFileConnection): Promise<number> {
  const rows = await conn.queryAsync("PRAGMA user_version");
  return Number(rows[0].user_version);
}

async function countRows(conn: CacheFileConnection): Promise<number> {
  const rows = await conn.queryAsync("SELECT COUNT(*) AS n FROM item_cache");
  return Number(rows[0].n);
}

/** Lines of the report's "Recent problems" section that carry `code`. */
function recentProblemsWith(report: string, code: string): string[] {
  const recent = report.split(/^Recent problems/m)[1] ?? "";
  return recent.split("\n").filter((line) => line.includes(code));
}

describe("cache schema stamp", function () {
  let rowsBefore: number | undefined;

  // Registered before useStubItem, so it runs before the stub item is erased:
  // the item goes away while a writable copy is running, as it would for a user.
  after(async function () {
    this.timeout(BUDGETS.schemaStampRestore.timeoutMs);
    await disableCitegeist();
    await withCacheFile((conn) => conn.queryAsync(`PRAGMA user_version = ${CURRENT_STAMP}`));
    await enableCitegeist("Citegeist to restart on the restored stamp");
  });

  const stub = useStubItem("Citegeist schema-stamp spec");

  it("stamps the database it opened with the current schema", async function () {
    this.timeout(BUDGETS.schemaStampDisable.timeoutMs);
    await disableCitegeist();
    await withCacheFile(async (conn) => {
      expect(await readStamp(conn), "PRAGMA user_version after startup").to.equal(CURRENT_STAMP);
      rowsBefore = await countRows(conn);
      await conn.queryAsync(`PRAGMA user_version = ${NEWER_MAJOR_STAMP}`);
      expect(await readStamp(conn), "positive control: the newer stamp was written").to.equal(
        NEWER_MAJOR_STAMP,
      );
    });
  });

  it("opens a newer major read-only: a fetch makes no request and CG-DB03 is recorded once", async function () {
    this.timeout(BUDGETS.schemaStampEnable.timeoutMs);
    allowCitegeistErrors(READ_ONLY_STARTUP_ERROR);
    await enableCitegeist("Citegeist to start on the newer-major database");

    const requestsBefore = await stubRequestLog();
    const result = await Zotero.Citegeist.fetchItems([stub.item.id]);
    const requests = await stubRequestsSince(requestsBefore);

    expect(result, "bridge fetch resolved undefined (see Debug Output)").to.exist;
    expect(result.unwritableStopped, JSON.stringify(result)).to.equal(1);
    expect(result.fresh, JSON.stringify(result)).to.equal(0);
    expect(requests, "stub requests from a read-only session").to.be.empty;

    const report: string = Zotero.Citegeist.buildDiagnosticReport({});
    expect(report).to.include("Cache: read-only, CG-DB03");
    expect(recentProblemsWith(report, "CG-DB03"), report).to.have.length(1);
  });

  it("leaves every row and the newer stamp as it found them", async function () {
    this.timeout(BUDGETS.schemaStampDisable.timeoutMs);
    expect(rowsBefore, "the first test counted the rows").to.be.a("number");
    await disableCitegeist();
    await withCacheFile(async (conn) => {
      expect(await countRows(conn), "item_cache rows after the read-only session").to.equal(
        rowsBefore,
      );
      expect(await readStamp(conn), "PRAGMA user_version after the read-only session").to.equal(
        NEWER_MAJOR_STAMP,
      );
    });
  });
});

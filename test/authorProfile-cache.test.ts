/**
 * The author-profile writes against a real read-only cache (plan U16, T3).
 *
 * persistProfileMetrics and maybeReconcileMerge are fire-and-forget from every
 * pane render and author dialog. On a cache a newer schema wrote, reaching the
 * author writers would record a refusal per author per render, so both must
 * stop before them: nothing refused, recorded or written.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { fakeDb, mockZotero, resetCacheHarness } from "./_helpers/cacheHarness";
import {
  _resetForTesting,
  cacheWriteRefusalCode,
  closeCache,
  initCache,
} from "../src/modules/cache/db";
import { cacheItemAuthors } from "../src/modules/cache/authors";
import { maybeReconcileMerge, persistProfileMetrics } from "../src/modules/authorProfile";
import type { OpenAlexAuthorProfile } from "../src/modules/openalexAuthors";
import { clearDiagnostics, recentDiagnostics } from "../src/modules/diagnostics";
import { CACHE_SCHEMA_MAJOR, CACHE_SCHEMA_STAMP_MULTIPLIER } from "../src/constants";

const WRITE = /^(?:CREATE|DELETE|DROP|INSERT|UPDATE|REPLACE|ALTER)\b|^PRAGMA\s+user_version\s*=/i;

function profile(over: Partial<OpenAlexAuthorProfile> = {}): OpenAlexAuthorProfile {
  return {
    id: "A1",
    displayName: "Jane Q. Researcher",
    orcid: null,
    worksCount: 42,
    citedByCount: 900,
    hIndex: 20,
    i10Index: 15,
    metricsAreLowerBound: false,
    redirectedFrom: null,
    ...over,
  } as OpenAlexAuthorProfile;
}

/** Let fire-and-forget writes settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  await resetCacheHarness(initCache, _resetForTesting);
  // A session that resolved an author, then a newer major rewrote the file.
  await cacheItemAuthors({ libraryID: 1, key: "ITEM" }, [
    { author: { id: "A1", display_name: "Jane Q. Researcher" } },
  ]);
  await closeCache();
  fakeDb.pragma.userVersion = (CACHE_SCHEMA_MAJOR + 1) * CACHE_SCHEMA_STAMP_MULTIPLIER;
  await initCache();
  clearDiagnostics();
  mockZotero.debug.mockClear();
});

describe("author-profile writes on a read-only cache", () => {
  it("persist no metrics, reconcile no merge, and record or refuse nothing", async () => {
    expect(cacheWriteRefusalCode(), "positive control: the cache is read-only").toBe("CG-DB03");
    const from = fakeDb.statements.length;

    persistProfileMetrics(profile());
    maybeReconcileMerge(profile({ id: "A2", redirectedFrom: "A1" }));
    await settle();

    expect(recentDiagnostics()).toEqual([]);
    const refusals = mockZotero.debug.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes("refused"));
    expect(refusals).toEqual([]);
    expect(fakeDb.statements.slice(from).filter((s) => WRITE.test(s.sql))).toEqual([]);
    expect(fakeDb.authors.get("A1")?.h_index).toBeNull();
    expect([...fakeDb.itemAuthors.values()].map((r) => r.author_id)).toEqual(["A1"]);
  });
});

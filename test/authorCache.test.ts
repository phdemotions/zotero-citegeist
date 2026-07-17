/**
 * Tests for the U2 author cache sub-module: schema, identity persistence,
 * curated-wins preservation (AE1), concurrency under the shared per-key lock,
 * metric-preserving writes, and two-level orphan GC.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resetCacheHarness, fakeDb } from "./_helpers/cacheHarness";
import { initCache, _resetForTesting, deleteRow } from "../src/modules/cache/db";
import {
  cacheItemAuthors,
  getItemAuthors,
  getAuthor,
  setCuratedItemAuthor,
  updateAuthorMetrics,
  garbageCollectOrphanAuthors,
  reconcileAuthorMerge,
  type CacheAuthorshipInput,
} from "../src/modules/cache/authors";

function authorship(
  id: string,
  name = "Author " + id,
  orcid: string | null = null,
): CacheAuthorshipInput {
  return { author: { id, display_name: name, orcid } };
}

const ITEM = { libraryID: 1, key: "ITEMKEY1" };

beforeEach(async () => {
  await resetCacheHarness(initCache, _resetForTesting);
});

describe("cacheItemAuthors", () => {
  it("persists item_authors rows (ordered) and author identity rows", async () => {
    await cacheItemAuthors(ITEM, [authorship("A1", "Alice", "0000-1"), authorship("A2", "Bob")]);

    const rows = await getItemAuthors(1, "ITEMKEY1");
    expect(rows.map((r) => r.author_id)).toEqual(["A1", "A2"]);
    expect(rows.map((r) => r.author_position)).toEqual([0, 1]);
    expect(rows.every((r) => r.is_curated === 0)).toBe(true);

    const a1 = await getAuthor("A1");
    expect(a1?.display_name).toBe("Alice");
    expect(a1?.orcid).toBe("0000-1");
  });

  it("rejects malformed author ids at the trust boundary", async () => {
    await cacheItemAuthors(ITEM, [
      authorship("A1", "Valid"),
      authorship("W123", "AWorkId"),
      authorship("Axyz", "NotDigits"),
      { author: { id: "https://openalex.org/A5", display_name: "Prefixed" } },
    ]);
    const rows = await getItemAuthors(1, "ITEMKEY1");
    expect(rows.map((r) => r.author_id).sort()).toEqual(["A1", "A5"]);
  });

  it("keeps the same item key in two libraries distinct", async () => {
    await cacheItemAuthors({ libraryID: 1, key: "K" }, [authorship("A1")]);
    await cacheItemAuthors({ libraryID: 2, key: "K" }, [authorship("A2")]);
    expect((await getItemAuthors(1, "K")).map((r) => r.author_id)).toEqual(["A1"]);
    expect((await getItemAuthors(2, "K")).map((r) => r.author_id)).toEqual(["A2"]);
  });

  it("preserves a curated identity across a background refresh (AE1)", async () => {
    await cacheItemAuthors(ITEM, [authorship("A1"), authorship("A2")]);
    await setCuratedItemAuthor(ITEM, "A3", 5);

    // Background refresh with a different author set that omits the curated one.
    await cacheItemAuthors(ITEM, [authorship("A2")]);

    const rows = await getItemAuthors(1, "ITEMKEY1");
    const byId = new Map(rows.map((r) => [r.author_id, r]));
    expect(byId.get("A3")?.is_curated).toBe(1); // curated survives
    expect(byId.has("A2")).toBe(true); // non-curated re-added
    expect(byId.has("A1")).toBe(false); // stale non-curated dropped
  });

  it("does not downgrade a curated author present in the refresh set", async () => {
    await setCuratedItemAuthor(ITEM, "A1", 0);
    await cacheItemAuthors(ITEM, [authorship("A1"), authorship("A2")]);
    const rows = await getItemAuthors(1, "ITEMKEY1");
    expect(rows.find((r) => r.author_id === "A1")?.is_curated).toBe(1);
    expect(rows.find((r) => r.author_id === "A2")?.is_curated).toBe(0);
  });

  it("curated wins when an override races a background write (shared lock)", async () => {
    await Promise.all([
      cacheItemAuthors(ITEM, [authorship("A1")]),
      setCuratedItemAuthor(ITEM, "A1", 0),
    ]);
    const rows = await getItemAuthors(1, "ITEMKEY1");
    expect(rows).toHaveLength(1);
    expect(rows[0].is_curated).toBe(1);
  });
});

describe("author metrics", () => {
  it("identity writes preserve previously-derived metric columns", async () => {
    await cacheItemAuthors(ITEM, [authorship("A1", "Alice")]);
    await updateAuthorMetrics("A1", {
      worksCount: 42,
      citedByCount: 999,
      hIndex: 20,
      i10Index: 30,
      lastFetched: "2026-07-16",
    });
    // A later identity-only write (background refresh) must not null metrics.
    await cacheItemAuthors(ITEM, [authorship("A1", "Alice B. Smith")]);

    const a1 = await getAuthor("A1");
    expect(a1?.display_name).toBe("Alice B. Smith"); // identity updated
    expect(a1?.works_count).toBe(42); // metrics preserved
    expect(a1?.h_index).toBe(20);
  });
});

describe("orphan GC", () => {
  it("deleteRow drops the item's item_authors", async () => {
    await cacheItemAuthors(ITEM, [authorship("A1"), authorship("A2")]);
    await deleteRow(1, "ITEMKEY1");
    expect(await getItemAuthors(1, "ITEMKEY1")).toHaveLength(0);
  });

  it("two-level sweep removes orphaned item_authors then unreferenced authors", async () => {
    await cacheItemAuthors({ libraryID: 1, key: "GONE" }, [authorship("A1")]);
    await cacheItemAuthors({ libraryID: 1, key: "STAY" }, [authorship("A2")]);

    await garbageCollectOrphanAuthors(fakeDb as unknown as _ZoteroTypes.DBConnection, [
      { libraryID: 1, itemKey: "GONE" },
    ]);

    expect(await getItemAuthors(1, "GONE")).toHaveLength(0);
    expect(await getItemAuthors(1, "STAY")).toHaveLength(1);
    expect(await getAuthor("A1")).toBeNull(); // orphaned author swept
    expect(await getAuthor("A2")).not.toBeNull(); // still referenced
  });
});

describe("reconcileAuthorMerge (KTD3 — 301 author-id merge)", () => {
  it("rewrites item_authors refs to the survivor and GCs the orphaned author row", async () => {
    await cacheItemAuthors({ libraryID: 1, key: "K1" }, [
      authorship("A1", "Old"),
      authorship("A9", "Other"),
    ]);
    await cacheItemAuthors({ libraryID: 1, key: "K2" }, [authorship("A1", "Old")]);

    await reconcileAuthorMerge("A1", "A2");

    expect(
      (await getItemAuthors(1, "K1")).map((r) => r.author_id).sort(),
    ).toEqual(["A2", "A9"]);
    expect((await getItemAuthors(1, "K2")).map((r) => r.author_id)).toEqual(["A2"]);
    expect(await getAuthor("A1")).toBeNull(); // stale author row swept
  });

  it("drops the stale ref (no duplicate) when the item already carries the survivor", async () => {
    await cacheItemAuthors({ libraryID: 1, key: "K1" }, [authorship("A1"), authorship("A2")]);
    await reconcileAuthorMerge("A1", "A2");
    expect((await getItemAuthors(1, "K1")).map((r) => r.author_id)).toEqual(["A2"]);
  });

  it("no-ops on identical or malformed ids", async () => {
    await cacheItemAuthors({ libraryID: 1, key: "K1" }, [authorship("A1")]);
    await reconcileAuthorMerge("A1", "A1");
    await reconcileAuthorMerge("not-an-id", "A2");
    expect((await getItemAuthors(1, "K1")).map((r) => r.author_id)).toEqual(["A1"]);
  });
});

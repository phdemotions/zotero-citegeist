/**
 * Tests for the U5 Zotero-relations handoff: surgical add/remove of the
 * `openalex:author` relation set, the editability gate, id read-back, and
 * syncing the relation to the item's resolved authors.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetCacheHarness } from "./_helpers/cacheHarness";
import { initCache, _resetForTesting } from "../src/modules/cache/db";
import { cacheItemAuthors } from "../src/modules/cache/authors";
import {
  AUTHOR_RELATION_PREDICATE,
  setItemAuthorRelations,
  syncItemAuthorRelations,
  purgeAllAuthorRelations,
} from "../src/modules/cache/authors/relations";

function makeRelItem(opts: { editable?: boolean; libraryID?: number; key?: string } = {}) {
  const { editable = true, libraryID = 1, key = "K" } = opts;
  const rels: Record<string, string[]> = {};
  const saveTx = vi.fn(async () => 1);
  const item = {
    id: 1,
    libraryID,
    key,
    isEditable: () => editable,
    getRelations: () => rels,
    getRelationsByPredicate: (p: string) => rels[p] ?? [],
    addRelation: (p: string, o: string) => {
      rels[p] ??= [];
      if (!rels[p].includes(o)) {
        rels[p].push(o);
        return true;
      }
      return false;
    },
    removeRelation: (p: string, o: string) => {
      const arr = rels[p];
      if (!arr) return false;
      const i = arr.indexOf(o);
      if (i < 0) return false;
      arr.splice(i, 1);
      return true;
    },
    hasRelation: (p: string, o: string) => (rels[p] ?? []).includes(o),
    setRelations: () => true,
    saveTx,
  };
  return { item: item as unknown as _ZoteroTypes.Item, rels, saveTx };
}

const URI = (id: string) => `https://openalex.org/${id}`;

describe("setItemAuthorRelations", () => {
  it("asserts the author URIs under the openalex:author predicate and saves once", async () => {
    const { item, rels, saveTx } = makeRelItem();
    await setItemAuthorRelations(item, ["A1", "A2"]);
    expect(rels[AUTHOR_RELATION_PREDICATE]).toEqual([URI("A1"), URI("A2")]);
    expect(saveTx).toHaveBeenCalledTimes(1);
  });

  it("is a no-op (no save) when the relation set is already correct", async () => {
    const { item, saveTx } = makeRelItem();
    await setItemAuthorRelations(item, ["A1"]);
    saveTx.mockClear();
    await setItemAuthorRelations(item, ["A1"]);
    expect(saveTx).not.toHaveBeenCalled();
  });

  it("removes a superseded URI and adds the new one on override", async () => {
    const { item, rels } = makeRelItem();
    await setItemAuthorRelations(item, ["A1"]);
    await setItemAuthorRelations(item, ["A2"]);
    expect(rels[AUTHOR_RELATION_PREDICATE]).toEqual([URI("A2")]);
  });

  it("skips read-only (non-editable) libraries entirely", async () => {
    const { item, rels, saveTx } = makeRelItem({ editable: false });
    await setItemAuthorRelations(item, ["A1"]);
    expect(rels[AUTHOR_RELATION_PREDICATE]).toBeUndefined();
    expect(saveTx).not.toHaveBeenCalled();
  });
});

describe("syncItemAuthorRelations", () => {
  beforeEach(async () => {
    await resetCacheHarness(initCache, _resetForTesting);
  });

  it("brings the relation set in line with the item's resolved authors", async () => {
    await cacheItemAuthors({ libraryID: 1, key: "K" }, [
      { author: { id: "A1", display_name: "Alice" } },
      { author: { id: "A2", display_name: "Bob" } },
    ]);
    const { item, rels } = makeRelItem({ libraryID: 1, key: "K" });
    await syncItemAuthorRelations(item);
    expect(new Set(rels[AUTHOR_RELATION_PREDICATE])).toEqual(new Set([URI("A1"), URI("A2")]));
  });

  it("does not write relations for a read-only library", async () => {
    await cacheItemAuthors({ libraryID: 1, key: "K" }, [{ author: { id: "A1" } }]);
    const { item, saveTx } = makeRelItem({ editable: false, libraryID: 1, key: "K" });
    await syncItemAuthorRelations(item);
    expect(saveTx).not.toHaveBeenCalled();
  });
});

describe("purgeAllAuthorRelations (sync-unblock cleanup)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("strips openalex:author from every item and saves only the affected ones", async () => {
    const a = makeRelItem({ key: "A" });
    a.rels[AUTHOR_RELATION_PREDICATE] = [URI("A1"), URI("A2")];
    const b = makeRelItem({ key: "B" });
    b.rels[AUTHOR_RELATION_PREDICATE] = [URI("A3")];
    const clean = makeRelItem({ key: "C" }); // never carried the relation

    vi.stubGlobal("Zotero", {
      Libraries: { getAll: () => [{ libraryID: 1 }] },
      Items: { getAll: async () => [a.item, b.item, clean.item] },
    });

    const cleaned = await purgeAllAuthorRelations();

    expect(cleaned).toBe(2);
    expect(a.rels[AUTHOR_RELATION_PREDICATE]).toEqual([]);
    expect(b.rels[AUTHOR_RELATION_PREDICATE]).toEqual([]);
    expect(a.saveTx).toHaveBeenCalledTimes(1);
    expect(b.saveTx).toHaveBeenCalledTimes(1);
    expect(clean.saveTx).not.toHaveBeenCalled();
  });

  it("skips an item whose save throws (read-only/locked) and still counts the rest", async () => {
    const bad = makeRelItem({ key: "A" });
    bad.rels[AUTHOR_RELATION_PREDICATE] = [URI("A1")];
    bad.saveTx.mockRejectedValueOnce(new Error("read-only"));
    const good = makeRelItem({ key: "B" });
    good.rels[AUTHOR_RELATION_PREDICATE] = [URI("A2")];

    vi.stubGlobal("Zotero", {
      Libraries: { getAll: () => [{ libraryID: 1 }] },
      Items: { getAll: async () => [bad.item, good.item] },
    });

    expect(await purgeAllAuthorRelations()).toBe(1);
    expect(good.saveTx).toHaveBeenCalledTimes(1);
  });

  it("returns 0 and saves nothing when no item carries the relation", async () => {
    const clean = makeRelItem({ key: "A" });
    vi.stubGlobal("Zotero", {
      Libraries: { getAll: () => [{ libraryID: 1 }] },
      Items: { getAll: async () => [clean.item] },
    });
    expect(await purgeAllAuthorRelations()).toBe(0);
    expect(clean.saveTx).not.toHaveBeenCalled();
  });
});

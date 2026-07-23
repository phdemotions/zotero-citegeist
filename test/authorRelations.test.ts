/**
 * Tests for the sync-unblock purge of the `openalex:author` relation. The
 * writers (setItemAuthorRelations/syncItemAuthorRelations) were removed in
 * v3.0.0 — the predicate breaks Zotero sync — so only the purge remains.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  AUTHOR_RELATION_PREDICATE,
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

    const { cleaned, failures } = await purgeAllAuthorRelations();

    expect(cleaned).toBe(2);
    expect(failures).toBe(0);
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

    const { cleaned, failures } = await purgeAllAuthorRelations();
    expect(cleaned).toBe(1);
    // The locked item's relation survived, so the pass reports itself incomplete
    // and the caller will retry on the next launch.
    expect(failures).toBe(1);
    expect(good.saveTx).toHaveBeenCalledTimes(1);
  });

  it("returns 0 and saves nothing when no item carries the relation", async () => {
    const clean = makeRelItem({ key: "A" });
    vi.stubGlobal("Zotero", {
      Libraries: { getAll: () => [{ libraryID: 1 }] },
      Items: { getAll: async () => [clean.item] },
    });
    expect(await purgeAllAuthorRelations()).toEqual({ cleaned: 0, failures: 0 });
    expect(clean.saveTx).not.toHaveBeenCalled();
  });
});

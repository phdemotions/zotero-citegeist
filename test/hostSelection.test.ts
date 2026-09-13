/**
 * Tests for src/modules/host/selection.ts, the one place Citegeist reads the
 * collection-tree selection on Zotero 7 through 10.
 *
 * The rule under test: an unrecognised row never widens the scope. A saved
 * search, feed, Unfiled or Trash row must produce no targets, never a fallback
 * to the whole library.
 *
 * The module records CG-UI02 once per session, so each test loads a fresh
 * instance (vi.resetModules + dynamic import), as menu.test.ts does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UNSUPPORTED_ROW_TYPES,
  collectionRow,
  libraryRow,
  makeCollection,
  otherRow,
} from "./_helpers/menuHarness";

let mainWin: Window;

async function load() {
  vi.resetModules();
  const selection = await import("../src/modules/host/selection");
  const diagnostics = await import("../src/modules/diagnostics");
  diagnostics.clearDiagnostics();
  const ui02 = () => diagnostics.recentDiagnostics().filter((d) => d.code === "CG-UI02");
  return { ...selection, ui02 };
}

beforeEach(() => {
  vi.clearAllMocks();
  mainWin = { name: "main" } as unknown as Window;
  vi.stubGlobal("Zotero", { debug: vi.fn(), getMainWindow: vi.fn(() => mainWin) });
});

describe("collectionTargetsFromMenuContext — Zotero 10 collectionTreeRows", () => {
  it("returns every selected collection, in selection order", async () => {
    const { collectionTargetsFromMenuContext } = await load();
    const a = makeCollection([]);
    const b = makeCollection([]);
    expect(
      collectionTargetsFromMenuContext({
        collectionTreeRows: [collectionRow(a), collectionRow(b)],
      }),
    ).toEqual([
      { kind: "collection", collection: a },
      { kind: "collection", collection: b },
    ]);
  });

  it("lets a library row subsume the collections inside it", async () => {
    const { collectionTargetsFromMenuContext } = await load();
    const inside = makeCollection([], [], 1);
    expect(
      collectionTargetsFromMenuContext({
        collectionTreeRows: [collectionRow(inside), libraryRow(1)],
      }),
    ).toEqual([{ kind: "library", libraryID: 1 }]);
  });

  it("keeps a collection that belongs to a different library than the selected one", async () => {
    const { collectionTargetsFromMenuContext } = await load();
    const elsewhere = makeCollection([], [], 2);
    expect(
      collectionTargetsFromMenuContext({
        collectionTreeRows: [libraryRow(1), collectionRow(elsewhere)],
      }),
    ).toEqual([
      { kind: "library", libraryID: 1 },
      { kind: "collection", collection: elsewhere },
    ]);
  });

  it("treats a group library row as a library", async () => {
    const { collectionTargetsFromMenuContext } = await load();
    expect(
      collectionTargetsFromMenuContext({ collectionTreeRows: [libraryRow(7, "group")] }),
    ).toEqual([{ kind: "library", libraryID: 7 }]);
  });

  it("counts the same row once", async () => {
    const { collectionTargetsFromMenuContext } = await load();
    const col = makeCollection([]);
    expect(
      collectionTargetsFromMenuContext({
        collectionTreeRows: [collectionRow(col), collectionRow(col), libraryRow(3), libraryRow(3)],
      }),
    ).toEqual([
      { kind: "collection", collection: col },
      { kind: "library", libraryID: 3 },
    ]);
  });

  it.each(UNSUPPORTED_ROW_TYPES)("refuses a %s row on its own", async (type) => {
    const { collectionTargetsFromMenuContext } = await load();
    expect(collectionTargetsFromMenuContext({ collectionTreeRows: [otherRow(type)] })).toBeNull();
  });

  it.each(UNSUPPORTED_ROW_TYPES)(
    "refuses the whole selection when a %s row is mixed with a collection",
    async (type) => {
      const { collectionTargetsFromMenuContext } = await load();
      expect(
        collectionTargetsFromMenuContext({
          collectionTreeRows: [collectionRow(makeCollection([])), otherRow(type)],
        }),
      ).toBeNull();
    },
  );

  it("refuses a library row without a usable libraryID rather than widening to the user library", async () => {
    const { collectionTargetsFromMenuContext } = await load();
    for (const ref of [{}, { libraryID: 0 }, { libraryID: "1" }, null]) {
      expect(
        collectionTargetsFromMenuContext({ collectionTreeRows: [{ type: "library", ref }] }),
        `ref ${JSON.stringify(ref)}`,
      ).toBeNull();
    }
  });

  it("refuses a collection row whose ref is not a collection", async () => {
    const { collectionTargetsFromMenuContext } = await load();
    expect(
      collectionTargetsFromMenuContext({
        collectionTreeRows: [{ type: "collection", ref: { id: 4 } }],
      }),
    ).toBeNull();
  });

  it("returns null for an empty selection", async () => {
    const { collectionTargetsFromMenuContext, ui02 } = await load();
    expect(collectionTargetsFromMenuContext({ collectionTreeRows: [] })).toBeNull();
    expect(ui02()).toHaveLength(0);
  });

  it("never reads collectionTreeRow when collectionTreeRows is present (the Zotero 10 getter throws)", async () => {
    const { collectionTargetsFromMenuContext } = await load();
    const col = makeCollection([]);
    const ctx = {
      collectionTreeRows: [collectionRow(col), collectionRow(makeCollection([]))],
      get collectionTreeRow(): never {
        throw new Error("collectionTreeRow was removed -- use collectionTreeRows");
      },
    };
    expect(collectionTargetsFromMenuContext(ctx)).toHaveLength(2);
  });
});

describe("collectionTargetsFromMenuContext — Zotero 8/9 collectionTreeRow", () => {
  it("returns the one right-clicked collection", async () => {
    const { collectionTargetsFromMenuContext } = await load();
    const col = makeCollection([]);
    expect(collectionTargetsFromMenuContext({ collectionTreeRow: collectionRow(col) })).toEqual([
      { kind: "collection", collection: col },
    ]);
  });

  it("returns the right-clicked library root", async () => {
    const { collectionTargetsFromMenuContext } = await load();
    expect(collectionTargetsFromMenuContext({ collectionTreeRow: libraryRow(1) })).toEqual([
      { kind: "library", libraryID: 1 },
    ]);
  });

  it("refuses a saved search row", async () => {
    const { collectionTargetsFromMenuContext } = await load();
    expect(collectionTargetsFromMenuContext({ collectionTreeRow: otherRow("search") })).toBeNull();
  });

  it("returns null, without a diagnostic, when the field is present but empty", async () => {
    const { collectionTargetsFromMenuContext, ui02 } = await load();
    expect(collectionTargetsFromMenuContext({ collectionTreeRow: null })).toBeNull();
    expect(ui02()).toHaveLength(0);
  });
});

describe("collectionTargetsFromMenuContext — unreadable context (CG-UI02)", () => {
  it("returns null and records CG-UI02 when neither field exists", async () => {
    const { collectionTargetsFromMenuContext, ui02 } = await load();
    expect(() => collectionTargetsFromMenuContext({})).not.toThrow();
    expect(collectionTargetsFromMenuContext({})).toBeNull();
    expect(ui02()).toHaveLength(1);
  });

  it("records the code once per session, however often the menu opens", async () => {
    const { collectionTargetsFromMenuContext, ui02 } = await load();
    for (let i = 0; i < 5; i++) collectionTargetsFromMenuContext(undefined);
    expect(ui02()).toHaveLength(1);
  });

  it("treats a collectionTreeRows that is not an array as unreadable", async () => {
    const { collectionTargetsFromMenuContext, ui02 } = await load();
    const ctx = { collectionTreeRows: "rows" } as unknown as _ZoteroTypes.MenuSelectionContext;
    expect(collectionTargetsFromMenuContext(ctx)).toBeNull();
    expect(ui02()).toHaveLength(1);
  });
});

describe("collectionTargetsFromPane — Zotero 10 getCollectionTreeRows", () => {
  const removedSingular = () =>
    vi.fn(() => {
      throw new Error(
        "ZoteroPane.getCollectionTreeRow() was removed -- use ZoteroPane.getCollectionTreeRows()",
      );
    });

  it("targets every selected collection and never calls the throwing singular getter", async () => {
    const { collectionTargetsFromPane, ui02 } = await load();
    const a = makeCollection([]);
    const b = makeCollection([]);
    const getCollectionTreeRow = removedSingular();
    expect(
      collectionTargetsFromPane({
        getCollectionTreeRows: () => [collectionRow(a), collectionRow(b)],
        getCollectionTreeRow,
      }),
    ).toEqual([
      { kind: "collection", collection: a },
      { kind: "collection", collection: b },
    ]);
    expect(getCollectionTreeRow).not.toHaveBeenCalled();
    expect(ui02()).toHaveLength(0);
  });

  it("refuses a saved search row mixed with a collection", async () => {
    const { collectionTargetsFromPane, ui02 } = await load();
    expect(
      collectionTargetsFromPane({
        getCollectionTreeRows: () => [collectionRow(makeCollection([])), otherRow("search")],
        getCollectionTreeRow: removedSingular(),
      }),
    ).toBeNull();
    expect(ui02()).toHaveLength(0);
  });

  it("returns null and records CG-UI02 when the plural getter throws", async () => {
    const { collectionTargetsFromPane, ui02 } = await load();
    const getCollectionTreeRow = removedSingular();
    const pane = {
      getCollectionTreeRows: () => {
        throw new Error("collectionsView is gone");
      },
      getCollectionTreeRow,
    };
    expect(collectionTargetsFromPane(pane)).toBeNull();
    expect(ui02()).toHaveLength(1);
    expect(getCollectionTreeRow).not.toHaveBeenCalled();
  });

  it("treats a result that is not an array as unreadable", async () => {
    const { collectionTargetsFromPane, ui02 } = await load();
    const pane = {
      getCollectionTreeRows: () => "rows",
    } as unknown as Parameters<typeof collectionTargetsFromPane>[0];
    expect(collectionTargetsFromPane(pane)).toBeNull();
    expect(ui02()).toHaveLength(1);
  });

  it("returns null, without a diagnostic, for an empty selection", async () => {
    const { collectionTargetsFromPane, ui02 } = await load();
    expect(collectionTargetsFromPane({ getCollectionTreeRows: () => [] })).toBeNull();
    expect(ui02()).toHaveLength(0);
  });
});

describe("collectionTargetsFromPane — Zotero 7 to 9 getCollectionTreeRow", () => {
  it("returns the focused collection", async () => {
    const { collectionTargetsFromPane } = await load();
    const col = makeCollection([]);
    expect(collectionTargetsFromPane({ getCollectionTreeRow: () => collectionRow(col) })).toEqual([
      { kind: "collection", collection: col },
    ]);
  });

  it("returns the focused library root", async () => {
    const { collectionTargetsFromPane } = await load();
    expect(
      collectionTargetsFromPane({ getCollectionTreeRow: () => libraryRow(5, "group") }),
    ).toEqual([{ kind: "library", libraryID: 5 }]);
  });

  it.each(UNSUPPORTED_ROW_TYPES)(
    "refuses a focused %s row that the singular getters would have read as the library root",
    async (type) => {
      const { collectionTargetsFromPane } = await load();
      expect(collectionTargetsFromPane({ getCollectionTreeRow: () => otherRow(type) })).toBeNull();
    },
  );

  it("returns null when no row is focused (Zotero 7 returns 0)", async () => {
    const { collectionTargetsFromPane } = await load();
    expect(collectionTargetsFromPane({ getCollectionTreeRow: () => 0 })).toBeNull();
  });

  it("returns null and records CG-UI02 when the singular getter throws", async () => {
    const { collectionTargetsFromPane, ui02 } = await load();
    const pane = {
      getCollectionTreeRow: () => {
        throw new Error("ZoteroPane.getCollectionTreeRow() was removed");
      },
    };
    expect(() => collectionTargetsFromPane(pane)).not.toThrow();
    expect(collectionTargetsFromPane(pane)).toBeNull();
    expect(ui02()).toHaveLength(1);
  });

  it("returns null and records CG-UI02 when the pane has neither getter", async () => {
    const { collectionTargetsFromPane, ui02 } = await load();
    expect(collectionTargetsFromPane({})).toBeNull();
    expect(ui02()).toHaveLength(1);
  });
});

describe("selectedCollectionsFromPane — citation-network dialog", () => {
  it("prefers getSelectedCollections and never calls the singular getter", async () => {
    const { selectedCollectionsFromPane } = await load();
    const a = makeCollection([]);
    const b = makeCollection([]);
    const getSelectedCollection = vi.fn(() => {
      throw new Error("getSelectedCollection() was removed -- use getSelectedCollections()");
    });
    expect(
      selectedCollectionsFromPane({ getSelectedCollections: () => [a, b], getSelectedCollection }),
    ).toEqual([a, b]);
    expect(getSelectedCollection).not.toHaveBeenCalled();
  });

  it("falls back to getSelectedCollection where the plural getter does not exist", async () => {
    const { selectedCollectionsFromPane } = await load();
    const col = makeCollection([]);
    expect(selectedCollectionsFromPane({ getSelectedCollection: () => col })).toEqual([col]);
  });

  it("returns no collections for a library root or no pane", async () => {
    const { selectedCollectionsFromPane } = await load();
    for (const value of [false, null, undefined] as const) {
      expect(selectedCollectionsFromPane({ getSelectedCollection: () => value })).toEqual([]);
    }
    expect(selectedCollectionsFromPane(null)).toEqual([]);
  });
});

describe("menuCommandWindow", () => {
  const windowWith = (win: Window) => ({ ownerDocument: { defaultView: win } });

  it("uses the window of the context's menu element", async () => {
    const { menuCommandWindow } = await load();
    const second = { name: "second" } as unknown as Window;
    const ctx = { menuElem: windowWith(second) } as unknown as _ZoteroTypes.MenuSelectionContext;
    expect(menuCommandWindow({} as Event, ctx)).toBe(second);
    expect(Zotero.getMainWindow).not.toHaveBeenCalled();
  });

  it("falls back to the command event's target window", async () => {
    const { menuCommandWindow } = await load();
    const second = { name: "second" } as unknown as Window;
    const event = { target: windowWith(second) } as unknown as Event;
    expect(menuCommandWindow(event, {})).toBe(second);
  });

  it("falls back to the main window when neither names one", async () => {
    const { menuCommandWindow } = await load();
    expect(menuCommandWindow(undefined, undefined)).toBe(mainWin);
  });
});

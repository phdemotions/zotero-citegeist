/**
 * Tests for src/modules/host/selection.ts, the one place Citegeist reads the
 * Zotero selection on Zotero 7 through 10.
 *
 * The rule under test: an unrecognised row never widens the scope. A saved
 * search, feed, Unfiled or Trash row must produce no targets, never a fallback
 * to the whole library. A selection Citegeist does not act on records nothing;
 * only a selection that can't be read records CG-UI02.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DIAGNOSTIC_RING_BUFFER_SIZE } from "../src/constants";
import { buildDiagnosticReport } from "../src/modules/diagnostics";
import {
  collectionTargetsFromMenuContext,
  collectionTargetsFromPane,
  paneForWindow,
  selectedCollectionsFromPane,
  selectedItemsInWindow,
} from "../src/modules/host/selection";
import { logError } from "../src/modules/utils";
import {
  UNSUPPORTED_ROW_TYPES,
  clearRecordedFailures,
  collectionRow,
  idsOf,
  libraryRow,
  makeCollection,
  makeItem,
  otherRow,
  recordedFailures,
  selectionUnreadableReports,
} from "./_helpers/menuHarness";

type Ctx = _ZoteroTypes.MenuSelectionContext;
type Rows = () => unknown[];

let activePane: unknown;

beforeEach(async () => {
  vi.clearAllMocks();
  activePane = null;
  vi.stubGlobal("Zotero", { debug: vi.fn(), getActiveZoteroPane: vi.fn(() => activePane) });
  await clearRecordedFailures();
});

const rowsContext = (rows: unknown[]): Ctx => ({ collectionTreeRows: rows }) as unknown as Ctx;

async function expectNothingRecorded(): Promise<void> {
  expect(await recordedFailures()).toEqual([]);
}

const boom = (): never => {
  throw new Error("boom");
};

describe("collectionTargetsFromMenuContext — Zotero 10 collectionTreeRows", () => {
  it("returns every selected collection, in selection order", async () => {
    const a = makeCollection([]);
    const b = makeCollection([]);
    expect(
      collectionTargetsFromMenuContext(rowsContext([collectionRow(a), collectionRow(b)])),
    ).toEqual([
      { kind: "collection", collection: a },
      { kind: "collection", collection: b },
    ]);
    await expectNothingRecorded();
  });

  it("keeps collections from different libraries", () => {
    const mine = makeCollection([], [], 1);
    const group = makeCollection([], [], 2);
    expect(
      collectionTargetsFromMenuContext(rowsContext([collectionRow(mine), collectionRow(group)])),
    ).toEqual([
      { kind: "collection", collection: mine },
      { kind: "collection", collection: group },
    ]);
  });

  it("returns every selected library, personal and group", () => {
    expect(
      collectionTargetsFromMenuContext(rowsContext([libraryRow(1), libraryRow(7, "group")])),
    ).toEqual([
      { kind: "library", libraryID: 1 },
      { kind: "library", libraryID: 7 },
    ]);
  });

  it("counts the same row once", () => {
    const col = makeCollection([]);
    expect(
      collectionTargetsFromMenuContext(rowsContext([collectionRow(col), collectionRow(col)])),
    ).toEqual([{ kind: "collection", collection: col }]);
    expect(collectionTargetsFromMenuContext(rowsContext([libraryRow(3), libraryRow(3)]))).toEqual([
      { kind: "library", libraryID: 3 },
    ]);
  });

  it.each<[string, Rows]>([
    [
      "a library row before one of its collections",
      () => [libraryRow(1), collectionRow(makeCollection([], [], 1))],
    ],
    [
      "a collection before its library row",
      () => [collectionRow(makeCollection([], [], 1)), libraryRow(1)],
    ],
    [
      "a group library with a collection from another library",
      () => [libraryRow(2, "group"), collectionRow(makeCollection([], [], 1))],
    ],
    [
      "two collections and a library",
      () => [collectionRow(makeCollection([])), collectionRow(makeCollection([])), libraryRow(1)],
    ],
  ])("refuses %s, a selection Zotero 10 does not keep, and records nothing", async (_l, rows) => {
    expect(collectionTargetsFromMenuContext(rowsContext(rows()))).toBeNull();
    await expectNothingRecorded();
  });

  it.each(UNSUPPORTED_ROW_TYPES)(
    "refuses a %s row on its own and records nothing",
    async (type) => {
      expect(collectionTargetsFromMenuContext(rowsContext([otherRow(type)]))).toBeNull();
      await expectNothingRecorded();
    },
  );

  describe.each(UNSUPPORTED_ROW_TYPES)("a %s row in a larger selection", (type) => {
    it.each<[string, Rows]>([
      ["after a collection", () => [collectionRow(makeCollection([])), otherRow(type)]],
      ["before a collection", () => [otherRow(type), collectionRow(makeCollection([]))]],
      ["before a library", () => [otherRow(type), libraryRow(1)]],
    ])("%s refuses the whole selection and records nothing", async (_label, rows) => {
      expect(collectionTargetsFromMenuContext(rowsContext(rows()))).toBeNull();
      await expectNothingRecorded();
    });
  });

  it("refuses a library row without a usable libraryID rather than widening to the user library", async () => {
    for (const ref of [{}, { libraryID: 0 }, { libraryID: "1" }, null]) {
      expect(
        collectionTargetsFromMenuContext(rowsContext([{ type: "library", ref }])),
        `ref ${JSON.stringify(ref)}`,
      ).toBeNull();
    }
    await expectNothingRecorded();
  });

  it("refuses a collection row whose ref is not a collection", () => {
    expect(
      collectionTargetsFromMenuContext(rowsContext([{ type: "collection", ref: { id: 4 } }])),
    ).toBeNull();
  });

  it("returns null, without a diagnostic, for an empty selection", async () => {
    expect(collectionTargetsFromMenuContext(rowsContext([]))).toBeNull();
    await expectNothingRecorded();
  });

  it("never reads collectionTreeRow when collectionTreeRows is present (the Zotero 10 getter throws on a multi-row selection)", () => {
    const ctx = {
      collectionTreeRows: [collectionRow(makeCollection([])), collectionRow(makeCollection([]))],
      get collectionTreeRow(): never {
        throw new Error("collectionTreeRow was removed -- use collectionTreeRows");
      },
    };
    expect(collectionTargetsFromMenuContext(ctx)).toHaveLength(2);
  });
});

describe("collectionTargetsFromMenuContext — Zotero 8/9 collectionTreeRow", () => {
  it("returns the one right-clicked collection", () => {
    const col = makeCollection([]);
    expect(collectionTargetsFromMenuContext({ collectionTreeRow: collectionRow(col) })).toEqual([
      { kind: "collection", collection: col },
    ]);
  });

  it("returns the right-clicked library root", () => {
    expect(collectionTargetsFromMenuContext({ collectionTreeRow: libraryRow(1) })).toEqual([
      { kind: "library", libraryID: 1 },
    ]);
  });

  it("refuses a saved search row and records nothing", async () => {
    expect(collectionTargetsFromMenuContext({ collectionTreeRow: otherRow("search") })).toBeNull();
    await expectNothingRecorded();
  });

  it("returns null, without a diagnostic, when the field is present but empty", async () => {
    expect(collectionTargetsFromMenuContext({ collectionTreeRow: null })).toBeNull();
    await expectNothingRecorded();
  });
});

describe("collectionTargetsFromMenuContext — unreadable context (CG-UI02)", () => {
  it("returns null and records CG-UI02 when neither field exists", async () => {
    expect(() => collectionTargetsFromMenuContext({})).not.toThrow();
    expect(collectionTargetsFromMenuContext({})).toBeNull();
    expect(await selectionUnreadableReports()).toHaveLength(1);
  });

  it("records the code once while that record is still in the buffer, however often the menu opens", async () => {
    for (let i = 0; i < 5; i++) collectionTargetsFromMenuContext(undefined);
    expect(await selectionUnreadableReports()).toHaveLength(1);
  });

  it("treats a collectionTreeRows that is not an array as unreadable", async () => {
    expect(
      collectionTargetsFromMenuContext({ collectionTreeRows: "rows" } as unknown as Ctx),
    ).toBeNull();
    expect(await selectionUnreadableReports()).toHaveLength(1);
  });

  it.each<[string, () => Ctx]>([
    [
      "the collectionTreeRows getter",
      () =>
        ({
          get collectionTreeRows(): never {
            return boom();
          },
        }) as unknown as Ctx,
    ],
    [
      "the collectionTreeRow getter, with no collectionTreeRows",
      () =>
        ({
          get collectionTreeRow(): never {
            return boom();
          },
        }) as unknown as Ctx,
    ],
    [
      "a row's type",
      () =>
        rowsContext([
          {
            get type(): never {
              return boom();
            },
            ref: {},
          },
        ]),
    ],
    [
      "a row's ref",
      () =>
        rowsContext([
          {
            type: "collection",
            get ref(): never {
              return boom();
            },
          },
        ]),
    ],
    [
      "a library ref's libraryID",
      () =>
        rowsContext([
          {
            type: "library",
            ref: {
              get libraryID(): never {
                return boom();
              },
            },
          },
        ]),
    ],
  ])("returns null and records CG-UI02, without throwing, when %s throws", async (_l, ctx) => {
    expect(collectionTargetsFromMenuContext(ctx())).toBeNull();
    expect(await selectionUnreadableReports()).toHaveLength(1);
    expect(await recordedFailures()).toHaveLength(1);
  });

  it("records again once the earlier record has left the diagnostics buffer", async () => {
    collectionTargetsFromMenuContext({});
    expect(await selectionUnreadableReports()).toHaveLength(1);

    for (let i = 0; i < DIAGNOSTIC_RING_BUFFER_SIZE; i++) {
      logError(`later failure ${i}`, new Error("unrelated"));
    }
    expect(await selectionUnreadableReports()).toHaveLength(0);

    collectionTargetsFromMenuContext({});
    expect(await selectionUnreadableReports()).toHaveLength(1);
  });

  it("records again after the diagnostics are cleared", async () => {
    collectionTargetsFromMenuContext({});
    await clearRecordedFailures();
    collectionTargetsFromMenuContext({});
    expect(await selectionUnreadableReports()).toHaveLength(1);
  });

  it("records a dialog failure while a menu failure is still in the buffer, each once", async () => {
    collectionTargetsFromPane({ getCollectionTreeRows: boom });
    selectedCollectionsFromPane({
      getSelectedCollections: boom,
      getSelectedCollection: () => false,
    });
    collectionTargetsFromPane({ getCollectionTreeRows: boom });
    selectedCollectionsFromPane({
      getSelectedCollections: boom,
      getSelectedCollection: () => false,
    });

    const reports = await selectionUnreadableReports();
    expect(reports.map((d) => d.context)).toEqual([
      "collection menu selection",
      "network dialog default collection",
    ]);
  });

  it("records a different failed read on the same surface, each once", async () => {
    const notAnArray = { collectionTreeRows: "rows" } as unknown as Ctx;
    collectionTargetsFromMenuContext({});
    collectionTargetsFromMenuContext(notAnArray);
    collectionTargetsFromMenuContext({});
    collectionTargetsFromMenuContext(notAnArray);

    const reports = await selectionUnreadableReports();
    expect(reports.map((d) => d.detail)).toEqual([
      expect.stringMatching(/^menu context has neither collectionTreeRows nor collectionTreeRow\b/),
      expect.stringMatching(/^menu context collectionTreeRows is not an array\b/),
    ]);
  });
});

describe("a failed selection read never carries host error text into the report", () => {
  const secret = (): never => {
    throw new Error('Collection "Secret Grant" missing');
  };

  it.each<[string, () => unknown]>([
    [
      "the menu context's collectionTreeRows",
      () =>
        collectionTargetsFromMenuContext({
          get collectionTreeRows(): never {
            return secret();
          },
        } as unknown as Ctx),
    ],
    [
      "a collection-tree row",
      () =>
        collectionTargetsFromMenuContext(
          rowsContext([
            {
              type: "collection",
              get ref(): never {
                return secret();
              },
            },
          ]),
        ),
    ],
    [
      "pane getCollectionTreeRows",
      () => collectionTargetsFromPane({ getCollectionTreeRows: secret }),
    ],
    [
      "pane getCollectionTreeRow",
      () => collectionTargetsFromPane({ getCollectionTreeRow: secret }),
    ],
    [
      "pane getSelectedCollections",
      () =>
        selectedCollectionsFromPane({
          getSelectedCollections: secret,
          getSelectedCollection: () => false,
        }),
    ],
  ])("%s", async (_label, read) => {
    read();
    expect(await selectionUnreadableReports()).toHaveLength(1);
    const report = buildDiagnosticReport({});
    expect(report).toContain("CG-UI02");
    expect(report).not.toContain("Secret Grant");
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
    await expectNothingRecorded();
  });

  it.each<[string, Rows]>([
    ["after a collection", () => [collectionRow(makeCollection([])), otherRow("search")]],
    ["before a collection", () => [otherRow("search"), collectionRow(makeCollection([]))]],
  ])("refuses a saved search row %s and records nothing", async (_label, rows) => {
    expect(
      collectionTargetsFromPane({
        getCollectionTreeRows: rows as () => _ZoteroTypes.CollectionTreeRow[],
        getCollectionTreeRow: removedSingular(),
      }),
    ).toBeNull();
    await expectNothingRecorded();
  });

  it("refuses a library row selected with a collection and records nothing", async () => {
    expect(
      collectionTargetsFromPane({
        getCollectionTreeRows: () => [libraryRow(1), collectionRow(makeCollection([]))],
      }),
    ).toBeNull();
    await expectNothingRecorded();
  });

  it("returns null and records CG-UI02 when the plural getter throws", async () => {
    const getCollectionTreeRow = removedSingular();
    const pane = {
      getCollectionTreeRows: () => {
        throw new Error("collectionsView is gone");
      },
      getCollectionTreeRow,
    };
    expect(collectionTargetsFromPane(pane)).toBeNull();
    expect(await selectionUnreadableReports()).toHaveLength(1);
    expect(getCollectionTreeRow).not.toHaveBeenCalled();
  });

  it("treats a result that is not an array as unreadable", async () => {
    const pane = { getCollectionTreeRows: () => "rows" } as unknown as Parameters<
      typeof collectionTargetsFromPane
    >[0];
    expect(collectionTargetsFromPane(pane)).toBeNull();
    expect(await selectionUnreadableReports()).toHaveLength(1);
  });

  it("returns null, without a diagnostic, for an empty selection", async () => {
    expect(collectionTargetsFromPane({ getCollectionTreeRows: () => [] })).toBeNull();
    await expectNothingRecorded();
  });

  it("returns null and records CG-UI02 when there is no pane to read", async () => {
    expect(collectionTargetsFromPane(null)).toBeNull();
    expect(await selectionUnreadableReports()).toHaveLength(1);
  });
});

describe("collectionTargetsFromPane — Zotero 7 to 9 getCollectionTreeRow", () => {
  it("returns the focused collection", () => {
    const col = makeCollection([]);
    expect(collectionTargetsFromPane({ getCollectionTreeRow: () => collectionRow(col) })).toEqual([
      { kind: "collection", collection: col },
    ]);
  });

  it("returns the focused library root", () => {
    expect(
      collectionTargetsFromPane({ getCollectionTreeRow: () => libraryRow(5, "group") }),
    ).toEqual([{ kind: "library", libraryID: 5 }]);
  });

  it.each(UNSUPPORTED_ROW_TYPES)(
    "refuses a focused %s row that the singular getters would have read as the library root, and records nothing",
    async (type) => {
      expect(collectionTargetsFromPane({ getCollectionTreeRow: () => otherRow(type) })).toBeNull();
      await expectNothingRecorded();
    },
  );

  it("returns null when no row is focused (Zotero 7 returns 0)", async () => {
    expect(collectionTargetsFromPane({ getCollectionTreeRow: () => 0 })).toBeNull();
    await expectNothingRecorded();
  });

  it("returns null and records CG-UI02 when the singular getter throws", async () => {
    const pane = {
      getCollectionTreeRow: () => {
        throw new Error("ZoteroPane.getCollectionTreeRow() was removed");
      },
    };
    expect(() => collectionTargetsFromPane(pane)).not.toThrow();
    expect(collectionTargetsFromPane(pane)).toBeNull();
    expect(await selectionUnreadableReports()).toHaveLength(1);
  });

  it("returns null and records CG-UI02 when the pane has neither getter", async () => {
    expect(collectionTargetsFromPane({})).toBeNull();
    expect(await selectionUnreadableReports()).toHaveLength(1);
  });
});

describe("selectedCollectionsFromPane — citation-network dialog", () => {
  it("prefers getSelectedCollections and never calls the singular getter", async () => {
    const a = makeCollection([]);
    const b = makeCollection([]);
    const getSelectedCollection = vi.fn(() => {
      throw new Error("getSelectedCollection() was removed -- use getSelectedCollections()");
    });
    expect(
      selectedCollectionsFromPane({ getSelectedCollections: () => [a, b], getSelectedCollection }),
    ).toEqual([a, b]);
    expect(getSelectedCollection).not.toHaveBeenCalled();
    await expectNothingRecorded();
  });

  it("falls back to getSelectedCollection where the plural getter does not exist", () => {
    const col = makeCollection([]);
    expect(selectedCollectionsFromPane({ getSelectedCollection: () => col })).toEqual([col]);
  });

  it("returns no collections for a library root or no pane, and records nothing", async () => {
    for (const value of [false, null, undefined] as const) {
      expect(selectedCollectionsFromPane({ getSelectedCollection: () => value })).toEqual([]);
    }
    expect(selectedCollectionsFromPane(null)).toEqual([]);
    await expectNothingRecorded();
  });

  it.each<[string, Parameters<typeof selectedCollectionsFromPane>[0]]>([
    [
      "getSelectedCollections throws",
      { getSelectedCollections: boom, getSelectedCollection: () => false },
    ],
    [
      "getSelectedCollections returns something other than an array",
      {
        getSelectedCollections: () => "rows" as unknown as _ZoteroTypes.Collection[],
        getSelectedCollection: () => false,
      },
    ],
    ["getSelectedCollection throws, with no plural getter", { getSelectedCollection: boom }],
    [
      "the pane has neither getter",
      {} as unknown as Parameters<typeof selectedCollectionsFromPane>[0],
    ],
  ])("gives no collections, without throwing, and records CG-UI02 when %s", async (_l, pane) => {
    expect(selectedCollectionsFromPane(pane)).toEqual([]);
    expect(await selectionUnreadableReports()).toHaveLength(1);
  });
});

describe("paneForWindow and selectedItemsInWindow", () => {
  const paneWith = (...ids: number[]) => ({
    getSelectedItems: () => ids.map((id) => makeItem(id)),
  });

  it("prefer the window's own pane over the most recent window's", () => {
    activePane = paneWith(1);
    const own = paneWith(2);
    const win = { ZoteroPane: own } as unknown as Window;
    expect(paneForWindow(win)).toBe(own);
    expect(idsOf(selectedItemsInWindow(win))).toEqual([2]);
  });

  it("fall back to the active pane for a window without a pane, or no window", () => {
    activePane = paneWith(1);
    expect(paneForWindow({} as Window)).toBe(activePane);
    expect(idsOf(selectedItemsInWindow(undefined))).toEqual([1]);
  });

  it("give no pane and no items when no main window is open", () => {
    expect(paneForWindow(undefined)).toBeNull();
    expect(selectedItemsInWindow(null)).toEqual([]);
  });
});

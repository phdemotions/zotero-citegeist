import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDialogHTML,
  buildAuthorDialogHTML,
  defaultCollectionIdsFromPane,
  getItemSourceMetaLine,
  showAuthorWorks,
  showCitationNetwork,
} from "../src/modules/citationNetwork/dialog";
import type { ProfileViewModel } from "../src/modules/authorProfile";
import { clearRecordedFailures, selectionUnreadableReports } from "./_helpers/menuHarness";

// The dialog resolves the work through citationService; mock that surface so the
// identifier gate can be driven without standing up the OpenAlex/cache stack.
const serviceMocks = vi.hoisted(() => ({
  canResolveWork: vi.fn(),
  resolveWorkForItem: vi.fn(),
}));
vi.mock("../src/modules/citationService", () => ({
  canResolveWork: serviceMocks.canResolveWork,
  resolveWorkForItem: serviceMocks.resolveWorkForItem,
}));

// Opening the dialog for real needs its network and library reads stubbed: the
// results load, the library DOI search, the collection tree, and the author
// lookup and cache writes. Everything else, including the default-collection
// label, runs as shipped.
const openMocks = vi.hoisted(() => ({
  loadResults: vi.fn(async () => {}),
  getExistingDOIs: vi.fn(async () => new Set<string>()),
  buildCollectionTree: vi.fn(() => [
    { id: 3, name: "Grant A", depth: 0, parentId: false, hasChildren: false },
    { id: 4, name: "Grant B", depth: 0, parentId: false, hasChildren: false },
  ]),
  fetchAuthorProfile: vi.fn(async () => ({ id: "https://openalex.org/A5" })),
}));
vi.mock("../src/modules/citationNetwork/results", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadResults: openMocks.loadResults,
}));
vi.mock("../src/modules/citationNetwork/actions", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getExistingDOIs: openMocks.getExistingDOIs,
}));
vi.mock("../src/modules/citationNetwork/collectionPicker", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildCollectionTree: openMocks.buildCollectionTree,
}));
vi.mock("../src/modules/openalexAuthors", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchAuthorProfile: openMocks.fetchAuthorProfile,
}));
vi.mock("../src/modules/authorProfile", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildProfileViewModel: vi.fn(() => ({
    name: "Baumeister, R. F.",
    orcid: null,
    orcidUrl: null,
    openAlexUrl: "https://openalex.org/A5",
    hIndex: "164",
    i10Index: "612",
    worksCount: "731",
    citedByCount: "214,853",
    lowerBound: false,
  })),
  persistProfileMetrics: vi.fn(),
  maybeReconcileMerge: vi.fn(),
}));

function makeItem(opts: {
  creators?: Array<{ lastName?: string; name?: string; creatorTypeID?: number }>;
  publicationTitle?: string;
  date?: string;
}): _ZoteroTypes.Item {
  return {
    getCreators: () => opts.creators ?? [],
    getField: (field: string) => {
      if (field === "publicationTitle") return opts.publicationTitle ?? "";
      if (field === "date") return opts.date ?? "";
      return "";
    },
  } as unknown as _ZoteroTypes.Item;
}

describe("getItemSourceMetaLine", () => {
  beforeEach(() => {
    // No Zotero.CreatorTypes → all creators are treated as authors.
    vi.stubGlobal("Zotero", {});
  });

  it("formats up to three authors as surnames · venue · year", () => {
    const item = makeItem({
      creators: [{ lastName: "Smith" }, { lastName: "de la Cruz" }, { lastName: "Ng" }],
      publicationTitle: "Journal of Marketing",
      date: "2024-03-15",
    });
    expect(getItemSourceMetaLine(item)).toBe(
      "Smith, de la Cruz & Ng · Journal of Marketing · 2024",
    );
  });

  it("collapses more than three authors to 'et al.' and parses year from messy dates", () => {
    const item = makeItem({
      creators: [
        { lastName: "Smith" },
        { lastName: "Jones" },
        { lastName: "Patel" },
        { lastName: "Garcia" },
      ],
      publicationTitle: "Science",
      date: "Spring 2021",
    });
    expect(getItemSourceMetaLine(item)).toBe("Smith et al. · Science · 2021");
  });

  it("uses the two-author '&' form", () => {
    expect(getItemSourceMetaLine(makeItem({ creators: [{ lastName: "Solo" }] }))).toBe("Solo");
    expect(
      getItemSourceMetaLine(makeItem({ creators: [{ lastName: "Ada" }, { lastName: "Bo" }] })),
    ).toBe("Ada & Bo");
  });

  it("drops missing parts and returns empty string when nothing is available", () => {
    expect(getItemSourceMetaLine(makeItem({ publicationTitle: "Nature" }))).toBe("Nature");
    expect(getItemSourceMetaLine(makeItem({ date: "2019" }))).toBe("2019");
    expect(getItemSourceMetaLine(makeItem({}))).toBe("");
  });

  it("falls back to single-field creator 'name' when lastName is absent", () => {
    const item = makeItem({ creators: [{ name: "World Health Organization" }], date: "2020" });
    expect(getItemSourceMetaLine(item)).toBe("World Health Organization · 2020");
  });
});

describe("buildDialogHTML", () => {
  it("renders the redesigned chrome + command bar with the source meta line", () => {
    const html = buildDialogHTML("Brand love", "Batra, Ahuvia & Bagozzi · J. Marketing · 2012");
    expect(html).toContain('class="cg-dialog-chrome"');
    expect(html).toContain('class="cg-dialog-top"');
    expect(html).toContain('class="cg-command-bar"');
    expect(html).toContain('id="cg-source-cited-count"');
    expect(html).toContain('id="cg-hide-in-library"');
    expect(html).toContain('class="cg-source-authors"');
    expect(html).toContain("Brand love");
    expect(html).toContain("Batra, Ahuvia &amp; Bagozzi · J. Marketing · 2012");
  });

  it("escapes the title and the source meta line", () => {
    const html = buildDialogHTML("Title <One> & Two", "Smith & Jones · Journal <X>");
    expect(html).toContain("Title &lt;One&gt; &amp; Two");
    expect(html).toContain("Smith &amp; Jones · Journal &lt;X&gt;");
    expect(html).not.toContain("<One>");
  });

  it("omits the source-meta element when the meta line is empty", () => {
    const html = buildDialogHTML("Only title", "");
    expect(html).not.toContain("cg-source-authors");
  });

  it("preserves every selector the dialog event wiring depends on", () => {
    const html = buildDialogHTML("t", "m");
    for (const sel of [
      'id="cg-btn-close"',
      'aria-label="Close citation network browser"',
      'class="cg-tab"',
      'data-mode="citing"',
      'data-mode="references"',
      'id="cg-tab-citing"',
      'id="cg-tab-references"',
      'aria-controls="cg-dialog-body"',
      'class="cg-search-input"',
      'class="cg-sort-select"',
      'id="cg-dialog-body"',
      'id="cg-total-count"',
      'id="cg-default-chip"',
      'id="cg-default-label"',
      'id="cg-default-dropdown"',
    ]) {
      expect(html, `missing selector: ${sel}`).toContain(sel);
    }
  });

  it("includes all sort options including the new author + not-in-library modes", () => {
    const html = buildDialogHTML("t", "m");
    for (const v of [
      "citations",
      "fwci-desc",
      "percentile-desc",
      "year-desc",
      "year-asc",
      "author-asc",
      "not-in-library",
    ]) {
      expect(html).toContain(`value="${v}"`);
    }
  });
});

describe("buildAuthorDialogHTML", () => {
  const vm: ProfileViewModel = {
    name: "Baumeister, R. F.",
    orcid: "0000-0003-1148-2894",
    orcidUrl: "https://orcid.org/0000-0003-1148-2894",
    openAlexUrl: "https://openalex.org/A5",
    hIndex: "164",
    i10Index: "612",
    worksCount: "731",
    citedByCount: "214,853",
    lowerBound: false,
  };

  it("renders the author header with the shared metric-line primitive, never boxed stat tiles, and drops the tabs", () => {
    const html = buildAuthorDialogHTML(vm);
    // Composes the SHARED primitive so this header and the item pane's Impact
    // card read as one product.
    expect(html).toContain("cg-metricline");
    expect(html).toContain("cg-dialog-top--author");
    // Guard the regression: four bordered, equal-weight tiles flattened the
    // hierarchy and looked nothing like the pane. A box is earned by an
    // interaction, not by a number.
    expect(html).not.toContain("cg-stat--hero");
    expect(html).not.toContain("cg-author-metrics");
    expect(html).toContain("cg-command-bar--notabs");
    expect(html).toContain("Baumeister, R. F.");
    expect(html).toContain("ORCID 0000-0003-1148-2894");
    for (const v of ["164", "612", "731", "214,853"]) expect(html).toContain(v);
    expect(html).toContain("h-index");
    // no citing/references direction in author mode
    expect(html).not.toContain('data-mode="citing"');
    expect(html).not.toContain('data-mode="references"');
  });

  it("reuses the browser shell selectors the event wiring depends on", () => {
    const html = buildAuthorDialogHTML(vm);
    for (const sel of [
      'id="cg-btn-close"',
      'class="cg-search-input"',
      'class="cg-sort-select"',
      'id="cg-dialog-body"',
      'id="cg-total-count"',
      'id="cg-default-chip"',
    ]) {
      expect(html, `missing selector: ${sel}`).toContain(sel);
    }
  });

  it("escapes the author name and preserves the ≥ lower-bound label", () => {
    const html = buildAuthorDialogHTML({ ...vm, name: "A <x> & B", hIndex: "≥ 40" });
    expect(html).toContain("A &lt;x&gt; &amp; B");
    expect(html).not.toContain("A <x>");
    expect(html).toContain("≥ 40");
  });
});

describe("defaultCollectionIdsFromPane (default filing collection)", () => {
  const col = (id: number) => ({ id }) as unknown as _ZoteroTypes.Collection;
  const removed = () => {
    throw new Error("getSelectedCollection() was removed -- use getSelectedCollections()");
  };

  /** The most recent window's pane, which a window without its own pane falls back to. */
  function stubActivePane(pane: Record<string, unknown> | null) {
    vi.stubGlobal("Zotero", { debug: vi.fn(), getActiveZoteroPane: () => pane });
  }

  beforeEach(async () => {
    await clearRecordedFailures();
  });

  it("gives no default when two collections are selected", () => {
    stubActivePane({
      getSelectedCollections: () => [col(1), col(2)],
      getSelectedCollection: removed,
    });
    expect([...defaultCollectionIdsFromPane()]).toEqual([]);
  });

  it("defaults to the one selected collection", () => {
    stubActivePane({ getSelectedCollections: () => [col(3)], getSelectedCollection: removed });
    expect([...defaultCollectionIdsFromPane()]).toEqual([3]);
  });

  it("reads the dialog window's own pane, not the most recent window's", () => {
    stubActivePane({ getSelectedCollections: () => [col(3)], getSelectedCollection: removed });
    const win = {
      ZoteroPane: { getSelectedCollections: () => [col(9)], getSelectedCollection: removed },
    } as unknown as Window;
    expect([...defaultCollectionIdsFromPane(win)]).toEqual([9]);
  });

  it("falls back to getSelectedCollection on a pane without the plural getter", () => {
    stubActivePane({ getSelectedCollection: () => col(5) });
    expect([...defaultCollectionIdsFromPane()]).toEqual([5]);
  });

  it("gives no default for a library root on Zotero 7–9", () => {
    stubActivePane({ getSelectedCollection: () => false });
    expect([...defaultCollectionIdsFromPane()]).toEqual([]);
  });

  it("gives no default when no main window is open", () => {
    stubActivePane(null);
    expect([...defaultCollectionIdsFromPane()]).toEqual([]);
  });

  it("gives no default, without throwing, and records CG-UI02 when the selection read throws", async () => {
    stubActivePane({
      getSelectedCollections: () => {
        throw new Error("host broke");
      },
      getSelectedCollection: removed,
    });
    expect([...defaultCollectionIdsFromPane()]).toEqual([]);
    expect(await selectionUnreadableReports()).toHaveLength(1);
  });
});

describe("opening the dialog picks the default filing collection from the selection", () => {
  const collections = (...ids: number[]) => ({
    getSelectedCollections: () => ids.map((id) => ({ id }) as _ZoteroTypes.Collection),
    getSelectedCollection: () => {
      throw new Error("getSelectedCollection() was removed -- use getSelectedCollections()");
    },
  });

  /**
   * A main window just real enough for the dialog to open in: every element
   * accepts the calls the shell makes, and the default-collection label and its
   * `+N` suffix are the only elements a query finds.
   */
  function dialogWindow(pane: unknown) {
    const found = new Map<string, Record<string, unknown>>();
    const element = (): Record<string, unknown> => ({
      id: "",
      textContent: "",
      hidden: false,
      firstChild: null,
      style: { cssText: "" },
      dataset: {},
      setAttribute: vi.fn(),
      appendChild: vi.fn(),
      insertBefore: vi.fn(),
      remove: vi.fn(),
      focus: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
      querySelector: (selector: string) => found.get(selector) ?? null,
      querySelectorAll: () => [],
    });
    const label = element();
    found.set("#cg-default-label", label);
    found.set("#cg-default-extra", element());
    const document = { body: element(), documentElement: element(), createElementNS: element };
    return { win: { document, ZoteroPane: pane } as unknown as Window, label };
  }

  const item = {
    id: 1,
    getField: () => "Brand love",
    getCreators: () => [],
  } as unknown as _ZoteroTypes.Item;
  const opens: Array<[string, () => Promise<void>]> = [
    ["showCitationNetwork", () => showCitationNetwork(item, "citing")],
    ["showAuthorWorks", () => showAuthorWorks("A5")],
  ];

  async function openWith(open: () => Promise<void>, pane: unknown) {
    const { win, label } = dialogWindow(pane);
    vi.stubGlobal("Zotero", {
      debug: vi.fn(),
      getMainWindow: () => win,
      getActiveZoteroPane: () => null,
    });
    await open();
    const [state] = openMocks.loadResults.mock.calls.at(-1) as unknown as [
      { defaultCollectionIds: Set<number> },
    ];
    return { label: label.textContent, filing: [...state.defaultCollectionIds] };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.canResolveWork.mockReturnValue(true);
    serviceMocks.resolveWorkForItem.mockResolvedValue({
      id: "https://openalex.org/W1",
      cited_by_count: 3,
    });
    vi.stubGlobal("Services", { prompt: { alert: vi.fn() } });
    vi.stubGlobal(
      "DOMParser",
      class {
        parseFromString() {
          return { body: { childNodes: [] } };
        }
      },
    );
  });

  it.each(opens)("%s files into, and labels, the one selected collection", async (_name, open) => {
    expect(await openWith(open, collections(3))).toEqual({ label: "Grant A", filing: [3] });
  });

  it.each(opens)("%s gives no default when two collections are selected", async (_name, open) => {
    expect(await openWith(open, collections(3, 4))).toEqual({ label: "My Library", filing: [] });
  });
});

describe("showCitationNetwork identifier gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("alerts and bails when the item cannot be resolved to a work", async () => {
    const alert = vi.fn();
    vi.stubGlobal("Services", { prompt: { alert } });
    vi.stubGlobal("Zotero", { debug: vi.fn() });
    serviceMocks.canResolveWork.mockReturnValue(false);

    const item = { id: 1, getField: () => "" } as unknown as _ZoteroTypes.Item;
    await showCitationNetwork(item, "citing");

    expect(alert).toHaveBeenCalledTimes(1);
    // Services.prompt.alert(parent, title, message) — assert the rewritten copy.
    expect(String(alert.mock.calls[0][2])).toMatch(/can't identify this item/i);
    // Gate rejected before any resolution work.
    expect(serviceMocks.resolveWorkForItem).not.toHaveBeenCalled();
  });
});

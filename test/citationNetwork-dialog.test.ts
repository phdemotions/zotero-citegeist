import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDialogHTML,
  buildAuthorDialogHTML,
  getItemSourceMetaLine,
  showCitationNetwork,
} from "../src/modules/citationNetwork/dialog";
import type { ProfileViewModel } from "../src/modules/authorProfile";

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

  it("renders the author hero (metric stack, h-index prominent) and drops the tabs", () => {
    const html = buildAuthorDialogHTML(vm);
    expect(html).toContain("cg-author-metrics");
    expect(html).toContain("cg-stat--hero");
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

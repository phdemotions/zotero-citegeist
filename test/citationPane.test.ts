/**
 * The item pane never paints a save that didn't happen.
 *
 * Drives the real pane, cache and fetch service against the fake database and a
 * small fake DOM, with OpenAlex mocked out. On a cache that refuses writes
 * (read-only CG-DB03, closed CG-DB02) the pane must show that code where it
 * would otherwise say a match was confirmed or dismissed, must not offer those
 * decisions, and must not spend an OpenAlex request on data it can't keep.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, mockZotero, resetCacheHarness } from "./_helpers/cacheHarness";
import { FakeDocument, type FakeElement } from "./_helpers/fakeDom";
import type * as OpenAlexModule from "../src/modules/openalex";
import type * as OpenAlexAuthorsModule from "../src/modules/openalexAuthors";

vi.mock("../src/modules/openalex", async (importOriginal) => ({
  ...(await importOriginal<typeof OpenAlexModule>()),
  getWorkByDOI: vi.fn(async () => null),
  getWorkByPMID: vi.fn(async () => null),
  getWorkByArxivId: vi.fn(async () => null),
  getWorkByISBN: vi.fn(async () => null),
  getWorkById: vi.fn(async () => null),
  getSourceStats: vi.fn(async () => null),
}));
vi.mock("../src/modules/titleSearch", () => ({ searchByMetadata: vi.fn(async () => null) }));
vi.mock("../src/modules/citationColumn", () => ({ invalidateColumnCache: vi.fn() }));
vi.mock("../src/modules/citationNetwork", () => ({
  showCitationNetwork: vi.fn(),
  showAuthorWorks: vi.fn(),
}));
vi.mock("../src/modules/openalexAuthors", async (importOriginal) => ({
  ...(await importOriginal<typeof OpenAlexAuthorsModule>()),
  fetchAuthorProfile: vi.fn(async () => null),
}));

import { registerCitationPane } from "../src/modules/citationPane";
import { _resetForTesting, closeCache, initCache } from "../src/modules/cache/db";
import { cacheWorkData, writePendingSuggestion } from "../src/modules/cache";
import { getWorkByDOI, getWorkById } from "../src/modules/openalex";
import { searchByMetadata } from "../src/modules/titleSearch";
import { describeCode } from "../src/modules/diagnostics";
import { CACHE_SCHEMA_MAJOR, CACHE_SCHEMA_STAMP_MULTIPLIER } from "../src/constants";

const NEWER_MAJOR = (CACHE_SCHEMA_MAJOR + 1) * CACHE_SCHEMA_STAMP_MULTIPLIER;
const MATCH_CONFIRMED = "Match confirmed";
const MATCH_DISMISSED = "Match dismissed";
const SUGGESTION = {
  id: "https://openalex.org/W777",
  display_name: "A suggested work",
  cited_by_count: 12,
  fwci: null,
  publication_year: 2020,
  doi: null,
};

interface PaneArgs {
  body: FakeElement;
  item: _ZoteroTypes.Item;
  setSectionSummary: (summary: string) => void;
}

interface CapturedSection {
  onRender(args: PaneArgs): void;
  onAsyncRender(args: PaneArgs): Promise<void>;
  sectionButtons: Array<{ type: string; onClick(args: PaneArgs): Promise<void> | void }>;
}

let section: CapturedSection;

beforeAll(() => {
  Object.assign(mockZotero, {
    ItemPaneManager: {
      registerSection: vi.fn((options: CapturedSection) => {
        section = options;
      }),
      unregisterSection: vi.fn(),
    },
    launchURL: vi.fn(),
  });
  vi.stubGlobal("CSS", { escape: (s: string) => s });
  registerCitationPane("citegeist@test", "root/");
});

beforeEach(async () => {
  await resetCacheHarness(initCache, _resetForTesting);
  vi.mocked(getWorkByDOI).mockClear();
  vi.mocked(getWorkById).mockClear();
  vi.mocked(searchByMetadata).mockClear();
});

function paneItem(key: string, fields: Record<string, string> = {}): _ZoteroTypes.Item {
  return {
    id: 7,
    key,
    libraryID: 1,
    itemType: "journalArticle",
    deleted: false,
    isRegularItem: () => true,
    getField: vi.fn((field: string) => fields[field] ?? ""),
    setField: vi.fn(),
    saveTx: vi.fn(async () => 1),
    getCreators: () => [],
  } as unknown as _ZoteroTypes.Item;
}

/** A section body holding the `#citegeist-content` container the pane renders into. */
function paneBody(item: _ZoteroTypes.Item): PaneArgs & { content: FakeElement } {
  const doc = new FakeDocument();
  const body = doc.createElement("div");
  const content = body.appendChild(doc.createElement("div"));
  content.id = "citegeist-content";
  return { body, content, item, setSectionSummary: vi.fn() };
}

/** Close the cache and open the same file again with its stamp set to `stamp`. */
async function reopenAt(stamp: number): Promise<void> {
  await closeCache();
  fakeDb.pragma.userVersion = stamp;
  await initCache();
}

async function suggestionOnScreen(key: string): Promise<PaneArgs & { content: FakeElement }> {
  const item = paneItem(key);
  await writePendingSuggestion(item, SUGGESTION, "high", 0.93);
  const pane = paneBody(item);
  section.onRender(pane);
  return pane;
}

describe("pane on a cache that refuses writes", () => {
  it("positive control: on a writable cache, Confirm saves the match and says so", async () => {
    const pane = await suggestionOnScreen("SUGG");
    const confirm = pane.content.querySelector(".cg-match-confirm");
    expect(confirm, "the suggestion card offers Confirm").not.toBeNull();

    await confirm!.click();

    expect(pane.content.textContent).toContain(MATCH_CONFIRMED);
    expect(fakeDb.table.get("1:SUGG")?.confirmed_open_alex_id).toBe("W777");
  });

  it("offers no Confirm or Not-this-paper on a read-only cache, and shows CG-DB03 in their place", async () => {
    const item = paneItem("SUGG");
    await writePendingSuggestion(item, SUGGESTION, "high", 0.93);
    await reopenAt(NEWER_MAJOR);

    const pane = paneBody(item);
    section.onRender(pane);

    expect(pane.content.textContent).toContain("A suggested work");
    expect(pane.content.querySelector(".cg-match-confirm")).toBeNull();
    expect(pane.content.querySelector(".cg-match-dismiss")).toBeNull();
    expect(pane.content.textContent).not.toContain("Is this the right paper?");
    expect(pane.content.querySelector(".cg-write-refused")?.textContent).toContain(
      describeCode("CG-DB03").message,
    );
  });

  it("a Confirm drawn before the cache went read-only shows CG-DB03, never a confirmed match", async () => {
    const pane = await suggestionOnScreen("SUGG");
    const confirm = pane.content.querySelector(".cg-match-confirm")!;
    await reopenAt(NEWER_MAJOR);

    await confirm.click();

    expect(pane.content.textContent).not.toContain(MATCH_CONFIRMED);
    expect(pane.content.textContent).toContain(describeCode("CG-DB03").message);
    expect(pane.setSectionSummary).toHaveBeenLastCalledWith("Error");
    const row = fakeDb.table.get("1:SUGG");
    expect(row?.confirmed_open_alex_id ?? null).toBeNull();
    expect(row?.pending_open_alex_id).toBe("W777");
    expect(pane.item.setField).not.toHaveBeenCalled();
    expect(getWorkById).not.toHaveBeenCalled();
  });

  it("a Not-this-paper drawn before the cache went read-only shows CG-DB03, never a dismissal", async () => {
    const pane = await suggestionOnScreen("SUGG");
    const dismiss = pane.content.querySelector(".cg-match-dismiss")!;
    await reopenAt(NEWER_MAJOR);

    await dismiss.click();

    expect(pane.content.textContent).not.toContain(MATCH_DISMISSED);
    expect(pane.content.textContent).toContain(describeCode("CG-DB03").message);
    expect(fakeDb.table.get("1:SUGG")?.no_match ?? null).toBeNull();
  });

  it("a Confirm clicked after the cache closed shows CG-DB02, never a confirmed match", async () => {
    const pane = await suggestionOnScreen("SUGG");
    const confirm = pane.content.querySelector(".cg-match-confirm")!;
    await closeCache();

    await confirm.click();

    expect(pane.content.textContent).not.toContain(MATCH_CONFIRMED);
    expect(pane.content.textContent).toContain(describeCode("CG-DB02").message);
  });

  it("shows CG-DB03 for an uncached item without asking OpenAlex", async () => {
    await reopenAt(NEWER_MAJOR);
    const pane = paneBody(paneItem("NEW", { DOI: "10.1234/new" }));

    await section.onAsyncRender(pane);

    expect(pane.content.textContent).toContain(describeCode("CG-DB03").message);
    expect(getWorkByDOI).not.toHaveBeenCalled();
    expect(searchByMetadata).not.toHaveBeenCalled();
  });

  it("keeps stale saved metrics on screen and adds the CG-DB03 notice once", async () => {
    const item = paneItem("STALE", { DOI: "10.1234/stale" });
    await cacheWorkData(
      item,
      { id: "https://openalex.org/W42", cited_by_count: 42, fwci: null, is_retracted: false },
      null,
    );
    fakeDb.table.get("1:STALE")!.last_fetched = "2000-01-01T00:00:00.000Z";
    await reopenAt(NEWER_MAJOR);
    const pane = paneBody(item);

    section.onRender(pane);
    await section.onAsyncRender(pane);
    await section.onAsyncRender(pane);

    expect(pane.content.textContent).toContain("42");
    expect(pane.content.querySelectorAll(".cg-write-refused")).toHaveLength(1);
    expect(getWorkByDOI).not.toHaveBeenCalled();
  });

  it("Refresh keeps the saved metrics, explains CG-DB03, and clears nothing", async () => {
    const item = paneItem("SAVED", { DOI: "10.1234/saved" });
    await cacheWorkData(
      item,
      { id: "https://openalex.org/W42", cited_by_count: 42, fwci: null, is_retracted: false },
      null,
    );
    await reopenAt(NEWER_MAJOR);
    const pane = paneBody(item);
    const refresh = section.sectionButtons.find((button) => button.type === "refresh")!;

    await refresh.onClick(pane);

    expect(fakeDb.table.has("1:SAVED")).toBe(true);
    expect(pane.content.textContent).toContain("42");
    expect(pane.content.querySelector(".cg-write-refused")?.textContent).toContain(
      describeCode("CG-DB03").message,
    );
    expect(getWorkByDOI).not.toHaveBeenCalled();
  });
});

/**
 * Add to Library in the citation-network browser, against the real cache (plan
 * U16, review T2).
 *
 * Creating the Zotero item is the add. Caching its metrics is a courtesy that a
 * cache refusing writes (read-only, or closed) or failing must not undo: an add
 * shown as failed invites a second click, and the second click used to create a
 * duplicate item.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, mockZotero, resetCacheHarness } from "./_helpers/cacheHarness";

const openalexMocks = vi.hoisted(() => ({
  getSourceStats: vi.fn(async (): Promise<null> => null),
}));
vi.mock("../src/modules/openalex", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSourceStats: openalexMocks.getSourceStats,
}));
vi.mock("../src/modules/citationColumn", () => ({ invalidateColumnCache: vi.fn() }));
// The row button markup goes through DOMParser, which node lacks; keep its text.
vi.mock("../src/modules/utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  safeInnerHTML: (element: { textContent: string }, html: string) => {
    element.textContent = html.replace(/<[^>]*>/g, "");
  },
}));

import { addItemToLibrary } from "../src/modules/citationNetwork/actions";
import type { NetworkState } from "../src/modules/citationNetwork/types";
import type { OpenAlexWork } from "../src/modules/openalex";
import { _resetForTesting, closeCache, initCache } from "../src/modules/cache/db";
import { clearDiagnostics, recentDiagnostics } from "../src/modules/diagnostics";
import { CACHE_SCHEMA_MAJOR, CACHE_SCHEMA_STAMP_MULTIPLIER } from "../src/constants";

// ── A DOM just big enough for the row the add updates ───────────────────────

class Doc {
  createElement(tagName: string): El {
    return new El(this, tagName);
  }
  createElementNS(_namespace: string, tagName: string): El {
    return new El(this, tagName);
  }
  createTextNode(text: string): El {
    const node = new El(this, "#text");
    node.textContent = text;
    return node;
  }
}

class El {
  className = "";
  disabled = false;
  readonly style: Record<string, string> = {};
  readonly classList = {
    add: (name: string): void => {
      this.className = `${this.className} ${name}`.trim();
    },
  };
  private children: El[] = [];
  private parent: El | null = null;
  private ownText = "";
  private readonly attributes = new Map<string, string>();

  constructor(
    readonly ownerDocument: Doc,
    readonly tagName: string,
  ) {}

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.children = [];
    this.ownText = value;
  }
  appendChild(child: El): El {
    child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  /** `.a.b` optionally followed by one `[name="value"]`; anything else throws. */
  matches(selector: string): boolean {
    const parsed = /^((?:\.[\w-]+)+)(?:\[([\w-]+)="([^"]*)"\])?$/.exec(selector);
    if (!parsed) throw new Error(`unsupported selector ${selector}`);
    const classes = this.className.split(/\s+/);
    const wanted = parsed[1].split(".").filter(Boolean);
    if (!wanted.every((name) => classes.includes(name))) return false;
    return parsed[2] === undefined || this.attributes.get(parsed[2]) === parsed[3];
  }
  querySelector(selector: string): El | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const inner = child.querySelector(selector);
      if (inner) return inner;
    }
    return null;
  }
}

// ── Zotero items ─────────────────────────────────────────────────────────────

const created: FakeItem[] = [];

class FakeItem {
  readonly id: number;
  readonly key: string;
  readonly libraryID = 1;
  readonly saveTx = vi.fn(async () => this.id);
  constructor(readonly itemType: string) {
    created.push(this);
    this.id = 100 + created.length;
    this.key = `ADDED${created.length}`;
  }
  setField(): void {}
  setCreators(): void {}
  addTag(): void {}
  addToCollection(): void {}
}
(mockZotero as unknown as { Item: typeof FakeItem }).Item = FakeItem;

const WORK = {
  id: "https://openalex.org/W1",
  doi: "https://doi.org/10.1234/added",
  title: "An added work",
  display_name: "An added work",
  type: "article",
  publication_year: 2020,
  cited_by_count: 7,
  primary_location: {
    source: { id: "https://openalex.org/S1", display_name: "A journal", issn_l: null },
  },
  authorships: [{ author: { id: "https://openalex.org/A1", display_name: "Ada Lovelace" } }],
} as unknown as OpenAlexWork;

function openRow(): { state: NetworkState; row: El } {
  const doc = new Doc();
  const dialog = doc.createElement("div");
  const row = doc.createElement("div");
  row.className = "cg-result-item";
  row.setAttribute("data-work-id", "W1");
  const right = doc.createElement("div");
  right.className = "cg-result-right";
  const split = doc.createElement("div");
  split.className = "cg-split-btn";
  const main = doc.createElement("button");
  main.className = "cg-split-main";
  main.setAttribute("data-work-id", "W1");
  main.textContent = "+ Add to Library";
  split.appendChild(main);
  right.appendChild(split);
  row.appendChild(right);
  dialog.appendChild(row);
  const state = {
    dialog,
    results: [WORK],
    pendingAdds: new Set<string>(),
    createdItemIds: new Map<string, number>(),
    existingDOIs: new Set<string>(),
    itemCollections: new Map<string, Set<number>>(),
    undoTimers: new Map<string, ReturnType<typeof setTimeout>>(),
    addedThisSession: new Set<string>(),
    defaultCollectionIds: new Set<number>(),
    allCollections: [],
  } as unknown as NetworkState;
  opened.push(state);
  return { state, row };
}

const opened: NetworkState[] = [];

function buttonText(row: El): string {
  return row.querySelector(".cg-result-right")?.textContent ?? "";
}

/** One add, then the second click a user makes when the first looked unfinished. */
async function addTwice(state: NetworkState): Promise<void> {
  await addItemToLibrary(state, "W1", new Set());
  await addItemToLibrary(state, "W1", new Set());
}

beforeEach(async () => {
  created.length = 0;
  openalexMocks.getSourceStats.mockReset();
  openalexMocks.getSourceStats.mockResolvedValue(null);
  await resetCacheHarness(initCache, _resetForTesting);
  clearDiagnostics();
});

afterEach(() => {
  for (const state of opened.splice(0)) {
    for (const timer of state.undoTimers.values()) clearTimeout(timer);
  }
});

describe("Add to Library", () => {
  it("caches the new item's metrics and authors on a cache that takes writes (positive control)", async () => {
    const { state, row } = openRow();

    await addItemToLibrary(state, "W1", new Set());

    expect(created).toHaveLength(1);
    expect(openalexMocks.getSourceStats).toHaveBeenCalledWith("https://openalex.org/S1");
    expect(fakeDb.table.get(`1:${created[0].key}`)?.cited_by_count).toBe(7);
    expect(fakeDb.itemAuthors.size).toBe(1);
    expect(buttonText(row)).toContain("Added");
  });

  it("on a read-only cache, adds one item, shows Added, looks up no source and records nothing; a second click adds nothing", async () => {
    await closeCache();
    fakeDb.pragma.userVersion = (CACHE_SCHEMA_MAJOR + 1) * CACHE_SCHEMA_STAMP_MULTIPLIER;
    await initCache();
    clearDiagnostics();
    const { state, row } = openRow();

    await addTwice(state);

    expect(created).toHaveLength(1);
    expect(created[0].saveTx).toHaveBeenCalledTimes(1);
    expect(state.createdItemIds.get("W1")).toBe(created[0].id);
    expect(buttonText(row)).toContain("Added");
    expect(row.querySelector(".cg-row-error")).toBeNull();
    expect(openalexMocks.getSourceStats).not.toHaveBeenCalled();
    expect(recentDiagnostics()).toEqual([]);
    expect(fakeDb.table.size).toBe(0);
  });

  it("on a closed cache, adds one item, shows Added and looks up no source; a second click adds nothing", async () => {
    await closeCache();
    const { state, row } = openRow();

    await addTwice(state);

    expect(created).toHaveLength(1);
    expect(state.createdItemIds.get("W1")).toBe(created[0].id);
    expect(buttonText(row)).toContain("Added");
    expect(row.querySelector(".cg-row-error")).toBeNull();
    expect(openalexMocks.getSourceStats).not.toHaveBeenCalled();
    expect(recentDiagnostics()).toEqual([]);
  });

  it("when the cache closes during the add, the item stands, shows Added and records nothing; a second click adds nothing", async () => {
    openalexMocks.getSourceStats.mockImplementation(async () => {
      await closeCache();
      return null;
    });
    const { state, row } = openRow();

    await addTwice(state);

    expect(created).toHaveLength(1);
    expect(buttonText(row)).toContain("Added");
    expect(row.querySelector(".cg-row-error")).toBeNull();
    expect(recentDiagnostics()).toEqual([]);
  });

  it("records a failed cache write once, and the add still stands", async () => {
    const base = fakeDb.queryAsync.getMockImplementation()!;
    fakeDb.queryAsync.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/^INSERT\s+OR\s+REPLACE\s+INTO\s+item_cache/i.test(sql.trim())) {
        throw new Error("database is locked");
      }
      return base(sql, params);
    });
    const { state, row } = openRow();

    await addTwice(state);

    expect(created).toHaveLength(1);
    expect(buttonText(row)).toContain("Added");
    expect(recentDiagnostics().map((d) => [d.code, d.context])).toEqual([
      ["CG-DB01", "addItemToLibrary cache"],
    ]);
  });

  it("shows Add failed and records no created item when the item itself isn't saved", async () => {
    const { state, row } = openRow();
    class FailingItem extends FakeItem {
      override readonly saveTx = vi.fn(async (): Promise<number> => {
        throw new Error("item is locked");
      });
    }
    (mockZotero as unknown as { Item: typeof FakeItem }).Item = FailingItem;
    try {
      await addItemToLibrary(state, "W1", new Set());
    } finally {
      (mockZotero as unknown as { Item: typeof FakeItem }).Item = FakeItem;
    }

    expect(state.createdItemIds.has("W1")).toBe(false);
    expect(row.querySelector(".cg-row-error")?.textContent).toBe("Add failed — please try again.");
  });
});

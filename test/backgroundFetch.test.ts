/**
 * The background fetcher's state machine (backgroundFetch.ts), driven through
 * its dependencies: fake lookups, a recorded redraw, settings the test sets, and
 * vitest's fake clock and timers. The cache is the fake one, so the paint rule's
 * checks (an identifier, a cache that takes writes) run for real.
 *
 * test/autoFetch.test.ts drives the same fetcher through the real columns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, resetCacheHarness } from "./_helpers/cacheHarness";
import {
  AUTO_FETCH_PREF_TTL_MS,
  BACKGROUND_ANONYMOUS_REFUSAL_PAUSE_MS,
  BACKGROUND_RETRY_MAX_MS,
  BACKGROUND_RETRY_MIN_MS,
  CACHE_SCHEMA_MAJOR,
  CACHE_SCHEMA_STAMP_MULTIPLIER,
  FETCH_BATCH_DELAY_MS,
  FETCH_BATCH_SIZE,
  FETCH_QUEUE_DEBOUNCE_MS,
  NO_MATCH_RETRY_DAYS,
} from "../src/constants";
import {
  createBackgroundFetcher,
  nextUtcMidnight,
  type BackgroundFetcher,
  type BackgroundFetcherDeps,
} from "../src/modules/backgroundFetch";
import {
  initCache,
  isNoMatchSuppressed,
  writeNoMatch,
  type AllMetrics,
} from "../src/modules/cache";
import { _resetForTesting } from "../src/modules/cache/db";
import type { FetchResult } from "../src/modules/citationService";
import { clearDiagnostics, recentDiagnostics } from "../src/modules/diagnostics";
import { OpenAlexUnavailableError } from "../src/modules/openalex";
import { OpenAlexAuthError, OpenAlexBudgetError, OpenAlexNetworkError } from "../src/modules/utils";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A fixed noon, so "the next midnight UTC" is twelve hours away. */
const NOON_UTC = Date.UTC(2026, 8, 28, 12, 0, 0);

let nextId = 1;

function makeItem(
  fields: { DOI?: string; deleted?: boolean; feed?: boolean } = {},
): _ZoteroTypes.Item {
  const id = nextId++;
  const values: Record<string, string> = { DOI: fields.DOI ?? `10.5555/row-${id}` };
  return {
    id,
    key: `ROW${id}`,
    libraryID: 1,
    itemType: "journalArticle",
    objectType: fields.feed ? "feedItem" : "item",
    isFeedItem: fields.feed ? true : undefined,
    deleted: fields.deleted ?? false,
    isRegularItem: () => true,
    getField: (field: string) => values[field] ?? "",
  } as unknown as _ZoteroTypes.Item;
}

function metrics(isStale: boolean): AllMetrics {
  return {
    count: null,
    fwci: null,
    percentile: null,
    isStale,
    sourceId: null,
    citedness2yr: null,
    journalHIndex: null,
    sourceISSNs: [],
    suggestion: null,
  };
}
const STALE = metrics(true);

const OK: FetchResult = { status: "cached" };
const NOT_FOUND: FetchResult = { status: "error", error: "not-found" };
const refusedKey = (
  message = "OpenAlex rejected the request for work lookup (doi) (HTTP 403)",
): FetchResult => ({
  status: "error",
  error: "unexpected",
  code: "CG-API01",
  cause: new OpenAlexAuthError(message),
});
const spentBudget = (): FetchResult => ({
  status: "error",
  error: "unexpected",
  code: "CG-API42",
  cause: new OpenAlexBudgetError(),
});
const offline = (): FetchResult => ({
  status: "error",
  error: "network",
  code: "CG-NET01",
  cause: new OpenAlexNetworkError("OpenAlex unreachable while fetching work lookup (doi)"),
});
const overloaded = (): FetchResult => ({
  status: "error",
  error: "unexpected",
  code: "CG-API50",
  cause: new OpenAlexUnavailableError(503, "work lookup (doi)"),
});
const UNWRITABLE: FetchResult = { status: "error", error: "cache-unwritable", code: "CG-DB02" };

/** A fetcher on fake dependencies the test steers. */
interface Rig {
  fetcher: BackgroundFetcher;
  /** IDs looked up, in order. */
  lookups: number[];
  /** Every refreshRows call. */
  redraws: Array<{ ids: number[]; now: boolean }>;
  settings: { autoFetch: boolean; key: string };
  /** What a lookup of an ID resolves to; the default is OK. */
  answer: (id: number) => FetchResult | Promise<FetchResult>;
  /** The onChange the fetcher subscribed with, when watched. */
  onSettingsChange: (() => void) | null;
  unwatch: ReturnType<typeof vi.fn>;
  readAutoFetch: ReturnType<typeof vi.fn>;
}

function rig(options: { watch?: boolean; deps?: Partial<BackgroundFetcherDeps> } = {}): Rig {
  const r = {
    lookups: [],
    redraws: [],
    settings: { autoFetch: true, key: "" },
    answer: () => OK,
    onSettingsChange: null,
    unwatch: vi.fn(),
  } as unknown as Rig;
  r.readAutoFetch = vi.fn(() => r.settings.autoFetch);
  const deps: BackgroundFetcherDeps = {
    fetchItem: async (id) => {
      r.lookups.push(id);
      return r.answer(id);
    },
    refreshRows: (ids, now) => {
      r.redraws.push({ ids: [...ids], now });
    },
    readAutoFetch: r.readAutoFetch as unknown as () => boolean,
    readApiKey: () => r.settings.key,
    now: () => Date.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle),
    ...(options.watch
      ? {
          watchSettings: (onChange: () => void) => {
            r.onSettingsChange = onChange;
            return r.unwatch as unknown as () => void;
          },
        }
      : {}),
    ...options.deps,
  };
  r.fetcher = createBackgroundFetcher(deps);
  return r;
}

/** Every ID a redraw has named so far. */
function redrawn(r: Rig): Set<number> {
  return new Set(r.redraws.flatMap((call) => call.ids));
}

/** Run the debounce, the batches and their pauses: enough fake time for `rows` rows. */
async function runPass(rows = FETCH_BATCH_SIZE): Promise<void> {
  const batches = Math.ceil(rows / FETCH_BATCH_SIZE);
  await vi.advanceTimersByTimeAsync(FETCH_QUEUE_DEBOUNCE_MS + batches * FETCH_BATCH_DELAY_MS + 10);
}

/**
 * Run a pass of one batch whose lookups settle at once. It starts when the
 * debounce ends and settles within the same instant, so a pause it enters is
 * measured from now.
 */
async function runOneBatch(): Promise<void> {
  await vi.advanceTimersByTimeAsync(FETCH_QUEUE_DEBOUNCE_MS);
}

/** Offer rows as a paint would, and return what their cells would show. */
function paint(r: Rig, items: readonly _ZoteroTypes.Item[]): boolean[] {
  return items.map((item) => r.fetcher.offer(item, STALE));
}

beforeEach(async () => {
  await resetCacheHarness(initCache, _resetForTesting);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOON_UTC);
  clearDiagnostics();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("its phases", () => {
  it("goes idle → scheduled → running → idle, and a queued or running row reads as pending", async () => {
    const r = rig();
    let land: (result: FetchResult) => void = () => {};
    r.answer = () => new Promise((resolve) => (land = resolve));
    const [row] = [makeItem()];

    expect(r.fetcher.phase.name).toBe("idle");
    expect(r.fetcher.offer(row, STALE)).toBe(true);
    expect(r.fetcher.phase.name).toBe("scheduled");
    expect(r.fetcher.isPending(row.id)).toBe(true);

    await vi.advanceTimersByTimeAsync(FETCH_QUEUE_DEBOUNCE_MS);
    expect(r.fetcher.phase.name).toBe("running");
    expect(r.lookups).toEqual([row.id]);
    expect(r.fetcher.offer(row, STALE), "a row in flight still shows '…'").toBe(true);

    land(OK);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.fetcher.phase.name).toBe("idle");
    expect(r.fetcher.isPending(row.id)).toBe(false);
    expect(redrawn(r).has(row.id), "the landed row is redrawn").toBe(true);
  });
});

describe("which rows are due", () => {
  it("queues a stale row with an identifier, and no fresh row", () => {
    const r = rig();
    expect(r.fetcher.offer(makeItem(), STALE)).toBe(true);
    expect(r.fetcher.offer(makeItem(), metrics(false))).toBe(false);
  });

  it("never queues a feed item or an item in the trash", () => {
    const r = rig();
    expect(r.fetcher.offer(makeItem({ feed: true }), STALE)).toBe(false);
    expect(r.fetcher.offer(makeItem({ deleted: true }), STALE)).toBe(false);
    expect(r.fetcher.phase.name, "nothing was scheduled").toBe("idle");
  });

  it("never queues an item without an identifier", () => {
    const r = rig();
    expect(r.fetcher.offer(makeItem({ DOI: "" }), STALE)).toBe(false);
  });

  it("queues an identifier item whose earlier title search found nothing: that hold-off is for the metered search", async () => {
    const r = rig();
    const row = makeItem();
    await writeNoMatch(row);
    expect(isNoMatchSuppressed(row, NO_MATCH_RETRY_DAYS), "positive control").toBe(true);

    expect(r.fetcher.offer(row, STALE)).toBe(true);
  });

  it("queues nothing while the cache refuses writes", async () => {
    _resetForTesting();
    fakeDb.pragma.userVersion = (CACHE_SCHEMA_MAJOR + 1) * CACHE_SCHEMA_STAMP_MULTIPLIER;
    await initCache();
    const r = rig();
    expect(r.fetcher.offer(makeItem(), STALE)).toBe(false);
  });

  it("does not queue a row looked up without result again until a cache lifetime has passed", async () => {
    const r = rig();
    r.answer = () => NOT_FOUND;
    const row = makeItem();
    paint(r, [row]);
    await runPass();
    expect(r.lookups).toEqual([row.id]);

    expect(r.fetcher.offer(row, STALE)).toBe(false);
    await vi.advanceTimersByTimeAsync(6 * DAY_MS);
    expect(r.fetcher.offer(row, STALE), "within the 7-day lifetime").toBe(false);
    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    expect(r.fetcher.offer(row, STALE), "a lifetime later").toBe(true);
  });

  it("does not remember a row whose data landed, so it is due again once its data goes stale", async () => {
    const r = rig();
    const row = makeItem();
    paint(r, [row]);
    await runPass();
    expect(r.lookups).toEqual([row.id]);
    expect(r.fetcher.offer(row, STALE)).toBe(true);
  });

  it("does not remember a row trashed while it was queued", async () => {
    const r = rig();
    r.answer = () => ({ status: "error", error: "invalid-item" });
    const row = makeItem();
    paint(r, [row]);
    await runPass();
    expect(r.fetcher.offer(row, STALE), "restored from the trash, it is due").toBe(true);
  });
});

describe("a pause ends by its rule", () => {
  /** Pause the fetcher with `result` on one row, and return a second row held by the pause. */
  async function pauseWith(r: Rig, result: () => FetchResult): Promise<_ZoteroTypes.Item> {
    r.answer = () => result();
    paint(r, [makeItem()]);
    await runOneBatch();
    expect(r.fetcher.phase.name, "positive control: paused").toBe("paused");
    r.answer = () => OK;
    const held = makeItem();
    expect(r.fetcher.offer(held, STALE), "a paused fetcher queues nothing").toBe(false);
    return held;
  }

  it("a refused key: not by time, but by a new key", async () => {
    const r = rig();
    r.settings.key = "sk-old";
    const held = await pauseWith(r, refusedKey);
    expect(r.fetcher.phase).toMatchObject({ reason: "auth", apiKey: "sk-old", until: null });

    await vi.advanceTimersByTimeAsync(3 * DAY_MS);
    expect(r.fetcher.offer(held, STALE), "days later, same key").toBe(false);

    r.settings.key = "sk-new";
    expect(r.fetcher.offer(held, STALE)).toBe(true);
    expect(r.fetcher.phase.name).toBe("scheduled");
  });

  it("a refused key: by clearing it", async () => {
    const r = rig();
    r.settings.key = "sk-old";
    const held = await pauseWith(r, refusedKey);

    r.settings.key = "";
    expect(r.fetcher.offer(held, STALE)).toBe(true);
  });

  it("a refused request that carried no key: after its timeout, by the timer, and the held rows are redrawn", async () => {
    const r = rig();
    const held = await pauseWith(r, refusedKey);
    expect(r.fetcher.phase).toMatchObject({ reason: "auth", apiKey: "" });

    await vi.advanceTimersByTimeAsync(BACKGROUND_ANONYMOUS_REFUSAL_PAUSE_MS - 60_000);
    expect(r.fetcher.phase.name).toBe("paused");
    r.redraws.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.fetcher.phase.name).toBe("idle");
    expect(r.redraws).toContainEqual({ ids: expect.arrayContaining([held.id]), now: true });
  });

  it("a spent budget: by adding a key", async () => {
    const r = rig();
    const held = await pauseWith(r, spentBudget);
    expect(r.fetcher.phase).toMatchObject({
      reason: "budget",
      apiKey: "",
      until: nextUtcMidnight(NOON_UTC),
    });

    r.settings.key = "sk-added";
    expect(r.fetcher.offer(held, STALE)).toBe(true);
  });

  it("a spent budget: at the next midnight UTC, with no paint", async () => {
    const r = rig();
    r.settings.key = "sk-same";
    const held = await pauseWith(r, spentBudget);
    r.redraws.length = 0;

    await vi.advanceTimersByTimeAsync(nextUtcMidnight(Date.now()) - Date.now() - 1_000);
    expect(r.fetcher.phase.name, "a second before midnight").toBe("paused");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.fetcher.phase.name).toBe("idle");
    expect(redrawn(r).has(held.id), "the held row is redrawn, to queue on its paint").toBe(true);
    expect(r.fetcher.offer(held, STALE)).toBe(true);
  });

  it("a cache that refuses writes: not by a key or a day", async () => {
    const r = rig();
    const held = await pauseWith(r, () => UNWRITABLE);
    expect(r.fetcher.phase).toMatchObject({ reason: "cache-unwritable", until: null });
    expect(recentDiagnostics(), "the write gate recorded it already").toEqual([]);

    r.settings.key = "sk-new";
    await vi.advanceTimersByTimeAsync(2 * DAY_MS);
    expect(r.fetcher.offer(held, STALE)).toBe(false);
    expect(r.fetcher.phase.name).toBe("paused");
  });

  it("network trouble: after a cool-down that doubles while it lasts and resets once lookups work", async () => {
    const r = rig();
    await pauseWith(r, offline);
    const coolDown = () => {
      const phase = r.fetcher.phase;
      return phase.name === "paused" && phase.until !== null ? phase.until - Date.now() : null;
    };
    expect(coolDown()).toBe(BACKGROUND_RETRY_MIN_MS);

    // Still offline when the cool-down ends: the next pause is twice as long.
    r.answer = () => offline();
    await vi.advanceTimersByTimeAsync(BACKGROUND_RETRY_MIN_MS);
    expect(r.fetcher.phase.name).toBe("idle");
    paint(r, [makeItem()]);
    await runOneBatch();
    expect(coolDown()).toBe(2 * BACKGROUND_RETRY_MIN_MS);

    // Back online: a lookup that gets an answer resets the next cool-down.
    r.answer = () => OK;
    await vi.advanceTimersByTimeAsync(2 * BACKGROUND_RETRY_MIN_MS);
    paint(r, [makeItem()]);
    await runOneBatch();
    expect(r.fetcher.phase.name).toBe("idle");
    r.answer = () => overloaded();
    paint(r, [makeItem()]);
    await runOneBatch();
    expect(coolDown(), "an overloaded OpenAlex pauses the same way").toBe(BACKGROUND_RETRY_MIN_MS);
  });

  it("network trouble: the cool-down stops growing at its maximum", async () => {
    const r = rig();
    r.answer = () => offline();
    const coolDowns: number[] = [];
    for (let i = 0; i < 6; i++) {
      paint(r, [makeItem()]);
      await runOneBatch();
      const phase = r.fetcher.phase;
      if (phase.name !== "paused" || phase.until === null) throw new Error("not paused");
      coolDowns.push(phase.until - Date.now());
      await vi.advanceTimersByTimeAsync(phase.until - Date.now());
    }
    expect(coolDowns).toEqual(
      [1, 2, 4, 8, 16, 32].map((n) =>
        Math.min(BACKGROUND_RETRY_MAX_MS, n * BACKGROUND_RETRY_MIN_MS),
      ),
    );
  });
});

describe("the key a refused batch carried", () => {
  it("is the key read before the batch began, so a key changed meanwhile ends the pause at once", async () => {
    const r = rig();
    r.settings.key = "sk-refused";
    let refuse: (result: FetchResult) => void = () => {};
    r.answer = () => new Promise((resolve) => (refuse = resolve));
    const row = makeItem();
    paint(r, [row]);
    await vi.advanceTimersByTimeAsync(FETCH_QUEUE_DEBOUNCE_MS);
    expect(r.lookups, "positive control: the batch is in flight").toEqual([row.id]);

    r.settings.key = "sk-replacement";
    refuse(refusedKey());
    await vi.advanceTimersByTimeAsync(0);

    expect(r.fetcher.phase.name, "the refusal was for the old key").toBe("idle");
    expect(
      recentDiagnostics().map((d) => d.code),
      "the refusal is still recorded",
    ).toEqual(["CG-API01"]);
    r.answer = () => OK;
    expect(r.fetcher.offer(row, STALE), "the refused row is looked up with the new key").toBe(true);
  });
});

describe("the diagnostics a pause records", () => {
  it("one entry for a refused batch, holding the refusal's own message: its HTTP status and lookup", async () => {
    const r = rig();
    r.settings.key = "sk-rejected";
    r.answer = () => refusedKey();
    paint(r, [makeItem(), makeItem(), makeItem(), makeItem()]);
    await runPass(4);

    const entries = recentDiagnostics();
    expect(entries).toHaveLength(1);
    expect(entries[0].code).toBe("CG-API01");
    expect(entries[0].detail).toContain("HTTP 403");
    expect(entries[0].detail).toContain("work lookup (doi)");
  });

  it("one entry for network trouble that pauses lookups again and again", async () => {
    const r = rig();
    r.answer = () => offline();
    for (let i = 0; i < 3; i++) {
      paint(r, [makeItem(), makeItem()]);
      await runPass();
      const phase = r.fetcher.phase;
      if (phase.name === "paused" && phase.until !== null) {
        await vi.advanceTimersByTimeAsync(phase.until - Date.now());
      }
    }
    expect(r.lookups.length, "positive control: three passes ran").toBeGreaterThanOrEqual(3);
    expect(recentDiagnostics().map((d) => d.code)).toEqual(["CG-NET01"]);
  });
});

describe("network trouble", () => {
  it("is not remembered: the rows it cut short are redrawn now and looked up once the cool-down ends", async () => {
    const r = rig();
    r.answer = () => offline();
    const rows = [makeItem(), makeItem()];
    expect(paint(r, rows)).toEqual([true, true]);
    await runPass();
    expect(r.fetcher.phase).toMatchObject({ name: "paused", reason: "transient" });
    for (const row of rows) {
      expect(r.fetcher.isPending(row.id)).toBe(false);
      expect(redrawn(r).has(row.id), "redrawn, so no cell keeps showing '…'").toBe(true);
    }

    r.answer = () => OK;
    r.redraws.length = 0;
    await vi.advanceTimersByTimeAsync(BACKGROUND_RETRY_MIN_MS);
    expect(redrawn(r), "the held rows are redrawn when the cool-down ends").toEqual(
      new Set(rows.map((row) => row.id)),
    );
    expect(paint(r, rows), "and queue on that paint").toEqual([true, true]);
    await runPass();
    expect(r.lookups.filter((id) => id === rows[0].id)).toHaveLength(2);
  });
});

describe("a pass that throws", () => {
  it("drops and redraws the rows still queued, pauses with the cool-down, and records the throw once", async () => {
    const r = rig();
    const rows = [makeItem(), makeItem(), makeItem(), makeItem()];
    paint(r, rows);
    let reads = 0;
    r.readAutoFetch.mockImplementation(() => {
      reads++;
      // The pass reads the setting before each batch (the paint's read came
      // before this stand-in): the read before its second batch fails.
      if (reads === 2) throw new Error("preferences unreadable");
      return true;
    });

    await runPass(4);

    expect(r.lookups, "the first batch ran").toEqual(
      rows.slice(0, FETCH_BATCH_SIZE).map((row) => row.id),
    );
    expect(r.fetcher.phase).toMatchObject({ name: "paused", reason: "failed" });
    for (const row of rows) {
      expect(r.fetcher.isPending(row.id), `row ${row.id} is left pending`).toBe(false);
      expect(redrawn(r).has(row.id), `row ${row.id} is not redrawn`).toBe(true);
    }
    const last = r.redraws.at(-1);
    expect(last?.now, "the end of the pass redraws at once").toBe(true);
    expect(recentDiagnostics().map((d) => d.context)).toEqual(["background lookups: pass failed"]);

    await vi.advanceTimersByTimeAsync(BACKGROUND_RETRY_MIN_MS);
    expect(r.fetcher.phase.name).toBe("idle");
    expect(paint(r, rows.slice(FETCH_BATCH_SIZE)), "the dropped rows queue again").toEqual([
      true,
      true,
    ]);
  });
});

describe("stop", () => {
  it("clears every timer it set", async () => {
    const r = rig();
    paint(r, [makeItem()]);
    expect(vi.getTimerCount(), "positive control: the debounce is set").toBeGreaterThan(0);

    await r.fetcher.stop();

    expect(vi.getTimerCount()).toBe(0);
    expect(r.fetcher.phase.name).toBe("stopped");
    expect(r.fetcher.offer(makeItem(), STALE), "a stopped fetcher queues nothing").toBe(false);
  });

  it("clears a pause's resume timer", async () => {
    const r = rig();
    r.answer = () => offline();
    paint(r, [makeItem()]);
    await runPass();
    expect(vi.getTimerCount(), "positive control: the cool-down timer is set").toBeGreaterThan(0);

    await r.fetcher.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("while a batch awaits: resolves once the batch settles, and the pass changes nothing after", async () => {
    const r = rig();
    const lands: Array<(result: FetchResult) => void> = [];
    r.answer = () => new Promise((resolve) => lands.push(resolve));
    const rows = [makeItem(), makeItem(), makeItem(), makeItem()];
    paint(r, rows);
    await vi.advanceTimersByTimeAsync(FETCH_QUEUE_DEBOUNCE_MS);
    expect(lands, "positive control: one batch in flight").toHaveLength(FETCH_BATCH_SIZE);

    let stopped = false;
    const stopping = r.fetcher.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped, "the batch has not settled").toBe(false);
    const redrawsAtStop = r.redraws.length;

    for (const land of lands) land(NOT_FOUND);
    await stopping;

    expect(r.redraws.length, "no redraw after stop").toBe(redrawsAtStop);
    await vi.advanceTimersByTimeAsync(10 * FETCH_BATCH_DELAY_MS);
    expect(r.lookups, "the rest of the queue was dropped").toHaveLength(FETCH_BATCH_SIZE);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("while the pass waits between batches: wakes it, and resolves at once", async () => {
    const r = rig();
    paint(r, [makeItem(), makeItem(), makeItem(), makeItem()]);
    await vi.advanceTimersByTimeAsync(FETCH_QUEUE_DEBOUNCE_MS + 1);
    expect(r.lookups, "positive control: the first batch ran").toHaveLength(FETCH_BATCH_SIZE);

    await r.fetcher.stop();

    expect(vi.getTimerCount()).toBe(0);
    expect(r.lookups).toHaveLength(FETCH_BATCH_SIZE);
  });
});

describe("the settings it watches", () => {
  it("subscribes once when created, and unsubscribes on stop", async () => {
    const r = rig({ watch: true });
    expect(r.onSettingsChange, "subscribed").not.toBeNull();

    await r.fetcher.stop();
    expect(r.unwatch).toHaveBeenCalledTimes(1);
  });

  it("ticking auto-fetch redraws the rows drawn while it was off, with no paint", () => {
    const r = rig({ watch: true });
    r.settings.autoFetch = false;
    const rows = [makeItem(), makeItem()];
    expect(paint(r, rows)).toEqual([false, false]);

    r.settings.autoFetch = true;
    r.onSettingsChange?.();

    expect(r.redraws).toContainEqual({ ids: rows.map((row) => row.id), now: true });
    expect(paint(r, rows), "their next paint queues them").toEqual([true, true]);
  });

  it("unticking auto-fetch drops the queue at once and redraws those rows", () => {
    const r = rig({ watch: true });
    const rows = [makeItem(), makeItem()];
    paint(r, rows);
    expect(r.fetcher.phase.name).toBe("scheduled");

    r.settings.autoFetch = false;
    r.onSettingsChange?.();

    expect(r.fetcher.phase.name).toBe("idle");
    for (const row of rows) expect(r.fetcher.isPending(row.id)).toBe(false);
    expect(r.redraws).toContainEqual({ ids: rows.map((row) => row.id), now: true });
    expect(vi.getTimerCount(), "the debounce is cleared").toBe(0);
  });

  it("a new key ends a refused-key pause, and redraws the held rows, with no paint", async () => {
    const r = rig({ watch: true });
    r.settings.key = "sk-old";
    r.answer = () => refusedKey();
    const row = makeItem();
    paint(r, [row]);
    await runPass();
    expect(r.fetcher.phase.name).toBe("paused");
    r.redraws.length = 0;

    r.settings.key = "sk-new";
    r.onSettingsChange?.();

    expect(r.fetcher.phase.name).toBe("idle");
    expect(redrawn(r).has(row.id)).toBe(true);
  });
});

describe("the auto-fetch setting it reads on each paint", () => {
  it("is read again after its TTL, and not before", () => {
    const r = rig();
    paint(r, [makeItem()]);
    paint(r, [makeItem()]);
    expect(r.readAutoFetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + AUTO_FETCH_PREF_TTL_MS + 1);
    paint(r, [makeItem()]);
    expect(r.readAutoFetch).toHaveBeenCalledTimes(2);
  });

  it("is read again when the clock was set back, instead of being trusted until the clock catches up", () => {
    const r = rig();
    paint(r, [makeItem()]);
    expect(r.readAutoFetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() - 60 * 60_000);
    r.settings.autoFetch = false;
    expect(r.fetcher.offer(makeItem(), STALE)).toBe(false);
    expect(r.readAutoFetch).toHaveBeenCalledTimes(2);
  });
});

describe("nextUtcMidnight", () => {
  it("is the start of the next UTC day", () => {
    expect(nextUtcMidnight(NOON_UTC)).toBe(Date.UTC(2026, 8, 29));
    expect(nextUtcMidnight(Date.UTC(2026, 11, 31, 23, 59))).toBe(Date.UTC(2027, 0, 1));
    expect(nextUtcMidnight(Date.UTC(2026, 8, 29))).toBe(Date.UTC(2026, 8, 30));
  });
});

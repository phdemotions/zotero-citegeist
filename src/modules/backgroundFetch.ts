/**
 * The item-tree columns' background lookups.
 *
 * With "Automatically fetch citation data" ticked, which is the default, a row
 * Zotero draws with missing or stale metrics is looked up on its own. One
 * fetcher serves one column registration: `registerCitationColumn` creates it
 * and `unregisterCitationColumn` stops it, so a pass left over from an earlier
 * registration can never touch the next one's state.
 *
 * The fetcher is a state machine with one state object. Its phase is always one
 * of:
 *
 * - `idle`: nothing queued;
 * - `scheduled`: rows queued, and the first batch starts when the debounce ends;
 * - `running`: a pass is working through the queue, a batch at a time, taking
 *   rows queued while it runs;
 * - `paused`: a result said the next lookups would fail the same way, so none
 *   start until the pause ends (see {@link pauseIsOver});
 * - `stopped`: the registration ended; nothing more happens.
 *
 * Every timer it sets is its own and is cleared by {@link BackgroundFetcher.stop}.
 * It never redraws a row itself: it names rows to `refreshRows`, which batches
 * them into one targeted redraw (citationColumn.ts).
 */

import { cacheWriteRefusalCode, type AllMetrics } from "./cache";
import {
  backgroundStopFor,
  canResolveWork,
  type BackgroundStop,
  type FetchResult,
} from "./citationService";
import { guard, logErrorUnlessBuffered } from "./diagnostics";
import { getCacheLifetimeDays } from "./prefs";
import {
  codeForError,
  logError,
  OpenAlexAuthError,
  OpenAlexBudgetError,
  OpenAlexNetworkError,
} from "./utils";
import {
  AUTO_FETCH_PREF_TTL_MS,
  BACKGROUND_ANONYMOUS_REFUSAL_PAUSE_MS,
  BACKGROUND_RETRY_MAX_MS,
  BACKGROUND_RETRY_MIN_MS,
  DEFAULT_CACHE_LIFETIME_DAYS,
  FETCH_BATCH_DELAY_MS,
  FETCH_BATCH_SIZE,
  FETCH_QUEUE_DEBOUNCE_MS,
  MAX_ATTEMPTED_FETCH_CACHE,
  MAX_HELD_ROWS,
} from "../constants";

type Item = _ZoteroTypes.Item;
type TimerHandle = ReturnType<typeof setTimeout>;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Why background lookups paused: a {@link BackgroundStop} one of their results
 * carried, or `"failed"` when a pass itself threw.
 */
export type PauseReason = BackgroundStop | "failed";

/** A pause, and what ends it. */
export interface PausedPhase {
  readonly name: "paused";
  readonly reason: PauseReason;
  /**
   * When the pause ends by time, in the fetcher's clock, or null when no time
   * ends it. A timer ends it then, and so does the first paint after it.
   */
  readonly until: number | null;
  /**
   * The API key the refused requests carried ("" for none), for a pause a
   * different key ends. Null when a key change does not end it.
   */
  readonly apiKey: string | null;
}

/** Where the fetcher is. See the module comment. */
export type FetcherPhase =
  | { readonly name: "idle" }
  | { readonly name: "scheduled" }
  | { readonly name: "running" }
  | PausedPhase
  | { readonly name: "stopped" };

/** What the fetcher needs from its host, so a test can supply every one of them. */
export interface BackgroundFetcherDeps {
  /** Look one item up by ID, identifier lookups only. Total: resolves, never rejects. */
  fetchItem(id: number): Promise<FetchResult>;
  /**
   * Redraw these rows' Citegeist cells. `now` asks for the redraw at once (the
   * end of a pass, a pause lifting) rather than at the batching's next turn.
   */
  refreshRows(ids: readonly number[], now: boolean): void;
  /** Whether "Automatically fetch citation data" is ticked. May throw. */
  readAutoFetch(): boolean;
  /** The API key a request built now would carry, "" for none. May throw. */
  readApiKey(): string;
  now(): number;
  setTimer(callback: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  /**
   * Subscribe `onChange` to changes of the auto-fetch and API-key settings, and
   * return the unsubscribe, which {@link BackgroundFetcher.stop} calls. Absent,
   * a change takes effect on the next paint instead.
   */
  watchSettings?(onChange: () => void): () => void;
}

export interface BackgroundFetcher {
  /**
   * Whether a lookup of this drawn row is queued or running: the cells show "…"
   * until it lands. Queues the lookup when one is due. Called on every paint of
   * every metric cell, so a row drawn again after a setting changed, or after a
   * pause ended, is queued then. See {@link isDue} for the rule.
   */
  offer(item: Item, metrics: AllMetrics): boolean;
  /** Whether a lookup of this row is queued or running. */
  isPending(id: number): boolean;
  /**
   * Re-read the auto-fetch and API-key settings now. Ticking auto-fetch redraws
   * the rows drawn while it was off, unticking it drops the queue, and a new key
   * ends a pause the old one caused. `watchSettings` calls it.
   */
  settingsChanged(): void;
  /**
   * Stop for good: clear every timer, drop the queue and unsubscribe from the
   * settings. Resolves once a running pass has ended, after the lookups it had
   * already started settle; the pass changes nothing after `stop`.
   */
  stop(): Promise<void>;
  readonly phase: FetcherPhase;
}

/** A value read from a setting, and when. */
interface Reading<T> {
  readonly value: T;
  readonly at: number;
}

/** An item the fetcher looked up without a result it could show, and when. */
interface Attempt {
  /** The {@link FetcherState.passNumber} it was looked up or last drawn in. */
  readonly pass: number;
  readonly at: number;
}

/** A pause a pass asked for, before it becomes the phase. */
interface PauseRequest {
  readonly reason: PauseReason;
  /** The error behind it, which its one diagnostic records. */
  readonly cause: unknown;
  /** The key the refused batch carried, read before the batch started. */
  readonly apiKey: string;
}

interface FetcherState {
  phase: FetcherPhase;
  /** Rows waiting for a lookup, oldest first. */
  readonly queue: Set<number>;
  /** Rows whose lookup is running. */
  readonly inFlight: Set<number>;
  /**
   * Rows looked up without data to show (OpenAlex did not know the identifier, or
   * a failure that is not transient), so a repaint does not queue them again.
   * In pass order, oldest first; bounded, see {@link rememberAttempt}. A row whose
   * lookup landed is not here: its fresh metrics keep it from being due, and once
   * they go stale again it is due again.
   */
  readonly attempted: Map<number, Attempt>;
  /**
   * Rows drawn while lookups were paused or switched off, redrawn when they
   * resume so they queue without a scroll. Newest last, at most MAX_HELD_ROWS.
   */
  readonly held: Set<number>;
  /**
   * How many passes have finished. A pass's lookups, and every paint from the
   * end of the previous pass until it ends, share one number.
   */
  passNumber: number;
  /** Consecutive transient pauses, which double the next one. */
  retryStreak: number;
  autoFetch: Reading<boolean> | null;
  cacheLifetimeMs: Reading<number> | null;
  /** The debounce timer while scheduled, or the resume timer while paused. */
  timer: TimerHandle | null;
  /** The wait between two batches, which `stop` cuts short. */
  nap: { readonly handle: TimerHandle; readonly wake: () => void } | null;
  /** The running pass, which `stop` hands back to wait on. */
  pass: Promise<void> | null;
  unwatch: (() => void) | null;
}

const IDLE: FetcherPhase = { name: "idle" };
const SCHEDULED: FetcherPhase = { name: "scheduled" };
const RUNNING: FetcherPhase = { name: "running" };
const STOPPED: FetcherPhase = { name: "stopped" };

/** Which stop wins when one batch meets several: the one that lasts longest. */
const PAUSE_PRECEDENCE: Readonly<Record<PauseReason, number>> = {
  "cache-unwritable": 4,
  auth: 3,
  budget: 2,
  transient: 1,
  failed: 0,
};

export function createBackgroundFetcher(deps: BackgroundFetcherDeps): BackgroundFetcher {
  const state: FetcherState = {
    phase: IDLE,
    queue: new Set(),
    inFlight: new Set(),
    attempted: new Map(),
    held: new Set(),
    passNumber: 0,
    retryStreak: 0,
    autoFetch: null,
    cacheLifetimeMs: null,
    timer: null,
    nap: null,
    pass: null,
    unwatch: null,
  };

  const stopped = (): boolean => state.phase.name === "stopped";

  // ── Settings ──────────────────────────────────────────────────────────────

  /**
   * A reading is stale past its TTL, and when the clock reads earlier than the
   * reading was taken: a clock set backwards must not freeze the value.
   */
  function expired(reading: Reading<unknown> | null, ttl: number): boolean {
    if (reading === null) return true;
    const now = deps.now();
    return now < reading.at || now - reading.at > ttl;
  }

  /** The auto-fetch setting, read again past AUTO_FETCH_PREF_TTL_MS. */
  function autoFetchOn(): boolean {
    const reading = state.autoFetch;
    if (reading !== null && !expired(reading, AUTO_FETCH_PREF_TTL_MS)) return reading.value;
    return readAutoFetchNow();
  }

  function readAutoFetchNow(): boolean {
    const value = deps.readAutoFetch();
    state.autoFetch = { value, at: deps.now() };
    return value;
  }

  /** The cache lifetime, which also ends an {@link Attempt}. */
  function cacheLifetimeMs(): number {
    const reading = state.cacheLifetimeMs;
    if (reading !== null && !expired(reading, AUTO_FETCH_PREF_TTL_MS)) return reading.value;
    let days = DEFAULT_CACHE_LIFETIME_DAYS;
    try {
      days = getCacheLifetimeDays();
    } catch {
      // Keep the default; the cache module reads the same setting the same way.
    }
    state.cacheLifetimeMs = { value: days * DAY_MS, at: deps.now() };
    return state.cacheLifetimeMs.value;
  }

  /** The key a request would carry now, or `fallback` when it cannot be read. */
  function currentKey(fallback: string): string {
    try {
      return deps.readApiKey();
    } catch {
      return fallback;
    }
  }

  // ── The paint rule ────────────────────────────────────────────────────────

  /**
   * Whether this drawn row is due a lookup, the one rule behind both queueing a
   * row and drawing "…" in its cells, so a cell never promises a lookup the
   * queue will not make. All of these hold:
   *
   * - its cached metrics are missing or stale;
   * - the fetcher has not looked it up without result in the last cache
   *   lifetime ({@link stillAttempted});
   * - it is a library item, not a feed item (feedItem.js@10.0.2 lines 44-46
   *   define `isFeedItem`), and not in the trash;
   * - it resolves to a work without a title search: a DOI, PMID, arXiv ID or
   *   ISBN, or an OpenAlex ID the user confirmed ({@link canResolveWork}). The
   *   30-day hold-off after a title search found nothing does not apply: it
   *   holds off the metered search, and these lookups are free and would find
   *   a DOI added since;
   * - the cache takes writes;
   * - "Automatically fetch citation data" is ticked;
   * - lookups are not paused.
   *
   * A row that fails only the last two is held, and redrawn when they pass.
   */
  function isDue(item: Item, metrics: AllMetrics): boolean {
    if (!metrics.isStale) return false;
    if (stillAttempted(item.id)) return false;
    if (item.deleted || (item as { isFeedItem?: unknown }).isFeedItem === true) return false;
    if (!canResolveWork(item)) return false;
    if (cacheWriteRefusalCode() !== null) return false;
    if (!autoFetchOn()) {
      hold(item.id);
      return false;
    }
    const phase = state.phase;
    if (phase.name === "paused") {
      if (!pauseIsOver(phase)) {
        hold(item.id);
        return false;
      }
      resume();
    }
    return true;
  }

  /**
   * Whether an attempt still keeps the row from being queued. It lapses after
   * one cache lifetime, as cached data goes stale, so a long session looks the
   * row up again; and when the clock reads earlier than the attempt, since the
   * clock can no longer say how old it is. Drawn and kept, it moves into the
   * current pass (see {@link rememberAttempt}).
   */
  function stillAttempted(id: number): boolean {
    const attempt = state.attempted.get(id);
    if (attempt === undefined) return false;
    const now = deps.now();
    if (now < attempt.at || now - attempt.at >= cacheLifetimeMs()) {
      state.attempted.delete(id);
      return false;
    }
    if (attempt.pass !== state.passNumber) {
      state.attempted.delete(id);
      state.attempted.set(id, { pass: state.passNumber, at: attempt.at });
    }
    return true;
  }

  /**
   * Remember that a row was looked up without result, in the current pass.
   *
   * Past MAX_ATTEMPTED_FETCH_CACHE entries the oldest are forgotten, and only
   * those can be looked up again; clearing the whole map would re-run every
   * earlier lookup on the next repaint. An entry of the current pass is never
   * forgotten: a row this pass looked up, or a stale row drawn since the last
   * pass ended. Each pass ends by redrawing its rows, and sorting by a Citegeist
   * column draws every row, so forgetting a row that redraw draws would queue it
   * again, and a library with more such rows than the cap would look the
   * overflow up again on every pass, all session. The map therefore holds at most
   * MAX_ATTEMPTED_FETCH_CACHE entries, or as many as one pass touched when that
   * is more: never more than the rows Zotero's item trees hold.
   */
  function rememberAttempt(id: number): void {
    const { attempted, passNumber } = state;
    attempted.delete(id);
    attempted.set(id, { pass: passNumber, at: deps.now() });
    for (const [oldest, attempt] of attempted) {
      if (attempted.size <= MAX_ATTEMPTED_FETCH_CACHE || attempt.pass === passNumber) break;
      attempted.delete(oldest);
    }
  }

  /** Keep a row to redraw when lookups resume, newest last. */
  function hold(id: number): void {
    state.held.delete(id);
    state.held.add(id);
    if (state.held.size > MAX_HELD_ROWS) {
      const oldest = state.held.values().next().value;
      if (oldest !== undefined) state.held.delete(oldest);
    }
  }

  function redrawHeld(): void {
    if (state.held.size === 0) return;
    const ids = [...state.held];
    state.held.clear();
    deps.refreshRows(ids, true);
  }

  // ── Pauses ────────────────────────────────────────────────────────────────

  /**
   * Whether a pause has ended:
   *
   * - a refused key (CG-API01) when the key changes, cleared included; a refusal
   *   of a request that carried no key also at `until`;
   * - a spent budget (CG-API42) when the key changes, or at `until`, the next
   *   midnight UTC, when OpenAlex's daily allowance starts over;
   * - network trouble, or a pass that threw, at `until`, the end of its cool-down;
   * - a cache that refuses writes: never, until the registration ends.
   */
  function pauseIsOver(phase: PausedPhase): boolean {
    if (phase.reason === "cache-unwritable") return false;
    if (phase.apiKey !== null && currentKey(phase.apiKey) !== phase.apiKey) return true;
    return phase.until !== null && deps.now() >= phase.until;
  }

  /** End a pause: back to idle, and redraw the rows it held so they queue. */
  function resume(): void {
    clearPhaseTimer();
    state.phase = IDLE;
    redrawHeld();
  }

  function enterPause(request: PauseRequest): void {
    const now = deps.now();
    const phase = pausedPhase(request, now);
    state.phase = phase;
    recordPause(request);
    // The key may have changed while the refused batch was in flight.
    if (pauseIsOver(phase)) {
      resume();
      return;
    }
    if (phase.until !== null) {
      state.timer = deps.setTimer(
        () =>
          guard("background lookups: resume", () => {
            state.timer = null;
            if (state.phase === phase) resume();
          }),
        Math.max(0, phase.until - now),
      );
    }
  }

  function pausedPhase(request: PauseRequest, now: number): PausedPhase {
    switch (request.reason) {
      case "auth":
        return {
          name: "paused",
          reason: "auth",
          apiKey: request.apiKey,
          until: request.apiKey === "" ? now + BACKGROUND_ANONYMOUS_REFUSAL_PAUSE_MS : null,
        };
      case "budget":
        return {
          name: "paused",
          reason: "budget",
          apiKey: request.apiKey,
          until: nextUtcMidnight(now),
        };
      case "cache-unwritable":
        return { name: "paused", reason: "cache-unwritable", apiKey: null, until: null };
      case "transient":
      case "failed": {
        const coolDown = Math.min(
          BACKGROUND_RETRY_MAX_MS,
          BACKGROUND_RETRY_MIN_MS * 2 ** state.retryStreak,
        );
        state.retryStreak++;
        return { name: "paused", reason: request.reason, apiKey: null, until: now + coolDown };
      }
    }
  }

  /**
   * Record one diagnostic for the pause, with the error behind it. A cache that
   * refuses writes records none, because the write gate already recorded why,
   * and a pass that threw recorded its error as it threw. Network trouble is
   * recorded only while the buffer does not hold the same entry, so an outage
   * that pauses lookups again and again stays one entry.
   */
  function recordPause(request: PauseRequest): void {
    switch (request.reason) {
      case "auth":
        logError(
          request.apiKey === ""
            ? "background lookups paused: OpenAlex refused a request without an API key"
            : "background lookups paused until the OpenAlex API key changes",
          request.cause ?? new OpenAlexAuthError(),
        );
        return;
      case "budget":
        logError(
          "background lookups paused until the API key changes or the day ends (UTC)",
          request.cause ?? new OpenAlexBudgetError(),
        );
        return;
      case "transient":
        logErrorUnlessBuffered(
          "background lookups paused: OpenAlex is unreachable or overloaded",
          request.cause ?? new OpenAlexNetworkError("OpenAlex unreachable"),
        );
        return;
      case "cache-unwritable":
      case "failed":
        return;
    }
  }

  function clearPhaseTimer(): void {
    if (state.timer !== null) {
      deps.clearTimer(state.timer);
      state.timer = null;
    }
  }

  // ── Passes ────────────────────────────────────────────────────────────────

  function enqueue(id: number): void {
    state.queue.add(id);
    if (state.phase.name !== "idle") return;
    state.phase = SCHEDULED;
    state.timer = deps.setTimer(
      () => guard("background lookups: start", startPass),
      FETCH_QUEUE_DEBOUNCE_MS,
    );
  }

  function startPass(): void {
    state.timer = null;
    if (state.phase.name !== "scheduled") return;
    state.phase = RUNNING;
    const pass = runPass();
    state.pass = pass;
    void pass.then(() => {
      if (state.pass === pass) state.pass = null;
    });
  }

  /**
   * Work through the queue a batch at a time, including rows queued while it
   * runs. It ends when the queue empties, when "Automatically fetch citation
   * data" is unticked (read at every batch, past its cache), when a result
   * pauses lookups, or when it throws. However it ends, the rows still queued
   * are dropped and redrawn, so none keeps showing "…". Never rejects.
   */
  async function runPass(): Promise<void> {
    let pause: PauseRequest | null = null;
    try {
      while (state.queue.size > 0) {
        if (!readAutoFetchNow()) break;
        const batch = takeFromQueue(FETCH_BATCH_SIZE);
        // The key the batch's requests carry: each builds its URL before its
        // first await, so a key read after the batch could be a newer one.
        const carriedKey = currentKey("");
        for (const id of batch) state.inFlight.add(id);
        const results = await Promise.all(batch.map(lookUp));
        if (stopped()) return;
        pause = settleBatch(batch, results, carriedKey);
        if (pause !== null) break;
        if (state.queue.size > 0) await nap(FETCH_BATCH_DELAY_MS);
        if (stopped()) return;
      }
    } catch (e) {
      if (stopped()) return;
      logError("background lookups: pass failed", e);
      pause = { reason: "failed", cause: e, apiKey: "" };
    } finally {
      if (!stopped()) endPass(pause);
    }
  }

  /** Remove up to `count` rows from the front of the queue. */
  function takeFromQueue(count: number): number[] {
    const batch: number[] = [];
    for (const id of state.queue) {
      if (batch.length === count) break;
      batch.push(id);
    }
    for (const id of batch) state.queue.delete(id);
    return batch;
  }

  /** One lookup. `fetchItem` is total; a throw anyway becomes an error result. */
  async function lookUp(id: number): Promise<FetchResult> {
    try {
      return await deps.fetchItem(id);
    } catch (e) {
      logError("background lookup", e);
      return { status: "error", error: "unexpected", code: codeForError(e), cause: e };
    } finally {
      state.inFlight.delete(id);
    }
  }

  /**
   * Take in a batch's results: remember the rows it looked up without result,
   * hold the rows a stop cut short, and redraw them all. Returns the pause a stop
   * asks for, or null to go on.
   *
   * A stop (a refused key, a spent budget, an unwritable cache, network trouble)
   * says nothing about the row, so the row is not remembered: it is looked up
   * once lookups resume. Neither is a row trashed while queued ("invalid-item"),
   * nor one whose data landed or was already fresh.
   */
  function settleBatch(
    batch: readonly number[],
    results: readonly FetchResult[],
    carriedKey: string,
  ): PauseRequest | null {
    let pause: PauseRequest | null = null;
    for (let i = 0; i < batch.length; i++) {
      const id = batch[i];
      const result = results[i];
      const stop = backgroundStopFor(result);
      if (stop !== null) {
        hold(id);
        if (pause === null || PAUSE_PRECEDENCE[stop] > PAUSE_PRECEDENCE[pause.reason]) {
          pause = { reason: stop, cause: causeOf(result), apiKey: carriedKey };
        }
      } else if (isConclusive(result)) {
        rememberAttempt(id);
      }
    }
    if (pause === null) state.retryStreak = 0;
    deps.refreshRows(batch, false);
    return pause;
  }

  /** Drop what is still queued, count the pass, pause if asked, and send the pass's last redraw. */
  function endPass(pause: PauseRequest | null): void {
    try {
      const dropped = [...state.queue];
      state.queue.clear();
      for (const id of dropped) hold(id);
      state.passNumber++;
      if (pause !== null) enterPause(pause);
      else state.phase = IDLE;
      deps.refreshRows(dropped, true);
    } catch (e) {
      logError("background lookups: end of pass", e);
      state.phase = IDLE;
    }
  }

  /** Wait between two batches; `stop` wakes it early. */
  function nap(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const handle = deps.setTimer(() => {
        state.nap = null;
        resolve();
      }, ms);
      state.nap = { handle, wake: resolve };
    });
  }

  // ── The fetcher ───────────────────────────────────────────────────────────

  const fetcher: BackgroundFetcher = {
    offer(item, metrics) {
      if (stopped()) return false;
      if (state.queue.has(item.id) || state.inFlight.has(item.id)) return true;
      if (!isDue(item, metrics)) return false;
      enqueue(item.id);
      return true;
    },

    isPending(id) {
      return state.queue.has(id) || state.inFlight.has(id);
    },

    settingsChanged() {
      if (stopped()) return;
      guard("background lookups: settings changed", () => {
        if (!readAutoFetchNow()) {
          // A running pass drops the rest at its next batch; drop them now.
          const dropped = [...state.queue];
          state.queue.clear();
          for (const id of dropped) hold(id);
          if (state.phase.name === "scheduled") {
            clearPhaseTimer();
            state.phase = IDLE;
          }
          deps.refreshRows(dropped, true);
          return;
        }
        const phase = state.phase;
        if (phase.name === "paused") {
          if (pauseIsOver(phase)) resume();
          return;
        }
        redrawHeld();
      });
    },

    stop() {
      if (!stopped()) {
        state.phase = STOPPED;
        clearPhaseTimer();
        const nap = state.nap;
        state.nap = null;
        if (nap !== null) {
          deps.clearTimer(nap.handle);
          nap.wake();
        }
        state.queue.clear();
        state.held.clear();
        state.attempted.clear();
        const unwatch = state.unwatch;
        state.unwatch = null;
        if (unwatch !== null) guard("background lookups: unwatch settings", unwatch);
      }
      return state.pass ?? Promise.resolve();
    },

    get phase() {
      return state.phase;
    },
  };

  if (deps.watchSettings) {
    const watch = deps.watchSettings;
    state.unwatch =
      guard("background lookups: watch settings", () => watch(() => fetcher.settingsChanged())) ??
      null;
  }

  return fetcher;
}

/** The error a result carries, for the pause's diagnostic. */
function causeOf(result: FetchResult): unknown {
  return result.status === "error" ? result.cause : undefined;
}

/**
 * Whether a result that is no stop ends the row's lookup without data to show,
 * so it is remembered as looked up: OpenAlex did not know the identifier, or a
 * failure a retry would repeat. Data that landed, data that was already fresh
 * and a row trashed while queued ("invalid-item") are not.
 */
function isConclusive(result: FetchResult): boolean {
  if (result.status === "ok" || result.status === "cached") return false;
  return !(result.status === "error" && result.error === "invalid-item");
}

/** The next midnight UTC after `now`: when OpenAlex's daily allowance starts over. */
export function nextUtcMidnight(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

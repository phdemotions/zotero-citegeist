/**
 * The batch commands behind the right-click menus: gather what the user
 * selected, keep the items Citegeist can resolve to a work, run the batch under a
 * progress window, and summarize what happened.
 *
 * Each command is one {@link BatchAction}, and two runners drive every action:
 * {@link runOnItems} for the item menu's selection and {@link runOnTargets} for
 * the collection menu's collections and libraries. How a batch starts, reports
 * progress, fails or finishes is written once, in the runners, and reaches all
 * four commands.
 */

import {
  canResolveWork,
  fetchAndCacheItems,
  resolveAuthorsForItems,
  type AuthorBackfillResult,
  type FetchBatchResult,
} from "../citationService";
import { invalidateColumnCache } from "../citationColumn";
import type { CollectionTarget } from "../host/selection";
import { logError } from "../utils";
import {
  CACHE_READ_ONLY_HEADLINE,
  PROGRESS_WINDOW_DONE_CLOSE_MS,
  PROGRESS_WINDOW_ERROR_CLOSE_MS,
} from "../../constants";
import { menuIconURL } from "./icons";

type Item = _ZoteroTypes.Item;

/** One batch command, as the runners drive it. */
export interface BatchAction<R> {
  /** Prefix of the command's diagnostic contexts, e.g. "menu fetch". */
  readonly context: string;
  /** Progress-window headline. */
  readonly headline: string;
  /** Alert title when the selection holds nothing the command can act on. */
  readonly nothingToDo: string;
  /** Alert body when no item resolves, given how to name the items ("the 2 selected items"). */
  nothingEligible(items: string): string;
  /** Progress line once the eligible items are known. */
  starting(count: number): string;
  /** Progress line after `current` of `total` items. */
  progress(current: number, total: number): string;
  /** Last line when the batch throws. */
  readonly failed: string;
  run(items: Item[], onProgress: (current: number, total: number) => void): Promise<R>;
  /** Last line when the batch finishes. */
  summarize(result: R, total: number): string;
}

/**
 * Fetch citation data for `items` and repaint their columns: each row as its
 * data lands, so a long fetch fills in progressively, then every row once the
 * batch ends. A repaint that fails is recorded and does not fail the fetch.
 *
 * The menu's fetch commands and the `Zotero.Citegeist` bridge both run this, so
 * the real-Zotero suite exercises the fetch a user starts from the menu.
 */
export async function fetchItemsAndRepaint(
  items: Item[],
  onProgress?: (current: number, total: number) => void,
): Promise<FetchBatchResult> {
  const result = await fetchAndCacheItems(items, onProgress, (itemId, status) => {
    if (status === "ok" || status === "suggestion") void invalidateColumnCache(itemId);
  });
  if (items.length > 0) {
    try {
      await invalidateColumnCache(items.map((item) => item.id));
    } catch (e) {
      logError("batch fetch column repaint", e);
    }
  }
  return result;
}

export const FETCH_CITATIONS: BatchAction<FetchBatchResult> = {
  context: "menu fetch",
  headline: "Citegeist: Fetching Citations",
  nothingToDo: "Citegeist: Nothing to fetch",
  nothingEligible: (items) =>
    `None of ${items} has a recognized identifier (DOI, PMID, arXiv ID, or ISBN). Add an identifier to the items you want citation data for, then try again.`,
  starting: (count) => `Fetching ${itemCount(count)}…`,
  progress: (current, total) => `${current}/${total} items fetched`,
  failed: "Citegeist: fetch failed — see Debug Output",
  run: (items, onProgress) => fetchItemsAndRepaint(items, onProgress),
  summarize: summarizeFetch,
};

export const RESOLVE_AUTHORS: BatchAction<AuthorBackfillResult> = {
  context: "menu resolve-authors",
  headline: "Citegeist: Resolving Author Identities",
  nothingToDo: "Citegeist: Nothing to resolve",
  nothingEligible: (items) =>
    `None of ${items} has a recognized identifier to resolve authors from.`,
  starting: (count) => `Resolving authors for ${itemCount(count)}…`,
  progress: (current, total) => `${current}/${total} items processed`,
  failed: "Citegeist: resolve failed — see Debug Output",
  run: (items, onProgress) => resolveAuthorsForItems(items, onProgress),
  summarize: summarizeAuthorBackfill,
};

/**
 * Run `action` on `items`, the selection in the window the menu opened in.
 *
 * Total: a failure is recorded under the action's context, never thrown into
 * the menu handler.
 */
export async function runOnItems<R>(
  win: Window,
  items: readonly Item[],
  action: BatchAction<R>,
): Promise<void> {
  try {
    if (items.length === 0) return;
    const eligible = items.filter(canResolveWork);
    // The entry is hidden for such a selection, but one that changed while the
    // menu was open can still land here, and a silent no-op reads as broken.
    if (eligible.length === 0) {
      alertIn(
        win,
        action.nothingToDo,
        action.nothingEligible(`the ${itemCount(items.length, "selected ")}`),
      );
      return;
    }
    await withProgressWindow(win, action.headline, action.starting(eligible.length), (ui) =>
      runWithProgress(ui, eligible, action, action.context),
    );
  } catch (e) {
    logError(action.context, e);
  }
}

/**
 * Run `action` on every item under `targets`, the collections or libraries
 * selected in the window the menu opened in, each item once.
 *
 * The progress window opens before the items are gathered, so a large selection
 * shows "Gathering items…" instead of nothing while Zotero loads it. Total, like
 * {@link runOnItems}.
 */
export async function runOnTargets<R>(
  win: Window,
  targets: readonly CollectionTarget[],
  action: BatchAction<R>,
): Promise<void> {
  const context = `${action.context}-collection`;
  try {
    await withProgressWindow(win, action.headline, "Gathering items…", async (ui) => {
      let gathered: Map<number, Item>;
      try {
        gathered = await gatherTargetItems(targets);
      } catch (e) {
        logError(`${context} gather`, e);
        ui.finish(action.failed, PROGRESS_WINDOW_ERROR_CLOSE_MS);
        return;
      }
      const eligible = [...gathered.values()].filter(canResolveWork);
      // A modal alert, not the progress window's easily missed corner line, so
      // an empty result is unambiguous and says why.
      if (eligible.length === 0) {
        ui.close();
        alertIn(
          win,
          action.nothingToDo,
          gathered.size === 0
            ? emptySelectionMessage(targets)
            : action.nothingEligible(
                `the ${itemCount(gathered.size)} in ${selectionPhrase(targets)}`,
              ),
        );
        return;
      }
      ui.progress.setText(action.starting(eligible.length));
      await runWithProgress(ui, eligible, action, context);
    });
  } catch (e) {
    logError(context, e);
  }
}

// ── Progress windows ─────────────────────────────────────────────────────────

/** What a runner reports into while its progress window is open. */
interface ProgressUI {
  readonly progress: _ZoteroTypes.ProgressWindowItem;
  /** Fill the bar, show `text` as the last line, and close the window after `closeMs`. */
  finish(text: string, closeMs: number): void;
  /** Close the window at once, before an alert takes its place. */
  close(): void;
}

/**
 * Open a progress window for `win`, run `work` with it, and make sure it closes.
 *
 * `work` closes the window itself on every path it expects. The `finally` covers
 * the path it doesn't: a throw once the window is up, such as the eligibility
 * check failing under "Gathering items…", would otherwise leave that line on
 * screen for good.
 */
async function withProgressWindow(
  win: Window,
  headline: string,
  initialText: string,
  work: (ui: ProgressUI) => Promise<void>,
): Promise<void> {
  const progressWin = new Zotero.ProgressWindow({ window: openWindow(win), closeOnClick: false });
  progressWin.changeHeadline(headline);
  // Explicit-colour PNG: the SVG's `context-fill` does not resolve inside a
  // ProgressWindow, and Zotero falls back to its red loading curve, which reads
  // as an error.
  const progress = new progressWin.ItemProgress(menuIconURL("icon-16-color.png"), initialText);
  progressWin.show();

  let closing = false;
  const ui: ProgressUI = {
    progress,
    finish(text, closeMs) {
      progress.setProgress(100);
      progress.setText(text);
      progressWin.startCloseTimer(closeMs);
      closing = true;
    },
    close() {
      progressWin.close();
      closing = true;
    },
  };
  try {
    await work(ui);
  } finally {
    if (!closing) progressWin.close();
  }
}

/** Run `action` on `eligible` and report the outcome in `ui`. */
async function runWithProgress<R>(
  ui: ProgressUI,
  eligible: Item[],
  action: BatchAction<R>,
  context: string,
): Promise<void> {
  let result: R;
  try {
    result = await action.run(eligible, (current, total) => {
      ui.progress.setProgress((current / total) * 100);
      ui.progress.setText(action.progress(current, total));
    });
  } catch (e) {
    logError(`${context} batch`, e);
    ui.finish(action.failed, PROGRESS_WINDOW_ERROR_CLOSE_MS);
    return;
  }
  ui.finish(action.summarize(result, eligible.length), PROGRESS_WINDOW_DONE_CLOSE_MS);
}

/**
 * The window a progress window or alert attaches to: `win`, the window the menu
 * opened in, unless it has closed since the command started. A batch outlives
 * its window easily (gathering a library takes a while), and a closed window is
 * no parent for a dialog.
 */
function openWindow(win: Window): Window {
  return win.closed ? Zotero.getMainWindow() : win;
}

function alertIn(win: Window, title: string, body: string): void {
  Services.prompt.alert(openWindow(win), title, body);
}

// ── Gathering ────────────────────────────────────────────────────────────────

/** Every item under the targets, each ID once. A library target covers its whole library. */
async function gatherTargetItems(targets: readonly CollectionTarget[]): Promise<Map<number, Item>> {
  const out = new Map<number, Item>();
  for (const target of targets) {
    if (target.kind === "collection") {
      gatherCollectionItems(target.collection, out);
    } else {
      for (const item of await Zotero.Items.getAll(target.libraryID, false)) {
        out.set(item.id, item);
      }
    }
    // Hand the event loop back between targets, so the progress window paints
    // and Zotero stays responsive while a large selection loads.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return out;
}

/** Add a collection's items, and its subcollections' items, to `out`. */
function gatherCollectionItems(col: _ZoteroTypes.Collection, out: Map<number, Item>): void {
  for (const item of col.getChildItems()) {
    if (!out.has(item.id)) out.set(item.id, item);
  }
  for (const child of col.getChildCollections()) {
    gatherCollectionItems(child, out);
  }
}

// ── Copy ─────────────────────────────────────────────────────────────────────

/** "1 item", "2 selected items". */
function itemCount(count: number, adjective = ""): string {
  return `${count} ${adjective}item${count === 1 ? "" : "s"}`;
}

/**
 * How the alerts name what was right-clicked: "this collection", "these 2
 * collections", "this library" or "these 2 libraries". Targets never mix the two:
 * `host/selection.ts` refuses that selection.
 */
function selectionPhrase(targets: readonly CollectionTarget[]): string {
  const libraries = targets.every((t) => t.kind === "library");
  if (targets.length === 1) return libraries ? "this library" : "this collection";
  return `these ${targets.length} ${libraries ? "libraries" : "collections"}`;
}

/** "This collection is empty." / "These 2 collections are empty." */
function emptySelectionMessage(targets: readonly CollectionTarget[]): string {
  const phrase = selectionPhrase(targets);
  const verb = targets.length === 1 ? "is" : "are";
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)} ${verb} empty.`;
}

/**
 * One line for a finished fetch. Each outcome is named, including each reason a
 * pass stopped early, so a pass the cache refused never reads as "N processed",
 * and items still fresh from auto-fetch read as "already up to date" rather than
 * "0 updated".
 */
function summarizeFetch(r: FetchBatchResult, total: number): string {
  const parts: string[] = [];
  if (r.fresh > 0) parts.push(`${r.fresh} updated`);
  if (r.cached > 0) parts.push(`${r.cached} already up to date`);
  if (r.suggestion > 0) parts.push(`${r.suggestion} need confirmation`);
  if (r.errors > 0) parts.push(`${r.errors} couldn't be matched`);
  if (r.budgetStopped > 0) parts.push(`${r.budgetStopped} skipped (daily budget spent)`);
  if (r.authStopped > 0) parts.push(`${r.authStopped} skipped (check your API key in settings)`);
  const unwritable = r.unwritableStopped ?? 0;
  if (unwritable > 0) parts.push(`${unwritable} skipped (${unwritableReason(r)})`);
  if (parts.length === 0) parts.push(`${total} processed`);
  return `Done — ${parts.join(", ")}`;
}

/**
 * One line for a finished author backfill. A spent budget stays distinct from a
 * genuine no-match, so it never reads as "no authors found".
 */
function summarizeAuthorBackfill(r: AuthorBackfillResult, total: number): string {
  const parts: string[] = [];
  if (r.resolved > 0) parts.push(`${r.resolved} resolved`);
  if (r.already > 0) parts.push(`${r.already} already linked`);
  if (r.unresolved > 0) parts.push(`${r.unresolved} no author match`);
  if (r.budgetStopped > 0) parts.push(`${r.budgetStopped} skipped (daily budget spent)`);
  if (r.authStopped > 0) parts.push(`${r.authStopped} skipped (check your API key in settings)`);
  if (r.unwritableStopped > 0)
    parts.push(`${r.unwritableStopped} skipped (${unwritableReason(r)})`);
  if (r.errors > 0) parts.push(`${r.errors} failed`);
  if (parts.length === 0) parts.push(`${total} processed`);
  const head = r.cancelled ? "Stopped" : "Done";
  return `${head} — ${parts.join(", ")}`;
}

/**
 * Why the cache refused the rest of a pass, by the refusal code the result
 * carries. A closed cache (CG-DB02) says so. A read-only cache (CG-DB03, CG-DB04),
 * or a result that names no code, gets the words of the startup notice.
 */
function unwritableReason(result: FetchBatchResult | AuthorBackfillResult): string {
  return refusalCode(result) === "CG-DB02"
    ? "Citegeist's local database is closed; restart Zotero"
    : CACHE_READ_ONLY_HEADLINE;
}

/**
 * The refusal code on a batch result, read defensively: the field is `code`, and
 * a result built before the service reported it has none.
 */
function refusalCode(result: object): unknown {
  return (result as { code?: unknown }).code;
}

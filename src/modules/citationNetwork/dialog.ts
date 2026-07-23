/**
 * Citation Network Browser — dialog orchestrator.
 *
 * Opens a modal showing works that cite or are cited by the selected item.
 * Each row shows title (linked to DOI), authors, year, journal, citation
 * count, OA/retracted badges. Click a row to expand its abstract.
 * One-click split button per row: main click adds to default collection,
 * triangle opens a per-item collection picker. Items already in library get a
 * "File triangle" button to manage collection membership.
 *
 * Performance:
 *  - Event delegation bound once on the body element (survives re-renders)
 *  - Expand/collapse uses targeted DOM insertion, not full re-render
 *  - Abstracts fetched on-demand and cached
 */

import { resolveWorkForItem, canResolveWork } from "../citationService";
import { getAllCachedOpenAlexIds } from "../cache";
import { escapeHTML, safeInnerHTML, codeForError, logError } from "../utils";
import {
  bindGuarded,
  buildDiagnosticElement,
  describeCode,
  type DiagnosticCode,
} from "../diagnostics";
import {
  SEARCH_DEBOUNCE_MS,
  INFINITE_SCROLL_THRESHOLD_PX,
  SKELETON_ROW_COUNT,
} from "../../constants";
import type { NetworkMode, NetworkSortKey, NetworkState } from "./types";
import { getDialogCSS } from "./styles";
import { loadResults, renderResults, toggleExpanded } from "./results";
import { handleAdd, handleUndo, getExistingDOIs } from "./actions";
import {
  toggleItemPicker,
  closeOpenPickers,
  initDefaultCollectionPicker,
  updateDefaultCollectionLabel,
  buildCollectionTree,
} from "./collectionPicker";
import { resolveHostScheme } from "../ui/theme";
import { fetchAuthorProfile, type OpenAlexAuthorProfile } from "../openalexAuthors";
import {
  buildProfileViewModel,
  persistProfileMetrics,
  maybeReconcileMerge,
  type ProfileViewModel,
} from "../authorProfile";

export let activeDialog: HTMLElement | null = null;
/**
 * Active dialog's state, tracked alongside `activeDialog` so a stacked
 * open can run the FULL `closeDialog(state)` cleanup (undo timers, picker
 * overlays, addedThisSession finalization) — not just remove the DOM
 * node. Without this, dispatching the `citegeist:dialog-closed` event
 * fired into a void: no listener cleared state, undo timers kept running
 * against detached DOM, and items added with pending undo were
 * silently committed. (ADV-U1)
 */
let activeState: NetworkState | null = null;

/**
 * Monotonic open counter, bumped synchronously by BOTH entry points right after
 * closeActiveDialog(). showAuthorWorks captures it before its pre-shell identity
 * fetch and bails if a newer open (either entry) supersedes it while that await
 * is in flight — without it, a double-click on an author row (or a
 * Citing/References click during the fetch) stacks a second modal and orphans
 * the first, defeating the ADV-U1 undo-timer cleanup. showCitationNetwork claims
 * `activeDialog` synchronously, so its own post-await guard already covers it; it
 * only bumps the counter so it can supersede an in-flight showAuthorWorks.
 */
let dialogOpenSeq = 0;

/**
 * Fully tear down whatever dialog is currently open before a stacked open. Runs
 * the SAME cleanup the Close button would (undo timers, picker overlays, search
 * debounce) via `closeDialog` when the state object exists; otherwise the first
 * dialog is still in its early-skeleton phase, so we dispatch the close event
 * (for the `markClosed` listener) and drop the overlay. (ADV-U1) Shared by both
 * entry points so the two can never diverge on this teardown.
 */
function closeActiveDialog(): void {
  if (!activeDialog) return;
  if (activeState) {
    try {
      closeDialog(activeState);
    } catch {
      // Defensive — closeDialog only does DOM remove + Map.clear + Set.clear.
    }
    activeState = null;
  } else {
    try {
      activeDialog.dispatchEvent(new Event("citegeist:dialog-closed"));
    } catch {
      /* event dispatch can throw in rare XUL contexts */
    }
    try {
      activeDialog.remove();
    } catch {
      /* already gone */
    }
  }
  activeDialog = null;
}

/**
 * Create the modal overlay + dialog element with the host-forced theme and the
 * initial inner HTML, and prepend the stylesheet. Returns them un-attached (the
 * caller appends to the parent + sets `activeDialog`). Shared by both entries so
 * the surface chrome, theme forcing, and stylesheet wiring stay identical.
 */
function createDialogShell(
  win: Window,
  initialHTML: string,
  ariaLabel: string,
): { overlay: HTMLDivElement; dialog: HTMLDivElement } {
  const doc = win.document;
  // Force the host (Zotero) theme so light-dark() tokens don't follow the OS.
  const scheme = resolveHostScheme(win);
  const isDark = scheme === "dark";

  const overlay = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
  overlay.id = "citegeist-network-overlay";
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.45);
    display: flex; align-items: center; justify-content: center;
    z-index: 10000;
  `;

  const dialog = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
  dialog.id = "citegeist-network-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", ariaLabel);
  dialog.style.cssText = `
    width: 780px; max-width: 90vw; max-height: 82vh;
    padding: 0; border: 1px solid rgba(128,128,128,0.1);
    border-radius: 12px;
    /* Force the host theme so light-dark() tokens resolve to Zotero's theme,
       not the OS appearance, regardless of the main window's color-scheme. */
    color-scheme: ${scheme};
    /* Pre-stylesheet placeholder (matches the --cg-surface/--cg-text arms for
       this theme); getDialogCSS() immediately takes over with the tokens. */
    background: ${isDark ? "#141D18" : "#F8FAF9"}; color: ${isDark ? "#E7EEE9" : "#1A2820"};
    box-shadow: 0 20px 40px rgba(0,0,0,0.5), 0 0 1px rgba(128,128,128,0.1);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px; line-height: 1.4;
    display: flex; flex-direction: column; overflow: hidden;
  `;

  safeInnerHTML(dialog, initialHTML);

  const styleEl = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
  styleEl.textContent = getDialogCSS();
  dialog.insertBefore(styleEl, dialog.firstChild);

  overlay.appendChild(dialog);
  return { overlay, dialog };
}

// ────────────────────────────────────────────────────────
// Entry point
// ────────────────────────────────────────────────────────

/**
 * Paint the loading skeleton into the dialog body. Shared by both entry points
 * (citation network and author works) so the row markup lives in one place.
 */
function renderSkeletonRows(body: HTMLElement): void {
  let skeleton = "";
  for (let i = 0; i < SKELETON_ROW_COUNT; i++) {
    skeleton += `<div class="cg-skeleton-row">
        <div class="cg-skeleton-content">
          <div class="cg-skeleton-bar cg-skeleton-title"></div>
          <div class="cg-skeleton-bar cg-skeleton-meta"></div>
          <div class="cg-skeleton-bar cg-skeleton-meta2"></div>
        </div>
        <div class="cg-skeleton-bar cg-skeleton-right"></div>
      </div>`;
  }
  safeInnerHTML(body, skeleton);
}

/**
 * Render the coded failure block into the dialog body.
 *
 * The block itself comes from the shared renderer so the dialog and the item
 * pane present a failure identically; only the surrounding layout is
 * dialog-specific (left-aligned and measure-capped, unlike the centred
 * one-line empty states).
 */
function renderDialogDiagnostic(body: HTMLElement, code: DiagnosticCode, context: string): void {
  const doc = body.ownerDocument;
  body.innerHTML = "";
  const wrap = doc.createElement("div");
  wrap.className = "cg-empty cg-empty--diag";
  wrap.appendChild(buildDiagnosticElement(doc, code, context));
  body.appendChild(wrap);
}

export async function showCitationNetwork(
  item: _ZoteroTypes.Item,
  mode: NetworkMode,
): Promise<void> {
  Zotero.debug(`[Citegeist] showCitationNetwork called: mode=${mode}, itemID=${item.id}`);

  if (!canResolveWork(item)) {
    Services.prompt.alert(
      null,
      "Citegeist",
      "Citegeist can't identify this item. Add a DOI, PMID, arXiv ID, or ISBN — or confirm a title match — then try again.",
    );
    return;
  }

  // Tear down any currently-open dialog with the full cleanup before opening
  // this one (see closeActiveDialog).
  closeActiveDialog();
  dialogOpenSeq++;

  // Show dialog immediately with skeleton loading state
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const parent = doc.body || doc.documentElement;
  const title = item.getField("title");
  const { overlay, dialog } = createDialogShell(
    win,
    buildDialogHTML(title, getItemSourceMetaLine(item)),
    "Citation network browser",
  );
  parent.appendChild(overlay);
  activeDialog = overlay;

  // Show skeleton in body while loading
  const body = dialog.querySelector(".cg-dialog-body") as HTMLElement;
  if (body) renderSkeletonRows(body);

  // Close on Escape/backdrop while loading. We flip `phase` to "closed"
  // BEFORE the DOM removal so any awaiter that resumes between this handler
  // and `closedBeforeReady` returning true sees a consistent state — without
  // it, the post-await "happy path" (work fetched after early-close) would
  // proceed to bind events on a detached overlay and fire network calls
  // against an orphaned UI.
  const earlyClose = (e: Event) => {
    if ((e as KeyboardEvent).key === "Escape" || e.target === overlay) {
      phase = "closed";
      try {
        overlay.remove();
      } catch {
        /* gone */
      }
      if (activeDialog === overlay) activeDialog = null;
    }
  };
  // Raw listeners on purpose: earlyClose is removed by identity below, and a
  // wrapper would make removeEventListener silently no-op. The handler itself
  // only closes the dialog, so there is nothing here that can fail.
  overlay.addEventListener("keydown", earlyClose);
  overlay.addEventListener("click", earlyClose);

  // Dialog lifecycle is tracked via an external phase variable until the
  // full state object exists. Guards below early-return when phase flips to
  // "closed" mid-await.
  let phase: "loading-skeleton" | "loading-data" | "ready" | "closed" = "loading-skeleton";
  const markClosed = () => {
    phase = "closed";
  };
  const closedBeforeReady = () => phase === "closed" || activeDialog !== overlay;

  // Fetch work + existing DOIs in parallel (user sees skeleton)
  phase = "loading-data";
  const allCollections = buildCollectionTree();
  const defaultCollectionIds = new Set<number>();
  try {
    const zp = Zotero.getActiveZoteroPane();
    const currentCol = zp?.getSelectedCollection?.();
    if (currentCol) defaultCollectionIds.add(currentCol.id);
  } catch {
    /* library root */
  }

  let work;
  let existingDOIs;
  try {
    [work, existingDOIs] = await Promise.all([resolveWorkForItem(item), getExistingDOIs()]);
  } catch (e) {
    if (closedBeforeReady()) return;
    logError(`showCitationNetwork load (item ${item.id}, ${mode})`, e);
    if (body) {
      // Coded state, built by the shared renderer. The dialog used to
      // hand-write its own generic failure copy, which told the user nothing
      // and gave a bug report nothing to quote.
      renderDialogDiagnostic(body, codeForError(e), `network dialog load (${mode})`);
    }
    return;
  }

  if (closedBeforeReady()) return;

  if (!work) {
    if (body) {
      safeInnerHTML(
        body,
        `<div class="cg-empty">
        <div class="cg-empty-title">Not found on OpenAlex</div>
        This work could not be found. It may not be indexed yet.
      </div>`,
      );
    }
    return;
  }

  // Second check: a user can close the dialog between the first guard and
  // here (rare but possible — the safeInnerHTML write yields to the event
  // loop). Without this, we'd bind the full event set and fire loadResults
  // on a detached overlay.
  if (closedBeforeReady()) return;

  // Remove early close handlers, bind full event set
  overlay.removeEventListener("keydown", earlyClose);
  overlay.removeEventListener("click", earlyClose);
  // Ensure close handlers update the phase variable the closures above use.
  bindGuarded(
    overlay,
    "citegeist:dialog-closed",
    "network dialog overlay citegeist:dialog-closed",
    markClosed as EventListener,
  );

  phase = "ready";

  const state: NetworkState = {
    phase: "ready",
    overlay,
    dialog,
    win,
    work,
    mode,
    results: [],
    cursor: "*",
    hasMore: true,
    loading: false,
    sortBy: "citations",
    hideInLibrary: false,
    existingDOIs,
    existingWorkIds: getAllCachedOpenAlexIds(),
    generation: 0,
    searchTimeout: null,
    defaultCollectionIds,
    allCollections,
    expandedIds: new Set(),
    abstractCache: new Map(),
    undoTimers: new Map(),
    addedThisSession: new Set(),
    itemCollections: new Map(),
    createdItemIds: new Map(),
    defaultPickerExpanded: new Set(),
    pendingAdds: new Set(),
  };

  // Publish so a subsequent stacked-open invocation can run the full
  // closeDialog cleanup on this state instead of just removing the DOM.
  activeState = state;

  bindDialogEvents(state);
  updateDefaultCollectionLabel(state);

  // Fill the source paper's own cited-by count in the header now that the
  // OpenAlex work is loaded.
  const citedStat = dialog.querySelector("#cg-source-cited-count .cg-stat-value");
  if (citedStat) citedStat.textContent = (work.cited_by_count ?? 0).toLocaleString();

  await loadResults(state);

  const searchInput = dialog.querySelector(".cg-search-input") as HTMLInputElement;
  searchInput?.focus();
}

/**
 * Open an author's works as a dialog — the "author works" mode of the citation
 * browser (U7b). Reached from the item pane's Authors section (U7a). Reuses the
 * whole browser shell (results rendering, add/file, sort, search, infinite
 * scroll, focus trap); only the header (an author hero instead of source
 * metadata + tabs) and the fetch source (`authorships.author.id`) differ. Back
 * is the dialog's existing dismiss (× / Esc / backdrop) → returns to the pane.
 *
 * Identity is fetched first (a free singleton) so the dialog opens fully
 * populated with the hero; a hard failure alerts and never opens an empty
 * dialog. That identity fetch IS a pre-shell async window, so this open is
 * claimed on `dialogOpenSeq` and bails if a re-entrant open supersedes it
 * mid-fetch. Once the shell exists, `activeDialog`/`activeState` guard the rest
 * exactly as the work-mode entry does.
 */
export async function showAuthorWorks(authorId: string): Promise<void> {
  Zotero.debug(`[Citegeist] showAuthorWorks called: authorId=${authorId}`);

  // Tear down any currently-open dialog before opening this one, and claim this
  // open synchronously so a re-entrant open (a double-click on the row, or a
  // Citing/References click) during the identity fetch below supersedes us
  // instead of stacking a second modal.
  closeActiveDialog();
  const myOpen = ++dialogOpenSeq;

  const win = Zotero.getMainWindow();
  const doc = win.document;
  const parent = doc.body || doc.documentElement;

  let profile: OpenAlexAuthorProfile | null = null;
  let existingDOIs: Set<string> = new Set();
  try {
    [profile, existingDOIs] = await Promise.all([fetchAuthorProfile(authorId), getExistingDOIs()]);
  } catch (e) {
    if (myOpen !== dialogOpenSeq) return; // superseded mid-fetch — newer open owns the UI
    logError(`showAuthorWorks(${authorId})`, e);
    // This path is a modal alert (no dialog body to render into yet), so the
    // code is appended to the message — a user reporting "the author view
    // won't open" still has something to quote.
    const code = codeForError(e);
    Services.prompt.alert(null, "Citegeist", `${describeCode(code).message}\n\n${code}`);
    return;
  }

  // Bail if a newer open superseded us during the identity fetch (re-entrancy).
  if (myOpen !== dialogOpenSeq) return;

  if (!profile) {
    Services.prompt.alert(null, "Citegeist", "This author has no OpenAlex profile to show.");
    return;
  }

  // Cache exact metrics so the pane's Authors-section h-index hint fills in,
  // and reconcile a 301 author-id merge if this lookup redirected (KTD3).
  persistProfileMetrics(profile);
  maybeReconcileMerge(profile);

  // INVARIANT: no `await` between the `myOpen !== dialogOpenSeq` check above and
  // this synchronous shell build + `activeDialog` claim. Inserting one reopens the
  // stacking race — a later open could bump the seq after we passed the check but
  // before we claim `activeDialog`. Keep this block await-free.
  const vm = buildProfileViewModel(profile);
  const { overlay, dialog } = createDialogShell(win, buildAuthorDialogHTML(vm), "Author works");
  parent.appendChild(overlay);
  activeDialog = overlay;

  // Skeleton while the first works page loads.
  const body = dialog.querySelector(".cg-dialog-body") as HTMLElement;
  if (body) renderSkeletonRows(body);

  const defaultCollectionIds = new Set<number>();
  try {
    const zp = Zotero.getActiveZoteroPane();
    const currentCol = zp?.getSelectedCollection?.();
    if (currentCol) defaultCollectionIds.add(currentCol.id);
  } catch {
    /* library root */
  }

  const state: NetworkState = {
    phase: "ready",
    overlay,
    dialog,
    win,
    work: null,
    mode: "author",
    authorId: profile.id,
    authorProfile: profile,
    results: [],
    cursor: "*",
    hasMore: true,
    loading: false,
    sortBy: "citations",
    hideInLibrary: false,
    existingDOIs,
    existingWorkIds: getAllCachedOpenAlexIds(),
    generation: 0,
    searchTimeout: null,
    defaultCollectionIds,
    allCollections: buildCollectionTree(),
    expandedIds: new Set(),
    abstractCache: new Map(),
    undoTimers: new Map(),
    addedThisSession: new Set(),
    itemCollections: new Map(),
    createdItemIds: new Map(),
    defaultPickerExpanded: new Set(),
    pendingAdds: new Set(),
  };

  // Publish so a stacked open runs the full closeDialog cleanup on this state.
  activeState = state;

  bindDialogEvents(state);
  updateDefaultCollectionLabel(state);
  await loadResults(state);

  const searchInput = dialog.querySelector(".cg-search-input") as HTMLInputElement;
  searchInput?.focus();
}

// ────────────────────────────────────────────────────────
// Dialog HTML shell
// ────────────────────────────────────────────────────────

/**
 * One-line source metadata for the dialog header: `Surname, Surname & Surname \u00B7
 * Venue \u00B7 Year`. Authors use last names only; more than three collapse to
 * "Surname et al.". Any missing part is dropped; returns "" when nothing is
 * available. Filters to authors when Zotero can resolve the creator type \u2014
 * books resolved by ISBN may carry editors rather than authors, which we
 * intentionally drop here so the header stays a clean author line.
 */
export function getItemSourceMetaLine(item: _ZoteroTypes.Item): string {
  const parts: string[] = [];

  let authorTypeID: number | undefined;
  try {
    const creatorTypes = (Zotero as { CreatorTypes?: { getID?: (name: string) => number } })
      .CreatorTypes;
    authorTypeID = creatorTypes?.getID?.("author");
  } catch {
    authorTypeID = undefined;
  }
  const creators = (item.getCreators?.() ?? []) as Array<{
    creatorTypeID?: number;
    lastName?: string;
    name?: string;
  }>;
  const surnames = creators
    .filter(
      (c) => authorTypeID == null || c.creatorTypeID == null || c.creatorTypeID === authorTypeID,
    )
    .map((c) => (c.lastName || c.name || "").trim())
    .filter(Boolean);

  if (surnames.length === 1) {
    parts.push(surnames[0]);
  } else if (surnames.length === 2) {
    parts.push(`${surnames[0]} & ${surnames[1]}`);
  } else if (surnames.length === 3) {
    parts.push(`${surnames[0]}, ${surnames[1]} & ${surnames[2]}`);
  } else if (surnames.length > 3) {
    parts.push(`${surnames[0]} et al.`);
  }

  const venue = (item.getField?.("publicationTitle") || "").trim();
  if (venue) parts.push(venue);

  const yearMatch = (item.getField?.("date") || "").match(/\d{4}/);
  if (yearMatch) parts.push(yearMatch[0]);

  return parts.join(" \u00B7 ");
}

const DIALOG_CHROME_HTML = `
    <div class="cg-dialog-chrome">
      <button class="cg-close-btn" id="cg-btn-close" title="Close"
              aria-label="Close citation network browser">\u00D7</button>
    </div>`;

const MODE_TABS_HTML = `
      <div class="cg-tabs-inner" role="tablist" aria-label="Citation direction">
        <button class="cg-tab" data-mode="citing" role="tab" id="cg-tab-citing"
                aria-selected="false" aria-controls="cg-dialog-body" tabindex="-1">Cited By</button>
        <button class="cg-tab" data-mode="references" role="tab" id="cg-tab-references"
                aria-selected="false" aria-controls="cg-dialog-body" tabindex="-1">References</button>
      </div>`;

/** Command bar (search + hide-in-library + sort). `tabsHTML` is the mode tabs in
 *  work modes, empty in author mode (which has no citing/references direction). */
function commandBarHTML(tabsHTML: string): string {
  return `
    <div class="cg-command-bar${tabsHTML ? "" : " cg-command-bar--notabs"}">
      ${tabsHTML}
      <div class="cg-search-wrap">
        <span class="cg-search-icon" aria-hidden="true">\uD83D\uDD0D</span>
        <input type="text" class="cg-search-input"
               placeholder="Search titles, authors\u2026"
               aria-label="Filter results by title or author" />
      </div>
      <div class="cg-control-cluster">
        <button type="button" class="cg-hide-in-library" id="cg-hide-in-library"
                role="switch" aria-checked="false"
                aria-label="Hide works already in your library">
          <span class="cg-switch" aria-hidden="true"></span>Hide in library
        </button>
        <label class="cg-sort-label">Sort:
          <select class="cg-sort-select" aria-label="Sort results by">
            <option value="citations">Most cited</option>
            <option value="fwci-desc">Highest FWCI</option>
            <option value="percentile-desc">Top percentile</option>
            <option value="year-desc">Newest</option>
            <option value="year-asc">Oldest</option>
            <option value="author-asc">First author</option>
            <option value="not-in-library">Not in library first</option>
          </select>
        </label>
      </div>
    </div>`;
}

/** Results panel + footer (default-collection chip). Identical for both modes. */
const BODY_FOOTER_HTML = `
    <div class="cg-dialog-body" id="cg-dialog-body" role="tabpanel"
         aria-labelledby="cg-tab-citing" aria-live="polite" aria-busy="true">
      <div class="cg-loading-more">Loading\u2026</div>
    </div>
    <div class="cg-dialog-footer">
      <div class="cg-footer-info">
        <span id="cg-total-count">\u2026</span>
      </div>
      <div class="cg-footer-right" style="position:relative;">
        <span class="cg-footer-label" id="cg-footer-label">Default folder:</span>
        <button class="cg-default-chip" id="cg-default-chip"
                aria-haspopup="listbox" aria-expanded="false"
                title="Set default collection for new items">
          <span>\uD83D\uDCC1</span>
          <span class="cg-default-chip-label" id="cg-default-label">My Library</span>
          <span class="cg-default-chip-extra" id="cg-default-extra"></span>
          <span style="color:var(--cg-text-tertiary);font-size:9px;">\u25BE</span>
        </button>
        <div class="cg-default-dropdown" id="cg-default-dropdown"
             role="listbox" aria-label="Default collection" hidden></div>
      </div>
    </div>`;

export function buildDialogHTML(title: string, sourceMetaLine: string): string {
  const sourceMeta = sourceMetaLine
    ? `<div class="cg-source-authors" id="cg-source-meta">${escapeHTML(sourceMetaLine)}</div>`
    : "";
  const header = `
    <div class="cg-dialog-top">
      <div class="cg-header-text">
        <div class="cg-eyebrow">Citation Network</div>
        <div class="cg-dialog-title" title="${escapeHTML(title)}">${escapeHTML(title)}</div>
        ${sourceMeta}
      </div>
      <div class="cg-count-stack">
        <div class="cg-stat" id="cg-source-cited-count">
          <strong class="cg-stat-value">\u2026</strong>
          <span class="cg-stat-label">Cited by</span>
        </div>
      </div>
    </div>`;
  return DIALOG_CHROME_HTML + header + commandBarHTML(MODE_TABS_HTML) + BODY_FOOTER_HTML;
}

/**
 * Author-mode header. Composes the SHARED `.cg-metricline` primitive rather than
 * a row of boxed stat tiles: four bordered, equal-weight tiles flattened the
 * hierarchy and looked nothing like the item pane's Impact card, which does the
 * identical job (one dominant figure, then supporting metrics inline). A box is
 * earned by an interaction, not by a number.
 */
export function buildAuthorDialogHTML(vm: ProfileViewModel): string {
  const ids = [vm.orcid ? `ORCID ${vm.orcid}` : "", "OpenAlex"].filter(Boolean).join(" \u00B7 ");
  const sep = `<span class="cg-metricline-sep">\u00B7</span>`;
  const metrics = [
    `<strong>h-index ${escapeHTML(vm.hIndex)}</strong>`,
    `i10 ${escapeHTML(vm.i10Index)}`,
    `${escapeHTML(vm.worksCount)} works`,
    `${escapeHTML(vm.citedByCount)} cited`,
  ].join(sep);
  const header = `
    <div class="cg-dialog-top cg-dialog-top--author">
      <div class="cg-header-text">
        <div class="cg-eyebrow">Author</div>
        <div class="cg-dialog-title" title="${escapeHTML(vm.name)}">${escapeHTML(vm.name)}</div>
        <div class="cg-metricline">${metrics}</div>
        <div class="cg-source-authors">${escapeHTML(ids)}</div>
      </div>
    </div>`;
  return DIALOG_CHROME_HTML + header + commandBarHTML("") + BODY_FOOTER_HTML;
}

// ────────────────────────────────────────────────────────
// Dialog lifecycle
// ────────────────────────────────────────────────────────

export function closeDialog(state: NetworkState): void {
  state.phase = "closed";
  if (state.searchTimeout) clearTimeout(state.searchTimeout);
  // Clear all undo timers
  for (const timer of state.undoTimers.values()) clearTimeout(timer);
  state.undoTimers.clear();
  try {
    state.overlay.dispatchEvent(new Event("citegeist:dialog-closed"));
  } catch {
    // Event dispatch can throw in rare XUL contexts — safe to ignore.
  }
  try {
    state.overlay.remove();
  } catch {
    /* already gone */
  }
  if (activeDialog === state.overlay) activeDialog = null;
  if (activeState === state) activeState = null;
}

// ────────────────────────────────────────────────────────
// Event binding (once, delegation-based)
// ────────────────────────────────────────────────────────

export function bindDialogEvents(state: NetworkState): void {
  const { dialog, overlay } = state;

  // Close button
  bindGuarded(dialog.querySelector("#cg-btn-close"), "click", "network dialog close button", () =>
    closeDialog(state),
  );

  // Escape
  bindGuarded(overlay, "keydown", "network dialog overlay keydown", (e: Event) => {
    if ((e as KeyboardEvent).key === "Escape") {
      // Close any open picker first, then dialog
      const openPicker = dialog.querySelector(".cg-item-picker:not([hidden])") as HTMLElement;
      const openDefault = dialog.querySelector("#cg-default-dropdown:not([hidden])") as HTMLElement;
      if (openPicker) {
        openPicker.hidden = true;
      } else if (openDefault) {
        openDefault.hidden = true;
        dialog.querySelector("#cg-default-chip")?.setAttribute("aria-expanded", "false");
      } else {
        closeDialog(state);
      }
    }
  });

  // Overlay backdrop click
  bindGuarded(overlay, "click", "network dialog overlay click", (e: Event) => {
    if (e.target === overlay) closeDialog(state);
  });

  // Tabs — roving-tabindex + arrow-key navigation per WAI-ARIA tabs pattern.
  const tabs = Array.from(dialog.querySelectorAll(".cg-tab")) as HTMLElement[];
  const tabPanel = dialog.querySelector("#cg-dialog-body");
  tabs.forEach((tabEl) => {
    const isActive = tabEl.dataset.mode === state.mode;
    if (isActive) {
      tabEl.classList.add("active");
      tabEl.setAttribute("aria-selected", "true");
      tabEl.setAttribute("tabindex", "0");
      tabPanel?.setAttribute("aria-labelledby", tabEl.id);
    }
    // Arrow-key navigation within the tablist. Skip when a load is in
    // flight so focus + aria-selected + tabindex stay in sync (C2: the
    // click handler short-circuits on `state.loading`, but focus had
    // already moved, desyncing roving-tabindex from the active tab).
    bindGuarded(tabEl, "keydown", "network dialog tabEl keydown", (evt: Event) => {
      const e = evt as KeyboardEvent;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (state.loading) return;
      e.preventDefault();
      const idx = tabs.indexOf(tabEl);
      const next = tabs[(idx + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      (next as HTMLElement).click();
    });
    bindGuarded(tabEl, "click", "network dialog tabEl click", async () => {
      const newMode = tabEl.dataset.mode as NetworkMode;
      if (newMode === state.mode || state.loading) return;
      // Cancel any pending debounced search — without this, a mid-typing
      // tab switch would fire `renderResults` with stale filter against the
      // brand-new tab's results once the debounce window elapsed (P2.5).
      if (state.searchTimeout) {
        clearTimeout(state.searchTimeout);
        state.searchTimeout = null;
      }
      state.generation++;
      state.mode = newMode;
      state.results = [];
      state.expandedIds.clear();
      state.cursor = "*";
      state.hasMore = true;
      tabs.forEach((t) => {
        t.classList.remove("active");
        t.setAttribute("aria-selected", "false");
        t.setAttribute("tabindex", "-1");
      });
      tabEl.classList.add("active");
      tabEl.setAttribute("aria-selected", "true");
      tabEl.setAttribute("tabindex", "0");
      tabPanel?.setAttribute("aria-labelledby", tabEl.id);
      await loadResults(state);
    });
  });

  // Search (debounced)
  const searchInput = dialog.querySelector(".cg-search-input") as HTMLInputElement;
  bindGuarded(searchInput, "input", "network dialog searchInput input", () => {
    if (state.searchTimeout) clearTimeout(state.searchTimeout);
    state.searchTimeout = setTimeout(() => {
      state.searchTimeout = null;
      renderResults(state, searchInput.value);
    }, SEARCH_DEBOUNCE_MS);
  });

  // Sort
  const sortSelect = dialog.querySelector(".cg-sort-select") as HTMLSelectElement;
  bindGuarded(sortSelect, "change", "network dialog sortSelect change", () => {
    state.sortBy = sortSelect.value as NetworkSortKey;
    renderResults(state, searchInput?.value || "");
  });

  // Hide-in-library filter toggle
  const hideToggle = dialog.querySelector("#cg-hide-in-library") as HTMLButtonElement | null;
  if (hideToggle) {
    bindGuarded(hideToggle, "click", "network dialog hideToggle click", () => {
      state.hideInLibrary = !state.hideInLibrary;
      hideToggle.setAttribute("aria-checked", state.hideInLibrary ? "true" : "false");
      hideToggle.classList.toggle("cg-switch-on", state.hideInLibrary);
      renderResults(state, searchInput?.value || "");
    });
  }

  // ── Body event delegation (survives re-renders) ──
  const body = dialog.querySelector(".cg-dialog-body") as HTMLElement;

  bindGuarded(body, "click", "network dialog body click", (e: Event) => {
    const target = e.target as HTMLElement;

    // Close any open per-item picker if clicking outside it
    closeOpenPickers(state, target);

    // Title link -> open article (use localName for XUL compat -- tagName case varies)
    const link = target.closest(".cg-result-title")
      ? (target.closest("[href]") as HTMLAnchorElement)
      : null;
    if (
      !link &&
      (target.localName === "a" || target.tagName === "A") &&
      target.closest(".cg-result-title")
    ) {
      // Direct click on <a> -- also handle in case closest("[href]") fails in XUL
      e.preventDefault();
      e.stopPropagation();
      const href = (target as HTMLAnchorElement).getAttribute("href");
      if (href) Zotero.launchURL(href);
      return;
    }
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      const href = link.getAttribute("href");
      if (href) Zotero.launchURL(href);
      return;
    }

    // Split button main -> add / undo / file
    const splitMain = target.closest(".cg-split-main") as HTMLButtonElement | null;
    if (splitMain) {
      e.stopPropagation();
      // Disabled-state re-check at delegation boundary: clicks on the
      // chrome around a disabled button (.cg-split-btn padding, focus
      // ring) bubble here even though the inner <button> rejected them.
      // Without this, a spam-click during the in-flight add could
      // re-enter and create a duplicate item. (F2 belt-and-suspenders)
      if (splitMain.disabled) return;
      const workId = splitMain.dataset.workId;
      const action = splitMain.dataset.action;
      if (!workId) return;
      if (action === "add") handleAdd(state, workId);
      else if (action === "undo") handleUndo(state, workId);
      else if (action === "file") toggleItemPicker(state, workId, splitMain);
      return;
    }

    // Split button arrow -> open per-item picker
    const splitArrow = target.closest(".cg-split-arrow") as HTMLElement | null;
    if (splitArrow) {
      e.stopPropagation();
      const workId = splitArrow.dataset.workId;
      if (workId) toggleItemPicker(state, workId, splitArrow);
      return;
    }

    // Per-item picker interactions are handled by their own listeners
    if (target.closest(".cg-item-picker")) {
      e.stopPropagation();
      return;
    }

    // Row click -> expand/collapse abstract
    const itemEl = target.closest(".cg-result-item") as HTMLElement | null;
    if (itemEl) {
      const workId = itemEl.dataset.workId;
      if (workId) toggleExpanded(state, workId);
      return;
    }
  });

  // Keyboard on body -- buttons + row navigation
  bindGuarded(body, "keydown", "network dialog body keydown", (e: Event) => {
    const ke = e as KeyboardEvent;
    const target = ke.target as HTMLElement;

    // Button activation
    if (ke.key === "Enter" || ke.key === " ") {
      if (
        target.classList.contains("cg-split-main") ||
        target.classList.contains("cg-split-arrow")
      ) {
        ke.preventDefault();
        target.click();
        return;
      }
    }

    // Row-level keyboard navigation
    if (ke.key === "ArrowDown" || ke.key === "ArrowUp") {
      const row = target.closest(".cg-result-item") as HTMLElement;
      if (row || target === body) {
        ke.preventDefault();
        const items = body.querySelectorAll(".cg-result-item");
        if (items.length === 0) return;
        let idx = -1;
        if (row) {
          items.forEach((el, i) => {
            if (el === row) idx = i;
          });
        }
        const next =
          ke.key === "ArrowDown" ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
        (items[next] as HTMLElement).focus();
        return;
      }
    }

    // Enter/Escape on row → expand/collapse. Use closest() so the key
    // fires from anywhere inside the row (title link, badge, or any
    // focusable child) — not only when focus is on the row element
    // itself. Without this, tabbing into a link inside the row made
    // Enter lose its expand behaviour (a-n 1).
    if (ke.key === "Enter") {
      const row = target.closest(".cg-result-item") as HTMLElement | null;
      if (row && !target.matches("button, a, input, select")) {
        ke.preventDefault();
        const workId = row.dataset.workId;
        if (workId) toggleExpanded(state, workId);
      }
    }
    if (ke.key === "Escape") {
      const row = target.closest(".cg-result-item") as HTMLElement | null;
      if (row && state.expandedIds.has(row.dataset.workId ?? "")) {
        ke.preventDefault();
        const workId = row.dataset.workId;
        if (workId) toggleExpanded(state, workId);
      }
    }
  });

  // Infinite scroll — throttled so a long results list doesn't force a
  // layout read on every paint. Without this, fast scrolling on 1k+
  // items measurably jankifies the dialog. (F12)
  //
  // Use `state.win.requestAnimationFrame` (NOT the bare global) — Zotero's
  // XUL sandbox does not expose `requestAnimationFrame` as a global, so
  // `requestAnimationFrame(...)` threw ReferenceError on every scroll
  // event. Fall back to `setTimeout(fn, 16)` (~60Hz) on builds that
  // don't expose the per-window rAF either.
  const win = state.win as Window & {
    requestAnimationFrame?: (cb: FrameRequestCallback) => number;
  };
  const schedule: (cb: FrameRequestCallback) => unknown =
    typeof win.requestAnimationFrame === "function"
      ? win.requestAnimationFrame.bind(win)
      : (cb) => setTimeout(() => cb(0), 16);
  let scrollScheduled = false;
  bindGuarded(body, "scroll", "network dialog body scroll", () => {
    if (scrollScheduled) return;
    scrollScheduled = true;
    schedule(async () => {
      scrollScheduled = false;
      if (state.loading || !state.hasMore || state.phase === "closed") return;
      const scrollBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
      if (scrollBottom < INFINITE_SCROLL_THRESHOLD_PX) await loadResults(state, true);
    });
  });

  // Focus trap — keep Tab within dialog. Re-queries focusables every
  // keydown so additions/removals (search input show/hide, picker open)
  // are picked up live. Filters out hidden elements explicitly so the
  // trap doesn't park focus on `cg-picker-option[hidden]` nodes that
  // surrounding CSS keeps reachable in the DOM. (P3.1)
  bindGuarded(dialog, "keydown", "network dialog dialog keydown", (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key !== "Tab") return;
    const all = dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]):not([hidden]), [href]:not([hidden]), input:not([hidden]), select:not([hidden]), [tabindex]:not([tabindex="-1"]):not([hidden])',
    );
    const focusable = Array.from(all).filter((el) => el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = dialog.ownerDocument.activeElement;
    if (ke.shiftKey && active === first) {
      ke.preventDefault();
      last.focus();
    } else if (!ke.shiftKey && active === last) {
      ke.preventDefault();
      first.focus();
    }
  });

  // Default collection picker
  initDefaultCollectionPicker(state);
}

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

import { getWorkByDOI } from "../openalex";
import { escapeHTML, safeInnerHTML, OpenAlexNetworkError, logError } from "../utils";
import { SEARCH_DEBOUNCE_MS, INFINITE_SCROLL_THRESHOLD_PX } from "../../constants";
import type { NetworkMode, NetworkState } from "./types";
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

export let activeDialog: HTMLElement | null = null;

// ────────────────────────────────────────────────────────
// Entry point
// ────────────────────────────────────────────────────────

export async function showCitationNetwork(
  item: _ZoteroTypes.Item,
  mode: NetworkMode,
): Promise<void> {
  Zotero.debug(`[Citegeist] showCitationNetwork called: mode=${mode}, itemID=${item.id}`);

  const doi = item.getField("DOI");
  if (!doi || !doi.trim()) {
    Services.prompt.alert(
      null,
      "Citegeist",
      "This item has no DOI. Citation network requires a DOI.",
    );
    return;
  }

  if (activeDialog) {
    // Fire the close event so any in-flight undo timers, picker overlays,
    // or "added this session" tracking get the same cleanup the explicit
    // Close button would trigger. Without this, opening a second dialog
    // while the first had a pending Add-undo timer left the timer firing
    // against a detached DOM and orphaned the just-added item in trash
    // (P2.1 — stacked dialogs lose undo state silently).
    try {
      activeDialog.dispatchEvent(new Event("citegeist:dialog-closed"));
    } catch {
      // Event dispatch can throw in rare XUL contexts — safe to ignore.
    }
    try {
      activeDialog.remove();
    } catch {
      /* already gone */
    }
    activeDialog = null;
  }

  // Show dialog immediately with skeleton loading state
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const parent = doc.body || doc.documentElement;

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
  dialog.setAttribute("aria-label", "Citation network browser");
  dialog.style.cssText = `
    width: 780px; max-width: 90vw; max-height: 82vh;
    padding: 0; border: 1px solid rgba(128,128,128,0.1);
    border-radius: 12px;
    background: var(--material-background, #2c2c2e); color: var(--fill-primary, #e8e8ed);
    box-shadow: 0 20px 40px rgba(0,0,0,0.5), 0 0 1px rgba(128,128,128,0.1);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px; line-height: 1.4;
    display: flex; flex-direction: column; overflow: hidden;
  `;

  const title = item.getField("title");
  safeInnerHTML(dialog, buildDialogHTML(title));

  const styleEl = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
  styleEl.textContent = getDialogCSS();
  dialog.insertBefore(styleEl, dialog.firstChild);

  overlay.appendChild(dialog);
  parent.appendChild(overlay);
  activeDialog = overlay;

  // Show skeleton in body while loading
  const body = dialog.querySelector(".cg-dialog-body") as HTMLElement;
  if (body) {
    let skeleton = "";
    for (let i = 0; i < 6; i++) {
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
    [work, existingDOIs] = await Promise.all([getWorkByDOI(doi), getExistingDOIs()]);
  } catch (e) {
    if (closedBeforeReady()) return;
    logError("showCitationNetwork load", e);
    if (body) {
      const msg =
        e instanceof OpenAlexNetworkError
          ? `<div class="cg-empty">
            <div class="cg-empty-title">OpenAlex is unavailable</div>
            Could not reach the citation service. Try again in a few minutes.
          </div>`
          : `<div class="cg-empty">
            <div class="cg-empty-title">Something went wrong</div>
            An unexpected error occurred while loading citations.
          </div>`;
      safeInnerHTML(body, msg);
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
  overlay.addEventListener("citegeist:dialog-closed", markClosed as EventListener);

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
    existingDOIs,
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

  bindDialogEvents(state);
  updateDefaultCollectionLabel(state);
  await loadResults(state);

  const searchInput = dialog.querySelector(".cg-search-input") as HTMLInputElement;
  searchInput?.focus();
}

// ────────────────────────────────────────────────────────
// Dialog HTML shell
// ────────────────────────────────────────────────────────

export function buildDialogHTML(title: string): string {
  return `
    <div class="cg-dialog-header">
      <button class="cg-close-btn" id="cg-btn-close" title="Close"
              aria-label="Close citation network browser">\u00D7</button>
      <div class="cg-header-text">
        <div class="cg-dialog-title">Citation Network</div>
        <div class="cg-dialog-subtitle">${escapeHTML(title)}</div>
      </div>
    </div>
    <div class="cg-dialog-tabs" role="tablist" aria-label="Citation direction">
      <div class="cg-tabs-inner">
        <button class="cg-tab" data-mode="citing" role="tab" id="cg-tab-citing"
                aria-selected="false" aria-controls="cg-dialog-body"
                tabindex="-1">Cited By</button>
        <button class="cg-tab" data-mode="references" role="tab" id="cg-tab-references"
                aria-selected="false" aria-controls="cg-dialog-body"
                tabindex="-1">References</button>
      </div>
    </div>
    <div class="cg-dialog-toolbar">
      <div class="cg-search-wrap">
        <span class="cg-search-icon">\uD83D\uDD0D</span>
        <input type="text" class="cg-search-input"
               placeholder="Search titles, authors\u2026"
               aria-label="Filter results by title or author" />
      </div>
      <select class="cg-sort-select" aria-label="Sort results by">
        <option value="citations">Most cited</option>
        <option value="fwci-desc">Highest FWCI</option>
        <option value="percentile-desc">Top percentile</option>
        <option value="year-desc">Newest</option>
        <option value="year-asc">Oldest</option>
      </select>
    </div>
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
          <span style="color:#636366;font-size:9px;">\u25BE</span>
        </button>
        <div class="cg-default-dropdown" id="cg-default-dropdown"
             role="listbox" aria-label="Default collection" hidden></div>
      </div>
    </div>
  `;
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
}

// ────────────────────────────────────────────────────────
// Event binding (once, delegation-based)
// ────────────────────────────────────────────────────────

export function bindDialogEvents(state: NetworkState): void {
  const { dialog, overlay } = state;

  // Close button
  dialog.querySelector("#cg-btn-close")?.addEventListener("click", () => closeDialog(state));

  // Escape
  overlay.addEventListener("keydown", (e: Event) => {
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
  overlay.addEventListener("click", (e: Event) => {
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
    // Arrow-key navigation within the tablist.
    tabEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const idx = tabs.indexOf(tabEl);
      const next = tabs[(idx + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      (next as HTMLElement).click();
    });
    tabEl.addEventListener("click", async () => {
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
  searchInput?.addEventListener("input", () => {
    if (state.searchTimeout) clearTimeout(state.searchTimeout);
    state.searchTimeout = setTimeout(() => {
      state.searchTimeout = null;
      renderResults(state, searchInput.value);
    }, SEARCH_DEBOUNCE_MS);
  });

  // Sort
  const sortSelect = dialog.querySelector(".cg-sort-select") as HTMLSelectElement;
  sortSelect?.addEventListener("change", () => {
    state.sortBy = sortSelect.value;
    renderResults(state, searchInput?.value || "");
  });

  // ── Body event delegation (survives re-renders) ──
  const body = dialog.querySelector(".cg-dialog-body") as HTMLElement;

  body?.addEventListener("click", (e: Event) => {
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
    const splitMain = target.closest(".cg-split-main") as HTMLElement | null;
    if (splitMain) {
      e.stopPropagation();
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
  body?.addEventListener("keydown", (e: Event) => {
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

  // Infinite scroll — rAF-throttled so a long results list doesn't force
  // a layout read on every paint. Without this, fast scrolling on 1k+
  // items measurably jankifies the dialog. (F12)
  let scrollScheduled = false;
  body?.addEventListener("scroll", () => {
    if (scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(async () => {
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
  dialog.addEventListener("keydown", (e: Event) => {
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

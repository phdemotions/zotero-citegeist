/**
 * Citation Network Browser — the killer feature.
 *
 * Opens a dialog showing works that cite or are cited by the selected item.
 * Each row shows title, authors, year, journal, citation count, OA status.
 * Users can select works and add them to their Zotero library with one click.
 */

import {
  getCitingWorks,
  getReferencedWorks,
  getWorkByDOI,
  formatAuthors,
  getSourceName,
  type OpenAlexWork,
} from "./openalex";
import { escapeHTML, safeInnerHTML } from "./utils";

type NetworkMode = "citing" | "references";

const MAX_RENDERED_RESULTS = 200;

let activeDialog: HTMLElement | null = null;

export async function showCitationNetwork(
  item: _ZoteroTypes.Item,
  mode: NetworkMode,
): Promise<void> {
  Zotero.debug(`[Citegeist] showCitationNetwork called: mode=${mode}, itemID=${item.id}`);

  const doi = item.getField("DOI");
  Zotero.debug(`[Citegeist] DOI: "${doi}"`);
  if (!doi || !doi.trim()) {
    Services.prompt.alert(
      null,
      "Citegeist",
      "This item has no DOI. Citation network requires a DOI.",
    );
    return;
  }

  if (activeDialog) {
    Zotero.debug("[Citegeist] Closing previous dialog");
    try { activeDialog.remove(); } catch { /* already gone */ }
    activeDialog = null;
  }

  Zotero.debug("[Citegeist] Fetching work from OpenAlex...");
  const work = await getWorkByDOI(doi);
  Zotero.debug(`[Citegeist] OpenAlex result: ${work ? "found" : "NOT FOUND"}`);
  if (!work) {
    Services.prompt.alert(
      null,
      "Citegeist",
      "Could not find this work on OpenAlex.",
    );
    return;
  }

  const win = Zotero.getMainWindow();
  const doc = win.document;
  Zotero.debug(`[Citegeist] Window: ${!!win}, doc: ${!!doc}, body: ${!!doc.body}, docEl: ${!!doc.documentElement}`);

  // Zotero's main window is XUL — document.body may not exist.
  // Use documentElement as the parent, which always exists.
  const parent = doc.body || doc.documentElement;
  Zotero.debug(`[Citegeist] Parent element: ${parent.tagName}`);

  // Try creating the dialog as a regular XHTML div with fixed positioning
  // instead of <dialog>, since <dialog> + showModal() may not work in XUL context
  const overlay = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLDivElement;
  overlay.id = "citegeist-network-overlay";
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.45);
    backdrop-filter: blur(2px);
    display: flex; align-items: center; justify-content: center;
    z-index: 10000;
  `;

  const dialog = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLDivElement;

  dialog.id = "citegeist-network-dialog";
  dialog.style.cssText = `
    width: 780px; max-width: 90vw; max-height: 82vh;
    padding: 0; border: 1px solid rgba(255,255,255,0.1);
    border-radius: 12px;
    background: #2c2c2e; color: #e8e8ed;
    box-shadow: 0 25px 80px rgba(0,0,0,0.6), 0 0 1px rgba(255,255,255,0.1);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px; line-height: 1.4;
    display: flex; flex-direction: column;
    overflow: hidden;
  `;

  const title = item.getField("title");
  const modeLabel = mode === "citing" ? "Cited By" : "References";
  const modeDesc = mode === "citing"
    ? "Works that cite this paper"
    : "Works cited by this paper";

  safeInnerHTML(dialog, buildDialogHTML(title, modeLabel, modeDesc));

  // Inject CSS via DOM-created <style> element AFTER safeInnerHTML
  // (safeInnerHTML clears children first). Styles imported via DOMParser
  // don't apply in XUL documents, so we must create via DOM API.
  const styleEl = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
  styleEl.textContent = getDialogCSS();
  dialog.insertBefore(styleEl, dialog.firstChild);

  overlay.appendChild(dialog);
  parent.appendChild(overlay);
  Zotero.debug("[Citegeist] Dialog appended to DOM");

  // Close on overlay backdrop click
  overlay.addEventListener("click", (e: Event) => {
    if (e.target === overlay) {
      closeDialog(state);
    }
  });

  const state: NetworkState = {
    overlay,
    dialog,
    win,
    work,
    mode,
    results: [],
    selectedIds: new Set(),
    cursor: "*",
    hasMore: true,
    loading: false,
    sortBy: "citations",
    existingDOIs: await getExistingDOIs(),
    generation: 0,
    searchTimeout: null,
  };

  activeDialog = overlay;

  bindDialogEvents(state);
  Zotero.debug("[Citegeist] Loading initial results...");
  await loadResults(state);
  Zotero.debug("[Citegeist] Initial results loaded");

  // Auto-focus search for immediate keyboard use
  const searchInput = dialog.querySelector(".cg-search-input") as HTMLInputElement;
  searchInput?.focus();
}

interface NetworkState {
  /** The backdrop overlay element (parent of dialog) */
  overlay: HTMLElement;
  /** The dialog panel element (contains all UI) */
  dialog: HTMLElement;
  win: Window;
  work: OpenAlexWork;
  mode: NetworkMode;
  results: OpenAlexWork[];
  selectedIds: Set<string>;
  cursor: string;
  hasMore: boolean;
  loading: boolean;
  sortBy: string;
  existingDOIs: Set<string>;
  /** Incremented on tab switch to invalidate in-flight requests */
  generation: number;
  searchTimeout: ReturnType<typeof setTimeout> | null;
}

/**
 * Returns CSS for the dialog as a raw string.
 * Injected via a DOM-created <style> element (not innerHTML)
 * because styles imported via DOMParser don't apply in XUL documents.
 */
function getDialogCSS(): string {
  return `
    #citegeist-network-dialog * { box-sizing: border-box; }

    /* ── Header: single cohesive bar ── */
    .cg-dialog-header {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      flex-shrink: 0;
    }
    .cg-close-btn {
      width: 24px; height: 24px; border-radius: 6px;
      border: none; background: rgba(255,255,255,0.06); color: #8e8e93;
      font-size: 15px; line-height: 1; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; padding: 0;
      transition: background 0.12s, color 0.12s;
    }
    .cg-close-btn:hover { background: rgba(255,255,255,0.12); color: #c8c8cd; }
    .cg-header-text { flex: 1; min-width: 0; }
    .cg-dialog-title {
      font-size: 11px; font-weight: 500; color: #8e8e93;
      letter-spacing: 0.2px; text-transform: uppercase;
    }
    .cg-dialog-subtitle {
      font-size: 13px; font-weight: 600; color: #e8e8ed;
      margin-top: 1px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    /* ── Segmented control tabs ── */
    .cg-dialog-tabs {
      display: flex; gap: 1px; padding: 8px 14px 8px;
      flex-shrink: 0;
      background: rgba(255,255,255,0.02);
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .cg-tabs-inner {
      display: flex; gap: 1px;
      background: rgba(255,255,255,0.06);
      border-radius: 7px; padding: 2px;
      flex-shrink: 0;
    }
    .cg-tab {
      padding: 5px 16px; font-size: 11px; font-weight: 500;
      cursor: pointer; border: none; background: transparent;
      color: #8e8e93; border-radius: 5px;
      transition: all 0.15s;
    }
    .cg-tab.active {
      background: rgba(255,255,255,0.1); color: #e8e8ed;
      font-weight: 600;
    }
    .cg-tab:hover:not(.active) { color: #c8c8cd; }

    /* ── Toolbar ── */
    .cg-dialog-toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 14px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      flex-shrink: 0;
    }
    .cg-search-wrap {
      flex: 1; position: relative;
    }
    .cg-search-icon {
      position: absolute; left: 8px; top: 50%; transform: translateY(-50%);
      color: #48484a; font-size: 12px; pointer-events: none;
    }
    .cg-search-input {
      width: 100%; padding: 6px 10px 6px 28px;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 7px; font-size: 12px;
      background: rgba(255,255,255,0.04); color: #e8e8ed; outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .cg-search-input:focus {
      border-color: rgba(90,156,255,0.5);
      box-shadow: 0 0 0 3px rgba(90,156,255,0.12);
      background: rgba(255,255,255,0.06);
    }
    .cg-search-input::placeholder { color: #48484a; }
    .cg-sort-select {
      padding: 6px 8px; border: 1px solid rgba(255,255,255,0.1);
      border-radius: 7px; font-size: 11px;
      background: rgba(255,255,255,0.04); color: #c8c8cd;
      cursor: pointer;
    }

    /* ── Results body ── */
    .cg-dialog-body {
      flex: 1; overflow-y: auto; padding: 0; min-height: 300px;
    }
    .cg-results-list { list-style: none; margin: 0; padding: 0; }

    /* ── Result items ── */
    .cg-result-item {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      cursor: pointer;
      transition: background 0.1s;
    }
    .cg-result-item:hover { background: rgba(255,255,255,0.025); }
    .cg-result-item.selected { background: rgba(90,156,255,0.07); }
    .cg-result-item.in-library { cursor: default; opacity: 0.45; }
    .cg-result-check {
      flex-shrink: 0; width: 14px; height: 14px; margin-top: 3px;
      accent-color: #5a9cff; cursor: pointer;
    }
    .cg-result-check-done {
      flex-shrink: 0; width: 14px; height: 14px; margin-top: 3px;
      display: flex; align-items: center; justify-content: center;
      color: #30d158; font-size: 12px;
    }
    .cg-result-content { flex: 1; min-width: 0; }
    .cg-result-title {
      font-size: 13px; font-weight: 500; line-height: 1.4;
      margin-bottom: 3px; color: #e8e8ed;
    }
    .cg-result-title a { color: #e8e8ed; text-decoration: none; }
    .cg-result-title a:hover { color: #6ab0ff; }
    .cg-result-meta {
      font-size: 11px; color: #8e8e93; line-height: 1.4;
    }
    .cg-result-meta-authors {
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .cg-result-meta-venue {
      color: #636366; margin-top: 1px;
    }
    .cg-result-year {
      color: #a8a8ad; font-weight: 500;
    }
    .cg-result-badges {
      display: flex; gap: 5px; margin-top: 5px; flex-wrap: wrap;
      align-items: center;
    }
    .cg-result-badge {
      font-size: 10px; padding: 1px 7px; border-radius: 4px;
      font-weight: 600; letter-spacing: 0.1px;
    }
    .cg-badge-oa { background: rgba(48,209,88,0.1); color: #32d74b; }
    .cg-badge-retracted { background: rgba(255,69,58,0.1); color: #ff453a; }
    .cg-badge-in-library { background: rgba(90,156,255,0.1); color: #5a9cff; }

    /* ── Citation count column ── */
    .cg-result-stats {
      flex-shrink: 0; text-align: right; min-width: 56px;
      padding-top: 2px;
    }
    .cg-result-count {
      font-size: 15px; font-weight: 700;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.3px;
    }
    .cg-count-high { color: #ffd60a; }
    .cg-count-medium { color: #e8e8ed; }
    .cg-count-low { color: #8e8e93; }

    /* ── Footer ── */
    .cg-dialog-footer {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px;
      border-top: 1px solid rgba(255,255,255,0.08);
      flex-shrink: 0;
      background: rgba(255,255,255,0.02);
    }
    .cg-footer-info { font-size: 11px; color: #636366; }
    .cg-footer-info .cg-footer-selected {
      color: #5a9cff; font-weight: 600;
    }
    .cg-footer-actions { display: flex; gap: 8px; }
    .cg-btn {
      padding: 6px 14px; border-radius: 7px; font-size: 12px; font-weight: 500;
      cursor: pointer; border: 1px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.06); color: #c8c8cd;
      transition: all 0.12s;
    }
    .cg-btn:hover { background: rgba(255,255,255,0.1); color: #e8e8ed; }
    .cg-btn-primary {
      background: #5a9cff; color: #fff; border-color: transparent;
      font-weight: 600;
    }
    .cg-btn-primary:hover { background: #4a8cf0; }
    .cg-btn-primary:disabled {
      background: rgba(90,156,255,0.15); color: rgba(255,255,255,0.3);
      cursor: default; border-color: transparent;
    }

    /* ── States ── */
    .cg-loading-more {
      text-align: center; padding: 20px; font-size: 12px; color: #48484a;
    }
    .cg-empty {
      text-align: center; padding: 48px 24px;
      color: #636366; font-size: 13px; line-height: 1.5;
    }
    .cg-empty-title {
      font-size: 14px; font-weight: 600; color: #8e8e93;
      margin-bottom: 4px;
    }
    .cg-cap-notice {
      text-align: center; padding: 8px 14px; font-size: 11px;
      color: #48484a; background: rgba(255,255,255,0.02);
      border-top: 1px solid rgba(255,255,255,0.04);
    }
  `;
}

function buildDialogHTML(
  title: string,
  modeLabel: string,
  modeDesc: string,
): string {
  return `
    <div class="cg-dialog-header">
      <button class="cg-close-btn" id="cg-btn-close" title="Close">\u00D7</button>
      <div class="cg-header-text">
        <div class="cg-dialog-title">Citation Network</div>
        <div class="cg-dialog-subtitle">${escapeHTML(title)}</div>
      </div>
    </div>
    <div class="cg-dialog-tabs" role="tablist">
      <div class="cg-tabs-inner">
        <button class="cg-tab" data-mode="citing" role="tab">Cited By</button>
        <button class="cg-tab" data-mode="references" role="tab">References</button>
      </div>
    </div>
    <div class="cg-dialog-toolbar">
      <div class="cg-search-wrap">
        <span class="cg-search-icon">\uD83D\uDD0D</span>
        <input type="text" class="cg-search-input" placeholder="Search titles, authors\u2026" />
      </div>
      <select class="cg-sort-select">
        <option value="citations">Most cited</option>
        <option value="year-desc">Newest</option>
        <option value="year-asc">Oldest</option>
      </select>
    </div>
    <div class="cg-dialog-body">
      <div class="cg-loading-more">Loading\u2026</div>
    </div>
    <div class="cg-dialog-footer">
      <div class="cg-footer-info">
        <span class="cg-footer-selected" id="cg-selected-count">0</span> selected \u00B7 <span id="cg-total-count">\u2026</span>
      </div>
      <div class="cg-footer-actions">
        <button class="cg-btn cg-btn-primary" id="cg-btn-add" disabled>Add to Zotero</button>
      </div>
    </div>
  `;
}

function closeDialog(state: NetworkState): void {
  // Clear pending search timeout
  if (state.searchTimeout) {
    clearTimeout(state.searchTimeout);
    state.searchTimeout = null;
  }
  try { state.overlay.remove(); } catch { /* already gone */ }
  if (activeDialog === state.overlay) {
    activeDialog = null;
  }
}

function bindDialogEvents(state: NetworkState): void {
  const { dialog } = state;

  dialog.querySelector("#cg-btn-close")?.addEventListener("click", () => {
    closeDialog(state);
  });

  // Escape key to close (since we're not using <dialog>.showModal())
  state.overlay.addEventListener("keydown", (e: Event) => {
    if ((e as KeyboardEvent).key === "Escape") {
      closeDialog(state);
    }
  });

  // Tab switching — increment generation to invalidate in-flight requests
  const tabs = dialog.querySelectorAll(".cg-tab");
  tabs.forEach((tab) => {
    const tabEl = tab as HTMLElement;
    if (tabEl.dataset.mode === state.mode) {
      tabEl.classList.add("active");
    }
    tabEl.addEventListener("click", async () => {
      const newMode = tabEl.dataset.mode as NetworkMode;
      if (newMode === state.mode || state.loading) return;

      state.generation++;
      state.mode = newMode;
      state.results = [];
      state.selectedIds.clear();
      state.cursor = "*";
      state.hasMore = true;
      tabs.forEach((t) => (t as HTMLElement).classList.remove("active"));
      tabEl.classList.add("active");
      updateSelectedCount(state);
      await loadResults(state);
    });
  });

  // Search filter (debounced)
  const searchInput = dialog.querySelector(".cg-search-input") as HTMLInputElement;
  searchInput?.addEventListener("input", () => {
    if (state.searchTimeout) clearTimeout(state.searchTimeout);
    state.searchTimeout = setTimeout(() => {
      state.searchTimeout = null;
      renderResults(state, searchInput.value);
    }, 200);
  });

  // Sort
  const sortSelect = dialog.querySelector(".cg-sort-select") as HTMLSelectElement;
  sortSelect?.addEventListener("change", () => {
    state.sortBy = sortSelect.value;
    renderResults(state, searchInput?.value || "");
  });

  // Add to Zotero
  dialog.querySelector("#cg-btn-add")?.addEventListener("click", async () => {
    await addSelectedToZotero(state);
  });

  // Infinite scroll
  const body = dialog.querySelector(".cg-dialog-body") as HTMLElement;
  body?.addEventListener("scroll", async () => {
    if (state.loading || !state.hasMore) return;
    const scrollBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
    if (scrollBottom < 100) {
      await loadResults(state, true);
    }
  });
}

async function loadResults(
  state: NetworkState,
  append: boolean = false,
): Promise<void> {
  if (state.loading) return;
  state.loading = true;
  const gen = state.generation;

  const body = state.dialog.querySelector(".cg-dialog-body") as HTMLElement;

  if (!append) {
    safeInnerHTML(body, `<div class="cg-loading-more">Loading…</div>`);
  } else {
    const loadingEl = state.dialog.ownerDocument.createElement("div");
    loadingEl.className = "cg-loading-more";
    loadingEl.textContent = "Loading more…";
    body.appendChild(loadingEl);
  }

  try {
    const perPage =
      (Zotero.Prefs.get("extensions.zotero.citegeist.networkPageSize") as number) || 25;

    let response;
    if (state.mode === "citing") {
      response = await getCitingWorks(state.work.id, state.cursor, perPage);
    } else {
      response = await getReferencedWorks(state.work.id, state.cursor, perPage);
    }

    // Check if tab was switched while we were fetching
    if (gen !== state.generation) {
      state.loading = false;
      return;
    }

    if (append) {
      state.results.push(...response.results);
    } else {
      state.results = response.results;
    }

    state.cursor = response.meta.next_cursor || "*";
    state.hasMore = !!response.meta.next_cursor;

    const totalEl = state.dialog.querySelector("#cg-total-count");
    if (totalEl) {
      totalEl.textContent = `${response.meta.count.toLocaleString()} total`;
    }

    const searchInput = state.dialog.querySelector(".cg-search-input") as HTMLInputElement;
    renderResults(state, searchInput?.value || "");
  } catch (e) {
    if (gen !== state.generation) {
      state.loading = false;
      return;
    }
    Zotero.debug(`[Citegeist] Error loading results: ${e}`);
    safeInnerHTML(body, `<div class="cg-empty">Error loading results. Please try again.</div>`);
  }

  state.loading = false;
}

function renderResults(state: NetworkState, filter: string = ""): void {
  const body = state.dialog.querySelector(".cg-dialog-body") as HTMLElement;
  if (!body) return;

  let results = state.results;

  if (filter) {
    const lower = filter.toLowerCase();
    results = results.filter(
      (w) =>
        w.display_name?.toLowerCase().includes(lower) ||
        w.title?.toLowerCase().includes(lower) ||
        w.authorships?.some((a) =>
          a.author.display_name.toLowerCase().includes(lower),
        ),
    );
  }

  results = [...results].sort((a, b) => {
    switch (state.sortBy) {
      case "year-desc":
        return (b.publication_year || 0) - (a.publication_year || 0);
      case "year-asc":
        return (a.publication_year || 0) - (b.publication_year || 0);
      default:
        return (b.cited_by_count || 0) - (a.cited_by_count || 0);
    }
  });

  if (results.length === 0 && !state.loading) {
    const emptyMsg = filter
      ? `<div class="cg-empty"><div class="cg-empty-title">No matches</div>Try a different search term</div>`
      : `<div class="cg-empty"><div class="cg-empty-title">No results</div>This work has no ${state.mode === "citing" ? "citing works" : "references"} in OpenAlex</div>`;
    safeInnerHTML(body, emptyMsg);
    return;
  }

  // Cap rendered results for performance
  const totalMatches = results.length;
  const capped = results.length > MAX_RENDERED_RESULTS;
  if (capped) {
    results = results.slice(0, MAX_RENDERED_RESULTS);
  }

  let html = `<ul class="cg-results-list">`;
  for (const work of results) {
    const workId = work.id.replace("https://openalex.org/", "");
    const isSelected = state.selectedIds.has(workId);
    const authors = formatAuthors(work.authorships);
    const source = getSourceName(work);
    const cleanDOI = work.doi ? work.doi.replace("https://doi.org/", "") : null;
    const inLibrary = cleanDOI ? state.existingDOIs.has(cleanDOI.toLowerCase()) : false;

    const checkCol = inLibrary
      ? `<div class="cg-result-check-done" title="Already in library">\u2713</div>`
      : `<input type="checkbox" class="cg-result-check" ${isSelected ? "checked" : ""} />`;

    // Citation count heat coloring: gold for exceptional, white for notable, grey for modest
    const count = work.cited_by_count || 0;
    const countClass = count >= 1000 ? "cg-count-high" : count >= 50 ? "cg-count-medium" : "cg-count-low";

    // Structured meta: authors on line 1, venue · year on line 2
    const yearStr = work.publication_year ? String(work.publication_year) : "n.d.";

    html += `
      <li class="cg-result-item${isSelected ? " selected" : ""}${inLibrary ? " in-library" : ""}" data-work-id="${escapeHTML(workId)}">
        ${checkCol}
        <div class="cg-result-content">
          <div class="cg-result-title">
            ${cleanDOI
              ? `<a href="https://doi.org/${escapeHTML(cleanDOI)}" title="Open DOI">${escapeHTML(work.display_name || work.title || "Untitled")}</a>`
              : escapeHTML(work.display_name || work.title || "Untitled")}
          </div>
          <div class="cg-result-meta">
            <div class="cg-result-meta-authors">${escapeHTML(authors)}</div>
            <div class="cg-result-meta-venue">${escapeHTML(source)} \u00B7 <span class="cg-result-year">${escapeHTML(yearStr)}</span></div>
          </div>
          <div class="cg-result-badges">
            ${work.open_access?.is_oa ? `<span class="cg-result-badge cg-badge-oa">Open Access</span>` : ""}
            ${work.is_retracted ? `<span class="cg-result-badge cg-badge-retracted">Retracted</span>` : ""}
            ${inLibrary ? `<span class="cg-result-badge cg-badge-in-library">In Library</span>` : ""}
          </div>
        </div>
        <div class="cg-result-stats">
          <div class="cg-result-count ${countClass}">${escapeHTML(count.toLocaleString())}</div>
        </div>
      </li>`;
  }
  html += `</ul>`;

  if (capped) {
    html += `<div class="cg-cap-notice">Showing ${MAX_RENDERED_RESULTS} of ${totalMatches} matches. Use the filter to narrow results.</div>`;
  } else if (state.hasMore) {
    html += `<div class="cg-loading-more">Scroll for more…</div>`;
  }

  safeInnerHTML(body, html);

  // Bind click events via delegation on the list
  const list = body.querySelector(".cg-results-list");
  if (list) {
    list.addEventListener("click", (e: Event) => {
      const target = e.target as HTMLElement;

      // Handle DOI link clicks
      if (target.tagName === "A") {
        e.preventDefault();
        e.stopPropagation();
        const href = (target as HTMLAnchorElement).getAttribute("href");
        if (href) Zotero.launchURL(href);
        return;
      }

      // Find the parent result item
      const itemEl = target.closest(".cg-result-item") as HTMLElement | null;
      if (!itemEl) return;

      const workId = itemEl.dataset.workId;
      if (!workId) return;

      // Items already in library can't be selected
      if (itemEl.classList.contains("in-library")) return;

      const checkbox = itemEl.querySelector(".cg-result-check") as HTMLInputElement;

      if (state.selectedIds.has(workId)) {
        state.selectedIds.delete(workId);
        itemEl.classList.remove("selected");
        if (checkbox) checkbox.checked = false;
      } else {
        state.selectedIds.add(workId);
        itemEl.classList.add("selected");
        if (checkbox) checkbox.checked = true;
      }
      updateSelectedCount(state);
    });
  }
}

function updateSelectedCount(state: NetworkState): void {
  const countEl = state.dialog.querySelector("#cg-selected-count");
  if (countEl) {
    countEl.textContent = String(state.selectedIds.size);
  }
  const addBtn = state.dialog.querySelector("#cg-btn-add") as HTMLButtonElement;
  if (addBtn) {
    addBtn.disabled = state.selectedIds.size === 0;
    if (state.selectedIds.size > 0) {
      addBtn.textContent = `Add ${state.selectedIds.size} to Zotero`;
    } else {
      addBtn.textContent = "Add to Zotero";
    }
  }
}

async function addSelectedToZotero(state: NetworkState): Promise<void> {
  const addBtn = state.dialog.querySelector("#cg-btn-add") as HTMLButtonElement;
  if (addBtn) {
    addBtn.disabled = true;
    addBtn.textContent = "Adding…";
  }

  let added = 0;
  const selectedWorks = state.results.filter((w) =>
    state.selectedIds.has(w.id.replace("https://openalex.org/", "")),
  );

  for (const work of selectedWorks) {
    try {
      await createZoteroItemFromWork(work);
      added++;
    } catch (e) {
      Zotero.debug(`[Citegeist] Error adding work ${work.id}: ${e}`);
    }
  }

  // Only refresh DOIs after adding (not on open — cached from dialog start)
  state.existingDOIs = await getExistingDOIs();
  state.selectedIds.clear();
  updateSelectedCount(state);

  const searchInput = state.dialog.querySelector(".cg-search-input") as HTMLInputElement;
  renderResults(state, searchInput?.value || "");

  if (addBtn) {
    addBtn.textContent = `\u2713 Added ${added} item${added !== 1 ? "s" : ""}`;
    setTimeout(() => {
      addBtn.textContent = "Add to Zotero";
    }, 2000);
  }
}

async function createZoteroItemFromWork(
  work: OpenAlexWork,
): Promise<_ZoteroTypes.Item> {
  const typeMap: Record<string, string> = {
    "article": "journalArticle",
    "book-chapter": "bookSection",
    "book": "book",
    "dissertation": "thesis",
    "dataset": "dataset",
    "preprint": "preprint",
    "review": "journalArticle",
    "paratext": "journalArticle",
    "report": "report",
    "editorial": "journalArticle",
    "letter": "journalArticle",
    "erratum": "journalArticle",
  };

  const itemType = typeMap[work.type] || "journalArticle";
  const item = new Zotero.Item(itemType);

  item.setField("title", work.display_name || work.title || "Untitled");

  if (work.doi) {
    item.setField("DOI", work.doi.replace("https://doi.org/", ""));
  }

  if (work.publication_date) {
    item.setField("date", work.publication_date);
  } else if (work.publication_year) {
    item.setField("date", String(work.publication_year));
  }

  if (work.primary_location?.source) {
    const source = work.primary_location.source;
    if (itemType === "journalArticle" || itemType === "preprint") {
      item.setField("publicationTitle", source.display_name);
      if (source.issn_l) item.setField("ISSN", source.issn_l);
    } else if (itemType === "bookSection") {
      item.setField("bookTitle", source.display_name);
    }
  }

  if (work.biblio) {
    if (work.biblio.volume) item.setField("volume", work.biblio.volume);
    if (work.biblio.issue) item.setField("issue", work.biblio.issue);
    if (work.biblio.first_page) {
      const pages = work.biblio.last_page
        ? `${work.biblio.first_page}-${work.biblio.last_page}`
        : work.biblio.first_page;
      item.setField("pages", pages);
    }
  }

  if (work.open_access?.oa_url) {
    item.setField("url", work.open_access.oa_url);
  }

  // Author name handling: use fieldMode=1 (single-field) for names
  // that are likely to be mis-split by simple last-word heuristics.
  // Single-word names, names with particles, etc.
  if (work.authorships && work.authorships.length > 0) {
    const creators = work.authorships.map((a) => {
      const displayName = a.author.display_name.trim();
      const parts = displayName.split(/\s+/);

      // Single-word name or name with common particles — use single-field mode
      if (parts.length <= 1) {
        return {
          lastName: displayName,
          firstName: "",
          creatorType: "author",
          fieldMode: 1, // Single-field mode in Zotero
        };
      }

      // Best-effort split: last token as family name, rest as given
      // This is imperfect for "van der Berg" etc., but matches
      // how most bibliography tools handle OpenAlex display_name.
      const lastName = parts[parts.length - 1];
      const firstName = parts.slice(0, -1).join(" ");
      return { firstName, lastName, creatorType: "author" };
    });
    item.setCreators(creators);
  }

  item.addTag("Citegeist:imported", 1);
  await item.saveTx();

  return item;
}

/**
 * Build a set of DOIs in the user's library using Zotero.Search.
 * More efficient than loading all items — only fetches items with DOIs.
 */
async function getExistingDOIs(): Promise<Set<string>> {
  const dois = new Set<string>();
  try {
    const s = new Zotero.Search();
    s.libraryID = Zotero.Libraries.userLibraryID;
    s.addCondition("DOI", "isNot", "");
    const ids = await s.search();
    if (ids && ids.length > 0) {
      const items = await Zotero.Items.getAsync(ids);
      const itemArray = Array.isArray(items) ? items : [items];
      for (const item of itemArray) {
        const doi = item.getField("DOI");
        if (doi) dois.add(doi.toLowerCase());
      }
    }
  } catch (e) {
    Zotero.debug(`[Citegeist] Error getting existing DOIs: ${e}`);
  }
  return dois;
}

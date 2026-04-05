/**
 * Citation Network Browser
 *
 * Opens a modal showing works that cite or are cited by the selected item.
 * Each row shows title (linked to DOI), authors, year, journal, citation
 * count, OA/retracted badges. Click a row to expand its abstract.
 * One-click split button per row: main click adds to default collection,
 * ▾ opens a per-item collection picker. Items already in library get a
 * "File ▾" button to manage collection membership.
 *
 * Performance:
 *  - Event delegation bound once on the body element (survives re-renders)
 *  - Expand/collapse uses targeted DOM insertion, not full re-render
 *  - Abstracts fetched on-demand and cached
 */

import {
  getCitingWorks,
  getReferencedWorks,
  getWorkByDOI,
  getWorkById,
  getSourceStats,
  reconstructAbstract,
  formatAuthors,
  getSourceName,
  type OpenAlexWork,
} from "./openalex";
import { cacheWorkData } from "./cache";
import { invalidateColumnCache } from "./citationColumn";
import { escapeHTML, safeInnerHTML } from "./utils";

type NetworkMode = "citing" | "references";

const MAX_RENDERED_RESULTS = 200;
const UNDO_TIMEOUT_MS = 8000;

/** Common surname prefixes that belong with the last name, not the first. */
const SURNAME_PREFIXES = new Set([
  "van", "von", "de", "del", "della", "di", "da", "dos", "das", "du",
  "la", "le", "el", "al", "bin", "ibn", "ben", "ter", "ten",
]);

let activeDialog: HTMLElement | null = null;

// ────────────────────────────────────────────────────────
// State interfaces
// ────────────────────────────────────────────────────────

interface CollectionNode {
  id: number;
  name: string;
  depth: number;
  parentId: number | false;
  hasChildren: boolean;
}

interface NetworkState {
  overlay: HTMLElement;
  dialog: HTMLElement;
  win: Window;
  work: OpenAlexWork;
  mode: NetworkMode;
  results: OpenAlexWork[];
  cursor: string;
  hasMore: boolean;
  loading: boolean;
  sortBy: string;
  existingDOIs: Set<string>;
  /** Incremented on tab switch to invalidate in-flight requests */
  generation: number;
  searchTimeout: ReturnType<typeof setTimeout> | null;
  /** Default collection IDs for new items */
  defaultCollectionIds: Set<number>;
  /** Flat list of all collections for pickers */
  allCollections: CollectionNode[];
  /** Currently expanded work IDs (for abstract view) */
  expandedIds: Set<string>;
  /** Cached abstracts keyed by work ID */
  abstractCache: Map<string, string | null>;
  /** Work IDs with pending undo — maps to timeout handle */
  undoTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Work IDs that were added this session (past undo window) */
  addedThisSession: Set<string>;
  /** Map of item DOI → collection IDs it belongs to (for filing) */
  itemCollections: Map<string, Set<number>>;
  /** Map of work ID → Zotero item ID for undo tracking */
  createdItemIds: Map<string, number>;
  /** Expanded parent IDs in the default collection picker */
  defaultPickerExpanded: Set<number>;
}

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
    Services.prompt.alert(null, "Citegeist", "This item has no DOI. Citation network requires a DOI.");
    return;
  }

  if (activeDialog) {
    try { activeDialog.remove(); } catch { /* already gone */ }
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

  // Close on Escape/backdrop while loading
  const earlyClose = (e: Event) => {
    if ((e as KeyboardEvent).key === "Escape" || e.target === overlay) {
      try { overlay.remove(); } catch { /* gone */ }
      if (activeDialog === overlay) activeDialog = null;
    }
  };
  overlay.addEventListener("keydown", earlyClose);
  overlay.addEventListener("click", earlyClose);

  // Fetch work + existing DOIs in parallel (user sees skeleton)
  const allCollections = buildCollectionTree();
  const defaultCollectionIds = new Set<number>();
  try {
    const zp = Zotero.getActiveZoteroPane();
    const currentCol = zp?.getSelectedCollection?.();
    if (currentCol) defaultCollectionIds.add(currentCol.id);
  } catch { /* library root */ }

  const [work, existingDOIs] = await Promise.all([
    getWorkByDOI(doi),
    getExistingDOIs(),
  ]);

  // Check if dialog was closed during loading
  if (activeDialog !== overlay) return;

  if (!work) {
    if (body) {
      safeInnerHTML(body, `<div class="cg-empty">
        <div class="cg-empty-title">Not found on OpenAlex</div>
        This work could not be found. It may not be indexed yet.
      </div>`);
    }
    return;
  }

  // Remove early close handlers, bind full event set
  overlay.removeEventListener("keydown", earlyClose);
  overlay.removeEventListener("click", earlyClose);

  const state: NetworkState = {
    overlay, dialog, win, work, mode,
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
  };

  bindDialogEvents(state);
  updateDefaultCollectionLabel(state);
  await loadResults(state);

  const searchInput = dialog.querySelector(".cg-search-input") as HTMLInputElement;
  searchInput?.focus();
}

// ────────────────────────────────────────────────────────
// CSS
// ────────────────────────────────────────────────────────

function getDialogCSS(): string {
  return `
    #citegeist-network-dialog * { box-sizing: border-box; }

    /* ── Header ── */
    .cg-dialog-header {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid rgba(128,128,128,0.08);
      flex-shrink: 0;
    }
    .cg-close-btn {
      width: 24px; height: 24px; border-radius: 6px;
      border: none; background: rgba(255,69,58,0.12); color: #ff453a;
      font-size: 15px; line-height: 1; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; padding: 0;
      transition: background 0.12s, color 0.12s;
    }
    .cg-close-btn:hover { background: rgba(255,69,58,0.22); color: #ff6961; }
    .cg-close-btn:focus-visible { outline: 2px solid #5a9cff; outline-offset: 1px; }
    .cg-header-text { flex: 1; min-width: 0; }
    .cg-dialog-title {
      font-size: 11px; font-weight: 500; color: var(--fill-secondary, #8e8e93);
      letter-spacing: 0.2px; text-transform: uppercase;
    }
    .cg-dialog-subtitle {
      font-size: 13px; font-weight: 600; color: var(--fill-primary, #e8e8ed);
      margin-top: 1px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    /* ── Tabs ── */
    .cg-dialog-tabs {
      display: flex; gap: 1px; padding: 8px 14px;
      flex-shrink: 0;
      background: rgba(128,128,128,0.02);
      border-bottom: 1px solid rgba(128,128,128,0.06);
    }
    .cg-tabs-inner {
      display: flex; gap: 1px;
      background: rgba(128,128,128,0.06);
      border-radius: 7px; padding: 2px;
    }
    .cg-tab {
      padding: 5px 16px; font-size: 11px; font-weight: 500;
      cursor: pointer; border: none; background: transparent;
      color: var(--fill-secondary, #8e8e93); border-radius: 5px;
      transition: background 0.15s, color 0.15s;
    }
    .cg-tab.active { background: rgba(128,128,128,0.1); color: var(--fill-primary, #e8e8ed); font-weight: 600; }
    .cg-tab:hover:not(.active) { color: var(--fill-secondary, #c8c8cd); }
    .cg-tab:focus-visible { outline: 2px solid #5a9cff; outline-offset: 1px; }

    /* ── Toolbar ── */
    .cg-dialog-toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 14px;
      border-bottom: 1px solid rgba(128,128,128,0.06);
      flex-shrink: 0;
    }
    .cg-search-wrap { flex: 1; position: relative; }
    .cg-search-icon {
      position: absolute; left: 8px; top: 50%; transform: translateY(-50%);
      color: var(--fill-quaternary, #48484a); font-size: 12px; pointer-events: none;
    }
    .cg-search-input {
      width: 100%; padding: 6px 10px 6px 28px;
      border: 1px solid rgba(128,128,128,0.1);
      border-radius: 7px; font-size: 12px;
      background: rgba(128,128,128,0.04); color: var(--fill-primary, #e8e8ed); outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .cg-search-input:focus {
      border-color: rgba(90,156,255,0.5);
      box-shadow: 0 0 0 3px rgba(90,156,255,0.12);
      background: rgba(128,128,128,0.06);
    }
    .cg-search-input::placeholder { color: var(--fill-quaternary, #48484a); }
    .cg-sort-select {
      padding: 6px 8px; border: 1px solid rgba(128,128,128,0.1);
      border-radius: 7px; font-size: 11px;
      background: rgba(128,128,128,0.04); color: var(--fill-secondary, #c8c8cd); cursor: pointer;
    }
    .cg-sort-select:focus-visible { outline: 2px solid #5a9cff; outline-offset: 1px; }

    /* ── Results body ── */
    .cg-dialog-body { flex: 1; overflow-y: auto; padding: 0; min-height: 300px; }
    .cg-results-list { list-style: none; margin: 0; padding: 0; }

    /* ── Result items ── */
    .cg-result-item {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid rgba(128,128,128,0.04);
      cursor: pointer;
      transition: background 0.1s;
    }
    .cg-result-item:hover { background: rgba(128,128,128,0.025); }
    .cg-result-content { flex: 1; min-width: 0; }
    .cg-result-title {
      font-size: 13px; font-weight: 500; line-height: 1.4;
      margin-bottom: 3px; color: var(--fill-primary, #e8e8ed);
    }
    .cg-result-title a {
      color: var(--fill-primary, #e8e8ed); text-decoration: none;
      transition: color 0.1s;
    }
    .cg-result-title a:hover { color: #6ab0ff; text-decoration: underline; }
    .cg-result-title a:focus-visible {
      outline: 2px solid #5a9cff; outline-offset: 1px; border-radius: 2px;
    }
    .cg-result-title .cg-no-link {
      color: var(--fill-secondary, #8e8e93); cursor: default;
    }
    .cg-result-meta { font-size: 11px; color: var(--fill-secondary, #8e8e93); line-height: 1.4; }
    .cg-result-meta-authors {
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .cg-result-meta-venue { color: var(--fill-tertiary, #636366); margin-top: 1px; }
    .cg-result-year { color: var(--fill-secondary, #a8a8ad); font-weight: 500; }
    .cg-result-badges {
      display: flex; gap: 5px; margin-top: 5px; flex-wrap: wrap; align-items: center;
    }
    .cg-result-badge {
      font-size: 10px; padding: 1px 7px; border-radius: 4px;
      font-weight: 600; letter-spacing: 0.1px;
    }
    .cg-badge-oa { background: rgba(48,209,88,0.1); color: #32d74b; }
    .cg-badge-retracted { background: rgba(255,69,58,0.1); color: #ff453a; }
    .cg-badge-in-library { background: rgba(90,156,255,0.1); color: #5a9cff; }
    .cg-badge-no-doi { background: rgba(128,128,128,0.04); color: var(--fill-tertiary, #636366); }

    /* ── Right column: count + action ── */
    .cg-result-right {
      flex-shrink: 0; display: flex; flex-direction: column;
      align-items: flex-end; gap: 6px; min-width: 130px;
    }
    .cg-result-count {
      font-size: 15px; font-weight: 700;
      font-variant-numeric: tabular-nums; letter-spacing: -0.3px;
    }
    .cg-count-high { color: var(--accent-blue, #5a9cff); font-weight: 800; }
    .cg-count-medium { color: var(--fill-primary, #e8e8ed); }
    .cg-count-low { color: var(--fill-secondary, #8e8e93); }

    /* ── Split button ── */
    .cg-split-btn {
      display: inline-flex; align-items: stretch;
      border-radius: 7px;
      border: 1px solid rgba(90,156,255,0.25);
      font-size: 11px; font-weight: 500;
      transition: border-color 0.12s;
    }
    .cg-split-btn > .cg-split-main:first-child { border-radius: 6px 0 0 6px; }
    .cg-split-btn > .cg-split-arrow:last-of-type { border-radius: 0 6px 6px 0; }
    .cg-split-btn:hover { border-color: rgba(90,156,255,0.4); }
    .cg-split-main {
      padding: 4px 10px; background: rgba(90,156,255,0.08); color: #5a9cff;
      border: none; cursor: pointer;
      white-space: nowrap; max-width: 180px;
      overflow: hidden; text-overflow: ellipsis;
      transition: background 0.12s;
    }
    .cg-split-main:hover { background: rgba(90,156,255,0.15); }
    .cg-split-main:focus-visible { outline: 2px solid #5a9cff; outline-offset: -2px; }
    .cg-split-arrow {
      padding: 4px 6px; background: rgba(90,156,255,0.06); color: #5a9cff;
      border: none; border-left: 1px solid rgba(90,156,255,0.2);
      cursor: pointer; font-size: 9px;
      display: flex; align-items: center;
      transition: background 0.12s;
    }
    .cg-split-arrow:hover { background: rgba(90,156,255,0.15); }
    .cg-split-arrow:focus-visible { outline: 2px solid #5a9cff; outline-offset: -2px; }

    /* Added state */
    .cg-split-btn.cg-state-added { border-color: rgba(48,209,88,0.25); }
    .cg-split-btn.cg-state-added .cg-split-main {
      background: rgba(48,209,88,0.08); color: #30d158;
    }
    .cg-split-btn.cg-state-added .cg-split-main:hover {
      background: rgba(48,209,88,0.15);
    }

    /* File state (in library) */
    .cg-split-btn.cg-state-file { border-color: rgba(128,128,128,0.12); }
    .cg-split-btn.cg-state-file .cg-split-main {
      background: rgba(128,128,128,0.04); color: var(--fill-secondary, #a8a8ad);
    }
    .cg-split-btn.cg-state-file .cg-split-main:hover {
      background: rgba(128,128,128,0.08); color: var(--fill-secondary, #c8c8cd);
    }
    .cg-split-btn.cg-state-file .cg-split-arrow {
      background: rgba(128,128,128,0.02); color: var(--fill-tertiary, #636366);
      border-left-color: rgba(128,128,128,0.08);
    }
    .cg-split-btn.cg-state-file .cg-split-arrow:hover {
      background: rgba(128,128,128,0.08); color: var(--fill-secondary, #a8a8ad);
    }

    /* Adding spinner */
    .cg-spinner {
      display: inline-block; width: 12px; height: 12px;
      border: 2px solid rgba(90,156,255,0.2);
      border-top-color: #5a9cff; border-radius: 50%;
      animation: cg-spin 0.6s linear infinite;
      vertical-align: middle;
    }
    @keyframes cg-spin { to { transform: rotate(360deg); } }

    /* ── Expanded detail area ── */
    .cg-result-expanded {
      padding: 8px 14px 12px 14px;
      border-bottom: 1px solid rgba(128,128,128,0.04);
      background: rgba(128,128,128,0.015);
      animation: cg-expand-in 0.15s ease-out;
    }
    @keyframes cg-expand-in {
      from { opacity: 0; } to { opacity: 1; }
    }
    .cg-abstract-text {
      font-size: 12px; line-height: 1.55; color: var(--fill-secondary, #a8a8ad);
      display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .cg-abstract-loading {
      font-size: 12px; color: var(--fill-tertiary, #636366); font-style: italic;
    }
    .cg-abstract-none {
      font-size: 12px; color: var(--fill-quaternary, #48484a); font-style: italic;
    }

    /* ── Expand affordance ── */
    .cg-expand-hint {
      font-size: 10px; color: var(--fill-quaternary, #48484a);
      margin-top: 4px; cursor: pointer;
      transition: color 0.12s;
    }
    .cg-result-item:hover .cg-expand-hint { color: var(--fill-secondary, #8e8e93); }
    .cg-expand-chevron {
      display: inline-block; transition: transform 0.15s ease;
      font-size: 9px; margin-right: 3px;
    }
    .cg-result-item[aria-expanded="true"] .cg-expand-chevron {
      transform: rotate(90deg);
    }

    /* ── Undo countdown bar ── */
    .cg-undo-bar {
      position: absolute; bottom: 0; left: 0; height: 2px;
      background: #30d158; border-radius: 0 0 6px 6px;
      animation: cg-undo-shrink 8s linear forwards;
    }
    @keyframes cg-undo-shrink { from { width: 100%; } to { width: 0; } }

    /* ── Result item focus (keyboard nav) ── */
    .cg-result-item:focus-visible {
      outline: 2px solid #5a9cff; outline-offset: -2px;
      background: rgba(90,156,255,0.04);
    }
    .cg-result-item:focus { outline: none; }

    /* ── Skeleton loading ── */
    .cg-skeleton-row {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 12px 14px; border-bottom: 1px solid rgba(128,128,128,0.04);
    }
    .cg-skeleton-bar {
      height: 12px; border-radius: 4px;
      background: rgba(128,128,128,0.08);
      animation: cg-pulse 1.5s ease-in-out infinite;
    }
    @keyframes cg-pulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 0.8; }
    }
    .cg-skeleton-content { flex: 1; }
    .cg-skeleton-title { width: 70%; height: 14px; margin-bottom: 8px; }
    .cg-skeleton-meta { width: 50%; height: 10px; margin-bottom: 4px; }
    .cg-skeleton-meta2 { width: 35%; height: 10px; }
    .cg-skeleton-right { width: 40px; height: 20px; flex-shrink: 0; }

    /* ── Per-item collection picker (dropdown) ── */
    .cg-item-picker {
      position: absolute; right: 0; top: calc(100% + 4px);
      width: 270px; max-height: 300px;
      display: flex; flex-direction: column;
      background: var(--material-background, #1c1c1e); border: 1px solid rgba(128,128,128,0.12);
      border-radius: 10px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5);
      z-index: 20;
      animation: cg-picker-in 0.12s ease-out;
    }
    @keyframes cg-picker-in {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .cg-item-picker[hidden] { display: none; }
    .cg-picker-list {
      flex: 1; overflow-y: auto; padding: 4px 0;
      min-height: 0;
    }
    .cg-picker-option {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 12px; font-size: 12px; color: var(--fill-secondary, #c8c8cd);
      cursor: pointer; border: none; background: transparent;
      width: 100%; text-align: left;
      transition: background 0.1s;
    }
    .cg-picker-option:hover { background: rgba(128,128,128,0.06); }
    .cg-picker-option:focus-visible { outline: 2px solid #5a9cff; outline-offset: -2px; }
    .cg-picker-option[hidden] { display: none; }
    .cg-picker-check {
      width: 14px; height: 14px; flex-shrink: 0;
      border: 1.5px solid rgba(128,128,128,0.2); border-radius: 3px;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; color: transparent;
    }
    .cg-picker-option.checked .cg-picker-check {
      background: #5a9cff; border-color: #5a9cff; color: #fff;
    }
    .cg-picker-chevron {
      width: 14px; height: 14px; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 9px; color: var(--fill-tertiary, #8e8e93);
      transition: transform 0.15s ease;
      cursor: pointer;
      margin-left: -4px;
    }
    .cg-picker-chevron.expanded { transform: rotate(90deg); }
    .cg-picker-label {
      flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .cg-picker-separator {
      height: 1px; background: rgba(128,128,128,0.06); margin: 4px 12px;
    }
    .cg-picker-actions {
      display: flex; justify-content: flex-end; padding: 6px 12px;
      border-top: 1px solid rgba(128,128,128,0.06);
      flex-shrink: 0;
      background: var(--material-background, #1c1c1e);
      border-radius: 0 0 10px 10px;
    }
    .cg-picker-done {
      padding: 5px 16px; border-radius: 6px; font-size: 11px; font-weight: 600;
      background: #5a9cff; color: #fff; border: none; cursor: pointer;
      transition: background 0.12s;
    }
    .cg-picker-done:hover { background: #4a8cf0; }
    .cg-picker-done:focus-visible { outline: 2px solid #5a9cff; outline-offset: 2px; }

    /* ── Footer ── */
    .cg-dialog-footer {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px;
      border-top: 1px solid rgba(128,128,128,0.08);
      flex-shrink: 0;
      background: rgba(128,128,128,0.02);
    }
    .cg-footer-info { font-size: 11px; color: var(--fill-tertiary, #636366); }
    .cg-footer-right {
      display: flex; align-items: center; gap: 8px;
    }
    .cg-footer-label { font-size: 11px; color: var(--fill-tertiary, #636366); }
    .cg-default-chip {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 5px 10px; border-radius: 7px; font-size: 11px; font-weight: 500;
      background: rgba(128,128,128,0.06); color: var(--fill-secondary, #c8c8cd);
      border: 1px solid rgba(128,128,128,0.1);
      cursor: pointer; white-space: nowrap; max-width: 200px;
      transition: background 0.12s;
    }
    .cg-default-chip:hover { background: rgba(128,128,128,0.1); }
    .cg-default-chip:focus-visible { outline: 2px solid #5a9cff; outline-offset: 1px; }
    .cg-default-chip-label {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .cg-default-chip-extra { color: #5a9cff; font-weight: 600; flex-shrink: 0; }
    .cg-default-dropdown {
      position: absolute; bottom: calc(100% + 6px); right: 0;
      width: 270px; max-height: 300px;
      display: flex; flex-direction: column;
      background: var(--material-background, #1c1c1e); border: 1px solid rgba(128,128,128,0.12);
      border-radius: 10px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5);
      z-index: 20;
      animation: cg-picker-in 0.12s ease-out;
    }
    .cg-default-dropdown[hidden] { display: none; }

    /* ── States ── */
    .cg-loading-more {
      text-align: center; padding: 20px; font-size: 12px; color: var(--fill-quaternary, #48484a);
    }
    .cg-empty {
      text-align: center; padding: 48px 24px;
      color: var(--fill-tertiary, #636366); font-size: 13px; line-height: 1.5;
    }
    .cg-empty-title {
      font-size: 14px; font-weight: 600; color: var(--fill-secondary, #8e8e93); margin-bottom: 4px;
    }
    .cg-cap-notice {
      text-align: center; padding: 8px 14px; font-size: 11px;
      color: var(--fill-quaternary, #48484a); background: rgba(128,128,128,0.02);
      border-top: 1px solid rgba(128,128,128,0.04);
    }
  `;
}

// ────────────────────────────────────────────────────────
// Dialog HTML shell
// ────────────────────────────────────────────────────────

function buildDialogHTML(title: string): string {
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
        <button class="cg-tab" data-mode="citing" role="tab"
                aria-selected="false" tabindex="0">Cited By</button>
        <button class="cg-tab" data-mode="references" role="tab"
                aria-selected="false" tabindex="0">References</button>
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
        <option value="year-desc">Newest</option>
        <option value="year-asc">Oldest</option>
      </select>
    </div>
    <div class="cg-dialog-body">
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

function closeDialog(state: NetworkState): void {
  if (state.searchTimeout) clearTimeout(state.searchTimeout);
  // Clear all undo timers
  for (const timer of state.undoTimers.values()) clearTimeout(timer);
  state.undoTimers.clear();
  try { state.overlay.remove(); } catch { /* already gone */ }
  if (activeDialog === state.overlay) activeDialog = null;
}

// ────────────────────────────────────────────────────────
// Event binding (once, delegation-based)
// ────────────────────────────────────────────────────────

function bindDialogEvents(state: NetworkState): void {
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

  // Tabs
  const tabs = dialog.querySelectorAll(".cg-tab");
  tabs.forEach((tab) => {
    const tabEl = tab as HTMLElement;
    if (tabEl.dataset.mode === state.mode) {
      tabEl.classList.add("active");
      tabEl.setAttribute("aria-selected", "true");
    }
    tabEl.addEventListener("click", async () => {
      const newMode = tabEl.dataset.mode as NetworkMode;
      if (newMode === state.mode || state.loading) return;
      state.generation++;
      state.mode = newMode;
      state.results = [];
      state.expandedIds.clear();
      state.cursor = "*";
      state.hasMore = true;
      tabs.forEach((t) => {
        (t as HTMLElement).classList.remove("active");
        (t as HTMLElement).setAttribute("aria-selected", "false");
      });
      tabEl.classList.add("active");
      tabEl.setAttribute("aria-selected", "true");
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
    }, 200);
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

    // Title link → open article (use localName for XUL compat — tagName case varies)
    const link = target.closest(".cg-result-title") ? target.closest("[href]") as HTMLAnchorElement : null;
    if (!link && (target.localName === "a" || target.tagName === "A") && target.closest(".cg-result-title")) {
      // Direct click on <a> — also handle in case closest("[href]") fails in XUL
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

    // Split button main → add / undo / file
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

    // Split button arrow → open per-item picker
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

    // Row click → expand/collapse abstract
    const itemEl = target.closest(".cg-result-item") as HTMLElement | null;
    if (itemEl) {
      const workId = itemEl.dataset.workId;
      if (workId) toggleExpanded(state, workId);
      return;
    }
  });

  // Keyboard on body — buttons + row navigation
  body?.addEventListener("keydown", (e: Event) => {
    const ke = e as KeyboardEvent;
    const target = ke.target as HTMLElement;

    // Button activation
    if (ke.key === "Enter" || ke.key === " ") {
      if (target.classList.contains("cg-split-main") || target.classList.contains("cg-split-arrow")) {
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
          items.forEach((el, i) => { if (el === row) idx = i; });
        }
        const next = ke.key === "ArrowDown"
          ? Math.min(idx + 1, items.length - 1)
          : Math.max(idx - 1, 0);
        (items[next] as HTMLElement).focus();
        return;
      }
    }

    // Enter on row → expand/collapse
    if (ke.key === "Enter" && target.classList.contains("cg-result-item")) {
      ke.preventDefault();
      const workId = target.dataset.workId;
      if (workId) toggleExpanded(state, workId);
    }
  });

  // Infinite scroll
  body?.addEventListener("scroll", async () => {
    if (state.loading || !state.hasMore) return;
    const scrollBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
    if (scrollBottom < 100) await loadResults(state, true);
  });

  // Focus trap — keep Tab within dialog
  dialog.addEventListener("keydown", (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key !== "Tab") return;
    const focusable = dialog.querySelectorAll(
      'button:not([disabled]), [href], input, select, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;
    if (ke.shiftKey && (dialog.ownerDocument.activeElement === first || dialog.contains(dialog.ownerDocument.activeElement) && dialog.ownerDocument.activeElement === first)) {
      ke.preventDefault();
      last.focus();
    } else if (!ke.shiftKey && dialog.ownerDocument.activeElement === last) {
      ke.preventDefault();
      first.focus();
    }
  });

  // Default collection picker
  initDefaultCollectionPicker(state);
}

// ────────────────────────────────────────────────────────
// Loading & rendering
// ────────────────────────────────────────────────────────

async function loadResults(state: NetworkState, append = false): Promise<void> {
  if (state.loading) return;
  state.loading = true;
  const gen = state.generation;
  const body = state.dialog.querySelector(".cg-dialog-body") as HTMLElement;

  if (!append) {
    safeInnerHTML(body, `<div class="cg-loading-more">Loading\u2026</div>`);
  } else {
    const el = state.dialog.ownerDocument.createElement("div");
    el.className = "cg-loading-more";
    el.textContent = "Loading more\u2026";
    body.appendChild(el);
  }

  try {
    const perPage = (Zotero.Prefs.get("extensions.zotero.citegeist.networkPageSize") as number) || 25;
    const response = state.mode === "citing"
      ? await getCitingWorks(state.work.id, state.cursor, perPage)
      : await getReferencedWorks(state.work.id, state.cursor, perPage);

    if (gen !== state.generation) { state.loading = false; return; }

    if (append) {
      state.results.push(...response.results);
    } else {
      state.results = response.results;
    }

    state.cursor = response.meta.next_cursor || "*";
    state.hasMore = !!response.meta.next_cursor;

    const totalEl = state.dialog.querySelector("#cg-total-count");
    if (totalEl) totalEl.textContent = `${response.meta.count.toLocaleString()} total`;

    const searchInput = state.dialog.querySelector(".cg-search-input") as HTMLInputElement;
    renderResults(state, searchInput?.value || "");
  } catch (e) {
    if (gen !== state.generation) { state.loading = false; return; }
    Zotero.debug(`[Citegeist] Error loading results: ${e}`);
    safeInnerHTML(body, `<div class="cg-empty">Error loading results. Please try again.</div>`);
  }

  state.loading = false;
}

function renderResults(state: NetworkState, filter = ""): void {
  const body = state.dialog.querySelector(".cg-dialog-body") as HTMLElement;
  if (!body) return;

  let results = state.results;

  if (filter) {
    const lower = filter.toLowerCase();
    results = results.filter((w) =>
      w.display_name?.toLowerCase().includes(lower) ||
      w.title?.toLowerCase().includes(lower) ||
      w.authorships?.some((a) => a.author.display_name.toLowerCase().includes(lower)),
    );
  }

  results = [...results].sort((a, b) => {
    switch (state.sortBy) {
      case "year-desc": return (b.publication_year || 0) - (a.publication_year || 0);
      case "year-asc": return (a.publication_year || 0) - (b.publication_year || 0);
      default: return (b.cited_by_count || 0) - (a.cited_by_count || 0);
    }
  });

  if (results.length === 0 && !state.loading) {
    const msg = filter
      ? `<div class="cg-empty"><div class="cg-empty-title">No matches</div>Try a different search term</div>`
      : `<div class="cg-empty"><div class="cg-empty-title">No results</div>This work has no ${state.mode === "citing" ? "citing works" : "references"} in OpenAlex</div>`;
    safeInnerHTML(body, msg);
    return;
  }

  const totalMatches = results.length;
  const capped = results.length > MAX_RENDERED_RESULTS;
  if (capped) results = results.slice(0, MAX_RENDERED_RESULTS);

  const defaultName = getDefaultCollectionName(state);
  let html = `<ul class="cg-results-list" role="list">`;

  for (const work of results) {
    const workId = work.id.replace("https://openalex.org/", "");
    const isExpanded = state.expandedIds.has(workId);
    const authors = formatAuthors(work.authorships);
    const source = getSourceName(work);
    const cleanDOI = work.doi ? work.doi.replace("https://doi.org/", "") : null;
    const inLibrary = cleanDOI ? state.existingDOIs.has(cleanDOI.toLowerCase()) : false;
    const titleText = work.display_name || work.title || "Untitled";
    const yearStr = work.publication_year ? String(work.publication_year) : "n.d.";
    const count = work.cited_by_count || 0;
    const countClass = count >= 1000 ? "cg-count-high" : count >= 50 ? "cg-count-medium" : "cg-count-low";

    // Determine button state
    const isUndo = state.undoTimers.has(workId);
    const addedSession = state.addedThisSession.has(workId);
    const showAsInLibrary = inLibrary || addedSession;

    let btnHtml: string;
    if (isUndo) {
      btnHtml = `
        <div class="cg-split-btn cg-state-added" style="position:relative;overflow:hidden;">
          <button class="cg-split-main" data-work-id="${escapeHTML(workId)}" data-action="undo"
                  aria-label="Undo adding ${escapeHTML(titleText)}">\u2713 Added \u00B7 Undo</button>
          <div class="cg-undo-bar"></div>
        </div>`;
    } else if (showAsInLibrary) {
      btnHtml = `
        <div class="cg-split-btn cg-state-file" style="position:relative;">
          <button class="cg-split-main" data-work-id="${escapeHTML(workId)}" data-action="file"
                  aria-label="Manage collections for ${escapeHTML(titleText)}">\uD83D\uDCC1 File</button>
          <button class="cg-split-arrow" data-work-id="${escapeHTML(workId)}"
                  aria-label="Choose collections" aria-haspopup="listbox">\u25BE</button>
        </div>`;
    } else {
      const addLabel = defaultName ? `+ Add to ${escapeHTML(defaultName)}` : "+ Add to Library";
      btnHtml = `
        <div class="cg-split-btn" style="position:relative;">
          <button class="cg-split-main" data-work-id="${escapeHTML(workId)}" data-action="add"
                  aria-label="Add ${escapeHTML(titleText)} to ${defaultName || "library"}">${addLabel}</button>
          <button class="cg-split-arrow" data-work-id="${escapeHTML(workId)}"
                  aria-label="Choose collections" aria-haspopup="listbox">\u25BE</button>
        </div>`;
    }

    // Badges
    let badges = "";
    if (!cleanDOI) badges += `<span class="cg-result-badge cg-badge-no-doi">No DOI</span>`;
    if (work.open_access?.is_oa) badges += `<span class="cg-result-badge cg-badge-oa">Open Access</span>`;
    if (work.is_retracted) badges += `<span class="cg-result-badge cg-badge-retracted">Retracted</span>`;
    if (showAsInLibrary) badges += `<span class="cg-result-badge cg-badge-in-library">In Library</span>`;

    const expandLabel = isExpanded ? "Hide abstract" : "Abstract";
    const expandChevron = isExpanded ? "\u25BE" : "\u25B8";

    html += `
      <li class="cg-result-item" data-work-id="${escapeHTML(workId)}" role="listitem"
          tabindex="0" aria-expanded="${isExpanded}">
        <div class="cg-result-content">
          <div class="cg-result-title">
            ${cleanDOI
              ? `<a href="https://doi.org/${escapeHTML(cleanDOI)}" title="Open article in browser"
                    aria-label="Open ${escapeHTML(titleText)} in browser">${escapeHTML(titleText)}</a>`
              : `<span class="cg-no-link" title="No DOI available — cannot link to article">${escapeHTML(titleText)}</span>`}
          </div>
          <div class="cg-result-meta">
            <div class="cg-result-meta-authors">${escapeHTML(authors)}</div>
            <div class="cg-result-meta-venue">${escapeHTML(source)} \u00B7 <span class="cg-result-year">${escapeHTML(yearStr)}</span></div>
          </div>
          <div class="cg-result-badges">${badges}</div>
          <div class="cg-expand-hint"><span class="cg-expand-chevron">${expandChevron}</span>${expandLabel}</div>
        </div>
        <div class="cg-result-right">
          <div class="cg-result-count ${countClass}">${escapeHTML(count.toLocaleString())}</div>
          ${btnHtml}
        </div>
      </li>`;

    // Expanded abstract (rendered inline for full re-renders like sort/filter)
    if (isExpanded) {
      html += buildExpandedHTML(state, workId, work);
    }
  }
  html += `</ul>`;

  if (capped) {
    html += `<div class="cg-cap-notice">Showing ${MAX_RENDERED_RESULTS} of ${totalMatches} matches. Use the filter to narrow results.</div>`;
  } else if (state.hasMore) {
    html += `<div class="cg-loading-more">Scroll for more\u2026</div>`;
  }

  safeInnerHTML(body, html);
}

function buildExpandedHTML(state: NetworkState, workId: string, _work: OpenAlexWork): string {
  const cached = state.abstractCache.get(workId);
  const hasCached = state.abstractCache.has(workId);

  let abstractHtml: string;
  if (!hasCached) {
    abstractHtml = `<div class="cg-abstract-loading">Loading abstract\u2026</div>`;
  } else if (cached) {
    abstractHtml = `<div class="cg-abstract-text">${escapeHTML(cached)}</div>`;
  } else {
    abstractHtml = `<div class="cg-abstract-none">No abstract available</div>`;
  }

  return `<div class="cg-result-expanded" data-expanded-for="${escapeHTML(workId)}">${abstractHtml}</div>`;
}

// ────────────────────────────────────────────────────────
// Expand / collapse (targeted DOM, no re-render)
// ────────────────────────────────────────────────────────

async function toggleExpanded(state: NetworkState, workId: string): Promise<void> {
  const body = state.dialog.querySelector(".cg-dialog-body") as HTMLElement;
  if (!body) return;

  const itemEl = body.querySelector(`.cg-result-item[data-work-id="${workId}"]`) as HTMLElement;

  if (state.expandedIds.has(workId)) {
    state.expandedIds.delete(workId);
    const el = body.querySelector(`[data-expanded-for="${workId}"]`);
    if (el) el.remove();
    if (itemEl) {
      itemEl.setAttribute("aria-expanded", "false");
      const hint = itemEl.querySelector(".cg-expand-hint");
      if (hint) hint.innerHTML = `<span class="cg-expand-chevron">\u25B8</span>Abstract`;
    }
    return;
  }

  state.expandedIds.add(workId);
  if (!itemEl) return;
  itemEl.setAttribute("aria-expanded", "true");
  const hint = itemEl.querySelector(".cg-expand-hint");
  if (hint) hint.innerHTML = `<span class="cg-expand-chevron">\u25BE</span>Hide abstract`;

  // Create expanded element
  const doc = state.dialog.ownerDocument;
  const expandedEl = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
  expandedEl.className = "cg-result-expanded";
  expandedEl.setAttribute("data-expanded-for", workId);

  const needsFetch = !state.abstractCache.has(workId);
  if (needsFetch) {
    expandedEl.textContent = "";
    const loading = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
    loading.className = "cg-abstract-loading";
    loading.textContent = "Loading abstract\u2026";
    expandedEl.appendChild(loading);
  } else {
    const cached = state.abstractCache.get(workId);
    const div = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
    if (cached) {
      div.className = "cg-abstract-text";
      div.textContent = cached;
    } else {
      div.className = "cg-abstract-none";
      div.textContent = "No abstract available";
    }
    expandedEl.appendChild(div);
  }

  itemEl.insertAdjacentElement("afterend", expandedEl);

  // Fetch abstract on-demand
  if (needsFetch) {
    try {
      const fullWork = await getWorkById(workId);
      const text = fullWork?.abstract_inverted_index
        ? reconstructAbstract(fullWork.abstract_inverted_index)
        : null;
      state.abstractCache.set(workId, text);

      // Update DOM if still expanded
      const loadingEl = expandedEl.querySelector(".cg-abstract-loading");
      if (loadingEl) {
        loadingEl.className = text ? "cg-abstract-text" : "cg-abstract-none";
        loadingEl.textContent = text || "No abstract available";
      }
    } catch {
      state.abstractCache.set(workId, null);
      const loadingEl = expandedEl.querySelector(".cg-abstract-loading");
      if (loadingEl) {
        loadingEl.className = "cg-abstract-none";
        loadingEl.textContent = "No abstract available";
      }
    }
  }
}

// ────────────────────────────────────────────────────────
// Add / Undo / File actions
// ────────────────────────────────────────────────────────

async function handleAdd(state: NetworkState, workId: string): Promise<void> {
  const work = state.results.find((w) => w.id.replace("https://openalex.org/", "") === workId);
  if (!work) return;

  // Update button to spinner immediately
  const btnContainer = state.dialog.querySelector(
    `.cg-split-main[data-work-id="${workId}"]`,
  )?.parentElement;
  const mainBtn = btnContainer?.querySelector(".cg-split-main") as HTMLButtonElement | null;
  if (mainBtn) {
    mainBtn.disabled = true;
    mainBtn.innerHTML = `<span class="cg-spinner"></span> Adding\u2026`;
  }

  try {
    const item = await createZoteroItemFromWork(work, state.defaultCollectionIds);

    // Write citation + journal metrics to Extra so columns populate immediately
    const srcId = work.primary_location?.source?.id;
    const srcStats = srcId ? await getSourceStats(srcId) : null;
    await cacheWorkData(item, work, srcStats);
    invalidateColumnCache(item.id);

    const doi = work.doi?.replace("https://doi.org/", "")?.toLowerCase();
    if (doi) state.existingDOIs.add(doi);

    // Track collections for this item
    if (doi) {
      state.itemCollections.set(doi, new Set(state.defaultCollectionIds));
    }

    // Store the created item ID for undo
    const createdItemId = item.id;

    // Transition to "Added · Undo"
    state.undoTimers.set(workId, setTimeout(() => {
      state.undoTimers.delete(workId);
      state.addedThisSession.add(workId);
      updateRowButton(state, workId);
    }, UNDO_TIMEOUT_MS));

    state.createdItemIds.set(workId, createdItemId);

    updateRowButton(state, workId);
  } catch (e) {
    Zotero.debug(`[Citegeist] Error adding work ${workId}: ${e}`);
    // Restore button
    if (mainBtn) {
      mainBtn.disabled = false;
      const name = getDefaultCollectionName(state);
      mainBtn.textContent = name ? `+ Add to ${name}` : "+ Add to Library";
    }
  }
}

async function handleUndo(state: NetworkState, workId: string): Promise<void> {
  const work = state.results.find((w) => w.id.replace("https://openalex.org/", "") === workId);
  if (!work) return;

  const timer = state.undoTimers.get(workId);
  if (timer) clearTimeout(timer);
  state.undoTimers.delete(workId);

  // Move the item to trash (safer than permanent erase)
  const createdItemId = state.createdItemIds.get(workId);
  if (createdItemId) {
    try {
      const item = Zotero.Items.get(createdItemId) as any;
      if (item) {
        item.deleted = true;
        await item.saveTx();
      }
    } catch (e) {
      Zotero.debug(`[Citegeist] Error undoing add for ${workId}: ${e}`);
    }
    state.createdItemIds.delete(workId);
  }

  // Remove from tracking
  const doi = work.doi?.replace("https://doi.org/", "")?.toLowerCase();
  if (doi) {
    state.existingDOIs.delete(doi);
    state.itemCollections.delete(doi);
  }
  state.addedThisSession.delete(workId);

  updateRowButton(state, workId);
}

/**
 * Update a single row's button without re-rendering the entire list.
 */
function updateRowButton(state: NetworkState, workId: string): void {
  const itemEl = state.dialog.querySelector(
    `.cg-result-item[data-work-id="${workId}"]`,
  ) as HTMLElement | null;
  if (!itemEl) return;

  const right = itemEl.querySelector(".cg-result-right") as HTMLElement;
  if (!right) return;

  const work = state.results.find((w) => w.id.replace("https://openalex.org/", "") === workId);
  if (!work) return;

  const cleanDOI = work.doi ? work.doi.replace("https://doi.org/", "") : null;
  const inLibrary = cleanDOI ? state.existingDOIs.has(cleanDOI.toLowerCase()) : false;
  const titleText = work.display_name || work.title || "Untitled";
  const isUndo = state.undoTimers.has(workId);
  const addedSession = state.addedThisSession.has(workId);
  const showAsInLibrary = inLibrary || addedSession;
  const defaultName = getDefaultCollectionName(state);

  // Rebuild just the button
  const oldBtn = right.querySelector(".cg-split-btn");
  if (oldBtn) oldBtn.remove();

  const doc = state.dialog.ownerDocument;
  const btnWrap = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
  btnWrap.className = "cg-split-btn";
  btnWrap.style.position = "relative";

  if (isUndo) {
    btnWrap.classList.add("cg-state-added");
    btnWrap.style.overflow = "hidden";
    safeInnerHTML(btnWrap, `<button class="cg-split-main" data-work-id="${escapeHTML(workId)}" data-action="undo"
      aria-label="Undo adding ${escapeHTML(titleText)}">\u2713 Added \u00B7 Undo</button>
      <div class="cg-undo-bar"></div>`);
  } else if (showAsInLibrary) {
    btnWrap.classList.add("cg-state-file");
    safeInnerHTML(btnWrap, `
      <button class="cg-split-main" data-work-id="${escapeHTML(workId)}" data-action="file"
        aria-label="Manage collections for ${escapeHTML(titleText)}">\uD83D\uDCC1 File</button>
      <button class="cg-split-arrow" data-work-id="${escapeHTML(workId)}"
        aria-label="Choose collections" aria-haspopup="listbox">\u25BE</button>`);
  } else {
    const label = defaultName ? `+ Add to ${escapeHTML(defaultName)}` : "+ Add to Library";
    safeInnerHTML(btnWrap, `
      <button class="cg-split-main" data-work-id="${escapeHTML(workId)}" data-action="add"
        aria-label="Add ${escapeHTML(titleText)} to ${defaultName || "library"}">${label}</button>
      <button class="cg-split-arrow" data-work-id="${escapeHTML(workId)}"
        aria-label="Choose collections" aria-haspopup="listbox">\u25BE</button>`);
  }

  right.appendChild(btnWrap);

  // Update badges
  const badges = itemEl.querySelector(".cg-result-badges");
  if (badges) {
    const hasLibBadge = badges.querySelector(".cg-badge-in-library");
    if (showAsInLibrary && !hasLibBadge) {
      const badge = doc.createElementNS("http://www.w3.org/1999/xhtml", "span") as HTMLSpanElement;
      badge.className = "cg-result-badge cg-badge-in-library";
      badge.textContent = "In Library";
      badges.appendChild(badge);
    } else if (!showAsInLibrary && hasLibBadge) {
      hasLibBadge.remove();
    }
  }
}

// ────────────────────────────────────────────────────────
// Per-item collection picker
// ────────────────────────────────────────────────────────

async function toggleItemPicker(state: NetworkState, workId: string, anchor: HTMLElement): Promise<void> {
  const splitBtn = anchor.closest(".cg-split-btn") as HTMLElement;
  if (!splitBtn) return;

  // Close if already open
  const existing = splitBtn.querySelector(".cg-item-picker") as HTMLElement;
  if (existing) {
    existing.remove();
    return;
  }

  // Close any other open pickers
  closeOpenPickers(state);

  const work = state.results.find((w) => w.id.replace("https://openalex.org/", "") === workId);
  if (!work) return;
  const cleanDOI = work.doi?.replace("https://doi.org/", "")?.toLowerCase();
  const inLibrary = cleanDOI ? state.existingDOIs.has(cleanDOI) : false;

  // Get current collections for this item
  let currentCols = new Set<number>();
  if (inLibrary && cleanDOI) {
    const stored = state.itemCollections.get(cleanDOI);
    if (stored) {
      currentCols = new Set(stored);
    } else {
      currentCols = await getItemCollections(cleanDOI);
      state.itemCollections.set(cleanDOI, currentCols);
    }
  } else {
    // New item — use defaults
    currentCols = new Set(state.defaultCollectionIds);
  }

  const doc = state.dialog.ownerDocument;
  const picker = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
  picker.className = "cg-item-picker";
  picker.setAttribute("role", "listbox");
  picker.setAttribute("aria-label", "Collections");

  renderItemPickerContent(state, picker, workId, currentCols, inLibrary);
  splitBtn.appendChild(picker);
}

function renderItemPickerContent(
  state: NetworkState,
  picker: HTMLElement,
  workId: string,
  selectedCols: Set<number>,
  inLibrary: boolean,
): void {
  // Track which parent groups are expanded
  const expanded = new Set<number>();

  // Auto-expand parents of selected collections
  for (const col of state.allCollections) {
    if (selectedCols.has(col.id) && col.depth > 0) {
      // Walk up to expand all ancestors
      let pid = col.parentId;
      while (pid) {
        expanded.add(pid as number);
        const parent = state.allCollections.find((c) => c.id === pid);
        pid = parent ? parent.parentId : false;
      }
    }
  }

  let html = `<div class="cg-picker-list">`;
  for (const col of state.allCollections) {
    const checked = selectedCols.has(col.id);
    const indent = col.depth > 0 ? `padding-left: ${12 + col.depth * 18}px;` : "";
    // Children hidden by default unless parent is expanded
    const isChild = col.depth > 0;
    const isVisible = !isChild || isAncestorExpanded(col, state.allCollections, expanded);
    const hiddenAttr = isVisible ? "" : " hidden";
    const chevron = col.hasChildren
      ? `<span class="cg-picker-chevron${expanded.has(col.id) ? " expanded" : ""}" data-parent-id="${col.id}">\u25B8</span>`
      : "";
    html += `<button class="cg-picker-option${checked ? " checked" : ""}"
                    data-col-id="${col.id}" data-depth="${col.depth}"
                    data-parent-col="${col.parentId || ""}"
                    style="${indent}"
                    role="option" aria-selected="${checked}" tabindex="0"${hiddenAttr}>
      ${chevron}<span class="cg-picker-check">\u2713</span>
      <span class="cg-picker-label">${escapeHTML(col.name)}</span>
    </button>`;
  }
  html += `</div>`;

  const actionLabel = inLibrary ? "Done" : "+ Add to Zotero";
  html += `<div class="cg-picker-actions">
    <button class="cg-picker-done" data-work-id="${escapeHTML(workId)}"
            data-in-library="${inLibrary}">${actionLabel}</button>
  </div>`;

  safeInnerHTML(picker, html);

  // Bind chevron toggles
  picker.querySelectorAll(".cg-picker-chevron").forEach((chev) => {
    (chev as HTMLElement).addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const parentId = Number((chev as HTMLElement).dataset.parentId);
      if (expanded.has(parentId)) {
        expanded.delete(parentId);
        chev.classList.remove("expanded");
      } else {
        expanded.add(parentId);
        chev.classList.add("expanded");
      }
      // Show/hide children based on expanded state
      picker.querySelectorAll(".cg-picker-option").forEach((opt) => {
        const optEl = opt as HTMLElement;
        const depth = Number(optEl.dataset.depth);
        if (depth > 0) {
          const visible = isAncestorExpandedDOM(optEl, picker, expanded);
          if (visible) optEl.removeAttribute("hidden");
          else optEl.setAttribute("hidden", "");
        }
      });
    });
  });

  // Bind picker events
  picker.querySelectorAll(".cg-picker-option").forEach((opt) => {
    const optEl = opt as HTMLElement;
    const handler = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      // Don't toggle if clicking the chevron
      if ((e.target as HTMLElement)?.classList?.contains("cg-picker-chevron")) return;
      const colId = Number(optEl.dataset.colId);
      if (selectedCols.has(colId)) {
        selectedCols.delete(colId);
        optEl.classList.remove("checked");
        optEl.setAttribute("aria-selected", "false");
      } else {
        selectedCols.add(colId);
        optEl.classList.add("checked");
        optEl.setAttribute("aria-selected", "true");
      }
    };
    optEl.addEventListener("click", handler);
    optEl.addEventListener("keydown", (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter" || ke.key === " ") { ke.preventDefault(); handler(e); }
      else if (ke.key === "ArrowDown") {
        ke.preventDefault();
        let next = optEl.nextElementSibling as HTMLElement;
        while (next && (next.hidden || !next.classList.contains("cg-picker-option"))) {
          next = next.nextElementSibling as HTMLElement;
        }
        next?.focus();
      } else if (ke.key === "ArrowUp") {
        ke.preventDefault();
        let prev = optEl.previousElementSibling as HTMLElement;
        while (prev && (prev.hidden || !prev.classList.contains("cg-picker-option"))) {
          prev = prev.previousElementSibling as HTMLElement;
        }
        prev?.focus();
      } else if (ke.key === "Escape") {
        picker.remove();
      } else if (ke.key === "ArrowRight" && optEl.querySelector(".cg-picker-chevron")) {
        ke.preventDefault();
        const chev = optEl.querySelector(".cg-picker-chevron") as HTMLElement;
        const parentId = Number(chev.dataset.parentId);
        if (!expanded.has(parentId)) {
          chev.click();
        }
      } else if (ke.key === "ArrowLeft" && optEl.querySelector(".cg-picker-chevron")) {
        ke.preventDefault();
        const chev = optEl.querySelector(".cg-picker-chevron") as HTMLElement;
        const parentId = Number(chev.dataset.parentId);
        if (expanded.has(parentId)) {
          chev.click();
        }
      }
    });
  });

  // Done button
  const doneBtn = picker.querySelector(".cg-picker-done") as HTMLButtonElement;
  doneBtn?.addEventListener("click", async (e: Event) => {
    e.stopPropagation();
    const isInLibrary = doneBtn.dataset.inLibrary === "true";
    const doneWorkId = doneBtn.dataset.workId!;

    if (isInLibrary) {
      await updateItemCollections(state, doneWorkId, selectedCols);
    } else {
      await handleAddWithCollections(state, doneWorkId, selectedCols);
    }
    picker.remove();
  });
}

/** Check if all ancestors of a collection node are expanded (data model). */
function isAncestorExpanded(
  col: CollectionNode,
  allCollections: CollectionNode[],
  expanded: Set<number>,
): boolean {
  let pid = col.parentId;
  while (pid) {
    if (!expanded.has(pid as number)) return false;
    const parent = allCollections.find((c) => c.id === pid);
    pid = parent ? parent.parentId : false;
  }
  return true;
}

/** Check if all ancestors of a picker option are expanded (DOM walk). */
function isAncestorExpandedDOM(
  optEl: HTMLElement,
  picker: HTMLElement,
  expanded: Set<number>,
): boolean {
  const parentColId = optEl.dataset.parentCol;
  if (!parentColId) return true;
  const pid = Number(parentColId);
  if (!expanded.has(pid)) return false;
  // Check grandparent
  const parentOpt = picker.querySelector(`.cg-picker-option[data-col-id="${pid}"]`) as HTMLElement;
  if (parentOpt) return isAncestorExpandedDOM(parentOpt, picker, expanded);
  return true;
}

function closeOpenPickers(state: NetworkState, exceptUnder?: HTMLElement): void {
  const pickers = state.dialog.querySelectorAll(".cg-item-picker");
  pickers.forEach((p) => {
    if (exceptUnder && exceptUnder.closest(".cg-item-picker") === p) return;
    p.remove();
  });
}

async function handleAddWithCollections(
  state: NetworkState,
  workId: string,
  collectionIds: Set<number>,
): Promise<void> {
  const work = state.results.find((w) => w.id.replace("https://openalex.org/", "") === workId);
  if (!work) return;

  const mainBtn = state.dialog.querySelector(
    `.cg-split-main[data-work-id="${workId}"]`,
  ) as HTMLButtonElement | null;
  if (mainBtn) {
    mainBtn.disabled = true;
    mainBtn.innerHTML = `<span class="cg-spinner"></span> Adding\u2026`;
  }

  try {
    const item = await createZoteroItemFromWork(work, collectionIds);

    // Write citation + journal metrics to Extra so columns populate immediately
    const srcId2 = work.primary_location?.source?.id;
    const srcStats2 = srcId2 ? await getSourceStats(srcId2) : null;
    await cacheWorkData(item, work, srcStats2);
    invalidateColumnCache(item.id);

    const doi = work.doi?.replace("https://doi.org/", "")?.toLowerCase();
    if (doi) {
      state.existingDOIs.add(doi);
      state.itemCollections.set(doi, new Set(collectionIds));
    }
    state.createdItemIds.set(workId, item.id);

    state.undoTimers.set(workId, setTimeout(() => {
      state.undoTimers.delete(workId);
      state.addedThisSession.add(workId);
      updateRowButton(state, workId);
    }, UNDO_TIMEOUT_MS));

    updateRowButton(state, workId);
  } catch (e) {
    Zotero.debug(`[Citegeist] Error adding work ${workId}: ${e}`);
    updateRowButton(state, workId);
  }
}

async function updateItemCollections(
  state: NetworkState,
  workId: string,
  newCols: Set<number>,
): Promise<void> {
  const work = state.results.find((w) => w.id.replace("https://openalex.org/", "") === workId);
  if (!work) return;
  const doi = work.doi?.replace("https://doi.org/", "")?.toLowerCase();
  if (!doi) return;

  try {
    // Find the Zotero item
    const s = new Zotero.Search();
    s.libraryID = Zotero.Libraries.userLibraryID;
    s.addCondition("DOI", "is", work.doi!.replace("https://doi.org/", ""));
    const ids = await s.search();
    if (!ids || ids.length === 0) return;
    const item = Zotero.Items.get(ids[0]) as any;
    if (!item) return;

    // Get current collections
    const currentCols = new Set<number>(item.getCollections?.() || []);

    // Add to new collections
    for (const colId of newCols) {
      if (!currentCols.has(colId)) {
        item.addToCollection(colId);
      }
    }
    // Remove from unchecked collections
    for (const colId of currentCols) {
      if (!newCols.has(colId)) {
        item.removeFromCollection(colId);
      }
    }

    await item.saveTx();
    state.itemCollections.set(doi, new Set(newCols));
  } catch (e) {
    Zotero.debug(`[Citegeist] Error updating collections for ${workId}: ${e}`);
  }
}

// ────────────────────────────────────────────────────────
// Default collection picker (footer)
// ────────────────────────────────────────────────────────

function initDefaultCollectionPicker(state: NetworkState): void {
  const chip = state.dialog.querySelector("#cg-default-chip") as HTMLElement;
  const dropdown = state.dialog.querySelector("#cg-default-dropdown") as HTMLElement;
  if (!chip || !dropdown) return;

  chip.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    if (dropdown.hidden) {
      renderDefaultDropdown(state);
      dropdown.hidden = false;
      chip.setAttribute("aria-expanded", "true");
      const first = dropdown.querySelector(".cg-picker-option") as HTMLElement;
      first?.focus();
    } else {
      dropdown.hidden = true;
      chip.setAttribute("aria-expanded", "false");
    }
  });

  // Close on click outside
  state.overlay.addEventListener("click", () => {
    if (!dropdown.hidden) {
      dropdown.hidden = true;
      chip.setAttribute("aria-expanded", "false");
    }
  });
  dropdown.addEventListener("click", (e: Event) => e.stopPropagation());
}

function renderDefaultDropdown(state: NetworkState): void {
  const dropdown = state.dialog.querySelector("#cg-default-dropdown") as HTMLElement;
  if (!dropdown) return;

  // Persist expanded state across re-renders
  const expanded = state.defaultPickerExpanded;

  // Auto-expand parents of selected collections
  for (const col of state.allCollections) {
    if (state.defaultCollectionIds.has(col.id) && col.depth > 0) {
      let pid = col.parentId;
      while (pid) {
        expanded.add(pid as number);
        const parent = state.allCollections.find((c) => c.id === pid);
        pid = parent ? parent.parentId : false;
      }
    }
  }

  let html = `<div class="cg-picker-list">`;
  for (const col of state.allCollections) {
    const checked = state.defaultCollectionIds.has(col.id);
    const indent = col.depth > 0 ? `padding-left: ${12 + col.depth * 18}px;` : "";
    const isChild = col.depth > 0;
    const isVisible = !isChild || isAncestorExpanded(col, state.allCollections, expanded);
    const hiddenAttr = isVisible ? "" : " hidden";
    const chevron = col.hasChildren
      ? `<span class="cg-picker-chevron${expanded.has(col.id) ? " expanded" : ""}" data-parent-id="${col.id}">\u25B8</span>`
      : "";
    html += `<button class="cg-picker-option${checked ? " checked" : ""}"
                    data-col-id="${col.id}" data-depth="${col.depth}"
                    data-parent-col="${col.parentId || ""}"
                    style="${indent}"
                    role="option" aria-selected="${checked}" tabindex="0"${hiddenAttr}>
      ${chevron}<span class="cg-picker-check">\u2713</span>
      <span class="cg-picker-label">${escapeHTML(col.name)}</span>
    </button>`;
  }

  if (state.allCollections.length > 0) {
    html += `<div class="cg-picker-separator"></div>`;
  }
  const rootChecked = state.defaultCollectionIds.size === 0;
  html += `<button class="cg-picker-option${rootChecked ? " checked" : ""}"
                  data-col-id="root" role="option" aria-selected="${rootChecked}" tabindex="0">
    <span class="cg-picker-check">\u2713</span>
    <span class="cg-picker-label">My Library (root)</span>
  </button>`;
  html += `</div>`;

  safeInnerHTML(dropdown, html);

  // Bind chevron toggles
  dropdown.querySelectorAll(".cg-picker-chevron").forEach((chev) => {
    (chev as HTMLElement).addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const parentId = Number((chev as HTMLElement).dataset.parentId);
      if (expanded.has(parentId)) {
        expanded.delete(parentId);
        chev.classList.remove("expanded");
      } else {
        expanded.add(parentId);
        chev.classList.add("expanded");
      }
      dropdown.querySelectorAll(".cg-picker-option").forEach((opt) => {
        const optEl = opt as HTMLElement;
        const depth = Number(optEl.dataset.depth);
        if (depth > 0) {
          const visible = isAncestorExpandedDOM(optEl, dropdown, expanded);
          if (visible) optEl.removeAttribute("hidden");
          else optEl.setAttribute("hidden", "");
        }
      });
    });
  });

  // Bind option selection
  dropdown.querySelectorAll(".cg-picker-option").forEach((opt) => {
    const optEl = opt as HTMLElement;
    const handler = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if ((e.target as HTMLElement)?.classList?.contains("cg-picker-chevron")) return;
      const colId = optEl.dataset.colId;
      if (colId === "root") {
        state.defaultCollectionIds.clear();
      } else if (colId) {
        const numId = Number(colId);
        if (state.defaultCollectionIds.has(numId)) {
          state.defaultCollectionIds.delete(numId);
        } else {
          state.defaultCollectionIds.add(numId);
        }
      }
      renderDefaultDropdown(state);
      updateDefaultCollectionLabel(state);
      updateAllAddButtons(state);
    };
    optEl.addEventListener("click", handler);
    optEl.addEventListener("keydown", (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter" || ke.key === " ") { ke.preventDefault(); handler(e); }
      else if (ke.key === "ArrowDown") {
        ke.preventDefault();
        let next = optEl.nextElementSibling as HTMLElement;
        while (next && (next.hidden || !next.classList.contains("cg-picker-option"))) {
          next = next.nextElementSibling as HTMLElement;
        }
        next?.focus();
      } else if (ke.key === "ArrowUp") {
        ke.preventDefault();
        let prev = optEl.previousElementSibling as HTMLElement;
        while (prev && (prev.hidden || !prev.classList.contains("cg-picker-option"))) {
          prev = prev.previousElementSibling as HTMLElement;
        }
        prev?.focus();
      } else if (ke.key === "Escape") {
        const dd = state.dialog.querySelector("#cg-default-dropdown") as HTMLElement;
        const chip = state.dialog.querySelector("#cg-default-chip") as HTMLElement;
        if (dd) dd.hidden = true;
        chip?.setAttribute("aria-expanded", "false");
        chip?.focus();
      } else if (ke.key === "ArrowRight" && optEl.querySelector(".cg-picker-chevron")) {
        ke.preventDefault();
        const chev = optEl.querySelector(".cg-picker-chevron") as HTMLElement;
        const parentId = Number(chev.dataset.parentId);
        if (!expanded.has(parentId)) chev.click();
      } else if (ke.key === "ArrowLeft" && optEl.querySelector(".cg-picker-chevron")) {
        ke.preventDefault();
        const chev = optEl.querySelector(".cg-picker-chevron") as HTMLElement;
        const parentId = Number(chev.dataset.parentId);
        if (expanded.has(parentId)) chev.click();
      }
    });
  });
}

function updateDefaultCollectionLabel(state: NetworkState): void {
  const label = state.dialog.querySelector("#cg-default-label");
  const extra = state.dialog.querySelector("#cg-default-extra");
  const footerLabel = state.dialog.querySelector("#cg-footer-label");
  if (!label || !extra) return;

  if (state.defaultCollectionIds.size === 0) {
    label.textContent = "My Library";
    extra.textContent = "";
    if (footerLabel) footerLabel.textContent = "Default folder:";
  } else {
    const ids = Array.from(state.defaultCollectionIds);
    const name = state.allCollections.find((c) => c.id === ids[0])?.name || "Collection";
    label.textContent = name;
    extra.textContent = ids.length > 1 ? ` +${ids.length - 1}` : "";
    if (footerLabel) footerLabel.textContent = ids.length > 1 ? "Default folders:" : "Default folder:";
  }
}

function getDefaultCollectionName(state: NetworkState): string {
  if (state.defaultCollectionIds.size === 0) return "";
  const ids = Array.from(state.defaultCollectionIds);
  const name = state.allCollections.find((c) => c.id === ids[0])?.name || "Collection";
  if (ids.length > 1) return `${name} +${ids.length - 1}`;
  return name;
}

/**
 * Update all visible "Add" buttons to reflect the current default collection name.
 */
function updateAllAddButtons(state: NetworkState): void {
  const defaultName = getDefaultCollectionName(state);
  const label = defaultName ? `+ Add to ${defaultName}` : "+ Add to Library";
  const buttons = state.dialog.querySelectorAll('.cg-split-main[data-action="add"]');
  buttons.forEach((btn) => {
    (btn as HTMLElement).textContent = label;
  });
}

// ────────────────────────────────────────────────────────
// Collection helpers
// ────────────────────────────────────────────────────────

function buildCollectionTree(): CollectionNode[] {
  const nodes: CollectionNode[] = [];
  try {
    const libraryID = Zotero.Libraries.userLibraryID;

    // Zotero.Collections.getByLibrary returns ALL collections in the library,
    // each with .id, .name, and .parentID (number or false for top-level).
    // We also try getChildCollections() as a fallback for nested discovery.
    const allCollections = (Zotero as any).Collections.getByLibrary(libraryID) as any[];

    if (!allCollections || allCollections.length === 0) return nodes;

    // Build a map of id → collection and parentId → children
    const byId = new Map<number, { id: number; name: string; parentID: number | false }>();
    const childrenOf = new Map<number | false, Array<{ id: number; name: string; parentID: number | false }>>();

    for (const col of allCollections) {
      const entry = { id: col.id, name: col.name, parentID: col.parentID ?? false };
      byId.set(col.id, entry);

      const parentKey = entry.parentID || false;
      if (!childrenOf.has(parentKey)) childrenOf.set(parentKey, []);
      childrenOf.get(parentKey)!.push(entry);

      // Also try getChildCollections() to discover any subcollections
      // that might not appear in getByLibrary with correct parentID
      if (typeof col.getChildCollections === "function") {
        try {
          const children = col.getChildCollections();
          for (const child of children) {
            if (!byId.has(child.id)) {
              const childEntry = { id: child.id, name: child.name, parentID: col.id };
              byId.set(child.id, childEntry);
              if (!childrenOf.has(col.id)) childrenOf.set(col.id, []);
              childrenOf.get(col.id)!.push(childEntry);
            }
          }
        } catch (_) { /* ignore */ }
      }
    }

    // Sort each group alphabetically
    for (const children of childrenOf.values()) {
      children.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Walk tree starting from root (parentID === false)
    function walk(parentId: number | false, depth: number): void {
      const children = childrenOf.get(parentId);
      if (!children) return;
      for (const col of children) {
        const hasChildren = childrenOf.has(col.id) && childrenOf.get(col.id)!.length > 0;
        nodes.push({ id: col.id, name: col.name, depth, parentId: col.parentID, hasChildren });
        walk(col.id, depth + 1);
      }
    }
    walk(false, 0);
  } catch (e) {
    Zotero.debug(`[Citegeist] Error building collection tree: ${e}`);
  }
  return nodes;
}

async function getItemCollections(doi: string): Promise<Set<number>> {
  const cols = new Set<number>();
  try {
    const s = new Zotero.Search();
    s.libraryID = Zotero.Libraries.userLibraryID;
    s.addCondition("DOI", "is", doi);
    const ids = await s.search();
    if (ids && ids.length > 0) {
      const item = Zotero.Items.get(ids[0]) as any;
      if (item?.getCollections) {
        for (const colId of item.getCollections()) {
          cols.add(colId);
        }
      }
    }
  } catch (e) {
    Zotero.debug(`[Citegeist] Error getting item collections for DOI ${doi}: ${e}`);
  }
  return cols;
}

// ────────────────────────────────────────────────────────
// Item creation
// ────────────────────────────────────────────────────────

async function createZoteroItemFromWork(
  work: OpenAlexWork,
  collectionIds?: Set<number>,
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
    "proceedings-article": "conferencePaper",
    "proceedings": "conferencePaper",
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

  if (work.authorships && work.authorships.length > 0) {
    const creators = work.authorships.map((a) => {
      const displayName = a.author.display_name.trim();
      const parts = displayName.split(/\s+/);
      if (parts.length <= 1) {
        return { lastName: displayName, firstName: "", creatorType: "author", fieldMode: 1 };
      }
      // Detect surname prefixes (van, de, von, etc.) to avoid splitting
      // "Ludwig van Beethoven" into firstName="Ludwig van", lastName="Beethoven"
      let splitIdx = parts.length - 1;
      while (splitIdx > 0 && SURNAME_PREFIXES.has(parts[splitIdx - 1].toLowerCase())) {
        splitIdx--;
      }
      if (splitIdx === 0) {
        // All words before last are prefixes — use single field
        return { lastName: displayName, firstName: "", creatorType: "author", fieldMode: 1 };
      }
      const firstName = parts.slice(0, splitIdx).join(" ");
      const lastName = parts.slice(splitIdx).join(" ");
      return { firstName, lastName, creatorType: "author" };
    });
    item.setCreators(creators);
  }

  item.addTag("Citegeist:imported", 1);

  if (collectionIds && collectionIds.size > 0) {
    for (const colId of collectionIds) {
      (item as any).addToCollection(colId);
    }
  }

  await item.saveTx();
  return item;
}

// ────────────────────────────────────────────────────────
// Library DOI lookup
// ────────────────────────────────────────────────────────

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

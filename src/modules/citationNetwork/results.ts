/**
 * Loading and rendering results for the Citation Network dialog.
 */

import {
  getCitingWorks,
  getReferencedWorks,
  getWorkById,
  reconstructAbstract,
  formatAuthors,
  getSourceName,
  type OpenAlexWork,
} from "../openalex";
import { escapeHTML, safeInnerHTML, OpenAlexNetworkError, logError } from "../utils";
import {
  MAX_RENDERED_RESULTS,
  SURNAME_PREFIXES,
  type NetworkMode,
  type NetworkSortKey,
  type NetworkState,
} from "./types";
import { getDefaultCollectionName } from "./actions";
import {
  DEFAULT_NETWORK_PAGE_SIZE,
  OPENALEX_BOOK_WORK_TYPES,
  PREF_NETWORK_PAGE_SIZE,
} from "../../constants";

/**
 * Inner HTML for the results empty-state. Pure (no DOM/state) so each branch —
 * including the book-references special case — is unit-testable.
 */
export function emptyStateHTML(opts: {
  mode: NetworkMode;
  hasFilter: boolean;
  hideInLibraryWithResults: boolean;
  sourceWorkType?: string | null;
}): string {
  if (opts.hasFilter) {
    return `<div class="cg-empty"><div class="cg-empty-title">No matches</div>Try a different search term</div>`;
  }
  if (opts.hideInLibraryWithResults) {
    return `<div class="cg-empty"><div class="cg-empty-title">Nothing new here</div>Every ${opts.mode === "citing" ? "citing work" : "reference"} is already in your library. Turn off “Hide in library” to see them.</div>`;
  }
  if (opts.mode === "references" && OPENALEX_BOOK_WORK_TYPES.includes(opts.sourceWorkType ?? "")) {
    // OpenAlex rarely has a machine-readable reference list for books, so an
    // empty list means "not indexed", not "this book cites nothing". Say so
    // plainly rather than implying the book has no references.
    return `<div class="cg-empty"><div class="cg-empty-title">No references found</div>OpenAlex doesn't index a reference list for most books, so none can be shown here.</div>`;
  }
  return `<div class="cg-empty"><div class="cg-empty-title">No results</div>This work has no ${opts.mode === "citing" ? "citing works" : "references"} in OpenAlex</div>`;
}

// ────────────────────────────────────────────────────────
// Loading & rendering
// ────────────────────────────────────────────────────────

export async function loadResults(state: NetworkState, append = false): Promise<void> {
  if (state.loading) return;
  state.loading = true;
  const gen = state.generation;
  const body = state.dialog.querySelector(".cg-dialog-body") as HTMLElement;
  // Mark the tablist + panel as busy so screen readers announce the
  // pending fetch AND CSS can dim non-active tabs to indicate clicks
  // will be rejected until the current load finishes (F11).
  body?.setAttribute("aria-busy", "true");
  state.dialog.classList.add("cg-is-loading");

  if (!append) {
    safeInnerHTML(body, `<div class="cg-loading-more">Loading\u2026</div>`);
  } else {
    const el = state.dialog.ownerDocument.createElement("div");
    el.className = "cg-loading-more";
    el.textContent = "Loading more\u2026";
    body.appendChild(el);
  }

  try {
    const perPage =
      (Zotero.Prefs.get(PREF_NETWORK_PAGE_SIZE) as number) || DEFAULT_NETWORK_PAGE_SIZE;
    const response =
      state.mode === "citing"
        ? await getCitingWorks(state.work.id, state.cursor, perPage)
        : await getReferencedWorks(state.work.id, state.cursor, perPage);

    if (gen !== state.generation || state.phase === "closed") {
      state.loading = false;
      body?.setAttribute("aria-busy", "false");
      state.dialog.classList.remove("cg-is-loading");
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
    if (totalEl) totalEl.textContent = `${response.meta.count.toLocaleString()} total`;

    const searchInput = state.dialog.querySelector(".cg-search-input") as HTMLInputElement;
    renderResults(state, searchInput?.value || "");
  } catch (e) {
    if (gen !== state.generation || state.phase === "closed") {
      state.loading = false;
      body?.setAttribute("aria-busy", "false");
      state.dialog.classList.remove("cg-is-loading");
      return;
    }
    logError("loadResults", e);
    const msg =
      e instanceof OpenAlexNetworkError
        ? `<div class="cg-empty">
          <div class="cg-empty-title">OpenAlex is unavailable</div>
          Try again in a few minutes.
        </div>`
        : `<div class="cg-empty">Error loading results. Please try again.</div>`;
    safeInnerHTML(body, msg);
  }

  state.loading = false;
  body?.setAttribute("aria-busy", "false");
  state.dialog.classList.remove("cg-is-loading");
}

// ────────────────────────────────────────────────────────
// Sorting & filtering (pure — unit-tested)
// ────────────────────────────────────────────────────────

/** Short OpenAlex work id, e.g. `W123`, stripped of the URL prefix. */
function shortWorkId(work: OpenAlexWork): string {
  return work.id.replace("https://openalex.org/", "");
}

/** Clean, lowercased DOI (no `https://doi.org/` prefix), or null. */
function cleanDoi(work: OpenAlexWork): string | null {
  return work.doi ? work.doi.replace("https://doi.org/", "").toLowerCase() : null;
}

/**
 * Is this work already in the user's library? True when its DOI is in
 * `existingDOIs`, its OpenAlex work id is in `existingWorkIds` (so DOI-less
 * items dedup too), OR it was added during this session. Mirrors the per-row
 * "In Library" badge logic in {@link renderResults}.
 */
export function isWorkInLibrary(
  work: OpenAlexWork,
  existingDOIs: Set<string>,
  existingWorkIds: Set<string>,
  addedThisSession: Set<string>,
): boolean {
  const doi = cleanDoi(work);
  if (doi && existingDOIs.has(doi)) return true;
  const id = shortWorkId(work);
  return existingWorkIds.has(id) || addedThisSession.has(id);
}

/**
 * First-author surname sort key. Uses the last name token, but folds known
 * surname prefixes ("de la Cruz", "van der Berg") into the key so they sort by
 * the prefix, not the given name. Works with no authors sort last.
 */
function firstAuthorSortKey(work: OpenAlexWork): string {
  const name = work.authorships?.[0]?.author?.display_name?.trim();
  if (!name) return "￿"; // no authors → sort last
  const tokens = name.split(/\s+/);
  if (tokens.length <= 1) return tokens[0].toLowerCase();
  for (let i = 0; i < tokens.length - 1; i++) {
    if (SURNAME_PREFIXES.has(tokens[i].toLowerCase())) {
      return tokens.slice(i).join(" ").toLowerCase();
    }
  }
  return tokens[tokens.length - 1].toLowerCase();
}

export interface NetworkSortContext {
  sortBy: NetworkSortKey;
  existingDOIs: Set<string>;
  existingWorkIds: Set<string>;
  addedThisSession: Set<string>;
}

/**
 * Comparator for two network works under the active sort mode. Pure: depends
 * only on the works + context. Unknown publication years always sort last for
 * both year directions; `not-in-library` floats not-yet-added works first.
 */
export function compareNetworkWorks(
  a: OpenAlexWork,
  b: OpenAlexWork,
  ctx: NetworkSortContext,
): number {
  switch (ctx.sortBy) {
    case "fwci-desc":
      return (b.fwci ?? -1) - (a.fwci ?? -1);
    case "percentile-desc":
      return (
        (b.citation_normalized_percentile?.value ?? -1) -
        (a.citation_normalized_percentile?.value ?? -1)
      );
    case "year-desc":
    case "year-asc": {
      const ya = a.publication_year || 0;
      const yb = b.publication_year || 0;
      if (!ya && !yb) return 0;
      if (!ya) return 1; // unknown date → last, regardless of direction
      if (!yb) return -1;
      return ctx.sortBy === "year-asc" ? ya - yb : yb - ya;
    }
    case "author-asc": {
      const ka = firstAuthorSortKey(a);
      const kb = firstAuthorSortKey(b);
      if (ka !== kb) return ka < kb ? -1 : 1;
      const ya = a.publication_year || 0;
      const yb = b.publication_year || 0;
      if (ya !== yb) return ya - yb;
      return (a.display_name || a.title || "").localeCompare(b.display_name || b.title || "");
    }
    case "not-in-library": {
      const ia = isWorkInLibrary(a, ctx.existingDOIs, ctx.existingWorkIds, ctx.addedThisSession);
      const ib = isWorkInLibrary(b, ctx.existingDOIs, ctx.existingWorkIds, ctx.addedThisSession);
      if (ia !== ib) return ia ? 1 : -1; // not-in-library first
      return (b.cited_by_count || 0) - (a.cited_by_count || 0);
    }
    default:
      return (b.cited_by_count || 0) - (a.cited_by_count || 0);
  }
}

/** Does a work match the free-text filter (title or any author name)? */
function matchesFilter(work: OpenAlexWork, lowerFilter: string): boolean {
  return (
    work.display_name?.toLowerCase().includes(lowerFilter) ||
    work.title?.toLowerCase().includes(lowerFilter) ||
    (work.authorships?.some((a) => a.author.display_name.toLowerCase().includes(lowerFilter)) ??
      false)
  );
}

export interface NetworkVisibilityOptions extends NetworkSortContext {
  hideInLibrary: boolean;
}

/**
 * Apply the free-text filter + optional hide-in-library filter, then sort.
 * Returns a new array; never mutates the input. Single source of truth for
 * which works the results list shows and in what order.
 */
export function getVisibleNetworkWorks(
  works: OpenAlexWork[],
  filter: string,
  opts: NetworkVisibilityOptions,
): OpenAlexWork[] {
  let result = works;
  const trimmed = filter.trim().toLowerCase();
  if (trimmed) result = result.filter((w) => matchesFilter(w, trimmed));
  if (opts.hideInLibrary) {
    result = result.filter(
      (w) => !isWorkInLibrary(w, opts.existingDOIs, opts.existingWorkIds, opts.addedThisSession),
    );
  }
  return [...result].sort((a, b) => compareNetworkWorks(a, b, opts));
}

export function renderResults(state: NetworkState, filter = ""): void {
  const body = state.dialog.querySelector(".cg-dialog-body") as HTMLElement;
  if (!body) return;

  let results = getVisibleNetworkWorks(state.results, filter, {
    sortBy: state.sortBy,
    hideInLibrary: state.hideInLibrary,
    existingDOIs: state.existingDOIs,
    existingWorkIds: state.existingWorkIds,
    addedThisSession: state.addedThisSession,
  });

  if (results.length === 0 && !state.loading) {
    safeInnerHTML(
      body,
      emptyStateHTML({
        mode: state.mode,
        hasFilter: !!filter,
        hideInLibraryWithResults: state.hideInLibrary && state.results.length > 0,
        sourceWorkType: state.work.type,
      }),
    );
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
    const inLibrary =
      (cleanDOI ? state.existingDOIs.has(cleanDOI.toLowerCase()) : false) ||
      state.existingWorkIds.has(workId);
    const titleText = work.display_name || work.title || "Untitled";
    const yearStr = work.publication_year ? String(work.publication_year) : "n.d.";
    const count = work.cited_by_count || 0;
    const countClass =
      count >= 1000 ? "cg-count-high" : count >= 50 ? "cg-count-medium" : "cg-count-low";

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
    if (!cleanDOI) badges += `<span class="cg-chip cg-chip--quiet">No DOI</span>`;
    if (work.open_access?.is_oa) badges += `<span class="cg-chip">Open Access</span>`;
    if (work.is_retracted) badges += `<span class="cg-chip cg-chip--danger">Retracted</span>`;
    if (showAsInLibrary) badges += `<span class="cg-chip cg-in-library">In Library</span>`;

    const expandLabel = isExpanded ? "Hide abstract" : "Abstract";
    const expandChevron = isExpanded ? "\u25BE" : "\u25B8";

    html += `
      <li class="cg-result-item" data-work-id="${escapeHTML(workId)}" role="listitem"
          tabindex="0" aria-expanded="${isExpanded}">
        <div class="cg-result-content">
          <div class="cg-result-title">
            ${
              cleanDOI
                ? `<a href="https://doi.org/${escapeHTML(cleanDOI)}" title="Open article in browser"
                    aria-label="Open ${escapeHTML(titleText)} in browser">${escapeHTML(titleText)}</a>`
                : `<span class="cg-no-link" title="No DOI available — cannot link to article">${escapeHTML(titleText)}</span>`
            }
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

export function buildExpandedHTML(
  state: NetworkState,
  workId: string,
  _work: OpenAlexWork,
): string {
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

export async function toggleExpanded(state: NetworkState, workId: string): Promise<void> {
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
      if (hint) safeInnerHTML(hint, `<span class="cg-expand-chevron">\u25B8</span>Abstract`);
    }
    return;
  }

  state.expandedIds.add(workId);
  if (!itemEl) return;
  itemEl.setAttribute("aria-expanded", "true");
  const hint = itemEl.querySelector(".cg-expand-hint");
  if (hint) safeInnerHTML(hint, `<span class="cg-expand-chevron">\u25BE</span>Hide abstract`);

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

  // Fetch abstract on-demand. On resume we re-query for the current
  // `[data-expanded-for]` node in the live body rather than writing to the
  // captured `expandedEl` — a search/sort/tab-switch between expand-click
  // and fetch-resolution detaches the original node, and updating it
  // would silently change nothing visible (F5).
  if (needsFetch) {
    let text: string | null = null;
    try {
      const fullWork = await getWorkById(workId);
      text = fullWork?.abstract_inverted_index
        ? reconstructAbstract(fullWork.abstract_inverted_index)
        : null;
    } catch {
      text = null;
    }
    state.abstractCache.set(workId, text);
    // OpenAlex workId matches /^W\d+$/ — alphanumeric, no quotes or
    // special chars — so CSS.escape is unnecessary AND the global is
    // not exposed in Zotero's XUL sandbox (throws ReferenceError there).
    const live = state.dialog.querySelector(`.cg-result-expanded[data-expanded-for="${workId}"]`);
    const loadingEl = live?.querySelector(".cg-abstract-loading");
    if (loadingEl) {
      loadingEl.className = text ? "cg-abstract-text" : "cg-abstract-none";
      loadingEl.textContent = text || "No abstract available";
    }
  }
}

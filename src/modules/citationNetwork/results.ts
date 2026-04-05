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
import { escapeHTML, safeInnerHTML } from "../utils";
import { MAX_RENDERED_RESULTS, type NetworkState } from "./types";
import { getDefaultCollectionName } from "./actions";

// ────────────────────────────────────────────────────────
// Loading & rendering
// ────────────────────────────────────────────────────────

export async function loadResults(state: NetworkState, append = false): Promise<void> {
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

export function renderResults(state: NetworkState, filter = ""): void {
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

export function buildExpandedHTML(state: NetworkState, workId: string, _work: OpenAlexWork): string {
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

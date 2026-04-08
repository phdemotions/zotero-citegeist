/**
 * Add / Undo / File actions and item creation for Citation Network.
 */

import { getSourceStats, type OpenAlexWork } from "../openalex";
import { cacheWorkData } from "../cache";
import { invalidateColumnCache } from "../citationColumn";
import { escapeHTML, safeInnerHTML } from "../utils";
import { SURNAME_PREFIXES, UNDO_TIMEOUT_MS, type NetworkState } from "./types";

// ────────────────────────────────────────────────────────
// Shared add-to-library logic (deduplicated from handleAdd + handleAddWithCollections)
// ────────────────────────────────────────────────────────

/**
 * Core routine that creates a Zotero item from an OpenAlex work,
 * caches metrics, updates state tracking, and starts the undo timer.
 * Both `handleAdd` and `handleAddWithCollections` delegate here.
 */
export async function addItemToLibrary(
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
    const srcId = work.primary_location?.source?.id;
    const srcStats = srcId ? await getSourceStats(srcId) : null;
    await cacheWorkData(item, work, srcStats);
    invalidateColumnCache(item.id);

    const doi = work.doi?.replace("https://doi.org/", "")?.toLowerCase();
    if (doi) {
      state.existingDOIs.add(doi);
      state.itemCollections.set(doi, new Set(collectionIds));
    }

    state.createdItemIds.set(workId, item.id);

    // Transition to "Added · Undo"
    state.undoTimers.set(
      workId,
      setTimeout(() => {
        state.undoTimers.delete(workId);
        state.addedThisSession.add(workId);
        updateRowButton(state, workId);
      }, UNDO_TIMEOUT_MS),
    );

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

// ────────────────────────────────────────────────────────
// Public action handlers
// ────────────────────────────────────────────────────────

export async function handleAdd(state: NetworkState, workId: string): Promise<void> {
  await addItemToLibrary(state, workId, state.defaultCollectionIds);
}

export async function handleUndo(state: NetworkState, workId: string): Promise<void> {
  const work = state.results.find((w) => w.id.replace("https://openalex.org/", "") === workId);
  if (!work) return;

  const timer = state.undoTimers.get(workId);
  if (timer) clearTimeout(timer);
  state.undoTimers.delete(workId);

  // Move the item to trash (safer than permanent erase)
  const createdItemId = state.createdItemIds.get(workId);
  if (createdItemId) {
    try {
      const item = Zotero.Items.get(createdItemId);
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
export function updateRowButton(state: NetworkState, workId: string): void {
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
    safeInnerHTML(
      btnWrap,
      `<button class="cg-split-main" data-work-id="${escapeHTML(workId)}" data-action="undo"
      aria-label="Undo adding ${escapeHTML(titleText)}">\u2713 Added \u00B7 Undo</button>
      <div class="cg-undo-bar"></div>`,
    );
  } else if (showAsInLibrary) {
    btnWrap.classList.add("cg-state-file");
    safeInnerHTML(
      btnWrap,
      `
      <button class="cg-split-main" data-work-id="${escapeHTML(workId)}" data-action="file"
        aria-label="Manage collections for ${escapeHTML(titleText)}">\uD83D\uDCC1 File</button>
      <button class="cg-split-arrow" data-work-id="${escapeHTML(workId)}"
        aria-label="Choose collections" aria-haspopup="listbox">\u25BE</button>`,
    );
  } else {
    const label = defaultName ? `+ Add to ${escapeHTML(defaultName)}` : "+ Add to Library";
    safeInnerHTML(
      btnWrap,
      `
      <button class="cg-split-main" data-work-id="${escapeHTML(workId)}" data-action="add"
        aria-label="Add ${escapeHTML(titleText)} to ${defaultName || "library"}">${label}</button>
      <button class="cg-split-arrow" data-work-id="${escapeHTML(workId)}"
        aria-label="Choose collections" aria-haspopup="listbox">\u25BE</button>`,
    );
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
// Item creation
// ────────────────────────────────────────────────────────

export async function createZoteroItemFromWork(
  work: OpenAlexWork,
  collectionIds?: Set<number>,
): Promise<_ZoteroTypes.Item> {
  const typeMap: Record<string, string> = {
    article: "journalArticle",
    "book-chapter": "bookSection",
    book: "book",
    dissertation: "thesis",
    dataset: "dataset",
    preprint: "preprint",
    review: "journalArticle",
    paratext: "journalArticle",
    report: "report",
    editorial: "journalArticle",
    letter: "journalArticle",
    erratum: "journalArticle",
    "proceedings-article": "conferencePaper",
    proceedings: "conferencePaper",
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
      item.addToCollection(colId);
    }
  }

  await item.saveTx();
  return item;
}

// ────────────────────────────────────────────────────────
// Library DOI lookup
// ────────────────────────────────────────────────────────

export async function getExistingDOIs(): Promise<Set<string>> {
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

export function getDefaultCollectionName(state: NetworkState): string {
  if (state.defaultCollectionIds.size === 0) return "";
  const ids = Array.from(state.defaultCollectionIds);
  const name = state.allCollections.find((c) => c.id === ids[0])?.name || "Collection";
  if (ids.length > 1) return `${name} +${ids.length - 1}`;
  return name;
}

/**
 * Update all visible "Add" buttons to reflect the current default collection name.
 */
export function updateAllAddButtons(state: NetworkState): void {
  const defaultName = getDefaultCollectionName(state);
  const label = defaultName ? `+ Add to ${defaultName}` : "+ Add to Library";
  const buttons = state.dialog.querySelectorAll('.cg-split-main[data-action="add"]');
  buttons.forEach((btn) => {
    (btn as HTMLElement).textContent = label;
  });
}

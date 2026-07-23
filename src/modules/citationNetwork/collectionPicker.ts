/**
 * Collection picker UI for the Citation Network dialog.
 *
 * Contains both the per-item picker (dropdown on each row) and the
 * default-collection picker (footer chip). Shared rendering logic is
 * consolidated in `renderCollectionOptions`.
 */

import { escapeHTML, logError, safeInnerHTML } from "../utils";
import { bindGuarded } from "../diagnostics";
import type { CollectionNode, NetworkState } from "./types";
import type { OpenAlexWork } from "../openalex";
import { findCachedItemKeyByOpenAlexId } from "../cache";
import { addItemToLibrary, updateAllAddButtons } from "./actions";

/** Short OpenAlex work id (`W123`), stripped of the URL prefix. */
function shortWorkId(work: OpenAlexWork): string {
  return work.id.replace("https://openalex.org/", "");
}

/**
 * Resolve the live Zotero item for a network result so its collections can be
 * read or edited. Resolution order: the id tracked when the item was added
 * this session → a cached-OpenAlex-id reverse lookup (covers prior-session
 * library items, with or without a DOI) → a DOI search (legacy / not-yet-cached
 * DOI items). Returns null when the work isn't in the library. The work id path
 * is what lets DOI-less items (books, preprints) be filed at all.
 */
async function resolveLibraryItem(
  state: NetworkState,
  work: OpenAlexWork,
): Promise<_ZoteroTypes.Item | null> {
  const workId = shortWorkId(work);

  const createdId = state.createdItemIds.get(workId);
  if (createdId) {
    const item = Zotero.Items.get(createdId);
    if (item) return item;
  }

  const cached = findCachedItemKeyByOpenAlexId(workId);
  if (cached) {
    const id = Zotero.Items.getIDFromLibraryAndKey(cached.libraryID, cached.key);
    if (id) {
      const item = Zotero.Items.get(id);
      if (item) return item;
    }
  }

  const doi = work.doi?.replace("https://doi.org/", "");
  if (doi) {
    const s = new Zotero.Search();
    s.libraryID = Zotero.Libraries.userLibraryID;
    s.addCondition("DOI", "is", doi);
    const ids = await s.search();
    if (ids && ids.length > 0) {
      const item = Zotero.Items.get(ids[0]);
      if (item) return item;
    }
  }

  return null;
}

/** Collections a network result's library item currently belongs to (empty if not found). */
async function getItemCollectionsForWork(
  state: NetworkState,
  work: OpenAlexWork,
): Promise<Set<number>> {
  const cols = new Set<number>();
  try {
    const item = await resolveLibraryItem(state, work);
    if (item) for (const colId of item.getCollections()) cols.add(colId);
  } catch (e) {
    logError("getItemCollectionsForWork", e);
  }
  return cols;
}

// ────────────────────────────────────────────────────────
// Shared collection-option rendering
// ────────────────────────────────────────────────────────

/**
 * Build the HTML for a list of collection options (checkboxes with tree
 * indentation). Both the per-item picker and the default-collection
 * dropdown call this instead of duplicating the HTML generation.
 */
function renderCollectionOptions(
  allCollections: CollectionNode[],
  selectedCols: Set<number>,
  expanded: Set<number>,
): string {
  let html = "";
  for (const col of allCollections) {
    const checked = selectedCols.has(col.id);
    const indent = col.depth > 0 ? `padding-left: ${12 + col.depth * 18}px;` : "";
    const isChild = col.depth > 0;
    const isVisible = !isChild || isAncestorExpanded(col, allCollections, expanded);
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
  return html;
}

/**
 * Bind chevron toggle and keyboard navigation events on all picker options
 * inside a container. Shared by per-item and default pickers.
 */
function bindPickerOptionEvents(
  container: HTMLElement,
  expanded: Set<number>,
  onToggle: (optEl: HTMLElement) => void,
  onEscape?: () => void,
): void {
  // Bind chevron toggles
  container.querySelectorAll(".cg-picker-chevron").forEach((chev) => {
    bindGuarded(chev as HTMLElement, "click", "collection picker chevron click", (e: Event) => {
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
      container.querySelectorAll(".cg-picker-option").forEach((opt) => {
        const optEl = opt as HTMLElement;
        const depth = Number(optEl.dataset.depth);
        if (depth > 0) {
          const visible = isAncestorExpandedDOM(optEl, container, expanded);
          if (visible) optEl.removeAttribute("hidden");
          else optEl.setAttribute("hidden", "");
        }
      });
    });
  });

  // Bind option selection + keyboard nav
  container.querySelectorAll(".cg-picker-option").forEach((opt) => {
    const optEl = opt as HTMLElement;
    const handler = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if ((e.target as HTMLElement)?.classList?.contains("cg-picker-chevron")) return;
      onToggle(optEl);
    };
    bindGuarded(optEl, "click", "collection picker optEl click", handler);
    bindGuarded(optEl, "keydown", "collection picker optEl keydown", (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter" || ke.key === " ") {
        ke.preventDefault();
        handler(e);
      } else if (ke.key === "ArrowDown") {
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
        if (onEscape) onEscape();
        else container.remove();
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

// ────────────────────────────────────────────────────────
// Per-item collection picker
// ────────────────────────────────────────────────────────

export async function toggleItemPicker(
  state: NetworkState,
  workId: string,
  anchor: HTMLElement,
): Promise<void> {
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
  const inLibrary =
    (cleanDOI ? state.existingDOIs.has(cleanDOI) : false) || state.existingWorkIds.has(workId);

  // Current collections for this item, keyed by work id. Prefer the set we
  // tracked when adding it this session; otherwise resolve from the library
  // item (covers prior-session items, DOI-less included); otherwise defaults.
  let currentCols: Set<number>;
  const stored = state.itemCollections.get(workId);
  if (stored) {
    currentCols = new Set(stored);
  } else if (inLibrary) {
    currentCols = await getItemCollectionsForWork(state, work);
    state.itemCollections.set(workId, currentCols);
  } else {
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

export function renderItemPickerContent(
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
      let pid = col.parentId;
      while (pid) {
        expanded.add(pid as number);
        const parent = state.allCollections.find((c) => c.id === pid);
        pid = parent ? parent.parentId : false;
      }
    }
  }

  let html = `<div class="cg-picker-list">`;
  html += renderCollectionOptions(state.allCollections, selectedCols, expanded);
  html += `</div>`;

  const actionLabel = inLibrary ? "Done" : "+ Add to Zotero";
  html += `<div class="cg-picker-actions">
    <button class="cg-btn cg-btn--sm cg-btn--filled cg-picker-done" data-work-id="${escapeHTML(workId)}"
            data-in-library="${inLibrary}">${actionLabel}</button>
  </div>`;

  safeInnerHTML(picker, html);

  // Bind shared option events
  bindPickerOptionEvents(
    picker,
    expanded,
    (optEl) => {
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
    },
    () => {
      picker.remove();
    },
  );

  // Done button
  const doneBtn = picker.querySelector(".cg-picker-done") as HTMLButtonElement;
  bindGuarded(doneBtn, "click", "collection picker doneBtn click", async (e: Event) => {
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

// ────────────────────────────────────────────────────────
// Default collection picker (footer)
// ────────────────────────────────────────────────────────

export function initDefaultCollectionPicker(state: NetworkState): void {
  const chip = state.dialog.querySelector("#cg-default-chip") as HTMLElement;
  const dropdown = state.dialog.querySelector("#cg-default-dropdown") as HTMLElement;
  if (!chip || !dropdown) return;

  bindGuarded(chip, "click", "collection picker chip click", (e: Event) => {
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

  // Close on click outside — listen on the dialog only. The dialog is
  // a child of the overlay so bubbled clicks reach this handler; binding
  // additionally on the overlay would fire the listener twice (C4).
  const closeOnOutside = (e: Event) => {
    if (dropdown.hidden) return;
    const target = e.target as HTMLElement;
    if (chip.contains(target) || dropdown.contains(target)) return;
    dropdown.hidden = true;
    chip.setAttribute("aria-expanded", "false");
    // Only restore focus when the closing click landed on a NON-
    // interactive element. If the user clicked a tab, result row,
    // search input, or any other focusable, the browser has already
    // moved focus there as part of normal click semantics — pulling
    // focus back to the chip would steal it from the user's intended
    // target. (ADV-U3)
    const movedToInteractive = target.closest("button, a, input, select, [tabindex]");
    if (!movedToInteractive) chip.focus();
  };
  bindGuarded(state.dialog, "click", "collection picker dialog click", closeOnOutside);
  bindGuarded(dropdown, "click", "collection picker dropdown click", (e: Event) =>
    e.stopPropagation(),
  );
}

export function renderDefaultDropdown(state: NetworkState): void {
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
  html += renderCollectionOptions(state.allCollections, state.defaultCollectionIds, expanded);

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

  // Bind shared option events
  bindPickerOptionEvents(
    dropdown,
    expanded,
    (optEl) => {
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
    },
    () => {
      const dd = state.dialog.querySelector("#cg-default-dropdown") as HTMLElement;
      const chip = state.dialog.querySelector("#cg-default-chip") as HTMLElement;
      if (dd) dd.hidden = true;
      chip?.setAttribute("aria-expanded", "false");
      chip?.focus();
    },
  );
}

export function updateDefaultCollectionLabel(state: NetworkState): void {
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
    if (footerLabel)
      footerLabel.textContent = ids.length > 1 ? "Default folders:" : "Default folder:";
  }
}

export function closeOpenPickers(state: NetworkState, exceptUnder?: HTMLElement): void {
  const pickers = state.dialog.querySelectorAll(".cg-item-picker");
  pickers.forEach((p) => {
    if (exceptUnder && exceptUnder.closest(".cg-item-picker") === p) return;
    p.remove();
  });
}

export async function handleAddWithCollections(
  state: NetworkState,
  workId: string,
  collectionIds: Set<number>,
): Promise<void> {
  await addItemToLibrary(state, workId, collectionIds);
}

export async function updateItemCollections(
  state: NetworkState,
  workId: string,
  newCols: Set<number>,
): Promise<void> {
  const work = state.results.find((w) => w.id.replace("https://openalex.org/", "") === workId);
  if (!work) return;

  try {
    // Resolve by work id (tracked add → cached reverse lookup → DOI search) so
    // DOI-less items can be filed; the old DOI-only search silently no-op'd.
    const item = await resolveLibraryItem(state, work);
    if (!item) return;

    const currentCols = new Set<number>(item.getCollections());
    for (const colId of newCols) {
      if (!currentCols.has(colId)) item.addToCollection(colId);
    }
    for (const colId of currentCols) {
      if (!newCols.has(colId)) item.removeFromCollection(colId);
    }

    await item.saveTx();
    state.itemCollections.set(workId, new Set(newCols));
  } catch (e) {
    logError("updateItemCollections", e);
  }
}

// ────────────────────────────────────────────────────────
// Collection helpers
// ────────────────────────────────────────────────────────

export function buildCollectionTree(): CollectionNode[] {
  const nodes: CollectionNode[] = [];
  try {
    const libraryID = Zotero.Libraries.userLibraryID;

    // Zotero.Collections.getByLibrary returns ALL collections in the library,
    // each with .id, .name, and .parentID (number or false for top-level).
    // We also try getChildCollections() as a fallback for nested discovery.
    const allCollections = Zotero.Collections.getByLibrary(libraryID);

    if (!allCollections || allCollections.length === 0) return nodes;

    // Build a map of id → collection and parentId → children
    const byId = new Map<number, { id: number; name: string; parentID: number | false }>();
    const childrenOf = new Map<
      number | false,
      Array<{ id: number; name: string; parentID: number | false }>
    >();

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
        } catch {
          /* ignore */
        }
      }
    }

    // Sort each group alphabetically
    for (const children of childrenOf.values()) {
      children.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Walk tree starting from root (parentID === false)
    const walk = (parentId: number | false, depth: number): void => {
      const children = childrenOf.get(parentId);
      if (!children) return;
      for (const col of children) {
        const hasChildren = childrenOf.has(col.id) && childrenOf.get(col.id)!.length > 0;
        nodes.push({ id: col.id, name: col.name, depth, parentId: col.parentID, hasChildren });
        walk(col.id, depth + 1);
      }
    };
    walk(false, 0);
  } catch (e) {
    logError("buildCollectionTree", e);
  }
  return nodes;
}

/** Check if all ancestors of a collection node are expanded (data model). */
export function isAncestorExpanded(
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
export function isAncestorExpandedDOM(
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

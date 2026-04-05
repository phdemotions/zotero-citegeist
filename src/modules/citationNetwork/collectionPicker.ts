/**
 * Collection picker UI for the Citation Network dialog.
 *
 * Contains both the per-item picker (dropdown on each row) and the
 * default-collection picker (footer chip). Shared rendering logic is
 * consolidated in `renderCollectionOptions`.
 */

import { escapeHTML, safeInnerHTML } from "../utils";
import type { CollectionNode, NetworkState } from "./types";
import { addItemToLibrary, updateAllAddButtons } from "./actions";

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

export async function toggleItemPicker(state: NetworkState, workId: string, anchor: HTMLElement): Promise<void> {
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
    <button class="cg-picker-done" data-work-id="${escapeHTML(workId)}"
            data-in-library="${inLibrary}">${actionLabel}</button>
  </div>`;

  safeInnerHTML(picker, html);

  // Bind shared option events
  bindPickerOptionEvents(picker, expanded, (optEl) => {
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
  }, () => {
    picker.remove();
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

// ────────────────────────────────────────────────────────
// Default collection picker (footer)
// ────────────────────────────────────────────────────────

export function initDefaultCollectionPicker(state: NetworkState): void {
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
  bindPickerOptionEvents(dropdown, expanded, (optEl) => {
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
  }, () => {
    const dd = state.dialog.querySelector("#cg-default-dropdown") as HTMLElement;
    const chip = state.dialog.querySelector("#cg-default-chip") as HTMLElement;
    if (dd) dd.hidden = true;
    chip?.setAttribute("aria-expanded", "false");
    chip?.focus();
  });
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
    if (footerLabel) footerLabel.textContent = ids.length > 1 ? "Default folders:" : "Default folder:";
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
  const doi = work.doi?.replace("https://doi.org/", "")?.toLowerCase();
  if (!doi) return;

  try {
    // Find the Zotero item
    const s = new Zotero.Search();
    s.libraryID = Zotero.Libraries.userLibraryID;
    s.addCondition("DOI", "is", work.doi!.replace("https://doi.org/", ""));
    const ids = await s.search();
    if (!ids || ids.length === 0) return;
    const item = Zotero.Items.get(ids[0]);
    if (!item) return;

    // Get current collections
    const currentCols = new Set<number>(item.getCollections());

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

export async function getItemCollections(doi: string): Promise<Set<number>> {
  const cols = new Set<number>();
  try {
    const s = new Zotero.Search();
    s.libraryID = Zotero.Libraries.userLibraryID;
    s.addCondition("DOI", "is", doi);
    const ids = await s.search();
    if (ids && ids.length > 0) {
      const item = Zotero.Items.get(ids[0]);
      if (item) {
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

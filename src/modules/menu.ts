/**
 * Context menu items and batch operations for Citegeist.
 *
 * Two registration paths share the same action handlers:
 *  - `Zotero.MenuManager` (Zotero 8+) — the official declarative menu API.
 *    Labels come from the injected FTL (`citegeist-menu-*`), visibility is
 *    decided in `onShowing`, and Zotero auto-removes the menus on shutdown
 *    via `pluginID`.
 *  - Manual DOM injection (Zotero 7.0.x, where `Zotero.MenuManager` is
 *    undefined) — the proven fallback. Plain string labels, `popupshowing`
 *    for visibility, explicit node removal on teardown.
 *
 * `registerMenus` feature-detects and prefers MenuManager; if it's absent or
 * a registration is rejected, it falls back to the DOM path so behaviour is
 * never worse than before. Action logic lives in the `run*` functions so both
 * paths stay in sync.
 */

import { fetchAndCacheItems, extractIdentifier } from "./citationService";
import { invalidateColumnCache } from "./citationColumn";
import { showCitationNetwork } from "./citationNetwork";
import { logError } from "./utils";

const MENU_IDS = {
  fetchCitations: "citegeist-menu-fetch",
  viewCiting: "citegeist-menu-citing",
  viewRefs: "citegeist-menu-refs",
  fetchCollection: "citegeist-menu-fetch-collection",
  separator: "citegeist-menu-separator",
  collectionSeparator: "citegeist-collection-menu-separator",
};

// MenuManager registration IDs (Zotero 8+ path).
const MM_ITEM_MENU_ID = "citegeist-item-menu";
const MM_COLLECTION_MENU_ID = "citegeist-collection-menu";

type NetworkMode = "citing" | "references";

/** Shape shared by both batch-fetch handlers. */
type BatchResult = { fresh: number; cached: number; suggestion: number; errors: number };

// ── Zotero.MenuManager surface (Zotero 8+; absent in typings/7.0.x) ──────────

interface MenuManagerContext {
  /** Selected items — present on the `main/library/item` target. */
  items?: _ZoteroTypes.Item[];
  /** Right-clicked collection/library row — present on collection target. */
  collectionTreeRow?: {
    ref?: { libraryID?: number };
    isCollection?: () => boolean;
    isLibrary?: () => boolean;
    editable?: boolean;
  };
  setVisible: (visible: boolean) => void;
  setEnabled: (enabled: boolean) => void;
}

interface MenuManagerMenuData {
  menuType: "menuitem" | "submenu" | "separator";
  l10nID?: string;
  icon?: string;
  onShowing?: (event: Event, context: MenuManagerContext) => void;
  onCommand?: (event: Event, context: MenuManagerContext) => void;
  menus?: MenuManagerMenuData[];
}

interface MenuManagerOptions {
  menuID: string;
  pluginID: string;
  target: string;
  menus: MenuManagerMenuData[];
}

interface ZoteroMenuManager {
  registerMenu(options: MenuManagerOptions): string | false;
  unregisterMenu(menuID: string): boolean;
}

/** Plugin ID, needed for the MenuManager path. Set once at startup. */
let menuPluginID: string | null = null;
export function setMenuPluginID(id: string): void {
  menuPluginID = id;
}

function getMenuManager(): ZoteroMenuManager | null {
  const mm = (Zotero as unknown as { MenuManager?: ZoteroMenuManager }).MenuManager;
  return mm && typeof mm.registerMenu === "function" ? mm : null;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Render a one-line summary of a batch fetch for the ProgressWindow.
 *
 * "Done — 0 of N updated" (old copy) confused users who'd already run
 * auto-fetch: every item came back `"cached"` (still fresh, no API call needed)
 * so the counter showed 0 even though the columns now displayed real data. New
 * copy distinguishes fresh / cached / suggestion / errors.
 */
function summarizeBatch(r: BatchResult, total: number): string {
  const parts: string[] = [];
  if (r.fresh > 0) parts.push(`${r.fresh} updated`);
  if (r.cached > 0) parts.push(`${r.cached} already up to date`);
  if (r.suggestion > 0) parts.push(`${r.suggestion} need confirmation`);
  if (r.errors > 0) parts.push(`${r.errors} couldn't be matched`);
  if (parts.length === 0) parts.push(`${total} processed`);
  return `Done — ${parts.join(", ")}`;
}

/** Recursively gather all items from a collection and its subcollections. */
function gatherCollectionItems(
  col: _ZoteroTypes.Collection,
  out: Map<number, _ZoteroTypes.Item>,
): void {
  for (const item of col.getChildItems()) {
    if (!out.has(item.id)) out.set(item.id, item);
  }
  for (const child of col.getChildCollections()) {
    gatherCollectionItems(child, out);
  }
}

function isEligible(item: _ZoteroTypes.Item): boolean {
  return item.isRegularItem() && extractIdentifier(item) !== null;
}

/** Count of currently-selected items that can be fetched. */
function eligibleSelectedCount(): number {
  return Zotero.getActiveZoteroPane().getSelectedItems().filter(isEligible).length;
}

/** True when exactly one item is selected and it has a recognized identifier. */
function singleSelectedWithIdentifier(): boolean {
  const items = Zotero.getActiveZoteroPane().getSelectedItems();
  return items.length === 1 && isEligible(items[0]);
}

// ── Actions (shared by DOM + MenuManager handlers) ───────────────────────────

async function runFetchSelected(win: Window): Promise<void> {
  const pane = Zotero.getActiveZoteroPane();
  const items = pane.getSelectedItems();
  if (items.length === 0) return;

  const eligible = items.filter(isEligible);
  // Modal alert when nothing is eligible — onShowing/popupshowing already hides
  // the entry, but a programmatic invocation or a mid-popup selection change
  // can land here with eligible.length=0.
  if (eligible.length === 0) {
    Services.prompt.alert(
      win,
      "Citegeist: Nothing to fetch",
      items.length === 0
        ? "No items selected."
        : `None of the ${items.length} selected item${items.length === 1 ? "" : "s"} has a recognized identifier (DOI, PMID, arXiv ID, or ISBN).`,
    );
    return;
  }

  const progressWin = new Zotero.ProgressWindow({ closeOnClick: false });
  progressWin.changeHeadline("Citegeist: Fetching Citations");
  // Explicit-color PNG inside the ProgressWindow — the SVG's `context-fill`
  // keyword fails to resolve there and Zotero falls back to its default red
  // loading curve, which clashes with the sage brand and reads as an error.
  const progress = new progressWin.ItemProgress(
    "chrome://citegeist/content/icons/icon-16-color.png",
    `Fetching ${eligible.length} item${eligible.length !== 1 ? "s" : ""}…`,
  );
  progressWin.show();

  let result: BatchResult = { fresh: 0, cached: 0, suggestion: 0, errors: 0 };
  try {
    result = await fetchAndCacheItems(eligible, (current, total) => {
      progress.setProgress((current / total) * 100);
      progress.setText(`${current}/${total} items fetched`);
    });
  } catch (e) {
    logError("menu fetch batch", e);
    progress.setProgress(100);
    progress.setText("Citegeist: fetch failed — see Debug Output");
    progressWin.startCloseTimer(5000);
    return;
  }

  progress.setProgress(100);
  progress.setText(summarizeBatch(result, eligible.length));
  progressWin.startCloseTimer(6000);

  // Targeted column repaint — pass the eligible item IDs so the Notifier event
  // tells Zotero's ItemTreeManager exactly which rows need re-rendering.
  try {
    invalidateColumnCache(eligible.map((i) => i.id));
  } catch (e) {
    logError("menu fetch column invalidate", e);
  }
}

function runViewNetwork(mode: NetworkMode): void {
  const items = Zotero.getActiveZoteroPane().getSelectedItems();
  if (items.length === 1) {
    showCitationNetwork(items[0], mode).catch((e) => logError("menu showCitationNetwork", e));
  }
}

async function runFetchCollection(win: Window): Promise<void> {
  const pane = Zotero.getActiveZoteroPane();
  const collection = pane.getSelectedCollection();

  // Gather items from the selected collection or the whole library when a
  // library root node (e.g. "My Library") is right-clicked — those nodes don't
  // return a collection from getSelectedCollection().
  const allItems = new Map<number, _ZoteroTypes.Item>();
  if (collection) {
    gatherCollectionItems(collection, allItems);
  } else {
    // Library root — getSelectedCollection() returns null for root nodes.
    // Use || (not ??) so a falsy 0 also falls back to the user library.
    const rawLibraryID = pane.getSelectedLibraryID?.();
    const libraryID = rawLibraryID || Zotero.Libraries.userLibraryID;
    const libraryItems = await Zotero.Items.getAll(libraryID, false);
    for (const item of libraryItems) allItems.set(item.id, item);
  }

  const totalItems = allItems.size;
  const eligible = [...allItems.values()].filter(isEligible);

  // Hard fallback when nothing is eligible — the ProgressWindow's corner
  // notification is easy to miss, leaving the user thinking the click did
  // nothing. A modal alert makes the empty result unambiguous + says WHY.
  const scope = collection ? "collection" : "library";
  if (eligible.length === 0) {
    Services.prompt.alert(
      win,
      "Citegeist: Nothing to fetch",
      totalItems === 0
        ? `This ${scope} is empty.`
        : `None of the ${totalItems} item${totalItems === 1 ? "" : "s"} in this ${scope} has a recognized identifier (DOI, PMID, arXiv ID, or ISBN). Add an identifier to the items you want citation data for, then try again.`,
    );
    return;
  }

  const progressWin = new Zotero.ProgressWindow({ closeOnClick: false });
  progressWin.changeHeadline("Citegeist: Fetching Citations");
  const progress = new progressWin.ItemProgress(
    "chrome://citegeist/content/icons/icon-16-color.png",
    `Fetching ${eligible.length} item${eligible.length === 1 ? "" : "s"}…`,
  );
  progressWin.show();

  let result: BatchResult = { fresh: 0, cached: 0, suggestion: 0, errors: 0 };
  try {
    result = await fetchAndCacheItems(eligible, (current, total) => {
      progress.setProgress((current / total) * 100);
      progress.setText(`${current}/${total} items fetched`);
    });
  } catch (e) {
    logError("menu fetch-collection batch", e);
    progress.setProgress(100);
    progress.setText("Citegeist: fetch failed — see Debug Output");
    progressWin.startCloseTimer(5000);
    return;
  }

  progress.setProgress(100);
  progress.setText(summarizeBatch(result, eligible.length));
  progressWin.startCloseTimer(6000);

  try {
    invalidateColumnCache(eligible.map((i) => i.id));
  } catch (e) {
    logError("menu fetch-collection column invalidate", e);
  }
}

// ── MenuManager path (Zotero 8+) ─────────────────────────────────────────────

/**
 * Register menus through `Zotero.MenuManager`. Returns true on success. If any
 * registration is rejected (`registerMenu` returns false), rolls back anything
 * already registered and returns false so the caller can fall back to DOM.
 */
function registerViaMenuManager(mm: ZoteroMenuManager, pluginID: string): boolean {
  const itemResult = mm.registerMenu({
    menuID: MM_ITEM_MENU_ID,
    pluginID,
    target: "main/library/item",
    menus: [
      {
        menuType: "menuitem",
        l10nID: "citegeist-menu-fetch",
        icon: "chrome://citegeist/content/icons/icon-16.svg",
        onShowing: (_e, ctx) =>
          ctx.setVisible((ctx.items ?? []).some(isEligible) || eligibleSelectedCount() > 0),
        onCommand: () => {
          runFetchSelected(Zotero.getMainWindow()).catch((e) => logError("menu fetch", e));
        },
      },
      {
        menuType: "menuitem",
        l10nID: "citegeist-menu-citing",
        onShowing: (_e, ctx) => ctx.setVisible(itemsSingleEligible(ctx.items)),
        onCommand: () => runViewNetwork("citing"),
      },
      {
        menuType: "menuitem",
        l10nID: "citegeist-menu-refs",
        onShowing: (_e, ctx) => ctx.setVisible(itemsSingleEligible(ctx.items)),
        onCommand: () => runViewNetwork("references"),
      },
    ],
  });
  if (itemResult === false) return false;

  const collectionResult = mm.registerMenu({
    menuID: MM_COLLECTION_MENU_ID,
    pluginID,
    target: "main/library/collection",
    menus: [
      {
        menuType: "menuitem",
        l10nID: "citegeist-menu-fetch-collection",
        icon: "chrome://citegeist/content/icons/icon-16.svg",
        onCommand: () => {
          runFetchCollection(Zotero.getMainWindow()).catch((e) =>
            logError("menu fetch-collection", e),
          );
        },
      },
    ],
  });
  if (collectionResult === false) {
    // Roll back the item menu so we don't leave a half-registered set, then
    // signal the caller to use the DOM path for everything.
    try {
      mm.unregisterMenu(MM_ITEM_MENU_ID);
    } catch (e) {
      logError("menu MenuManager rollback", e);
    }
    return false;
  }

  return true;
}

/**
 * Visibility helper for the MenuManager item menu. Prefers the context's
 * `items` (the documented access path) but falls back to the active pane's
 * selection if the context omits them.
 */
function itemsSingleEligible(items: _ZoteroTypes.Item[] | undefined): boolean {
  if (items && items.length > 0) {
    return items.length === 1 && isEligible(items[0]);
  }
  return singleSelectedWithIdentifier();
}

// ── DOM path (Zotero 7.0.x fallback) ─────────────────────────────────────────

function registerViaDOM(win: Window): void {
  const doc = win.document;
  const itemMenu = doc.getElementById("zotero-itemmenu");
  const collectionMenu = doc.getElementById("zotero-collectionmenu");

  Zotero.debug(
    `[Citegeist] registerMenus (DOM): itemMenu=${!!itemMenu}, collectionMenu=${!!collectionMenu}`,
  );

  // Guard against double registration (startup + onMainWindowLoad can both fire)
  if (doc.getElementById(MENU_IDS.fetchCitations)) {
    Zotero.debug("[Citegeist] Menus already registered, skipping");
    return;
  }

  if (itemMenu) {
    const sep = (doc as XULDocument).createXULElement("menuseparator");
    sep.id = MENU_IDS.separator;
    itemMenu.appendChild(sep);

    const fetchItem = (doc as XULDocument).createXULElement("menuitem");
    fetchItem.id = MENU_IDS.fetchCitations;
    fetchItem.setAttribute("label", "Fetch Citation Counts");
    fetchItem.setAttribute("image", "chrome://citegeist/content/icons/icon-16.svg");
    // Accesskeys audited against Zotero 7/8 default English item menu: F, R, I,
    // E, C are taken; G is unused — pick G for the "citeGeist" mnemonic. View
    // Citing/References get no accesskey (infrequent; Tab + Enter works).
    fetchItem.setAttribute("accesskey", "G");
    fetchItem.addEventListener("command", () => {
      runFetchSelected(win).catch((e) => logError("menu fetch", e));
    });
    itemMenu.appendChild(fetchItem);

    const citingItem = (doc as XULDocument).createXULElement("menuitem");
    citingItem.id = MENU_IDS.viewCiting;
    citingItem.setAttribute("label", "View Citing Works…");
    citingItem.addEventListener("command", () => runViewNetwork("citing"));
    itemMenu.appendChild(citingItem);

    const refsItem = (doc as XULDocument).createXULElement("menuitem");
    refsItem.id = MENU_IDS.viewRefs;
    refsItem.setAttribute("label", "View References…");
    refsItem.addEventListener("command", () => runViewNetwork("references"));
    itemMenu.appendChild(refsItem);

    // Hide citing/refs when multiple items are selected (single-item actions)
    // and hide Fetch when no selected items are eligible — a no-op click looked
    // like the feature was broken.
    itemMenu.addEventListener("popupshowing", () => {
      const eligibleCount = eligibleSelectedCount();
      const items = Zotero.getActiveZoteroPane().getSelectedItems();
      fetchItem.hidden = eligibleCount === 0;
      sep.hidden = eligibleCount === 0 && items.length !== 1;
      const singleWithIdentifier = singleSelectedWithIdentifier();
      citingItem.hidden = !singleWithIdentifier;
      refsItem.hidden = !singleWithIdentifier;
    });
  }

  if (collectionMenu) {
    const sep = (doc as XULDocument).createXULElement("menuseparator");
    sep.id = MENU_IDS.collectionSeparator;
    collectionMenu.appendChild(sep);

    const fetchAll = (doc as XULDocument).createXULElement("menuitem");
    fetchAll.id = MENU_IDS.fetchCollection;
    fetchAll.setAttribute("label", "Fetch All Citation Counts (Citegeist)");
    fetchAll.setAttribute("image", "chrome://citegeist/content/icons/icon-16.svg");
    // 'L' may collide with 'New Collection' on some builds; 'I' (citegeIst
    // mnemonic) is unused on the default collection context menu.
    fetchAll.setAttribute("accesskey", "I");
    fetchAll.addEventListener("command", () => {
      runFetchCollection(win).catch((e) => logError("menu fetch-collection", e));
    });
    collectionMenu.appendChild(fetchAll);
  }

  Zotero.debug("[Citegeist] Menus registered (DOM)");
}

// ── Public API ───────────────────────────────────────────────────────────────

export function registerMenus(win: Window): void {
  const mm = getMenuManager();
  if (mm && menuPluginID) {
    try {
      if (registerViaMenuManager(mm, menuPluginID)) {
        Zotero.debug("[Citegeist] Menus registered (MenuManager)");
        return;
      }
      Zotero.debug("[Citegeist] MenuManager registration rejected — falling back to DOM");
    } catch (e) {
      logError("menu MenuManager register", e);
      // Fall through to the DOM path.
    }
  }
  registerViaDOM(win);
}

export function unregisterMenus(win: Window): void {
  // MenuManager menus auto-clean on plugin shutdown via pluginID, but tear them
  // down explicitly too so a window-unload or hot-reload leaves nothing behind.
  const mm = getMenuManager();
  if (mm) {
    for (const id of [MM_ITEM_MENU_ID, MM_COLLECTION_MENU_ID]) {
      try {
        mm.unregisterMenu(id);
      } catch (e) {
        logError("menu MenuManager unregister", e);
      }
    }
  }
  // Always remove any DOM nodes too (covers the fallback path + mixed states).
  const doc = win.document;
  for (const id of Object.values(MENU_IDS)) {
    doc.getElementById(id)?.remove();
  }
}

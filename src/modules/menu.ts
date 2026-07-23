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

import {
  fetchAndCacheItems,
  canResolveWork,
  resolveAuthorsForItems,
  type AuthorBackfillResult,
  type FetchBatchResult,
} from "./citationService";
import { invalidateColumnCache } from "./citationColumn";
import { showCitationNetwork } from "./citationNetwork";
import { bindGuarded, guard } from "./diagnostics";
import { logError } from "./utils";

const MENU_IDS = {
  fetchCitations: "citegeist-menu-fetch",
  viewCiting: "citegeist-menu-citing",
  viewRefs: "citegeist-menu-refs",
  resolveAuthors: "citegeist-menu-resolve-authors",
  fetchCollection: "citegeist-menu-fetch-collection",
  resolveCollection: "citegeist-menu-resolve-collection",
  separator: "citegeist-menu-separator",
  collectionSeparator: "citegeist-collection-menu-separator",
};

// MenuManager registration IDs (Zotero 8+ path).
const MM_ITEM_MENU_ID = "citegeist-item-menu";
const MM_COLLECTION_MENU_ID = "citegeist-collection-menu";

type NetworkMode = "citing" | "references";

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

/**
 * Wrap every handler in a menu tree with an error boundary, recursing into
 * submenus.
 *
 * Applied once at the `registerMenu` call rather than at each handler, so a
 * menu item added later is protected without anyone remembering to wrap it.
 * A throwing `onCommand` does nothing at all from the user's side — the menu
 * closes and no work happens — and a throwing `onShowing` can break the whole
 * popup, so neither can be left bare.
 */
function guardMenus(menus: MenuManagerMenuData[]): MenuManagerMenuData[] {
  return menus.map((menu) => ({
    ...menu,
    onShowing: menu.onShowing
      ? (e: Event, ctx: MenuManagerContext) =>
          guard(`menu onShowing ${menu.l10nID ?? menu.menuType}`, () => menu.onShowing?.(e, ctx))
      : undefined,
    onCommand: menu.onCommand
      ? (e: Event, ctx: MenuManagerContext) =>
          guard(`menu onCommand ${menu.l10nID ?? menu.menuType}`, () => menu.onCommand?.(e, ctx))
      : undefined,
    menus: menu.menus ? guardMenus(menu.menus) : undefined,
  }));
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

/**
 * Plugin rootURI, set once at startup. Menu/progress icons are built off it as
 * `jar:` URLs — `chrome://citegeist/…` is unregistered on some Zotero 9 installs
 * ("No chrome package registered"), which made the menu-item icons fail to load
 * and, with them, the right-click menu itself.
 */
let menuRootURI = "";
export function setMenuRootURI(uri: string): void {
  menuRootURI = uri;
}
/** Build a plugin-icon URL that always resolves (jar: via rootURI). */
function iconURL(name: string): string {
  return `${menuRootURI}content/icons/${name}`;
}

/**
 * True once the process-global MenuManager registration has fully succeeded.
 *
 * The MenuManager registry is keyed per-process, not per-window, so a second
 * `registerMenus` call — File > New Window fires `onMainWindowLoad` again, and
 * dev hot-reload can re-enter — must be a NO-OP. Without this guard the repeat
 * call re-attempts `registerMenu`, Zotero rejects it as a duplicate (a plain
 * `false`, indistinguishable from a real failure), and the old code misread
 * that as "MenuManager unavailable" and injected a second, uncoordinated DOM
 * menu onto the same popup MenuManager still owns — the root cause of the
 * garbled / dead right-click menu in issue #67.
 *
 * Mirrors the `registered` flag in `citationColumn.ts`. Reset only by
 * `unregisterGlobalMenus()` at plugin shutdown.
 */
let menuManagerRegistered = false;

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
function summarizeBatch(r: FetchBatchResult, total: number): string {
  const parts: string[] = [];
  if (r.fresh > 0) parts.push(`${r.fresh} updated`);
  if (r.cached > 0) parts.push(`${r.cached} already up to date`);
  if (r.suggestion > 0) parts.push(`${r.suggestion} need confirmation`);
  if (r.errors > 0) parts.push(`${r.errors} couldn't be matched`);
  if (r.budgetStopped > 0) parts.push(`${r.budgetStopped} skipped (daily budget spent)`);
  if (parts.length === 0) parts.push(`${total} processed`);
  return `Done — ${parts.join(", ")}`;
}

/**
 * One-line summary of an author-identity backfill for the ProgressWindow.
 * Keeps the budget-stopped count distinct from a genuine no-match so a spent
 * daily budget never reads as "no authors found".
 */
function summarizeAuthorBackfill(r: AuthorBackfillResult, total: number): string {
  const parts: string[] = [];
  if (r.resolved > 0) parts.push(`${r.resolved} resolved`);
  if (r.already > 0) parts.push(`${r.already} already linked`);
  if (r.unresolved > 0) parts.push(`${r.unresolved} no author match`);
  if (r.budgetStopped > 0) parts.push(`${r.budgetStopped} skipped (daily budget spent)`);
  if (r.errors > 0) parts.push(`${r.errors} failed`);
  if (parts.length === 0) parts.push(`${total} processed`);
  const head = r.cancelled ? "Stopped" : "Done";
  return `${head} — ${parts.join(", ")}`;
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

/** Count of currently-selected items Citegeist can resolve to an OpenAlex work. */
function eligibleSelectedCount(): number {
  return Zotero.getActiveZoteroPane().getSelectedItems().filter(canResolveWork).length;
}

/** True when exactly one item is selected and the browser can resolve it to a work. */
function singleSelectedResolvable(): boolean {
  const items = Zotero.getActiveZoteroPane().getSelectedItems();
  return items.length === 1 && canResolveWork(items[0]);
}

// ── Actions (shared by DOM + MenuManager handlers) ───────────────────────────

async function runFetchSelected(win: Window): Promise<void> {
  const pane = Zotero.getActiveZoteroPane();
  const items = pane.getSelectedItems();
  if (items.length === 0) return;

  const eligible = items.filter(canResolveWork);
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
    iconURL("icon-16-color.png"),
    `Fetching ${eligible.length} item${eligible.length !== 1 ? "s" : ""}…`,
  );
  progressWin.show();

  let result: FetchBatchResult = {
    fresh: 0,
    cached: 0,
    suggestion: 0,
    errors: 0,
    budgetStopped: 0,
  };
  try {
    result = await fetchAndCacheItems(
      eligible,
      (current, total) => {
        progress.setProgress((current / total) * 100);
        progress.setText(`${current}/${total} items fetched`);
      },
      (itemId, status) => {
        // Repaint each row's columns the moment its data lands, so a long
        // collection/library fetch fills in progressively instead of all at
        // the end. The repaint is coalesced/debounced inside the column module.
        if (status === "ok" || status === "suggestion") {
          invalidateColumnCache(itemId);
        }
      },
    );
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
  const eligible = [...allItems.values()].filter(canResolveWork);

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
    iconURL("icon-16-color.png"),
    `Fetching ${eligible.length} item${eligible.length === 1 ? "" : "s"}…`,
  );
  progressWin.show();

  let result: FetchBatchResult = {
    fresh: 0,
    cached: 0,
    suggestion: 0,
    errors: 0,
    budgetStopped: 0,
  };
  try {
    result = await fetchAndCacheItems(
      eligible,
      (current, total) => {
        progress.setProgress((current / total) * 100);
        progress.setText(`${current}/${total} items fetched`);
      },
      (itemId, status) => {
        // Repaint each row's columns the moment its data lands, so a long
        // collection/library fetch fills in progressively instead of all at
        // the end. The repaint is coalesced/debounced inside the column module.
        if (status === "ok" || status === "suggestion") {
          invalidateColumnCache(itemId);
        }
      },
    );
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

async function runResolveAuthorsSelected(win: Window): Promise<void> {
  const pane = Zotero.getActiveZoteroPane();
  const items = pane.getSelectedItems();
  if (items.length === 0) return;

  const eligible = items.filter(canResolveWork);
  if (eligible.length === 0) {
    Services.prompt.alert(
      win,
      "Citegeist: Nothing to resolve",
      items.length === 0
        ? "No items selected."
        : `None of the ${items.length} selected item${items.length === 1 ? "" : "s"} has a recognized identifier to resolve authors from.`,
    );
    return;
  }

  const progressWin = new Zotero.ProgressWindow({ closeOnClick: false });
  progressWin.changeHeadline("Citegeist: Resolving Author Identities");
  const progress = new progressWin.ItemProgress(
    iconURL("icon-16-color.png"),
    `Resolving authors for ${eligible.length} item${eligible.length !== 1 ? "s" : ""}…`,
  );
  progressWin.show();

  let result: AuthorBackfillResult;
  try {
    result = await resolveAuthorsForItems(eligible, (current, total) => {
      progress.setProgress((current / total) * 100);
      progress.setText(`${current}/${total} items processed`);
    });
  } catch (e) {
    logError("menu resolve-authors batch", e);
    progress.setProgress(100);
    progress.setText("Citegeist: resolve failed — see Debug Output");
    progressWin.startCloseTimer(5000);
    return;
  }

  progress.setProgress(100);
  progress.setText(summarizeAuthorBackfill(result, eligible.length));
  progressWin.startCloseTimer(6000);
}

async function runResolveAuthorsCollection(win: Window): Promise<void> {
  const pane = Zotero.getActiveZoteroPane();
  const collection = pane.getSelectedCollection();

  const allItems = new Map<number, _ZoteroTypes.Item>();
  if (collection) {
    gatherCollectionItems(collection, allItems);
  } else {
    const rawLibraryID = pane.getSelectedLibraryID?.();
    const libraryID = rawLibraryID || Zotero.Libraries.userLibraryID;
    const libraryItems = await Zotero.Items.getAll(libraryID, false);
    for (const item of libraryItems) allItems.set(item.id, item);
  }

  const totalItems = allItems.size;
  const eligible = [...allItems.values()].filter(canResolveWork);
  const scope = collection ? "collection" : "library";
  if (eligible.length === 0) {
    Services.prompt.alert(
      win,
      "Citegeist: Nothing to resolve",
      totalItems === 0
        ? `This ${scope} is empty.`
        : `None of the ${totalItems} item${totalItems === 1 ? "" : "s"} in this ${scope} has a recognized identifier to resolve authors from.`,
    );
    return;
  }

  const progressWin = new Zotero.ProgressWindow({ closeOnClick: false });
  progressWin.changeHeadline("Citegeist: Resolving Author Identities");
  const progress = new progressWin.ItemProgress(
    iconURL("icon-16-color.png"),
    `Resolving authors for ${eligible.length} item${eligible.length === 1 ? "" : "s"}…`,
  );
  progressWin.show();

  let result: AuthorBackfillResult;
  try {
    result = await resolveAuthorsForItems(eligible, (current, total) => {
      progress.setProgress((current / total) * 100);
      progress.setText(`${current}/${total} items processed`);
    });
  } catch (e) {
    logError("menu resolve-authors-collection batch", e);
    progress.setProgress(100);
    progress.setText("Citegeist: resolve failed — see Debug Output");
    progressWin.startCloseTimer(5000);
    return;
  }

  progress.setProgress(100);
  progress.setText(summarizeAuthorBackfill(result, eligible.length));
  progressWin.startCloseTimer(6000);
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
    menus: guardMenus([
      {
        menuType: "menuitem",
        // l10nID, NOT label: the MenuManager schema has no `label` field — it
        // renders text ONLY from data-l10n-id, so a plain `label` string is
        // silently dropped and the item shows blank ("right-click shows
        // nothing"). Text + accesskey come from the FTL (citegeist-menu-*, in
        // `.label`/`.accesskey` attribute syntax). The FTL is injected per
        // window by hooks.ensureCitegeistFTL.
        l10nID: "citegeist-menu-fetch",
        icon: iconURL("icon-16.svg"),
        onShowing: (_e, ctx) =>
          // Use the supplied context items when present; only fall back to the
          // pane selection when ctx omits them — avoids a second eligibility
          // pass when ctx.items is present but all-ineligible.
          ctx.setVisible(
            ctx.items && ctx.items.length > 0
              ? ctx.items.some(canResolveWork)
              : eligibleSelectedCount() > 0,
          ),
        onCommand: () => {
          runFetchSelected(Zotero.getMainWindow()).catch((e) => logError("menu fetch", e));
        },
      },
      {
        menuType: "menuitem",
        l10nID: "citegeist-menu-citing",
        onShowing: (_e, ctx) => ctx.setVisible(itemsSingleResolvable(ctx.items)),
        onCommand: () => runViewNetwork("citing"),
      },
      {
        menuType: "menuitem",
        l10nID: "citegeist-menu-refs",
        onShowing: (_e, ctx) => ctx.setVisible(itemsSingleResolvable(ctx.items)),
        onCommand: () => runViewNetwork("references"),
      },
      {
        menuType: "menuitem",
        l10nID: "citegeist-menu-resolve-authors",
        icon: iconURL("icon-16.svg"),
        onShowing: (_e, ctx) =>
          ctx.setVisible(
            ctx.items && ctx.items.length > 0
              ? ctx.items.some(canResolveWork)
              : eligibleSelectedCount() > 0,
          ),
        onCommand: () => {
          runResolveAuthorsSelected(Zotero.getMainWindow()).catch((e) =>
            logError("menu resolve-authors", e),
          );
        },
      },
    ]),
  });
  if (itemResult === false) return false;

  const collectionResult = mm.registerMenu({
    menuID: MM_COLLECTION_MENU_ID,
    pluginID,
    target: "main/library/collection",
    menus: guardMenus([
      {
        menuType: "menuitem",
        l10nID: "citegeist-menu-fetch-collection",
        icon: iconURL("icon-16.svg"),
        onCommand: () => {
          runFetchCollection(Zotero.getMainWindow()).catch((e) =>
            logError("menu fetch-collection", e),
          );
        },
      },
      {
        menuType: "menuitem",
        l10nID: "citegeist-menu-resolve-collection",
        icon: iconURL("icon-16.svg"),
        onCommand: () => {
          runResolveAuthorsCollection(Zotero.getMainWindow()).catch((e) =>
            logError("menu resolve-authors-collection", e),
          );
        },
      },
    ]),
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
function itemsSingleResolvable(items: _ZoteroTypes.Item[] | undefined): boolean {
  if (items && items.length > 0) {
    return items.length === 1 && canResolveWork(items[0]);
  }
  return singleSelectedResolvable();
}

// ── DOM path (Zotero 7.0.x fallback) ─────────────────────────────────────────

/**
 * Which DOM item-menu entries are SHOWN for a given selection (caller sets
 * `.hidden = !shown`). Pure, so the separator-vs-entries rule is unit-tested
 * rather than buried in the popup handler.
 *
 * The separator groups the four entries below it, so it must show only when at
 * least one of them shows. Fetch / Resolve show when any selected item is
 * eligible; Citing / References are single-eligible-item actions — which implies
 * eligibility — so "any entry shows" reduces exactly to `eligibleCount > 0`.
 * The old handler kept the separator visible for a single *ineligible* item
 * (`eligibleCount === 0 && items.length !== 1`), stranding a lone empty section
 * in the right-click menu — issue #72.
 */
export function itemMenuVisibility(items: _ZoteroTypes.Item[]): {
  fetch: boolean;
  resolveAuthors: boolean;
  citing: boolean;
  references: boolean;
  separator: boolean;
} {
  const eligibleCount = items.filter(canResolveWork).length;
  const singleResolvable = items.length === 1 && eligibleCount === 1;
  return {
    fetch: eligibleCount > 0,
    resolveAuthors: eligibleCount > 0,
    citing: singleResolvable,
    references: singleResolvable,
    separator: eligibleCount > 0,
  };
}

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
    fetchItem.setAttribute("image", iconURL("icon-16.svg"));
    // Accesskeys audited against Zotero 7/8 default English item menu: F, R, I,
    // E, C are taken; G is unused — pick G for the "citeGeist" mnemonic. View
    // Citing/References get no accesskey (infrequent; Tab + Enter works).
    fetchItem.setAttribute("accesskey", "G");
    bindGuarded(fetchItem, "command", "menu fetch item", () => {
      runFetchSelected(win).catch((e) => logError("menu fetch", e));
    });
    itemMenu.appendChild(fetchItem);

    const citingItem = (doc as XULDocument).createXULElement("menuitem");
    citingItem.id = MENU_IDS.viewCiting;
    citingItem.setAttribute("label", "View Citing Works…");
    bindGuarded(citingItem, "command", "menu view citing", () => runViewNetwork("citing"));
    itemMenu.appendChild(citingItem);

    const refsItem = (doc as XULDocument).createXULElement("menuitem");
    refsItem.id = MENU_IDS.viewRefs;
    refsItem.setAttribute("label", "View References…");
    bindGuarded(refsItem, "command", "menu view references", () => runViewNetwork("references"));
    itemMenu.appendChild(refsItem);

    const resolveItem = (doc as XULDocument).createXULElement("menuitem");
    resolveItem.id = MENU_IDS.resolveAuthors;
    resolveItem.setAttribute("label", "Resolve Author Identities (Citegeist)");
    resolveItem.setAttribute("image", iconURL("icon-16.svg"));
    // 'A' (Authors) is free on the default item context menu alongside 'G'.
    resolveItem.setAttribute("accesskey", "A");
    bindGuarded(resolveItem, "command", "menu resolve authors", () => {
      runResolveAuthorsSelected(win).catch((e) => logError("menu resolve-authors", e));
    });
    itemMenu.appendChild(resolveItem);

    // Gate every entry — and the separator — on the current selection, so a
    // no-op click never looks like the feature is broken and no stray empty
    // section is left behind (issue #72). Visibility rule lives in the pure,
    // tested itemMenuVisibility().
    bindGuarded(itemMenu, "popupshowing", "menu item popupshowing", () => {
      const v = itemMenuVisibility(Zotero.getActiveZoteroPane().getSelectedItems());
      fetchItem.hidden = !v.fetch;
      resolveItem.hidden = !v.resolveAuthors;
      citingItem.hidden = !v.citing;
      refsItem.hidden = !v.references;
      sep.hidden = !v.separator;
    });
  }

  if (collectionMenu) {
    const sep = (doc as XULDocument).createXULElement("menuseparator");
    sep.id = MENU_IDS.collectionSeparator;
    collectionMenu.appendChild(sep);

    const fetchAll = (doc as XULDocument).createXULElement("menuitem");
    fetchAll.id = MENU_IDS.fetchCollection;
    fetchAll.setAttribute("label", "Fetch All Citation Counts (Citegeist)");
    fetchAll.setAttribute("image", iconURL("icon-16.svg"));
    // 'L' may collide with 'New Collection' on some builds; 'I' (citegeIst
    // mnemonic) is unused on the default collection context menu.
    fetchAll.setAttribute("accesskey", "I");
    bindGuarded(fetchAll, "command", "menu fetch collection", () => {
      runFetchCollection(win).catch((e) => logError("menu fetch-collection", e));
    });
    collectionMenu.appendChild(fetchAll);

    const resolveAll = (doc as XULDocument).createXULElement("menuitem");
    resolveAll.id = MENU_IDS.resolveCollection;
    resolveAll.setAttribute("label", "Resolve All Author Identities (Citegeist)");
    resolveAll.setAttribute("image", iconURL("icon-16.svg"));
    resolveAll.setAttribute("accesskey", "A");
    bindGuarded(resolveAll, "command", "menu resolve collection", () => {
      runResolveAuthorsCollection(win).catch((e) => logError("menu resolve-authors-collection", e));
    });
    collectionMenu.appendChild(resolveAll);
  }

  Zotero.debug("[Citegeist] Menus registered (DOM)");
}

// ── Public API ───────────────────────────────────────────────────────────────

export function registerMenus(win: Window): void {
  // Idempotency guard (issue #67): the MenuManager registration is
  // process-global, so once it is active a repeat call (new window, hot-reload)
  // must do nothing. Re-attempting would be rejected as a duplicate and misread
  // as "MenuManager broken", injecting a duplicate DOM menu onto the same popup.
  if (menuManagerRegistered) {
    Zotero.debug("[Citegeist] Menus already registered (MenuManager) — skipping");
    return;
  }

  const mm = getMenuManager();
  if (mm && menuPluginID) {
    try {
      if (registerViaMenuManager(mm, menuPluginID)) {
        menuManagerRegistered = true;
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

/**
 * Per-window teardown. Removes any DOM-injected menu nodes from THIS window
 * only. Runs on every window unload.
 *
 * Deliberately does NOT touch the process-global MenuManager registration:
 * doing so would remove Citegeist's context menu from every other still-open
 * window (issue #67, teardown side — a secondary window closing silently killed
 * the menu everywhere). Global MenuManager teardown lives in
 * `unregisterGlobalMenus()` and runs once, at plugin shutdown.
 */
export function unregisterMenus(win: Window): void {
  const doc = win.document;
  for (const id of Object.values(MENU_IDS)) {
    doc.getElementById(id)?.remove();
  }
}

/**
 * Process-global teardown. Unregisters the MenuManager menus and resets the
 * idempotency flag. Call ONCE, at plugin shutdown — never on a per-window
 * unload. MenuManager menus also auto-clean on plugin shutdown via `pluginID`,
 * but tearing them down explicitly keeps a hot-reload from leaking a stale
 * registration behind the flag.
 */
export function unregisterGlobalMenus(): void {
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
  menuManagerRegistered = false;
}

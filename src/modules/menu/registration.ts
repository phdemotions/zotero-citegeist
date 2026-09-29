/**
 * Registering Citegeist's right-click menus, and the handlers Zotero calls.
 *
 * Menus register through `Zotero.MenuManager` (Zotero 8 and later): labels come
 * from the injected FTL (`citegeist-menu-*`), `onShowing` decides visibility, and
 * Zotero removes the menus with the plugin through `pluginID`.
 *
 * **Keys.** Zotero stores each menu under `CSS.escape(`${pluginID}-${menuID}`)`,
 * returns that key from `registerMenu`, and `unregisterMenu` finds a menu by that
 * key only (pluginAPIBase.mjs `_validate` 177-194, `_remove` 163-170 and
 * `_namespacedMainKey` 312-320, identical at 8.0.4, 9.0.6 and 10.0.2; menuManager.js
 * `registerMenu` returns it, @8.0.4 789, @10.0.2 825). Teardown and rollback
 * therefore use the keys `registerMenu` returned, never the menu IDs.
 *
 * **When the DOM fallback runs.** `registerMenus` uses the DOM fallback, entries
 * injected into each window's own popups, in two cases: `Zotero.MenuManager` does
 * not exist (Zotero 7), or it rejected or threw on the registration (any Zotero).
 * The choice is made once per process, so every later window follows it and no
 * window shows both sets.
 *
 * What a command does lives in `batchActions.ts` and which entries show lives in
 * `visibility.ts`, so both registration paths run the same code.
 */

import { showCitationNetwork } from "../citationNetwork";
import { bindGuarded, guard } from "../diagnostics";
import {
  collectionTargetsFromMenuContext,
  collectionTargetsFromPane,
  paneForWindow,
  selectedItemsInWindow,
  type CollectionTarget,
} from "../host/selection";
import { logError, normalizeError } from "../utils";
import {
  FETCH_CITATIONS,
  RESOLVE_AUTHORS,
  runOnItems,
  runOnTargets,
  type BatchAction,
} from "./batchActions";
import { menuIconURL } from "./icons";
import { collectionEntriesVisible, itemMenuVisibility } from "./visibility";

type MenuContext = _ZoteroTypes.MenuManagerContext;
type MenuData = _ZoteroTypes.MenuManagerMenuData;
type NetworkMode = "citing" | "references";

const ITEM_MENU_ID = "citegeist-item-menu";
const COLLECTION_MENU_ID = "citegeist-collection-menu";

/**
 * The class MenuManager puts on every entry it renders into a popup
 * (`CUSTOM_MENU_CLASS`, menuManager.js line 73 at 8.0.4, 9.0.6 and 10.0.2).
 */
const RENDERED_ENTRY_CLASS = "zotero-custom-menu-item";

/** Plugin ID, needed to register through MenuManager. Set once at startup. */
let menuPluginID: string | null = null;
export function setMenuPluginID(id: string): void {
  menuPluginID = id;
}

/**
 * The keys Zotero stored this copy's menus under, as `registerMenu` returned
 * them. Empty until the process-global MenuManager registration has fully
 * succeeded, and emptied by `unregisterGlobalMenus()`.
 *
 * The MenuManager registry is per process, not per window, so a second
 * `registerMenus` call (File > New Window fires `onMainWindowLoad` again, and a
 * dev hot-reload can re-enter) must do nothing while these are held.
 * Re-attempting is rejected as a duplicate, a plain `false` that looks like a
 * real failure, and reading it as one put a second, uncoordinated menu on the
 * popup MenuManager still owns: the garbled, dead right-click menu of issue #67.
 */
let menuManagerKeys: readonly string[] = [];

/**
 * True once MenuManager was found missing or refused the menus, so later windows
 * go straight to the DOM fallback. Reset by `unregisterGlobalMenus()`.
 * Zotero 7 DOM fallback: delete with registerViaDOM (U9)
 */
let domFallbackChosen = false;

// ── Public API ───────────────────────────────────────────────────────────────

export function registerMenus(win: Window): void {
  if (menuManagerKeys.length > 0) {
    Zotero.debug("[Citegeist] Menus already registered (MenuManager) — skipping");
    return;
  }
  if (!domFallbackChosen) {
    const mm = getMenuManager();
    if (mm && menuPluginID && registerViaMenuManager(mm, menuPluginID)) {
      Zotero.debug("[Citegeist] Menus registered (MenuManager)");
      return;
    }
    domFallbackChosen = true;
  }
  registerViaDOM(win);
}

/**
 * Per-window teardown, on every window unload and at shutdown: removes this
 * window's DOM entries and aborts their listeners, including the `popupshowing`
 * listeners on Zotero's own popups, which outlive the entries.
 *
 * It leaves the process-global MenuManager registration alone. Removing it here
 * would take Citegeist's menu out of every other open window (issue #67, where a
 * secondary window closing killed the menu everywhere); `unregisterGlobalMenus()`
 * does that once, at plugin shutdown.
 *
 * Zotero 7 DOM fallback: delete with registerViaDOM (U9)
 */
export function unregisterMenus(win: Window): void {
  domListenerControllers.get(win)?.abort();
  domListenerControllers.delete(win);
  const doc = win.document;
  for (const id of Object.values(MENU_IDS)) {
    doc.getElementById(id)?.remove();
  }
}

/**
 * Process-global teardown: unregisters the MenuManager menus this copy
 * registered, by the keys Zotero returned for them, and forgets which path
 * registration took. Call once, when the plugin shuts down or fails to start,
 * never on a window unload. Zotero's plugin-shutdown observer would remove the
 * menus too (pluginAPIBase.mjs `_unregisterByPluginID` 345-356, added at 362-373),
 * but it runs only on a plugin shutdown, after the bootstrap method returns
 * (plugins.js `_callMethod`: the method at @8.0.4 250 and @10.0.2 258, the
 * observers from 261 and 269), so a failed startup and a hot-reload need this.
 *
 * It removes only keys this copy registered: `unregisterMenu` on any other string
 * logs "Can't remove unknown option" (pluginAPIBase.mjs 165), and Zotero 8 to 10
 * file that warning as an error in Help → Report Errors.
 *
 * Rendered entries are not touched: see `removeRenderedMenus`.
 */
export function unregisterGlobalMenus(): void {
  const mm = getMenuManager();
  if (mm) unregisterEach(mm, menuManagerKeys, "menu MenuManager unregister");
  menuManagerKeys = [];
  domFallbackChosen = false;
}

/**
 * Remove the entries MenuManager rendered for Citegeist's menus from `win`.
 *
 * MenuManager renders a menu's entries when its popup opens and leaves them in
 * the popup. `unregisterMenu` removes the registration only (pluginAPIBase.mjs
 * `_remove` 163-170). The plugin-shutdown observer removes rendered entries on
 * Zotero 9.0.6 and later, but only for the menus it unregisters itself
 * (menuManager.js@10.0.2 304-323), which is none of Citegeist's once
 * `unregisterGlobalMenus()` has run; Zotero 8.0.4's observer matches no rendered
 * entry, because 8.0.4 stamps no menu key on them (menuManager.js@8.0.4 435).
 *
 * A stale entry is not harmless. It keeps its `data-l10n-id`, and once Zotero
 * unregisters Citegeist's translations at disable, `translateFragment` over the
 * item popup rejects (locateMenu.js 127 at 8.0.4, 9.0.6 and 10.0.2), so
 * `buildItemContextMenu` stops before it reaches MenuManager (zoteroPane.js
 * @8.0.4 4200, @9.0.6 4242, @10.0.2 4683) and the right-click menu never builds.
 *
 * Entries are matched by the class MenuManager puts on each one and the
 * `data-l10n-id` it copies from the entry's `l10nID` (menuManager.js @8.0.4 440,
 * @9.0.6 and @10.0.2 454), limited to Citegeist's own l10nIDs, so another
 * plugin's entries stay. Entries MenuManager moved into its overflow submenu are
 * found the same way.
 */
export function removeRenderedMenus(win: Window): void {
  const l10nIDs = citegeistMenuL10nIDs();
  for (const entry of Array.from(win.document.querySelectorAll(`.${RENDERED_ENTRY_CLASS}`))) {
    const l10nID = entry.getAttribute("data-l10n-id");
    if (l10nID !== null && l10nIDs.has(l10nID)) entry.remove();
  }
}

// ── MenuManager ──────────────────────────────────────────────────────────────

function getMenuManager(): _ZoteroTypes.MenuManager | null {
  const mm = Zotero.MenuManager;
  return mm && typeof mm.registerMenu === "function" ? mm : null;
}

/**
 * Register both menus and keep the keys Zotero returned. On a rejection
 * (`registerMenu` returns `false`) or a throw, unregister whatever already
 * registered, so no half-registered set is left beside the fallback, and return
 * false.
 */
function registerViaMenuManager(mm: _ZoteroTypes.MenuManager, pluginID: string): boolean {
  const menus = menuManagerMenus(pluginID);
  for (const options of menus) {
    clearStaleRegistration(mm, namespacedMenuKey(pluginID, options.menuID));
  }
  const keys: string[] = [];
  try {
    for (const options of menus) {
      const key = mm.registerMenu(options);
      if (key === false) {
        Zotero.debug(`[Citegeist] MenuManager rejected ${options.menuID}`);
        unregisterEach(mm, keys, "menu MenuManager rollback");
        return false;
      }
      keys.push(key);
    }
    menuManagerKeys = keys;
    return true;
  } catch (e) {
    logError("menu MenuManager register", e);
    unregisterEach(mm, keys, "menu MenuManager rollback");
    return false;
  }
}

function unregisterEach(
  mm: _ZoteroTypes.MenuManager,
  keys: readonly string[],
  context: string,
): void {
  for (const key of keys) {
    try {
      mm.unregisterMenu(key);
    } catch (e) {
      logError(context, e);
    }
  }
}

/**
 * The key Zotero stores a menu under, built the way `namespacedColumnKey` in
 * citationColumn.ts builds a column's: `CSS.escape(`${pluginID}-${menuID}`)`
 * (pluginAPIBase.mjs `_namespacedMainKey` 312-320). Plugin code has `CSS` at every
 * supported Zotero (plugins.js `_loadScope` sandbox globals, @8.0.4 138, @9.0.6
 * and @10.0.2 146); without it, the two characters an add-on ID like Citegeist's
 * carries are escaped by hand.
 */
function namespacedMenuKey(pluginID: string, menuID: string): string {
  const raw = `${pluginID}-${menuID}`;
  const css = (globalThis as { CSS?: { escape?: (value: string) => string } }).CSS;
  return typeof css?.escape === "function" ? css.escape(raw) : raw.replace(/[@.]/g, "\\$&");
}

/**
 * Whether Zotero holds a menu registration under `key`, or `undefined` when it
 * can't be asked. MenuManager has no public query: it exposes `registerMenu`,
 * `unregisterMenu` and `updateMenuPopup` only (menuManager.js @8.0.4 780-810,
 * @9.0.6 808-838, @10.0.2 816-846, and the same on Zotero's `main`). So this reads
 * the `options` of its internal registry (`_menuManager`, @8.0.4 781, @9.0.6 809,
 * @10.0.2 817): every registration, with `menuID` set to its key
 * (pluginAPIBase.mjs `options` 94-96, `_validate` 192). Never throws.
 */
function menuKeyRegistered(mm: _ZoteroTypes.MenuManager, key: string): boolean | undefined {
  try {
    const options = mm._menuManager?.options;
    if (!Array.isArray(options)) return undefined;
    return options.some((option) => option?.menuID === key);
  } catch (e) {
    Zotero.debug(`[Citegeist] MenuManager registry unreadable: ${normalizeError(e)}`);
    return undefined;
  }
}

/**
 * Remove a registration an earlier copy of Citegeist left under `key`, so this
 * copy's is not refused as a duplicate and replaced by the DOM fallback, which
 * put a second set of entries beside the stale one (issue #67). Zotero's
 * plugin-shutdown observer removes a plugin's menus on every disable, upgrade and
 * uninstall, so a stale key survives only when a copy registered after that
 * observer ran: a build without the startup check in hooks.ts, disabled while it
 * started.
 *
 * Only when Zotero reports the key registered: unregistering an unknown key logs
 * "Can't remove unknown option" (pluginAPIBase.mjs 165), which Zotero 8 to 10 file
 * as an error in Help → Report Errors. When the registry can't be read, nothing is
 * removed.
 */
function clearStaleRegistration(mm: _ZoteroTypes.MenuManager, key: string): void {
  if (menuKeyRegistered(mm, key) !== true) return;
  Zotero.debug(`[Citegeist] Removing the MenuManager menu an earlier copy left registered: ${key}`);
  unregisterEach(mm, [key], "menu MenuManager stale unregister");
}

/** Every `l10nID` in Citegeist's MenuManager menus, submenus included. */
function citegeistMenuL10nIDs(): Set<string> {
  const l10nIDs = new Set<string>();
  const collect = (menus: readonly MenuData[]): void => {
    for (const menu of menus) {
      if (menu.l10nID) l10nIDs.add(menu.l10nID);
      if (menu.menus) collect(menu.menus);
    }
  };
  for (const tree of menuTrees()) collect(tree.menus);
  return l10nIDs;
}

/** The two menus, as `registerMenu` takes them. */
function menuManagerMenus(pluginID: string): _ZoteroTypes.MenuManagerOptions[] {
  return menuTrees().map((tree) => ({ ...tree, pluginID }));
}

/**
 * The two menu trees. Entries carry `l10nID`, never `label`: MenuManager renders
 * text only from `data-l10n-id` and drops a plain `label` silently, which left
 * the entries blank. The FTL messages use `.label`/`.accesskey` attribute syntax
 * and are injected per window by `hooks.ensureCitegeistFTL`.
 */
function menuTrees(): Omit<_ZoteroTypes.MenuManagerOptions, "pluginID">[] {
  return [
    {
      menuID: ITEM_MENU_ID,
      target: "main/library/item",
      menus: guardMenus([
        {
          menuType: "menuitem",
          l10nID: "citegeist-menu-fetch",
          icon: menuIconURL("icon-16.svg"),
          onShowing: (e, ctx) => ctx.setVisible(itemEntries(e, ctx).fetch),
          onCommand: (e, ctx) =>
            void runOnItems(menuWindow(e, ctx), contextItems(e, ctx), FETCH_CITATIONS),
        },
        {
          menuType: "menuitem",
          l10nID: "citegeist-menu-citing",
          onShowing: (e, ctx) => ctx.setVisible(itemEntries(e, ctx).citing),
          onCommand: (e, ctx) => runViewNetwork(menuWindow(e, ctx), contextItems(e, ctx), "citing"),
        },
        {
          menuType: "menuitem",
          l10nID: "citegeist-menu-refs",
          onShowing: (e, ctx) => ctx.setVisible(itemEntries(e, ctx).references),
          onCommand: (e, ctx) =>
            runViewNetwork(menuWindow(e, ctx), contextItems(e, ctx), "references"),
        },
        {
          menuType: "menuitem",
          l10nID: "citegeist-menu-resolve-authors",
          icon: menuIconURL("icon-16.svg"),
          onShowing: (e, ctx) => ctx.setVisible(itemEntries(e, ctx).resolveAuthors),
          onCommand: (e, ctx) =>
            void runOnItems(menuWindow(e, ctx), contextItems(e, ctx), RESOLVE_AUTHORS),
        },
      ]),
    },
    {
      menuID: COLLECTION_MENU_ID,
      target: "main/library/collection",
      menus: guardMenus([
        {
          menuType: "menuitem",
          l10nID: "citegeist-menu-fetch-collection",
          icon: menuIconURL("icon-16.svg"),
          onShowing: (_e, ctx) =>
            ctx.setVisible(collectionEntriesVisible(collectionTargetsFromMenuContext(ctx))),
          onCommand: (e, ctx) =>
            startOnTargets(
              menuWindow(e, ctx),
              collectionTargetsFromMenuContext(ctx),
              FETCH_CITATIONS,
            ),
        },
        {
          menuType: "menuitem",
          l10nID: "citegeist-menu-resolve-collection",
          icon: menuIconURL("icon-16.svg"),
          onShowing: (_e, ctx) =>
            ctx.setVisible(collectionEntriesVisible(collectionTargetsFromMenuContext(ctx))),
          onCommand: (e, ctx) =>
            startOnTargets(
              menuWindow(e, ctx),
              collectionTargetsFromMenuContext(ctx),
              RESOLVE_AUTHORS,
            ),
        },
      ]),
    },
  ];
}

/**
 * Wrap every handler in a menu tree with an error boundary, recursing into
 * submenus.
 *
 * Applied once per registered tree rather than at each handler, so an entry
 * added later is protected without anyone remembering to wrap it. A throwing
 * `onCommand` does nothing at all from the user's side, and a throwing
 * `onShowing` can break the whole popup, so neither can be left bare.
 */
function guardMenus(menus: MenuData[]): MenuData[] {
  return menus.map((menu) => ({
    ...menu,
    onShowing: menu.onShowing
      ? (e: Event, ctx: MenuContext) =>
          guard(`menu onShowing ${menu.l10nID ?? menu.menuType}`, () => menu.onShowing?.(e, ctx))
      : undefined,
    onCommand: menu.onCommand
      ? (e: Event, ctx: MenuContext) =>
          guard(`menu onCommand ${menu.l10nID ?? menu.menuType}`, () => menu.onCommand?.(e, ctx))
      : undefined,
    menus: menu.menus ? guardMenus(menu.menus) : undefined,
  }));
}

/**
 * The items an item-menu handler acts on. The context's `items` belong to the
 * right-clicked pane and decide when present, so a selection Citegeist can't act
 * on hides the entries even if another window's selection could. When the
 * context omits them, the selection in the menu's own window stands in, never
 * the most recent window's.
 */
function contextItems(event: Event, ctx: MenuContext): readonly _ZoteroTypes.Item[] {
  return ctx.items && ctx.items.length > 0
    ? ctx.items
    : selectedItemsInWindow(menuWindow(event, ctx));
}

function itemEntries(event: Event, ctx: MenuContext) {
  return itemMenuVisibility(contextItems(event, ctx));
}

// ── Shared by both paths ─────────────────────────────────────────────────────

/**
 * The window a menu event came from, so a command reads that window's selection
 * and opens its dialogs there rather than in the main window. Prefers the
 * context's `menuElem`, then the event's target, then the main window.
 */
function menuWindow(
  event: Event | null | undefined,
  ctx: _ZoteroTypes.MenuSelectionContext | null | undefined,
): Window {
  return windowOf(ctx?.menuElem) ?? windowOf(event?.target) ?? Zotero.getMainWindow();
}

function windowOf(target: unknown): Window | null {
  if (typeof target !== "object" || target === null) return null;
  return (target as { ownerDocument?: Document | null }).ownerDocument?.defaultView ?? null;
}

/**
 * Start `action` on `targets`. `null` targets start nothing: the selection holds
 * a row Citegeist does not act on, or could not be read, and falling back to the
 * library root would fetch a whole library the user never chose.
 */
function startOnTargets<R>(
  win: Window,
  targets: readonly CollectionTarget[] | null,
  action: BatchAction<R>,
): void {
  if (targets) void runOnTargets(win, targets, action);
}

/** Open the citation browser for the one selected item, in the menu's window. */
function runViewNetwork(win: Window, items: readonly _ZoteroTypes.Item[], mode: NetworkMode): void {
  if (items.length === 1) {
    showCitationNetwork(items[0], mode, win).catch((e) => logError("menu showCitationNetwork", e));
  }
}

// ── DOM fallback ─────────────────────────────────────────────────────────────

/** Zotero 7 DOM fallback: delete with registerViaDOM (U9) */
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

/**
 * One AbortController per window with DOM entries, aborted by `unregisterMenus`.
 * Zotero 7 DOM fallback: delete with registerViaDOM (U9)
 */
const domListenerControllers = new WeakMap<Window, AbortController>();

/**
 * A fresh signal for `win`'s DOM listeners, aborting any earlier one. Built from
 * the window's own `AbortController`: every chrome window has one, while
 * Zotero's plugin sandbox is not guaranteed to expose it as a global.
 * Zotero 7 DOM fallback: delete with registerViaDOM (U9)
 */
function listenerSignal(win: Window): AbortSignal | undefined {
  domListenerControllers.get(win)?.abort();
  domListenerControllers.delete(win);
  const Controller =
    (win as { AbortController?: typeof AbortController }).AbortController ??
    (typeof AbortController === "function" ? AbortController : undefined);
  if (!Controller) return undefined;
  const controller = new Controller();
  domListenerControllers.set(win, controller);
  return controller.signal;
}

/**
 * Inject the entries into `win`'s item and collection popups. Plain string
 * labels, `popupshowing` for visibility, and every read goes to this window's
 * pane, not the most recent window's.
 * Zotero 7 DOM fallback: delete with registerViaDOM (U9)
 */
function registerViaDOM(win: Window): void {
  const doc = win.document;
  const itemMenu = doc.getElementById("zotero-itemmenu");
  const collectionMenu = doc.getElementById("zotero-collectionmenu");

  Zotero.debug(
    `[Citegeist] registerMenus (DOM): itemMenu=${!!itemMenu}, collectionMenu=${!!collectionMenu}`,
  );

  // Startup and onMainWindowLoad can both reach a window.
  if (doc.getElementById(MENU_IDS.fetchCitations)) {
    Zotero.debug("[Citegeist] Menus already registered, skipping");
    return;
  }

  // Every listener carries this window's signal, so unregisterMenus removes them
  // with one abort.
  const signal = listenerSignal(win);

  if (itemMenu) {
    const sep = (doc as XULDocument).createXULElement("menuseparator");
    sep.id = MENU_IDS.separator;
    itemMenu.appendChild(sep);

    const fetchItem = (doc as XULDocument).createXULElement("menuitem");
    fetchItem.id = MENU_IDS.fetchCitations;
    fetchItem.setAttribute("label", "Fetch Citation Counts");
    fetchItem.setAttribute("image", menuIconURL("icon-16.svg"));
    // Accesskeys audited against Zotero 7/8 default English item menu: F, R, I,
    // E, C are taken; G is unused — pick G for the "citeGeist" mnemonic. View
    // Citing/References get no accesskey (infrequent; Tab + Enter works).
    fetchItem.setAttribute("accesskey", "G");
    bindGuarded(
      fetchItem,
      "command",
      "menu fetch item",
      () => void runOnItems(win, selectedItemsInWindow(win), FETCH_CITATIONS),
      { signal },
    );
    itemMenu.appendChild(fetchItem);

    const citingItem = (doc as XULDocument).createXULElement("menuitem");
    citingItem.id = MENU_IDS.viewCiting;
    citingItem.setAttribute("label", "View Citing Works…");
    bindGuarded(
      citingItem,
      "command",
      "menu view citing",
      () => runViewNetwork(win, selectedItemsInWindow(win), "citing"),
      { signal },
    );
    itemMenu.appendChild(citingItem);

    const refsItem = (doc as XULDocument).createXULElement("menuitem");
    refsItem.id = MENU_IDS.viewRefs;
    refsItem.setAttribute("label", "View References…");
    bindGuarded(
      refsItem,
      "command",
      "menu view references",
      () => runViewNetwork(win, selectedItemsInWindow(win), "references"),
      { signal },
    );
    itemMenu.appendChild(refsItem);

    const resolveItem = (doc as XULDocument).createXULElement("menuitem");
    resolveItem.id = MENU_IDS.resolveAuthors;
    resolveItem.setAttribute("label", "Resolve Author Identities (Citegeist)");
    resolveItem.setAttribute("image", menuIconURL("icon-16.svg"));
    // 'A' (Authors) is free on the default item context menu alongside 'G'.
    resolveItem.setAttribute("accesskey", "A");
    bindGuarded(
      resolveItem,
      "command",
      "menu resolve authors",
      () => void runOnItems(win, selectedItemsInWindow(win), RESOLVE_AUTHORS),
      { signal },
    );
    itemMenu.appendChild(resolveItem);

    // Hidden first, so a selection read that throws leaves no stale entries.
    bindGuarded(
      itemMenu,
      "popupshowing",
      "menu item popupshowing",
      () => {
        for (const entry of [sep, fetchItem, citingItem, refsItem, resolveItem]) {
          entry.hidden = true;
        }
        const v = itemMenuVisibility(selectedItemsInWindow(win));
        fetchItem.hidden = !v.fetch;
        resolveItem.hidden = !v.resolveAuthors;
        citingItem.hidden = !v.citing;
        refsItem.hidden = !v.references;
        sep.hidden = !v.separator;
      },
      { signal },
    );
  }

  if (collectionMenu) {
    const sep = (doc as XULDocument).createXULElement("menuseparator");
    sep.id = MENU_IDS.collectionSeparator;
    collectionMenu.appendChild(sep);

    const fetchAll = (doc as XULDocument).createXULElement("menuitem");
    fetchAll.id = MENU_IDS.fetchCollection;
    fetchAll.setAttribute("label", "Fetch All Citation Counts (Citegeist)");
    fetchAll.setAttribute("image", menuIconURL("icon-16.svg"));
    // 'L' may collide with 'New Collection' on some builds; 'I' (citegeIst
    // mnemonic) is unused on the default collection context menu.
    fetchAll.setAttribute("accesskey", "I");
    bindGuarded(
      fetchAll,
      "command",
      "menu fetch collection",
      () => startOnTargets(win, collectionTargetsFromPane(paneForWindow(win)), FETCH_CITATIONS),
      { signal },
    );
    collectionMenu.appendChild(fetchAll);

    const resolveAll = (doc as XULDocument).createXULElement("menuitem");
    resolveAll.id = MENU_IDS.resolveCollection;
    resolveAll.setAttribute("label", "Resolve All Author Identities (Citegeist)");
    resolveAll.setAttribute("image", menuIconURL("icon-16.svg"));
    resolveAll.setAttribute("accesskey", "A");
    bindGuarded(
      resolveAll,
      "command",
      "menu resolve collection",
      () => startOnTargets(win, collectionTargetsFromPane(paneForWindow(win)), RESOLVE_AUTHORS),
      { signal },
    );
    collectionMenu.appendChild(resolveAll);

    // Hidden first, so a selection read that throws leaves no stale entries.
    bindGuarded(
      collectionMenu,
      "popupshowing",
      "menu collection popupshowing",
      () => {
        const entries = [sep, fetchAll, resolveAll];
        for (const entry of entries) entry.hidden = true;
        const visible = collectionEntriesVisible(collectionTargetsFromPane(paneForWindow(win)));
        for (const entry of entries) entry.hidden = !visible;
      },
      { signal },
    );
  }

  Zotero.debug("[Citegeist] Menus registered (DOM)");
}

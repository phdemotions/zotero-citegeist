/**
 * Context menu items and batch operations for Citegeist.
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

export function registerMenus(win: Window): void {
  const doc = win.document;
  const itemMenu = doc.getElementById("zotero-itemmenu");
  const collectionMenu = doc.getElementById("zotero-collectionmenu");

  Zotero.debug(
    `[Citegeist] registerMenus: itemMenu=${!!itemMenu}, collectionMenu=${!!collectionMenu}`,
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
    // Use accesskeys that don't collide with Zotero's native item menu.
    // Audited against Zotero 7/8 default English: F (Find PDF), R
    // (Restore), I (Reindex), E (Export), C (Copy/Collection) all
    // taken. G is unused — pick G for "citeGeist" mnemonic on Fetch.
    // View-network items get no accesskey (rarely needed; keyboard
    // users can Tab + Enter). (ADV-U5, Iter W audit)
    fetchItem.setAttribute("accesskey", "G");
    fetchItem.addEventListener("command", async () => {
      const pane = Zotero.getActiveZoteroPane();
      const items = pane.getSelectedItems();
      if (items.length === 0) return;

      const eligible = items.filter(
        (i: _ZoteroTypes.Item) => i.isRegularItem() && extractIdentifier(i) !== null,
      );
      if (eligible.length === 0) return;

      const progressWin = new Zotero.ProgressWindow({ closeOnClick: false });
      progressWin.changeHeadline("Citegeist: Fetching Citations");
      const progress = new progressWin.ItemProgress(
        "chrome://citegeist/content/icons/icon-16.svg",
        `Fetching ${eligible.length} item${eligible.length !== 1 ? "s" : ""}\u2026`,
      );
      progressWin.show();

      const count = await fetchAndCacheItems(eligible, (current, total) => {
        progress.setProgress((current / total) * 100);
        progress.setText(`${current}/${total} items fetched`);
      });

      progress.setProgress(100);
      progress.setText(`Done \u2014 ${count} item${count !== 1 ? "s" : ""} updated`);
      progressWin.startCloseTimer(3000);

      // Drop per-item metrics cache + trigger Zotero column repaint so the
      // user sees the freshly-fetched counts/FWCI/percentile/ranking right
      // away. The column module's own queue handles repaint internally;
      // menu-driven fetches bypass that path entirely. Without this, the
      // SQLite + mirror were updated but the UI kept showing pre-fetch
      // values until the user sorted/scrolled/clicked.
      try {
        invalidateColumnCache();
      } catch (e) {
        logError("menu fetch column invalidate", e);
      }
    });
    itemMenu.appendChild(fetchItem);

    const citingItem = (doc as XULDocument).createXULElement("menuitem");
    citingItem.id = MENU_IDS.viewCiting;
    citingItem.setAttribute("label", "View Citing Works\u2026");
    // No accesskey on View Citing / References — these are infrequent
    // single-item actions and most candidate letters collide with
    // Zotero's native menu (Iter W audit).
    citingItem.addEventListener("command", () => {
      const items = Zotero.getActiveZoteroPane().getSelectedItems();
      if (items.length === 1) {
        showCitationNetwork(items[0], "citing").catch((e) =>
          logError("menu showCitationNetwork", e),
        );
      }
    });
    itemMenu.appendChild(citingItem);

    const refsItem = (doc as XULDocument).createXULElement("menuitem");
    refsItem.id = MENU_IDS.viewRefs;
    refsItem.setAttribute("label", "View References\u2026");
    // No accesskey — see comment above.
    refsItem.addEventListener("command", () => {
      const items = Zotero.getActiveZoteroPane().getSelectedItems();
      if (items.length === 1) {
        showCitationNetwork(items[0], "references").catch((e) =>
          logError("menu showCitationNetwork", e),
        );
      }
    });
    itemMenu.appendChild(refsItem);

    // Hide citing/refs options when multiple items are selected (they only work on single items)
    // and hide the Fetch entry when no selected items are eligible — a no-op
    // click looked like the feature was broken.
    itemMenu.addEventListener("popupshowing", () => {
      const items = Zotero.getActiveZoteroPane().getSelectedItems();
      const eligibleCount = items.filter(
        (i: _ZoteroTypes.Item) => i.isRegularItem() && extractIdentifier(i) !== null,
      ).length;
      fetchItem.hidden = eligibleCount === 0;
      sep.hidden = eligibleCount === 0 && items.length !== 1;
      const singleWithIdentifier =
        items.length === 1 && items[0].isRegularItem() && extractIdentifier(items[0]) !== null;
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
    fetchAll.setAttribute("accesskey", "L");
    fetchAll.addEventListener("command", async () => {
      const collection = Zotero.getActiveZoteroPane().getSelectedCollection();
      if (!collection) return;

      // Recursively gather items from this collection and all subcollections
      const allItems = new Map<number, _ZoteroTypes.Item>();
      const collectRecursive = (col: _ZoteroTypes.Collection) => {
        for (const item of col.getChildItems()) {
          if (!allItems.has(item.id)) allItems.set(item.id, item);
        }
        for (const child of col.getChildCollections()) {
          collectRecursive(child);
        }
      };
      collectRecursive(collection);

      const eligible = [...allItems.values()].filter(
        (i) => i.isRegularItem() && extractIdentifier(i) !== null,
      );

      const progressWin = new Zotero.ProgressWindow({ closeOnClick: false });
      progressWin.changeHeadline("Citegeist: Fetching Citations");
      const progress = new progressWin.ItemProgress(
        "chrome://citegeist/content/icons/icon-16.svg",
        `Fetching ${eligible.length} items…`,
      );
      progressWin.show();

      const count = await fetchAndCacheItems(eligible, (current, total) => {
        progress.setProgress((current / total) * 100);
        progress.setText(`${current}/${total} items fetched`);
      });

      progress.setProgress(100);
      progress.setText(`Done — ${count} items updated`);
      progressWin.startCloseTimer(3000);

      // Refresh columns — see fetchItem handler above for full rationale.
      try {
        invalidateColumnCache();
      } catch (e) {
        logError("menu fetch-collection column invalidate", e);
      }
    });
    collectionMenu.appendChild(fetchAll);
  }

  Zotero.debug("[Citegeist] Menus registered");
}

export function unregisterMenus(win: Window): void {
  const doc = win.document;
  for (const id of Object.values(MENU_IDS)) {
    doc.getElementById(id)?.remove();
  }
}

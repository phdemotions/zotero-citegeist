/**
 * Context menu items and batch operations for Citegeist.
 */

import { fetchAndCacheItems } from "./citationService";
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
    fetchItem.addEventListener("command", async () => {
      const pane = Zotero.getActiveZoteroPane();
      const items = pane.getSelectedItems();
      if (items.length === 0) return;

      const eligible = items.filter(
        (i: _ZoteroTypes.Item) => i.isRegularItem() && i.getField("DOI")?.trim(),
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
    });
    itemMenu.appendChild(fetchItem);

    const citingItem = (doc as XULDocument).createXULElement("menuitem");
    citingItem.id = MENU_IDS.viewCiting;
    citingItem.setAttribute("label", "View Citing Works\u2026");
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
    itemMenu.addEventListener("popupshowing", () => {
      const items = Zotero.getActiveZoteroPane().getSelectedItems();
      const singleWithDOI =
        items.length === 1 && items[0].isRegularItem() && !!items[0].getField("DOI")?.trim();
      citingItem.hidden = !singleWithDOI;
      refsItem.hidden = !singleWithDOI;
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
        (i) => i.isRegularItem() && i.getField("DOI")?.trim(),
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

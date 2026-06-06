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

/** Shape shared by both batch-fetch handlers. */
type BatchResult = { fresh: number; cached: number; suggestion: number; errors: number };

/**
 * Render a one-line summary of a batch fetch for the ProgressWindow.
 *
 * "Done — 0 of N updated" (old copy) confused users who'd already run
 * auto-fetch: every item came back `"cached"` (still fresh, no API
 * call needed) so the counter showed 0 even though the columns now
 * displayed real data. New copy distinguishes:
 *   • `fresh` — new data landed on this batch
 *   • `cached` — already up to date, no fetch needed
 *   • `suggestion` — title-match pending in the pane
 *   • `errors` — not-found / network / no-match
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
      // Modal alert when nothing is eligible \u2014 popupshowing already hides
      // the menu item in that case, but a programmatic invocation or a
      // mid-popup selection change can land here with eligible.length=0.
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
      // Use the explicit-color PNG inside the ProgressWindow \u2014 the SVG's
      // `context-fill` keyword fails to resolve there and Zotero falls
      // back to the default red loading curve, which (a) clashes with
      // citegeist's sage brand and (b) reads as an error indicator,
      // which it isn't.
      const progress = new progressWin.ItemProgress(
        "chrome://citegeist/content/icons/icon-16-color.png",
        `Fetching ${eligible.length} item${eligible.length !== 1 ? "s" : ""}\u2026`,
      );
      progressWin.show();

      let result: BatchResult = {
        fresh: 0,
        cached: 0,
        suggestion: 0,
        errors: 0,
      };
      try {
        result = await fetchAndCacheItems(eligible, (current, total) => {
          progress.setProgress((current / total) * 100);
          progress.setText(`${current}/${total} items fetched`);
        });
      } catch (e) {
        logError("menu fetch batch", e);
        progress.setProgress(100);
        progress.setText("Citegeist: fetch failed \u2014 see Debug Output");
        progressWin.startCloseTimer(5000);
        return;
      }

      progress.setProgress(100);
      progress.setText(summarizeBatch(result, eligible.length));
      // Hold progress window longer so result is visible even on fast fetches.
      progressWin.startCloseTimer(6000);

      // Targeted column repaint \u2014 pass the eligible item IDs so the
      // Notifier event tells Zotero's ItemTreeManager exactly which
      // rows need re-rendering. Bulk invalidate alone doesn't trigger
      // a re-paint on rows currently visible.
      try {
        invalidateColumnCache(eligible.map((i) => i.id));
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
    // Collection menu's 'L' may collide with 'New Collection' on some
    // Zotero builds. 'I' (citegeIst mnemonic) is unused on the default
    // collection context menu. (Iter Y collision audit)
    fetchAll.setAttribute("accesskey", "I");
    fetchAll.addEventListener("command", async () => {
      const pane = Zotero.getActiveZoteroPane();
      const collection = pane.getSelectedCollection();

      // Gather items from the selected collection or the whole library when a
      // library root node (e.g. "My Library") is right-clicked — those nodes
      // don't return a collection from getSelectedCollection().
      const allItems = new Map<number, _ZoteroTypes.Item>();
      if (collection) {
        gatherCollectionItems(collection, allItems);
      } else {
        // Library root — getSelectedCollection() returns null for root nodes.
        // Use || (not ??) so a falsy 0 also falls back to the user library.
        // Pass onlyTopLevel=false for consistency with the collection branch —
        // isRegularItem() below is the single source of truth for eligibility.
        const rawLibraryID = pane.getSelectedLibraryID?.();
        const libraryID = rawLibraryID || Zotero.Libraries.userLibraryID;
        const libraryItems = await Zotero.Items.getAll(libraryID, false);
        for (const item of libraryItems) allItems.set(item.id, item);
      }

      const totalItems = allItems.size;
      const eligible = [...allItems.values()].filter(
        (i) => i.isRegularItem() && extractIdentifier(i) !== null,
      );

      // Hard fallback when nothing is eligible — the ProgressWindow's
      // corner notification is easy to miss, leaving the user thinking
      // the menu click did nothing. A modal alert makes the empty result
      // unambiguous + tells the user WHY (no DOI/PMID/arXiv/ISBN).
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
      // Explicit-color PNG — see fetchItem handler for rationale.
      const progress = new progressWin.ItemProgress(
        "chrome://citegeist/content/icons/icon-16-color.png",
        `Fetching ${eligible.length} item${eligible.length === 1 ? "" : "s"}…`,
      );
      progressWin.show();

      let result: BatchResult = {
        fresh: 0,
        cached: 0,
        suggestion: 0,
        errors: 0,
      };
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
      // Hold the progress window longer so the result is visible even on
      // fast fetches that would otherwise flash and disappear.
      progressWin.startCloseTimer(6000);

      // Refresh columns — see fetchItem handler above for full rationale.
      try {
        invalidateColumnCache(eligible.map((i) => i.id));
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

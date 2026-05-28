/**
 * Lifecycle hooks for Citegeist.
 * Called by bootstrap.js — manages startup, shutdown, and window events.
 */

import { registerCitationColumn, unregisterCitationColumn } from "./modules/citationColumn";
import { registerCitationPane, unregisterCitationPane } from "./modules/citationPane";
import { registerMenus, unregisterMenus } from "./modules/menu";
import { clearSourceStatsCache } from "./modules/openalex";
import { initCache, closeCache, migrateFromExtraV1, garbageCollectOrphans } from "./modules/cache";
import { logError } from "./modules/utils";

const FTL_LINK_ID = "citegeist-ftl-link";

interface PluginData {
  id: string;
  version: string;
  rootURI: string;
  reason: number;
}

let pluginID: string;
let rootURI: string;

export async function onStartup(data: PluginData): Promise<void> {
  pluginID = data.id;
  rootURI = data.rootURI;
  Zotero.debug(`[Citegeist] Starting v${data.version}`);

  // Initialize the plugin-owned SQLite cache and warm the in-memory mirror
  // BEFORE any reader (pane, column) registers. Column dataProvider is
  // synchronous and assumes the mirror is populated.
  try {
    await initCache();
    await migrateFromExtraV1();
    // Best-effort GC of orphan rows from prior installs / library snapshots.
    // Failure here must not block startup.
    await garbageCollectOrphans().catch((e) => logError("orphan GC", e));
  } catch (e) {
    logError("cache init", e);
    // Continue startup: read functions will return empty metrics; users still
    // see the UI and can refetch. Better than refusing to load entirely.
  }

  // Register preference pane so users can access settings
  Zotero.PreferencePanes.register({
    pluginID,
    src: rootURI + "content/preferences.xhtml",
    label: "Citegeist",
    image: "chrome://citegeist/content/icons/icon-16.svg",
  });

  // Register the citation count column (global, not per-window)
  await registerCitationColumn(pluginID);

  // Register the item pane section
  registerCitationPane(pluginID);

  // If the main window is already open, register menus now.
  // onMainWindowLoad may not fire for windows that were open before startup.
  const mainWin = Zotero.getMainWindow();
  if (mainWin) {
    Zotero.debug("[Citegeist] Main window already open at startup — registering menus");
    registerMenus(mainWin);
  }

  Zotero.debug("[Citegeist] Startup complete");
}

export async function onShutdown(_data: PluginData): Promise<void> {
  Zotero.debug("[Citegeist] Shutting down");

  unregisterCitationColumn();
  unregisterCitationPane();
  clearSourceStatsCache();
  await closeCache().catch((e) => logError("cache close", e));

  Zotero.debug("[Citegeist] Shutdown complete");
}

export function onMainWindowLoad(win: Window): void {
  Zotero.debug("[Citegeist] Main window loaded");

  // Register FTL locale file with the document's Fluent system
  // so l10nIDs (pane header, sidenav, etc.) resolve properly
  const doc = win.document;
  const link = doc.createElement("link");
  link.id = FTL_LINK_ID;
  link.rel = "localization";
  link.href = "chrome://citegeist/locale/citegeist.ftl";
  doc.documentElement.appendChild(link);

  registerMenus(win);
}

export function onMainWindowUnload(win: Window): void {
  Zotero.debug("[Citegeist] Main window unloading");

  // Remove FTL link
  win.document.getElementById(FTL_LINK_ID)?.remove();

  unregisterMenus(win);
}

/**
 * Lifecycle hooks for Citegeist.
 * Called by bootstrap.js — manages startup, shutdown, and window events.
 */

import { registerCitationColumn, unregisterCitationColumn } from "./modules/citationColumn";
import { registerCitationPane, unregisterCitationPane } from "./modules/citationPane";
import { registerMenus, unregisterMenus } from "./modules/menu";
import { clearSourceStatsCache } from "./modules/openalex";

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

export function onShutdown(_data: PluginData): void {
  Zotero.debug("[Citegeist] Shutting down");

  unregisterCitationColumn();
  unregisterCitationPane();
  clearSourceStatsCache();

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

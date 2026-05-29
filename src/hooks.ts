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
import { PREF_LAST_BACKUP_PATH, PREF_MIGRATION_COMPLETE } from "./constants";

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
  let cacheInitFailed = false;
  const wasMigratedBefore = Zotero.Prefs.get(PREF_MIGRATION_COMPLETE) as boolean | undefined;
  try {
    await initCache();
    await migrateFromExtraV1();
    // Best-effort GC of orphan rows from prior installs / library snapshots.
    // Failure here must not block startup.
    await garbageCollectOrphans().catch((e) => logError("orphan GC", e));
  } catch (e) {
    logError("cache init", e);
    cacheInitFailed = true;
    // Continue startup: read functions will return empty metrics; users still
    // see the UI and can refetch. Better than refusing to load entirely.
  }

  if (cacheInitFailed) {
    showStartupAlert(
      "Citegeist: cache unavailable",
      "Citegeist could not open its local cache database. Citation columns " +
        "and the citation pane will not function until you restart Zotero. " +
        "If the problem persists, check that <profile>/citegeist.sqlite is " +
        "not locked or quarantined by antivirus.",
    );
  } else if (!wasMigratedBefore && Zotero.Prefs.get(PREF_MIGRATION_COMPLETE)) {
    // First successful migration of this profile. Surface a one-time
    // alert pointing to the safety-net backup file so users know exactly
    // where to find a verbatim copy of every pre-migration Extra field
    // if they want to audit or restore anything.
    const backupPath = Zotero.Prefs.get(PREF_LAST_BACKUP_PATH) as string | undefined;
    const backupLine = backupPath
      ? `A snapshot of every Extra field Citegeist touched was saved to:\n\n${backupPath}\n\n` +
        "Keep it until you've confirmed everything looks right. If anything is missing, " +
        "the JSON file lets you restore the original Extra contents by hand."
      : "Citegeist could not write a pre-migration backup file to your data directory " +
        "(usually a permissions issue). The migration still completed; if you need to " +
        "audit the changes, your Zotero Sync history or a Time Machine snapshot from " +
        "before today is the next-best source.";
    showStartupAlert(
      "Citegeist v2.0.0 — one-time migration complete",
      "Citegeist v2.0.0 moved your cached citation data from each item's Extra field " +
        "into a plugin-owned SQLite database (<profile>/citegeist.sqlite). Your library " +
        "is otherwise unchanged.\n\n" +
        backupLine +
        "\n\nSee Help → Debug Output for the migration log, or read docs/MIGRATION-v2.0.0.md " +
        "in the Citegeist GitHub repo for the full upgrade guide.",
    );
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

/**
 * Show a single alert dialog from inside `onStartup`. Fires on a short
 * delay so the main Zotero window has fully loaded before the modal
 * appears, and wraps the call in try/catch so a missing `Services.prompt`
 * (older builds, headless tests) can't crash startup.
 */
function showStartupAlert(title: string, body: string): void {
  Zotero.getMainWindow()?.setTimeout(() => {
    try {
      Services.prompt.alert(Zotero.getMainWindow(), title, body);
    } catch (alertErr) {
      logError("startup alert", alertErr);
    }
  }, 2000);
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

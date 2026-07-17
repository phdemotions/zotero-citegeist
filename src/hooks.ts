/**
 * Lifecycle hooks for Citegeist.
 * Called by bootstrap.js — manages startup, shutdown, and window events.
 */

import { registerCitationColumn, unregisterCitationColumn } from "./modules/citationColumn";
import { registerCitationPane, unregisterCitationPane } from "./modules/citationPane";
import { registerAuthorsSection, unregisterAuthorsSection } from "./modules/authorsSection";
import {
  registerMenus,
  unregisterMenus,
  unregisterGlobalMenus,
  setMenuPluginID,
} from "./modules/menu";
import { clearSourceStatsCache } from "./modules/openalex";
import { clearAuthorProfileCache } from "./modules/openalexAuthors";
import { initCache, closeCache, migrateFromExtraV1, garbageCollectOrphans } from "./modules/cache";
import { logError } from "./modules/utils";
import { PREF_LAST_BACKUP_PATH, SETTINGS_PANE_ID } from "./constants";

const FTL_LINK_ID = "citegeist-ftl-link";

interface PluginData {
  id: string;
  version: string;
  rootURI: string;
  reason: number;
}

let pluginID: string;
let rootURI: string;
// True only after the cache initialized AND all cache-dependent UI registered
// successfully. Gates onMainWindowLoad so menus never wire up against a dead
// cache (and a minimal/late window can't crash startup).
let cacheReady = false;

export async function onStartup(data: PluginData): Promise<void> {
  pluginID = data.id;
  rootURI = data.rootURI;
  cacheReady = false;
  setMenuPluginID(pluginID);
  Zotero.debug(`[Citegeist] Starting v${data.version}`);

  // Initialize the plugin-owned SQLite cache and warm the in-memory mirror
  // BEFORE any reader (pane, column) registers. Column dataProvider is
  // synchronous and assumes the mirror is populated.
  let cacheInitFailed = false;
  // Whether this launch actually migrated v1.x data out of Extra. Drives the
  // one-time migration alert below — read from the return value rather than
  // re-reading the completion pref, which can be stale or wrong-typed.
  let didMigrate = false;
  try {
    await initCache();
    didMigrate = await migrateFromExtraV1();
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
  } else if (didMigrate) {
    // First successful migration of this profile. Surface a one-time
    // alert pointing to the safety-net backup file so users know exactly
    // where to find a verbatim copy of every pre-migration Extra field
    // if they want to audit or restore anything.
    const backupPathRaw = Zotero.Prefs.get(PREF_LAST_BACKUP_PATH);
    const backupPath = typeof backupPathRaw === "string" ? backupPathRaw : undefined;
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

  // Register preference pane so users can access settings. This is the only
  // cache-independent UI, so it registers even when the cache failed.
  Zotero.PreferencePanes.register({
    pluginID,
    // Explicit id so the item pane's settings button can deep-link here via
    // Zotero.Utilities.Internal.openPreferences(SETTINGS_PANE_ID).
    id: SETTINGS_PANE_ID,
    src: rootURI + "content/preferences.xhtml",
    label: "Citegeist",
    image: "chrome://citegeist/content/icons/icon-16.svg",
  });

  // Fail closed: with no cache, the synchronous column dataProvider and the
  // pane would surface broken/empty data. Register nothing cache-dependent —
  // the user already saw the "cache unavailable" alert above.
  if (cacheInitFailed) {
    Zotero.debug("[Citegeist] Cache init failed — skipping cache-dependent UI registration");
    return;
  }

  // Register the cache-dependent runtime UI. If Zotero rejects any of these
  // registrations, fail closed: tear down what we opened (columns + cache) so
  // we don't leave half-wired UI against a live cache, and tell the user.
  // registerCitationColumn rolls back its own partial columns and rethrows.
  try {
    // Register the citation count column (global, not per-window)
    await registerCitationColumn(pluginID);

    // Register the item pane sections
    registerCitationPane(pluginID);
    registerAuthorsSection(pluginID);

    // If the main window is already open, register menus now.
    // onMainWindowLoad may not fire for windows that were open before startup.
    const mainWin = Zotero.getMainWindow();
    if (mainWin) {
      Zotero.debug("[Citegeist] Main window already open at startup — registering menus");
      registerMenus(mainWin);
    }
  } catch (e) {
    logError("UI registration", e);
    try {
      unregisterCitationColumn();
    } catch (cleanupErr) {
      logError("UI registration cleanup (column)", cleanupErr);
    }
    await closeCache().catch((closeErr) => logError("UI registration cleanup (cache)", closeErr));
    showStartupAlert(
      "Citegeist: UI unavailable",
      "Zotero rejected one of the UI registrations Citegeist needs (the citation " +
        "columns or the item pane). Citegeist has shut its cache to avoid leaving " +
        "things half-configured. Please restart Zotero; if this keeps happening, " +
        "report it on the Citegeist GitHub repo.",
    );
    return;
  }

  // Everything wired: the in-memory mirror is live and the UI is registered.
  cacheReady = true;
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
  cacheReady = false;

  const win = Zotero.getMainWindow() as Window | null;
  // Each UI-teardown step is best-effort: a throw in any one of them must not
  // strand the open SQLite handle. closeCache() runs unconditionally last.
  try {
    if (win) unregisterMenus(win);
  } catch (e) {
    logError("shutdown unregisterMenus", e);
  }
  // Global MenuManager teardown is process-scoped, not window-scoped: run it
  // unconditionally, independent of whether getMainWindow() returned a window.
  // (unregisterMenus above only clears per-window DOM nodes.)
  try {
    unregisterGlobalMenus();
  } catch (e) {
    logError("shutdown unregisterGlobalMenus", e);
  }
  try {
    unregisterCitationColumn();
  } catch (e) {
    logError("shutdown unregisterCitationColumn", e);
  }
  try {
    unregisterCitationPane();
  } catch (e) {
    logError("shutdown unregisterCitationPane", e);
  }
  try {
    unregisterAuthorsSection();
  } catch (e) {
    logError("shutdown unregisterAuthorsSection", e);
  }
  try {
    clearSourceStatsCache();
  } catch (e) {
    logError("shutdown clearSourceStatsCache", e);
  }
  try {
    clearAuthorProfileCache();
  } catch (e) {
    logError("shutdown clearAuthorProfileCache", e);
  }
  await closeCache().catch((e) => logError("cache close", e));

  Zotero.debug("[Citegeist] Shutdown complete");
}

export function onMainWindowLoad(win: Window): void {
  Zotero.debug("[Citegeist] Main window loaded");

  // Don't wire menus (or touch the window) until the cache is ready. Avoids
  // registering cache-dependent UI against a dead cache, and avoids crashing
  // on a minimal/early window object before startup finished.
  if (!cacheReady) {
    Zotero.debug("[Citegeist] Cache not ready — skipping menu registration on window load");
    return;
  }

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

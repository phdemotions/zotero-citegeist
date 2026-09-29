/**
 * Lifecycle hooks for Citegeist.
 * Called by bootstrap.js — manages startup, shutdown, and window events.
 */

import { registerCitationColumn, unregisterCitationColumn } from "./modules/citationColumn";
import { registerCitationPane, unregisterCitationPane } from "./modules/citationPane";
import { installBridge, removeBridge } from "./modules/bridge";
import {
  registerMenus,
  removeRenderedMenus,
  unregisterMenus,
  unregisterGlobalMenus,
  setMenuPluginID,
  setMenuRootURI,
} from "./modules/menu";
import { clearSourceStatsCache } from "./modules/openalex";
import { clearAuthorProfileCache } from "./modules/openalexAuthors";
import {
  initCache,
  closeCache,
  migrateFromExtraV1,
  garbageCollectOrphans,
  purgeAllAuthorRelations,
  cacheWriteRefusalCode,
} from "./modules/cache";
import { getPref, setPref } from "./modules/prefs";
import { logError } from "./modules/utils";
import { setPluginVersion, showCodedNotice } from "./modules/diagnostics";
import {
  CACHE_READ_ONLY_HEADLINE,
  PREF_AUTHOR_RELATIONS_PURGED,
  PREF_LAST_BACKUP_PATH,
  SETTINGS_PANE_ID,
} from "./constants";

// Bare FTL filename. Zotero auto-registers the plugin's locale/<locale>/*.ftl
// into its Fluent registry before onStartup, addressable by this bare name —
// NOT chrome://citegeist/locale/... (which needs the chrome registration and
// doesn't match the auto-registered source key).
const FTL_FILE = "citegeist.ftl";

/**
 * The build's id, injected by scripts/build.mjs. A production build takes it
 * from the commit alone (the first 12 characters of its SHA and its commit
 * time), so every production build of one commit carries the same id and the
 * same bytes; a dev build adds the time of day. The version stays the same
 * across many builds, so the id is what identifies one. Logged at startup, so
 * Debug Output shows which commit, and for a dev build which build, Zotero
 * loaded.
 */
declare const __BUILD_ID__: string;

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

/**
 * Set at the top of `onShutdown` and never cleared: addon/bootstrap.js loads a
 * fresh copy of the bundle on every `startup`, so a copy starts once and shuts
 * down once.
 *
 * `onStartup` checks it after every await. A disable can land while startup
 * waits on the cache, and Zotero's plugin-shutdown observers, which remove
 * whatever the plugin has registered, run as soon as the synchronous part of
 * `onShutdown` returns (plugins.js `_callMethod`: the bootstrap method at @8.0.4
 * 250 and @10.0.2 258, the observers from 261 and 269). Anything startup
 * registered after that would stay registered for a disabled plugin, and a menu
 * left that way made the next copy's registration a refused duplicate.
 */
let shutdownStarted = false;

/**
 * True while `registerCitationColumn` runs. A shutdown that lands then leaves the
 * columns to startup, which removes them once that call returns: removing them
 * in the middle of it would leave the columns it registers afterwards in place.
 */
let columnsRegistering = false;

/**
 * The cache close under way or done. Startup's failure cleanup and `onShutdown`
 * can both close the cache, and a disable can land while a failed startup is
 * closing it, so both wait on the one close.
 */
let cacheClosing: Promise<void> | null = null;

export async function onStartup(data: PluginData): Promise<void> {
  pluginID = data.id;
  rootURI = data.rootURI;
  cacheReady = false;
  setMenuPluginID(pluginID);
  setPluginVersion(data.version);
  installBridge(() => cacheReady);
  Zotero.debug(`[Citegeist] Starting v${data.version} (build ${__BUILD_ID__})`);

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
    if (shutdownBegan("cache init")) return;
    didMigrate = await migrateFromExtraV1();
    if (shutdownBegan("migration")) return;
    // Best-effort GC of orphan rows from prior installs / library snapshots.
    // Failure here must not block startup.
    await garbageCollectOrphans().catch((e) => logError("orphan GC", e));
    if (shutdownBegan("orphan GC")) return;
    // One-time purge of the sync-breaking `openalex:author` item relations that
    // v2.x/early-3.0 wrote (Zotero's sync server rejects the custom predicate and
    // halts the whole library sync). Best-effort — must not block startup.
    await purgeAuthorRelationsOnce();
  } catch (e) {
    logError("cache init", e);
    cacheInitFailed = true;
    // Continue startup: read functions will return empty metrics; users still
    // see the UI and can refetch. Better than refusing to load entirely.
  }
  // Nothing is registered yet, and onShutdown closes the cache.
  if (shutdownBegan("cache startup")) return;

  // Null unless init opened the database read-only (CG-DB03, CG-DB04).
  const readOnlyCode = cacheInitFailed ? null : cacheWriteRefusalCode();
  if (cacheInitFailed) {
    showStartupAlert(
      "Citegeist: cache unavailable",
      "Citegeist could not open its local cache database. Citation columns " +
        "and the citation pane will not function until you restart Zotero. " +
        "If the problem persists, check that <profile>/citegeist.sqlite is " +
        "not locked or quarantined by antivirus.",
    );
  } else if (readOnlyCode) {
    // Once per launch. The pane and the diagnostic report keep the code in view
    // for the rest of the session.
    showCodedNotice(CACHE_READ_ONLY_HEADLINE, readOnlyCode);
  } else if (didMigrate) {
    // First successful migration of this profile. Surface a one-time
    // alert pointing to the safety-net backup file so users know exactly
    // where to find a verbatim copy of every pre-migration Extra field
    // if they want to audit or restore anything.
    const backupPathRaw = getPref(PREF_LAST_BACKUP_PATH);
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
  registerSettingsPane();

  // Fail closed: with no cache, the synchronous column dataProvider and the
  // pane would surface broken/empty data. Register nothing cache-dependent —
  // the user already saw the "cache unavailable" alert above.
  if (cacheInitFailed) {
    Zotero.debug("[Citegeist] Cache init failed — skipping cache-dependent UI registration");
    return;
  }

  // Register the cache-dependent runtime UI. If Zotero rejects any of these
  // registrations, fail closed: tear down everything registered so far and close
  // the cache, so no surface is left wired to a closed cache, and tell the user.
  // registerCitationColumn rolls back its own partial columns and rethrows.
  try {
    // Register the citation count column (global, not per-window)
    columnsRegistering = true;
    try {
      await registerCitationColumn(pluginID);
    } finally {
      columnsRegistering = false;
    }
    if (shutdownBegan("column registration")) {
      // onShutdown left the columns to this startup (see columnsRegistering).
      bestEffort("startup stopped: unregisterCitationColumn", unregisterCitationColumn);
      return;
    }

    // Register the unified item pane section (impact + authors). Pass rootURI so
    // its icons load via jar: (chrome://citegeist/ is unregistered on some Z9
    // installs — the blank-sidenav-icon bug).
    registerCitationPane(pluginID, rootURI);

    // Give the menu module the rootURI too, for its jar:-loaded icons.
    setMenuRootURI(rootURI);

    // Wire every main window already open: onMainWindowLoad does not fire for a
    // window opened before startup, and File > New Window can leave several
    // open. registerMenus registers the MenuManager menus once per process and
    // does nothing for later windows; the DOM fallback wires each window.
    for (const mainWin of Zotero.getMainWindows()) {
      Zotero.debug("[Citegeist] Main window already open at startup — wiring FTL + menus");
      // Without the FTL the pane's l10nIDs (and the MenuManager labels) render
      // blank: the confirmed empty-header / blank-sidenav / "right-click shows
      // nothing" case on Zotero 9.
      ensureCitegeistFTL(mainWin);
      registerMenus(mainWin);
    }
  } catch (e) {
    logError("UI registration", e);
    // A window that failed partway leaves every window before it wired, so the
    // menus come down everywhere, not only where registration stopped.
    unregisterAllMenus("UI registration cleanup", mainWindows("UI registration cleanup"));
    bestEffort("UI registration cleanup (pane)", unregisterCitationPane);
    bestEffort("UI registration cleanup (column)", unregisterCitationColumn);
    await closeCacheOnce("UI registration cleanup (cache)");
    // A plugin being disabled needs no "restart Zotero" alert.
    if (shutdownBegan("UI registration cleanup")) return;
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
 * Run the one-time `openalex:author` relation purge, guarded by a pref so it
 * runs at most once per profile. The pref is set only AFTER a completed pass, so
 * a mid-pass failure (locked item, DB hiccup) retries next launch instead of
 * leaving stray relations that keep Zotero sync stuck. Never throws — a purge
 * failure must not break startup; the pref simply stays unset and it retries.
 */
async function purgeAuthorRelationsOnce(): Promise<void> {
  try {
    if (getPref(PREF_AUTHOR_RELATIONS_PURGED)) return;
    const { cleaned, failures } = await purgeAllAuthorRelations();
    if (cleaned > 0) {
      Zotero.debug(`[Citegeist] Purged openalex:author relations from ${cleaned} item(s)`);
    }
    // Only mark the purge done when the pass left nothing behind. A single stray
    // relation keeps the whole library's sync stuck, so a partial pass (a locked
    // item, a library that wouldn't enumerate) must retry on the next launch.
    if (failures === 0) {
      setPref(PREF_AUTHOR_RELATIONS_PURGED, true);
    } else {
      Zotero.debug(`[Citegeist] Author-relation purge incomplete (${failures} left); will retry`);
    }
  } catch (e) {
    logError("purgeAuthorRelationsOnce", e);
  }
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

/**
 * Register the settings pane. Zotero's `register` is async: it resolves the
 * pane's URIs through the AddonManager before it adds the pane
 * (preferencePanes.js @8.0.4 143-174, @9.0.6 and @10.0.2 134-165), and its
 * plugin-shutdown observer removes only panes already added (@10.0.2 183-199).
 * A disable that lands in between would leave the pane registered for a
 * disabled plugin, so once registration settles, the pane comes back out if a
 * shutdown began. A refusal, such as a pane ID already registered, is logged
 * rather than left as an unhandled rejection.
 */
function registerSettingsPane(): void {
  // Zotero's `register` resolves to the pane ID, and `unregister` takes it
  // (preferencePanes.js @10.0.2 164, 172-175); the typings declare neither.
  const panes = Zotero.PreferencePanes as typeof Zotero.PreferencePanes & {
    unregister?(paneID: string): void;
  };
  let registration: unknown;
  try {
    registration = panes.register({
      pluginID,
      // Explicit id so the item pane's settings button can deep-link here via
      // Zotero.Utilities.Internal.openPreferences(SETTINGS_PANE_ID).
      id: SETTINGS_PANE_ID,
      src: rootURI + "content/preferences.xhtml",
      label: "Citegeist",
      // rootURI (jar:), NOT chrome://citegeist/ — the latter is unregistered on
      // some installs (Zotero 9: "No chrome package registered"), so the icon 404s.
      image: rootURI + "content/icons/icon-16.svg",
    });
  } catch (e) {
    logError("settings pane", e);
    return;
  }
  void Promise.resolve(registration).then(
    (paneID) => {
      if (shutdownStarted && typeof paneID === "string") {
        bestEffort("settings pane unregister", () => panes.unregister?.(paneID));
      }
    },
    (e: unknown) => logError("settings pane", e),
  );
}

/** Whether a shutdown began; if one did, notes the stage where startup stops. */
function shutdownBegan(stage: string): boolean {
  if (!shutdownStarted) return false;
  Zotero.debug(`[Citegeist] Shutdown began during startup (${stage}); startup stops here`);
  return true;
}

/** Run `step`, logging a throw under `context` rather than letting it skip the steps after it. */
function bestEffort(context: string, step: () => void): void {
  try {
    step();
  } catch (e) {
    logError(context, e);
  }
}

/** Every open main window, or none when Zotero cannot list them. */
function mainWindows(context: string): Window[] {
  try {
    return Zotero.getMainWindows();
  } catch (e) {
    logError(`${context} getMainWindows`, e);
    return [];
  }
}

/** Close the cache, or wait on the close already under way (see `cacheClosing`). */
function closeCacheOnce(context: string): Promise<void> {
  cacheClosing ??= closeCache().catch((e) => logError(context, e));
  return cacheClosing;
}

/**
 * Take Citegeist's menus down everywhere: in each of `windows`, the DOM
 * fallback's entries and listeners and the entries MenuManager rendered, then
 * the process-global MenuManager registration. Each step is best-effort, so a
 * window that throws does not keep the others' menus, and the global teardown
 * runs however many windows could be read. `context` prefixes the diagnostic
 * labels.
 */
function unregisterAllMenus(context: string, windows: readonly Window[]): void {
  for (const win of windows) {
    // Zotero 7 DOM fallback: delete with registerViaDOM (U9)
    bestEffort(`${context} unregisterMenus`, () => unregisterMenus(win));
    bestEffort(`${context} removeRenderedMenus`, () => removeRenderedMenus(win));
  }
  bestEffort(`${context} unregisterGlobalMenus`, unregisterGlobalMenus);
}

export async function onShutdown(_data: PluginData): Promise<void> {
  shutdownStarted = true;
  Zotero.debug("[Citegeist] Shutting down");
  cacheReady = false;
  removeBridge();

  // Everything before the first await runs before Zotero unregisters
  // Citegeist's translations. bootstrap.js does not wait for this promise, and
  // Zotero runs its plugin-shutdown observers and then unregisterLocales as
  // soon as the bootstrap `shutdown` returns (plugins.js `onDisabled`, @8.0.4
  // 720-721, @9.0.6 771-772, @10.0.2 916-917; an upgrade or uninstall calls the
  // no-op `uninstall` in between, @10.0.2 862-866 and 925-929). So the
  // translation link and every entry that uses Citegeist's translations leave
  // each window here, and each step is best-effort: a throw in any one of them
  // must not strand the open SQLite handle, which closes last.
  const windows = mainWindows("shutdown");
  unregisterAllMenus("shutdown", windows);
  for (const win of windows) {
    bestEffort("shutdown removeCitegeistFTL", () => removeCitegeistFTL(win));
  }
  if (columnsRegistering) {
    Zotero.debug("[Citegeist] Columns still registering; startup removes them when it stops");
  } else {
    bestEffort("shutdown unregisterCitationColumn", unregisterCitationColumn);
  }
  bestEffort("shutdown unregisterCitationPane", unregisterCitationPane);
  bestEffort("shutdown clearSourceStatsCache", clearSourceStatsCache);
  bestEffort("shutdown clearAuthorProfileCache", clearAuthorProfileCache);
  await closeCacheOnce("cache close");

  Zotero.debug("[Citegeist] Shutdown complete");
}

/**
 * Attach Citegeist's FTL to a window so the item-pane section's l10nIDs
 * (citegeist-pane-*) and the MenuManager menu labels (citegeist-menu-*) resolve
 * to visible text. Uses the bare filename against Zotero's auto-registered
 * Fluent source (see FTL_FILE). Typings lack MozXULElement, hence the cast.
 *
 * Always a new link: one already there is removed first. `insertFTLIfNeeded`
 * adds nothing when the link exists, and only a new link makes the window drop
 * the translations it cached (see `removeCitegeistFTL`). This copy's shutdown
 * removes its link, but a copy of v2.0.5 or earlier leaves its own behind, so an
 * in-place upgrade from one would otherwise run on whatever the window cached
 * from the old copy, or while no source served Citegeist's translations: a
 * broken right-click menu and unlabelled entries. Calling this on both startup
 * and a window load is safe; the window keeps exactly one link.
 */
function ensureCitegeistFTL(win: Window): void {
  try {
    const mozXUL = (win as unknown as { MozXULElement?: { insertFTLIfNeeded(f: string): void } })
      .MozXULElement;
    if (!mozXUL) return;
    bestEffort("ensureCitegeistFTL remove old link", () => removeCitegeistFTL(win));
    mozXUL.insertFTLIfNeeded(FTL_FILE);
  } catch (e) {
    logError("ensureCitegeistFTL", e);
  }
}

/**
 * Remove the localization link `ensureCitegeistFTL` added to `win`: an XHTML
 * `<link rel="localization">` with the bare file name as its `href`
 * (`MozXULElement.insertFTLIfNeeded`, customElements.js@esr140 587-621).
 *
 * The link must go before Zotero unregisters Citegeist's translations. A string
 * resource ID is a required resource (L10nRegistry.cpp@esr140 196-201), so a
 * window that still lists `citegeist.ftl` once no source serves it gets no
 * translations built at all, and every `translateFragment` in it rejects with
 * no reason (DOMLocalization.cpp@esr140 272-276): Zotero's right-click menu never
 * builds and new text renders blank until Zotero restarts. Removing the link
 * drops the resource from the window's localization (HTMLLinkElement.cpp@esr140
 * 122-131, Document.cpp@esr140 4601-4619). Zotero's sample plugin removes its link
 * the same way when it shuts down (zotero/make-it-red@70f709d, src-2.0
 * bootstrap.js 34-38 and make-it-red.js 63-78).
 *
 * Removing it is also what lets a re-enable repair the window. A window caches
 * the translations it built, and only a change to its own resource list clears
 * that cache (fluent-fallback localization.rs@esr140 64-78 and 93-95, through
 * localization-ffi lib.rs@esr140 487-500): Zotero registering the source again
 * tells no window (l10nregistry-ffi registry.rs@esr140 302-336). A link left in
 * place keeps whatever the window cached while the source was gone, and the next
 * startup's `insertFTLIfNeeded` finds the link and adds nothing, so the menu
 * stayed broken and Citegeist's entries unlabelled after a re-enable (seen with
 * v2.0.5 on Zotero 10.0.4). With the link removed here, the next startup inserts
 * a new one, which clears the cache (HTMLLinkElement.cpp@esr140 97-101,
 * Document.cpp@esr140 4565-4585).
 */
function removeCitegeistFTL(win: Window): void {
  const links = win.document.querySelectorAll(`link[rel="localization"][href="${FTL_FILE}"]`);
  for (const link of Array.from(links)) link.remove();
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

  ensureCitegeistFTL(win);
  registerMenus(win);
}

export function onMainWindowUnload(win: Window): void {
  Zotero.debug("[Citegeist] Main window unloading");

  bestEffort("window unload removeCitegeistFTL", () => removeCitegeistFTL(win));

  // Zotero 7 DOM fallback: delete with registerViaDOM (U9)
  unregisterMenus(win);
}

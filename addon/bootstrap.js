/* eslint-disable no-undef */
/**
 * Citegeist — Zotero 7 Bootstrap Plugin
 *
 * This file is the entry point called by Zotero's plugin system.
 * It delegates all logic to the compiled TypeScript bundle.
 */

var citegeist;
// Handle returned by registerChrome. MUST be retained for the plugin's whole
// lifetime: it's the RAII owner of the chrome:// registration, and if we drop
// it the GC finalizer runs destruct() and tears the registration down —
// "No chrome package registered for chrome://citegeist/..." in the Zotero 9
// Debug Output, which broke the injected FTL (blank sidenav/menu labels) and
// any chrome:// icon. Destructed explicitly on shutdown. (make-it-red pattern.)
var chromeHandle;

function install(data, reason) {
  // No-op: handled by startup
}

function uninstall(data, reason) {
  // No-op: handled by shutdown
}

async function startup({ id, version, rootURI }, reason) {
  // Register chrome resource mapping for content/ and locale/
  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);

  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "__addonRef__", "content/"],
    ["locale", "__addonRef__", "en-US", "locale/en-US/"],
  ]);

  // Load the compiled plugin bundle
  Services.scriptloader.loadSubScript(
    rootURI + "content/scripts/citegeist.js",
  );

  citegeist = new Citegeist();
  await citegeist.startup({ id, version, rootURI, reason });
}

function shutdown({ id, version, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) return;
  if (citegeist) {
    citegeist.shutdown({ id, version, rootURI, reason });
    citegeist = undefined;
  }
  // Tear down the chrome:// registration we own. Explicit here so an
  // uninstall/disable/upgrade unmaps chrome://citegeist/ deterministically
  // instead of waiting on GC.
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = undefined;
  }
}

function onMainWindowLoad({ window }) {
  if (citegeist) {
    citegeist.onMainWindowLoad(window);
  }
}

function onMainWindowUnload({ window }) {
  if (citegeist) {
    citegeist.onMainWindowUnload(window);
  }
}

/**
 * The settings pane registers and opens with its controls.
 *
 * Catches: a `PreferencePanes.register` that rejects (it is async), a `src`
 * that does not resolve inside the shipped XPI, and a pane document that fails
 * to parse (it never reports loaded).
 */
import { SETTINGS_PANE_ID } from "../../src/constants";
import { ADDON_ID } from "./support/citegeist";
import { WAIT_TIMEOUT_MS, waitFor } from "./support/zotero";

describe("preference pane", function () {
  it("registers the Citegeist settings pane", async function () {
    const pane = await waitFor("the Citegeist settings pane to register", () =>
      Zotero.PreferencePanes.pluginPanes.find(
        (p: { id: string; pluginID: string }) => p.id === SETTINGS_PANE_ID,
      ),
    );
    expect(pane.pluginID).to.equal(ADDON_ID);
  });

  it("opens the pane with its settings controls", async function () {
    const prefsWindow = Zotero.Utilities.Internal.openPreferences(SETTINGS_PANE_ID);
    try {
      const prefs = await waitFor(
        "the settings window",
        () => prefsWindow.document?.readyState === "complete" && prefsWindow.Zotero_Preferences,
      );
      await prefs.navigateToPane(SETTINGS_PANE_ID);
      const pane = await waitFor(
        "the Citegeist pane to load and show",
        () => {
          const p = prefs.panes.get(SETTINGS_PANE_ID);
          return p?.loaded && !p.container.hidden ? p : null;
        },
        WAIT_TIMEOUT_MS,
      );
      expect(pane.container.querySelector("#citegeist-pref-apikey"), "API key field").to.exist;
    } finally {
      prefsWindow.close();
    }
  });
});

/**
 * Disable, re-enable and in-place upgrade leave exactly one set of Citegeist UI,
 * labelled, and never break Zotero's own translations.
 *
 * Catches: menus or pane sections that survive a disable; a main window left
 * holding Citegeist's localization link, or a rendered menu entry that uses
 * Citegeist's translations, once Zotero unregisters them at disable, which makes
 * every translation in the window reject so the right-click menu never builds
 * (BUG-DISABLE-L10N, which this spec first caught on 8.0.4, 9.0.6 and 10.0.2); a
 * re-enable or upgrade that leaves those translations broken and Citegeist's own
 * entries unlabelled, which a link left in place causes, because the window
 * keeps what it cached while the translations were gone (seen with v2.0.5 on
 * Zotero 10.0.4); duplicate MenuManager registrations or sections after enable
 * or upgrade ("paneID must be unique"); and a copy that never finishes startup
 * after enable or upgrade (the ready flag never returns). Numbered 90 because it
 * restarts the plugin under test (00-root-hooks.spec.ts).
 *
 * The first test also translates the whole window before anything is disabled,
 * so a translation that fails for a reason of Zotero's own shows up there, not as
 * a Citegeist failure later.
 *
 * It cannot catch an unregister by the wrong menu key (ADV-B1). Zotero's own
 * plugin-shutdown observer removes a plugin's menus on every disable and upgrade
 * (pluginAPIBase.mjs `_unregisterByPluginID` 345-356, observer 362-373), and runs
 * right after the bootstrap `shutdown` (plugins.js@10.0.2 `_callMethod` 258 and
 * 269), so this spec passes with that bug present. test/menu.test.ts covers it
 * against a MenuManager fake that keeps Zotero's registry rules.
 *
 * `Zotero.Citegeist` disappears at the start of shutdown, before the cache
 * closes, so the spec waits for the "[Citegeist] Shutdown complete" Debug Output
 * line: enabling any earlier would race the old connection's exclusive lock on
 * citegeist.sqlite. `reload()` on a temporary add-on is Zotero's in-place
 * upgrade path: bootstrap shutdown with ADDON_UPGRADE, then install and startup
 * of the same files. bootstrap.js does not await the old copy's shutdown, so the
 * new copy can start before the old cache closes. That race is the product's to
 * fix (plan U6); this spec waits for both ends before it looks.
 */
import { BUDGETS, SHUTDOWN_WAIT_TIMEOUT_MS, STARTUP_WAIT_TIMEOUT_MS } from "./shared/timeouts";
import { ITEM_MENU_L10N_IDS, SHUTDOWN_COMPLETE_DEBUG_LINE } from "./support/citegeist";
import {
  citegeistItemMenuCounts,
  citegeistSections,
  citegeistSidenavButtons,
  debugLinesContaining,
  ensureCitegeistReady,
  getCitegeistAddon,
  mainWindow,
  useStubItem,
  waitFor,
  waitForCitegeistReady,
  waitForNewDebugLine,
} from "./support/zotero";

/** The localization file Citegeist links into each main window (`FTL_FILE` in src/hooks.ts). */
const CITEGEIST_FTL = "citegeist.ftl";

/** Citegeist's localization links in the main window. */
function citegeistLocalizationLinks(): number {
  return mainWindow().document.querySelectorAll(`link[rel="localization"][href="${CITEGEIST_FTL}"]`)
    .length;
}

/**
 * "resolved", or "rejected (reason)". A window that lists a localization resource
 * no source serves rejects every translation with no reason, which Mocha would
 * report only as "Promise rejected with no or falsy reason".
 */
function outcome(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "resolved",
    (reason: unknown) => `rejected (${String(reason)})`,
  );
}

/** Translate `element` and everything in it with the main window's localization. */
async function expectTranslates(element: Element, what: string): Promise<void> {
  const translated = await outcome(mainWindow().document.l10n.translateFragment(element));
  expect(translated, `translating ${what}`).to.equal("resolved");
}

/** Citegeist's entries in the item context menu, overflow submenu included, as last built. */
function citegeistItemMenuEntries(): Element[] {
  const popup = mainWindow().document.getElementById("zotero-itemmenu");
  return [...popup.querySelectorAll(".zotero-custom-menu-item")].filter((entry: Element) =>
    (entry.getAttribute("data-l10n-id") ?? "").startsWith("citegeist-"),
  );
}

async function expectOneSet(phase: string): Promise<void> {
  const sections = await waitFor(`${phase}: one Citegeist item-pane section`, () =>
    citegeistSections().length === 1 ? citegeistSections() : null,
  );
  expect(sections).to.have.length(1);
  expect(citegeistLocalizationLinks(), `${phase}: Citegeist's localization links`).to.equal(1);
  const counts = await citegeistItemMenuCounts();
  for (const l10nID of ITEM_MENU_L10N_IDS) {
    expect(counts.get(l10nID) ?? 0, `${phase}: item-menu entries for ${l10nID}`).to.equal(1);
  }

  // The entries carry text: Citegeist's translations resolve in this window.
  const doc = mainWindow().document;
  await expectTranslates(doc.getElementById("zotero-itemmenu"), `the item context menu ${phase}`);
  for (const entry of citegeistItemMenuEntries()) {
    expect(
      entry.getAttribute("label") ?? "",
      `${phase}: the label of ${entry.getAttribute("data-l10n-id")}`,
    ).to.not.equal("");
  }
  await expectTranslates(doc.documentElement, `the whole main window ${phase}`);
}

describe("plugin lifecycle", function () {
  useStubItem("Citegeist lifecycle spec", { select: true });

  it("starts with one set of menu entries and one pane section", async function () {
    await expectOneSet("after startup");
  });

  it("leaves no menu entries or pane section while disabled", async function () {
    this.timeout(BUDGETS.lifecycleDisable.timeoutMs);
    const shutdownsBefore = debugLinesContaining(SHUTDOWN_COMPLETE_DEBUG_LINE);
    const addon = await getCitegeistAddon();
    await addon.disable();
    await waitForNewDebugLine(
      "Citegeist's shutdown to complete (its cache closed)",
      SHUTDOWN_COMPLETE_DEBUG_LINE,
      shutdownsBefore,
      SHUTDOWN_WAIT_TIMEOUT_MS,
    );
    expect(Zotero.Citegeist, "the bridge after shutdown").to.not.exist;
    await waitFor("Zotero to report Citegeist inactive", async () => {
      return !(await getCitegeistAddon()).isActive;
    });

    await waitFor("the Citegeist section to be removed", () => citegeistSections().length === 0);
    const counts = await citegeistItemMenuCounts();
    expect([...counts.entries()], "Citegeist menu entries while disabled").to.be.empty;
  });

  it("keeps Zotero's own translations working while disabled", async function () {
    expect(
      citegeistLocalizationLinks(),
      "Citegeist's localization links in the main window while disabled",
    ).to.equal(0);
    // Zotero removes the sidenav button with the section (itemDetails.js@10.0.2
    // renderCustomSections 320-333); it carries a Citegeist l10nID too.
    await waitFor(
      "the Citegeist sidenav button to be removed",
      () => citegeistSidenavButtons().length === 0,
    );

    const win = mainWindow();
    await expectTranslates(
      win.document.getElementById("zotero-itemmenu"),
      "Zotero's item context menu while disabled",
    );
    await expectTranslates(win.document.documentElement, "the whole main window while disabled");
    // buildItemContextMenu awaits the item menu's translation before it reaches MenuManager.
    expect(
      await outcome(win.ZoteroPane.buildItemContextMenu()),
      "building the item context menu while disabled",
    ).to.equal("resolved");
  });

  it("restores exactly one set when re-enabled", async function () {
    this.timeout(BUDGETS.lifecycleEnable.timeoutMs);
    const addon = await getCitegeistAddon();
    await addon.enable();
    await waitForCitegeistReady(
      "Citegeist to finish startup after enable",
      STARTUP_WAIT_TIMEOUT_MS,
    );
    await expectOneSet("after re-enable");
  });

  describe("in-place upgrade", function () {
    before(async function () {
      this.timeout(BUDGETS.lifecycleEnsureReady.timeoutMs);
      // Start from a running copy even when a test above failed partway.
      await ensureCitegeistReady();
    });

    it("keeps exactly one set across an in-place upgrade", async function () {
      this.timeout(BUDGETS.lifecycleUpgrade.timeoutMs);
      const previous = Zotero.Citegeist;
      const shutdownsBefore = debugLinesContaining(SHUTDOWN_COMPLETE_DEBUG_LINE);
      const addon = await getCitegeistAddon();
      await addon.reload();
      await waitForNewDebugLine(
        "the old copy's shutdown to complete (its cache closed)",
        SHUTDOWN_COMPLETE_DEBUG_LINE,
        shutdownsBefore,
        SHUTDOWN_WAIT_TIMEOUT_MS,
      );
      await waitFor(
        "the upgraded copy to finish startup",
        () => Zotero.Citegeist && Zotero.Citegeist !== previous && Zotero.Citegeist.ready,
        STARTUP_WAIT_TIMEOUT_MS,
      );
      await expectOneSet("after in-place upgrade");
    });
  });
});

/**
 * Disable, re-enable and in-place upgrade leave exactly one set of Citegeist UI.
 *
 * Catches: menus or pane sections that survive a disable; duplicate MenuManager
 * registrations or sections after enable or upgrade (unregister with the wrong
 * namespaced key, "paneID must be unique"); and a copy that never finishes
 * startup after enable or upgrade (the ready flag never returns). Numbered 90
 * because it restarts the plugin under test (00-root-hooks.spec.ts).
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
  debugLinesContaining,
  ensureCitegeistReady,
  getCitegeistAddon,
  useStubItem,
  waitFor,
  waitForCitegeistReady,
  waitForNewDebugLine,
} from "./support/zotero";

async function expectOneSet(phase: string): Promise<void> {
  const sections = await waitFor(`${phase}: one Citegeist item-pane section`, () =>
    citegeistSections().length === 1 ? citegeistSections() : null,
  );
  expect(sections).to.have.length(1);
  const counts = await citegeistItemMenuCounts();
  for (const l10nID of ITEM_MENU_L10N_IDS) {
    expect(counts.get(l10nID) ?? 0, `${phase}: item-menu entries for ${l10nID}`).to.equal(1);
  }
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

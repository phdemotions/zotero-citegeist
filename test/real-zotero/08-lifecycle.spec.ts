/**
 * Disable, re-enable and in-place upgrade leave exactly one set of Citegeist UI.
 *
 * Catches: menus or pane sections that survive a disable; duplicate MenuManager
 * registrations or sections after enable or upgrade (unregister with the wrong
 * namespaced key, "paneID must be unique"); and a copy that never finishes
 * startup after enable or upgrade (the ready flag never returns). Runs last
 * because it restarts the plugin under test.
 *
 * `reload()` on a temporary add-on is Zotero's in-place upgrade path: bootstrap
 * shutdown with ADDON_UPGRADE, then install and startup of the same files.
 */
import { STUB_DOI } from "./harness/fixture";
import { ITEM_MENU_L10N_IDS } from "./support/citegeist";
import {
  STARTUP_WAIT_TIMEOUT_MS,
  citegeistItemMenuCounts,
  citegeistSections,
  createJournalArticle,
  getCitegeistAddon,
  selectInLibrary,
  waitFor,
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
  let item: { id: number; eraseTx(): Promise<unknown> } | undefined;

  before(async function () {
    item = await createJournalArticle("Citegeist lifecycle spec", STUB_DOI);
    await selectInLibrary(item.id);
  });

  after(async function () {
    await item?.eraseTx();
  });

  it("starts with one set of menu entries and one pane section", async function () {
    await expectOneSet("after startup");
  });

  it("leaves no menu entries or pane section while disabled", async function () {
    const addon = await getCitegeistAddon();
    await addon.disable();
    await waitFor("the bridge to be removed on disable", () => !Zotero.Citegeist);
    await waitFor("Zotero to report Citegeist inactive", async () => {
      return !(await getCitegeistAddon()).isActive;
    });

    await waitFor("the Citegeist section to be removed", () => citegeistSections().length === 0);
    const counts = await citegeistItemMenuCounts();
    expect([...counts.entries()], "Citegeist menu entries while disabled").to.be.empty;
  });

  it("restores exactly one set when re-enabled", async function () {
    const addon = await getCitegeistAddon();
    await addon.enable();
    await waitFor(
      "Citegeist to finish startup after enable",
      () => Zotero.Citegeist?.ready === true,
      STARTUP_WAIT_TIMEOUT_MS,
    );
    await expectOneSet("after re-enable");
  });

  it("keeps exactly one set across an in-place upgrade", async function () {
    const previous = Zotero.Citegeist;
    const addon = await getCitegeistAddon();
    await addon.reload();
    await waitFor(
      "the upgraded copy to finish startup",
      () => Zotero.Citegeist && Zotero.Citegeist !== previous && Zotero.Citegeist.ready,
      STARTUP_WAIT_TIMEOUT_MS,
    );
    await expectOneSet("after in-place upgrade");
  });
});

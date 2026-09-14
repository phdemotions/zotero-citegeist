/**
 * Citegeist reads its settings under the names the settings pane writes, and
 * still honours the one-shot flags earlier builds stored under a doubled name.
 *
 * Catches: a pref read without `Zotero.Prefs`' `global` argument, which looks up
 * `extensions.zotero.extensions.zotero.citegeist.*` and silently ignores the
 * user's choice (every build through v2.0.5); and a fix for that which forgets
 * the flags those builds wrote, so every existing profile migrates again.
 * Numbered in the 9x range, which holds the specs that restart the plugin, so it
 * runs after every spec that needs the copy Zotero started (00-root-hooks.spec.ts).
 *
 * Each restart waits for the old copy's "[Citegeist] Shutdown complete" line
 * before looking at the new copy, for the reason 90-lifecycle.spec.ts gives: the
 * new copy can start before the old one has closed citegeist.sqlite.
 */
import { PREF_MIGRATION_COMPLETE, PREF_NETWORK_PAGE_SIZE } from "../../src/constants";
import { linesAdded } from "./shared/debugLines";
import { STUB_WORK_ID } from "./shared/fixture";
import { BUDGETS, SHUTDOWN_WAIT_TIMEOUT_MS, STARTUP_WAIT_TIMEOUT_MS } from "./shared/timeouts";
import { SHUTDOWN_COMPLETE_DEBUG_LINE } from "./support/citegeist";
import {
  citegeistSections,
  citegeistSidenavButtons,
  debugLinesContaining,
  ensureCitegeistReady,
  getCitegeistAddon,
  mainWindow,
  selectInLibrary,
  stubRequestLog,
  stubRequestsSince,
  waitFor,
  waitForNewDebugLine,
  withStubItem,
} from "./support/zotero";

/** What `Zotero.Prefs` prepends to a name read without `global`. */
const DOUBLED_PREFIX = "extensions.zotero.";
/** Not the shipped default of 25, and a step the settings field allows. */
const CHOSEN_PAGE_SIZE = 35;
/** The citation browser's overlay, `createDialogShell` in src/modules/citationNetwork/dialog.ts. */
const OVERLAY_ID = "citegeist-network-overlay";
/**
 * The Debug Output line `migrateFromExtraV1` in src/modules/cache/migration.ts
 * writes whenever its migration loop runs, even over a library with nothing to
 * move, so a profile without legacy Extra data raises no alert while the spec runs.
 */
const MIGRATION_RAN_MARK = "[Citegeist] migration complete";

/** Reload Citegeist in place: wait for the old copy's shutdown, then for the new copy to be ready. */
async function restartCitegeist(): Promise<void> {
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
    "the restarted copy to finish startup",
    () => Zotero.Citegeist && Zotero.Citegeist !== previous && Zotero.Citegeist.ready,
    STARTUP_WAIT_TIMEOUT_MS,
  );
}

/** Restart Citegeist and return the migration-loop lines that restart wrote. */
async function migrationRunsDuringRestart(): Promise<string[]> {
  const before = debugLinesContaining(MIGRATION_RAN_MARK);
  await restartCitegeist();
  return linesAdded(before, debugLinesContaining(MIGRATION_RAN_MARK));
}

describe("preference names", function () {
  it("sizes citation-browser pages from networkPageSize as the settings pane stores it", async function () {
    this.timeout(BUDGETS.preferencePageSize.timeoutMs);
    await withStubItem("Citegeist page-size spec", async (item) => {
      const doc = mainWindow().document;
      Services.prefs.setIntPref(PREF_NETWORK_PAGE_SIZE, CHOSEN_PAGE_SIZE);
      try {
        await selectInLibrary(item.id);
        const section = await waitFor(
          "the Citegeist item-pane section",
          () => citegeistSections()[0],
        );
        citegeistSidenavButtons()[0]?.click();
        const citingButton = await waitFor("the Citing works button", () =>
          [...section.querySelectorAll("button")].find((b) =>
            (b.textContent ?? "").startsWith("Citing works"),
          ),
        );

        const requestsBefore = await stubRequestLog();
        citingButton.click();
        const citing: string = await waitFor(
          "the citation browser's citing-works request",
          async () =>
            (await stubRequestsSince(requestsBefore)).find(
              (r) =>
                r.startsWith("/works?") && decodeURIComponent(r).includes(`cites:${STUB_WORK_ID}`),
            ),
        );

        expect(
          new URL(citing, "http://stub.invalid").searchParams.get("per_page"),
          `request: ${citing}`,
        ).to.equal(String(CHOSEN_PAGE_SIZE));
      } finally {
        doc
          .getElementById(OVERLAY_ID)
          ?.dispatchEvent(
            new (mainWindow().KeyboardEvent)("keydown", { key: "Escape", bubbles: true }),
          );
        doc.getElementById(OVERLAY_ID)?.remove();
        Services.prefs.clearUserPref(PREF_NETWORK_PAGE_SIZE);
      }
    });
  });

  describe("a migration flag an earlier build stored under the doubled name", function () {
    before(async function () {
      this.timeout(BUDGETS.preferenceEnsureReady.timeoutMs);
      // Start from a running copy even when an earlier spec failed partway.
      await ensureCitegeistReady();
    });

    it("stops startup migrating again, and is copied to its real name", async function () {
      this.timeout(BUDGETS.preferenceLegacyFlag.timeoutMs);
      const legacyFlag = DOUBLED_PREFIX + PREF_MIGRATION_COMPLETE;
      try {
        Services.prefs.clearUserPref(PREF_MIGRATION_COMPLETE);
        Services.prefs.setBoolPref(legacyFlag, true);
        expect(
          await migrationRunsDuringRestart(),
          "startup migrated despite the flag under the doubled name",
        ).to.be.empty;
        expect(
          Services.prefs.getBoolPref(PREF_MIGRATION_COMPLETE, false),
          "the flag under its real name after startup",
        ).to.equal(true);

        // With the flag under neither name the same restart migrates, so the
        // empty result above cannot come from a probe that never sees a migration.
        Services.prefs.clearUserPref(PREF_MIGRATION_COMPLETE);
        Services.prefs.clearUserPref(legacyFlag);
        expect(
          await migrationRunsDuringRestart(),
          "positive control: a restart with no flag migrates",
        ).to.have.length(1);
      } finally {
        Services.prefs.clearUserPref(legacyFlag);
        Services.prefs.setBoolPref(PREF_MIGRATION_COMPLETE, true);
      }
    });
  });
});

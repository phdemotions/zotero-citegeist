/**
 * Citegeist installs and activates on this Zotero release.
 *
 * Catches: a manifest `strict_max_version` below the running Zotero (e.g. `9.*`
 * on Zotero 10). Firefox then refuses the temporary install outright ("is not
 * compatible with application version"), so the run fails before any spec, and
 * the CI negative control asserts exactly that. If a future host installs the
 * add-on disabled instead, the appDisabled assertion here fails. Also catches a
 * startup that never completes (the ready flag), and a CI cell mis-pinned to a
 * beta or dev build, where strict_max_version is not enforced at all.
 */
import { ADDON_ID } from "./support/citegeist";
import { getCitegeistAddon } from "./support/zotero";

describe("activation", function () {
  it("runs on a release build, where Zotero enforces strict_max_version", function () {
    expect(
      Zotero.version,
      "beta and dev builds ignore strict_max_version, so the cap check would prove nothing",
    ).to.match(/^\d+\.\d+(\.\d+)?$/);
  });

  it("reports Citegeist active and not appDisabled", async function () {
    const addon = await getCitegeistAddon();
    expect(addon, `${ADDON_ID} is not installed`).to.exist;
    expect(
      addon.appDisabled,
      `Zotero ${Zotero.version} marked Citegeist incompatible (manifest strict_min/max_version)`,
    ).to.equal(false);
    expect(addon.isActive, "Citegeist is installed but not active").to.equal(true);
  });

  it("finished startup: the bridge ready flag is true", function () {
    expect(Zotero.Citegeist, "Zotero.Citegeist bridge missing").to.exist;
    expect(Zotero.Citegeist.ready).to.equal(true);
  });
});

/**
 * Citegeist installs and activates on the Zotero build under test.
 *
 * Catches: a manifest `strict_max_version` below the running Zotero (e.g. `9.*`
 * on Zotero 10). Firefox then refuses the temporary install outright ("is not
 * compatible with application version"), so the run fails before any spec, and
 * the CI negative control asserts exactly that. If a host installs the add-on
 * disabled instead, the root before hook fails at once ("marked Citegeist
 * incompatible"), as the appDisabled assertion here would. Also catches a CI
 * cell running a build other than the one it pinned: the pull-request matrix
 * sets CITEGEIST_EXPECT_ZOTERO_VERSION, and Zotero.version must equal it. Only
 * release builds enforce strict_max_version, which is why the matrix pins them;
 * a scheduled watch that runs beta and dev builds leaves the variable unset.
 */
import { EXPECTED_ZOTERO_VERSION_ENV } from "./shared/env";
import { ADDON_ID } from "./support/citegeist";
import { getCitegeistAddon } from "./support/zotero";

describe("activation", function () {
  it("runs the Zotero build the CI cell pinned", function () {
    expect(Zotero.version, "Zotero.version").to.be.a("string").that.is.not.empty;
    const expected: string = Services.env.get(EXPECTED_ZOTERO_VERSION_ENV);
    if (expected) {
      expect(Zotero.version, `${EXPECTED_ZOTERO_VERSION_ENV} pinned Zotero ${expected}`).to.equal(
        expected,
      );
    }
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

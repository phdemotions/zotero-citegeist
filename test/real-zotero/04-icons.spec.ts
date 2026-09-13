/**
 * The sidenav and section-header icons resolve to Citegeist's SVG in both themes.
 *
 * Catches: `url('undefined')` from a missing icon, an icon path that does not
 * load (a chrome:// URL whose package is unregistered, a renamed file), and a
 * theme-specific break. Note that on Zotero 8.0.4–10.0.2 a missing `darkIcon`
 * is NOT a regression this spec can see: Zotero falls back to `icon`
 * (`if (!darkIcon) darkIcon = icon` in itemPaneSidenav.js), so both themes
 * still resolve.
 */
import { STUB_DOI } from "./harness/fixture";
import { PANE_ICON_FILE } from "./support/citegeist";
import {
  citegeistSections,
  citegeistSidenavButtons,
  createJournalArticle,
  cssImageUrl,
  mainWindow,
  resetTheme,
  selectInLibrary,
  setTheme,
  waitFor,
} from "./support/zotero";

async function expectCitegeistIcon(where: string, computed: string): Promise<void> {
  expect(computed, `${where}: computed image`).to.not.include("undefined");
  const url = cssImageUrl(computed);
  expect(url, `${where}: expected a url(…) image, got ${computed}`).to.be.a("string");
  expect(url, `${where}: icon URL`).to.include(PANE_ICON_FILE);
  const svg: string = await Zotero.File.getContentsFromURLAsync(url);
  expect(svg, `${where}: ${url} did not load an SVG`).to.include("<svg");
}

describe("sidenav and section icons", function () {
  let item: { id: number; eraseTx(): Promise<unknown> } | undefined;

  before(async function () {
    item = await createJournalArticle("Citegeist icon spec", STUB_DOI);
    await selectInLibrary(item.id);
    await waitFor("the Citegeist sidenav button", () => citegeistSidenavButtons()[0]);
  });

  afterEach(function () {
    resetTheme();
  });

  after(async function () {
    await item?.eraseTx();
  });

  for (const theme of ["light", "dark"] as const) {
    it(`sidenav icon resolves to a real URL in the ${theme} theme`, async function () {
      await setTheme(theme);
      const button = citegeistSidenavButtons()[0];
      await expectCitegeistIcon(
        `sidenav (${theme})`,
        mainWindow().getComputedStyle(button).backgroundImage,
      );
    });

    it(`section header icon resolves to a real URL in the ${theme} theme`, async function () {
      await setTheme(theme);
      const title = citegeistSections()[0]?.querySelector(".head .title");
      expect(title, "Citegeist section header title").to.exist;
      await expectCitegeistIcon(
        `section header (${theme})`,
        mainWindow().getComputedStyle(title, "::before").backgroundImage,
      );
    });
  }
});

/**
 * Selecting an item renders Citegeist's section with its hero metric.
 *
 * Catches: a plain `label` instead of `l10nID` on registerSection (Zotero rejects
 * the options, no section exists, startup still reports ready); a pane stuck on
 * its loading state (a rejected onAsyncRender); a base-URL override that never
 * reaches the loopback stub (no data, no hero); and a hero fed the wrong numbers.
 */
import { STUB_CITED_BY_COUNT } from "./shared/fixture";
import { BUDGETS } from "./shared/timeouts";
import { citegeistSections, citegeistSidenavButtons, useStubItem, waitFor } from "./support/zotero";

describe("item pane section", function () {
  useStubItem("Citegeist item-pane spec", { select: true });

  it("renders a non-empty Citegeist section containing the hero metric", async function () {
    this.timeout(BUDGETS.itemPane.timeoutMs);
    const section = await waitFor("the Citegeist item-pane section", () => citegeistSections()[0]);
    // Bring the section into view the way a user would, so it renders even when
    // it sits below the fold of the item pane.
    citegeistSidenavButtons()[0]?.click();

    const hero = await waitFor("the hero metric in the Citegeist section", () =>
      section.querySelector("#citegeist-content .cg-hero"),
    );
    expect(section.querySelector("#citegeist-content").textContent.trim()).to.not.equal("");
    expect(
      hero.textContent.replace(/\D/g, ""),
      "the hero shows the stub's citation count",
    ).to.include(String(STUB_CITED_BY_COUNT));
  });
});

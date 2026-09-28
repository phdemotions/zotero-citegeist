/**
 * Selecting an item renders Citegeist's section with its hero metric.
 *
 * Catches: a plain `label` instead of `l10nID` on registerSection (Zotero rejects
 * the options, no section exists, startup still reports ready); a pane stuck on
 * its loading state (a rejected onAsyncRender); a base-URL override that never
 * reaches the loopback stub (no data, no hero); and a hero fed the wrong numbers.
 *
 * Zotero renders a section's async part, where Citegeist fetches, only while
 * the section is on screen, and Citegeist's sits below the built-in sections, so
 * the spec brings it into view the way a click on its sidenav button does
 * (revealCitegeistSection).
 */
import { STUB_CITED_BY_COUNT } from "./shared/fixture";
import { BUDGETS } from "./shared/timeouts";
import { revealCitegeistSection, useStubItem } from "./support/zotero";

describe("item pane section", function () {
  useStubItem("Citegeist item-pane spec", { select: true });

  it("renders a non-empty Citegeist section containing the hero metric", async function () {
    this.timeout(BUDGETS.itemPane.timeoutMs);
    const { section, found: hero } = await revealCitegeistSection("the hero metric", (s) =>
      s.querySelector("#citegeist-content .cg-hero"),
    );
    const content = section.querySelector("#citegeist-content")?.textContent?.trim() ?? "";
    expect(content, "the text in #citegeist-content").to.not.equal("");
    expect(
      (hero.textContent ?? "").replace(/\D/g, ""),
      "the hero shows the stub's citation count",
    ).to.include(String(STUB_CITED_BY_COUNT));
  });
});

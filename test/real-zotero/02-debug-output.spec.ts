/**
 * Startup leaves no error behind.
 *
 * Catches: any `logError` during startup (every Citegeist failure funnels into
 * one `[Citegeist] ERROR` Debug Output line), and a bootstrap.js that drops its
 * `registerChrome` handle so GC unregisters chrome://citegeist/ ("No chrome
 * package registered", blank icons, unresolved FTL). The GC is forced here, so
 * that regression fails deterministically instead of whenever GC happens to run.
 */
import { PANE_ICON_FILE } from "./support/citegeist";

describe("Debug Output after startup", function () {
  it("has no Citegeist error line", function () {
    const output: string[] = Zotero.Debug.getConsoleViewerOutput();
    expect(
      output.some((line) => line.includes("[Citegeist] Startup complete")),
      "positive control: Debug Output storing is on and holds Citegeist's startup lines",
    ).to.equal(true);
    const errors = output.filter((line) => line.includes("[Citegeist] ERROR"));
    expect(errors, errors.join("\n")).to.be.empty;
  });

  it("keeps chrome://citegeist/ registered through a forced garbage collection", async function () {
    Components.utils.forceGC();
    Components.utils.forceCC();
    Components.utils.forceGC();
    const svg: string = await Zotero.File.getContentsFromURLAsync(
      `chrome://citegeist/content/icons/${PANE_ICON_FILE}`,
    );
    expect(svg).to.include("<svg");
  });

  it('logs no "No chrome package registered" for chrome://citegeist', function () {
    const messages: string[] = Services.console
      .getMessageArray()
      .map((m: { message?: string }) => String(m.message ?? m));
    expect(messages.length, "positive control: the console has messages").to.be.greaterThan(0);
    const missing = [...messages, ...Zotero.Debug.getConsoleViewerOutput()].filter((m: string) =>
      m.includes("No chrome package registered for chrome://citegeist"),
    );
    expect(missing, missing.join("\n")).to.be.empty;
  });
});

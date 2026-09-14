/**
 * Startup leaves no error behind.
 *
 * Catches: any `logError` during startup (every Citegeist failure funnels into
 * one `[Citegeist] ERROR` Debug Output line; the root hooks check each test, and
 * this checks what startup logged before the first one), and a bootstrap.js
 * that drops its `registerChrome` handle so GC unregisters chrome://citegeist/
 * ("No chrome package registered", blank icons, unresolved FTL). The garbage
 * collection is precise and settled here, so that regression fails every time
 * instead of whenever GC happens to run.
 */
import { UNREGISTERED_CHROME_MESSAGE } from "./shared/debugLines";
import { ERROR_DEBUG_MARK, PANE_ICON_FILE, STARTUP_COMPLETE_DEBUG_LINE } from "./support/citegeist";
import { harnessState } from "./support/harnessState";
import { debugLinesContaining, preciseGarbageCollection } from "./support/zotero";

describe("Debug Output after startup", function () {
  it("has no Citegeist error line", function () {
    expect(
      debugLinesContaining(STARTUP_COMPLETE_DEBUG_LINE),
      "positive control: Debug Output storing is on and holds Citegeist's startup lines",
    ).to.not.be.empty;
    const errors = debugLinesContaining(ERROR_DEBUG_MARK);
    expect(errors, errors.join("\n")).to.be.empty;
  });

  it("keeps chrome://citegeist/ registered through a precise garbage collection", async function () {
    await preciseGarbageCollection();
    const svg: string = await Zotero.File.getContentsFromURLAsync(
      `chrome://citegeist/content/icons/${PANE_ICON_FILE}`,
    );
    expect(svg).to.include("<svg");
  });

  it('logs no "No chrome package registered" for chrome://citegeist', function () {
    const state = harnessState();
    expect(state.consoleListener, "positive control: the root hooks record the console").to.exist;
    expect(
      state.consoleMessagesSeen,
      "positive control: the console recorder has seen messages",
    ).to.be.greaterThan(0);
    const missing = [
      ...state.consoleRecords.map((record) => record.message),
      ...debugLinesContaining(UNREGISTERED_CHROME_MESSAGE),
    ].filter((message) => message.includes(UNREGISTERED_CHROME_MESSAGE));
    expect(missing, missing.join("\n")).to.be.empty;
  });
});

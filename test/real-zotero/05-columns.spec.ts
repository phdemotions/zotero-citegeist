/**
 * Columns register, and repaint with fresh data after a fetch against the stub.
 *
 * Catches: a column that fails to register (and the fail-closed rollback taking
 * the rest with it); a dataProvider that throws (the guard blanks the cell, so
 * the stub's count never shows); a repaint chain that never reaches the items
 * tree; a base-URL override that is ignored for loopback (the fetch never hits
 * the stub); and an api_key sent to a non-OpenAlex host.
 */
import { STUB_CITED_BY_COUNT, STUB_DOI } from "./harness/fixture";
import { ADDON_ID, CITATIONS_COLUMN_DATA_KEY, COLUMN_DATA_KEYS } from "./support/citegeist";
import {
  clearApiKeyPrefs,
  createJournalArticle,
  mainWindow,
  setApiKeyPrefs,
  showLibrary,
  stubRequestLog,
  waitFor,
} from "./support/zotero";

const API_KEY_SENTINEL = "citegeist-real-zotero-sentinel-key";

function columnKey(dataKey: string): string {
  return mainWindow().CSS.escape(`${ADDON_ID}-${dataKey}`);
}

describe("item tree columns", function () {
  it("registers every Citegeist column", function () {
    const missing = COLUMN_DATA_KEYS.filter(
      (dataKey) => !Zotero.ItemTreeManager.isCustomColumn(columnKey(dataKey)),
    );
    expect(missing, `unregistered columns: ${missing.join(", ")}`).to.be.empty;
  });

  it("repaints with the stub's data after a fetch, without sending the api_key", async function () {
    const item = await createJournalArticle("Citegeist columns spec", STUB_DOI);
    // Show the library but leave the item unselected: selecting it would start
    // the item pane's own fetch and race this one.
    await showLibrary();
    const view = mainWindow().ZoteroPane.itemsView;
    const repaint = view.refreshAndMaintainSelection;
    let repaints = 0;
    view.refreshAndMaintainSelection = function (...args: unknown[]) {
      repaints++;
      return repaint.apply(this, args);
    };
    setApiKeyPrefs(API_KEY_SENTINEL);
    try {
      const key = columnKey(CITATIONS_COLUMN_DATA_KEY);
      expect(Zotero.ItemTreeManager.getCustomCellData(item, key)).to.not.equal(
        String(STUB_CITED_BY_COUNT),
      );

      const result = await Zotero.Citegeist.fetchItems([item.id]);
      expect(result, "bridge fetch resolved undefined (see Debug Output)").to.exist;
      expect(result.fresh, JSON.stringify(result)).to.equal(1);

      await waitFor("Citegeist to repaint the items tree", () => repaints > 0);
      expect(Zotero.ItemTreeManager.getCustomCellData(item, key)).to.equal(
        String(STUB_CITED_BY_COUNT),
      );

      const requests = await stubRequestLog();
      expect(
        requests.some((r) => r.startsWith("/works/doi:")),
        `the loopback stub never saw the work lookup: ${JSON.stringify(requests)}`,
      ).to.equal(true);
      const leaked = requests.filter((r) => r.includes("api_key"));
      expect(leaked, "api_key sent to the loopback override host").to.be.empty;
    } finally {
      view.refreshAndMaintainSelection = repaint;
      clearApiKeyPrefs();
      await item.eraseTx();
    }
  });
});

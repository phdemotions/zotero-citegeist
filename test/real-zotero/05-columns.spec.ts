/**
 * Columns register, and the painted Citations cell shows fresh data after a
 * fetch against the stub.
 *
 * Catches: a column that fails to register (and the fail-closed rollback taking
 * the rest with it); a dataProvider that throws (the guard blanks the cell, so
 * the stub's count never shows); a fetch whose result never reaches the painted
 * items tree (Zotero caches each row's data, so the cell stays stale unless a
 * repaint re-runs the dataProvider); a base-URL override ignored for loopback
 * (the fetch never reaches the stub); and an api_key sent to the loopback host.
 *
 * The assertion reads the rendered row. The column's dataProvider would compute
 * the fresh value whether or not anything repainted. Auto-fetch is off in the
 * test profile (zotero-plugin.config.ts), so painting the row starts no fetch of
 * its own, and only stub requests made after this fetch began are checked.
 */
import { STUB_CITED_BY_COUNT } from "./shared/fixture";
import { BUDGETS } from "./shared/timeouts";
import { CITATIONS_COLUMN_DATA_KEY, COLUMN_DATA_KEYS } from "./support/citegeist";
import {
  API_KEY_SENTINEL,
  clearApiKeyPrefs,
  mainWindow,
  namespacedKey,
  renderedCellText,
  setApiKeyPrefs,
  showItemTreeColumn,
  showLibrary,
  stubRequestLog,
  stubRequestsSince,
  waitFor,
  withStubItem,
} from "./support/zotero";

describe("item tree columns", function () {
  it("registers every Citegeist column", function () {
    const missing = COLUMN_DATA_KEYS.filter(
      (dataKey) => !Zotero.ItemTreeManager.isCustomColumn(namespacedKey(dataKey)),
    );
    expect(missing, `unregistered columns: ${missing.join(", ")}`).to.be.empty;
  });

  it("paints the stub's count into the Citations cell after a fetch, without sending the api_key", async function () {
    this.timeout(BUDGETS.columnRepaint.timeoutMs);
    await withStubItem("Citegeist columns spec", async (item) => {
      // Show the library but leave the item unselected: selecting it would start
      // the item pane's own fetch and race this one.
      await showLibrary();
      const view = mainWindow().ZoteroPane.itemsView;
      const key = namespacedKey(CITATIONS_COLUMN_DATA_KEY);
      const expected = String(STUB_CITED_BY_COUNT);
      const restoreColumn = showItemTreeColumn(view, key);
      setApiKeyPrefs(API_KEY_SENTINEL);
      try {
        const before = await waitFor("the spec item's row to paint its Citations cell", () => {
          const text = renderedCellText(view, item.id, key);
          return text === null ? null : { text };
        });
        expect(
          before.text,
          "positive control: the cell starts without the stub's count",
        ).to.not.equal(expected);

        const requestsBefore = await stubRequestLog();
        const result = await Zotero.Citegeist.fetchItems([item.id]);
        expect(result, "bridge fetch resolved undefined (see Debug Output)").to.exist;
        expect(result.fresh, JSON.stringify(result)).to.equal(1);

        let painted: string | null = null;
        await waitFor(`the painted Citations cell to show ${expected}`, () => {
          painted = renderedCellText(view, item.id, key);
          return painted === expected;
        }).catch((e: Error) => {
          throw new Error(`${e.message}; the cell shows ${JSON.stringify(painted)}`);
        });

        const requests = await stubRequestsSince(requestsBefore);
        expect(
          requests.some((r) => r.startsWith("/works/doi:")),
          `the loopback stub never saw this fetch's work lookup: ${JSON.stringify(requests)}`,
        ).to.equal(true);
        const leaked = requests.filter((r) => r.includes("api_key"));
        expect(leaked, "api_key sent to the loopback override host").to.be.empty;
      } finally {
        clearApiKeyPrefs();
        restoreColumn();
      }
    });
  });
});

/**
 * Host helpers for specs running INSIDE Zotero. Every helper talks to the real
 * application; nothing is mocked. Waits are deadline-based, so a hang fails with
 * the name of what it was waiting for rather than Mocha's bare timeout, and
 * every deadline comes from ../shared/timeouts.ts.
 */
import { PREF_OPENALEX_API_KEY, PREF_OPENALEX_BASE_URL } from "../../../src/constants";
import {
  type ConsoleRecord,
  UNREGISTERED_CHROME_MESSAGE,
  isCitegeistConsoleProblem,
  linesAdded,
} from "../shared/debugLines";
import { STUB_DOI, STUB_REQUEST_LOG_PATH } from "../shared/fixture";
import {
  BUDGETS,
  POLL_INTERVAL_MS,
  STARTUP_WAIT_TIMEOUT_MS,
  WAIT_TIMEOUT_MS,
} from "../shared/timeouts";
import { ADDON_ID, ERROR_DEBUG_MARK, PANE_ID } from "./citegeist";
import { harnessState } from "./harnessState";

const THEME_PREF = "browser.theme.toolbar-theme";
/** Main-thread turns after a garbage collection, for finalizers and what they unregister. */
const GC_SETTLE_TICKS = 5;

/** An OpenAlex API key no account holds, so any sighting of it came from a spec. */
export const API_KEY_SENTINEL = "citegeist-real-zotero-sentinel-key";

/** A saved Zotero item, as far as the specs use one. */
export interface SpecItem {
  readonly id: number;
  eraseTx(): Promise<unknown>;
}

/** Poll `probe` until it returns a truthy value, or throw naming `what` at the deadline. */
export async function waitFor<T>(
  what: string,
  probe: () => T | Promise<T>,
  timeoutMs: number = WAIT_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() > deadline) {
      const cause = lastError ? ` (last error: ${String(lastError)})` : "";
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}${cause}`);
    }
    await Zotero.Promise.delay(POLL_INTERVAL_MS);
  }
}

export function mainWindow() {
  const win = Zotero.getMainWindow();
  if (!win) throw new Error("Zotero has no main window");
  return win;
}

/** The AddonManager record for Citegeist, or null when it is not installed. */
export async function getCitegeistAddon() {
  const { AddonManager } = ChromeUtils.importESModule(
    "resource://gre/modules/AddonManager.sys.mjs",
  );
  return AddonManager.getAddonByID(ADDON_ID);
}

async function describeCitegeistAddon(): Promise<string> {
  try {
    const addon = await getCitegeistAddon();
    if (!addon) return `${ADDON_ID} is not installed`;
    return (
      `${ADDON_ID} is installed with isActive=${addon.isActive}, ` +
      `appDisabled=${addon.appDisabled}, userDisabled=${addon.userDisabled}`
    );
  } catch (e) {
    return `the AddonManager lookup failed: ${String(e)}`;
  }
}

/**
 * Wait until Citegeist's bridge reports ready. Fails at once if Zotero marks the
 * add-on appDisabled (a manifest cap below the running Zotero), since it would
 * never start, and on timeout reports what AddonManager says about it.
 */
export async function waitForCitegeistReady(what: string, timeoutMs: number): Promise<void> {
  let outcome: "ready" | "appDisabled";
  try {
    outcome = await waitFor(
      what,
      async () => {
        if (Zotero.Citegeist?.ready === true) return "ready" as const;
        const addon = await getCitegeistAddon();
        return addon?.appDisabled ? ("appDisabled" as const) : null;
      },
      timeoutMs,
    );
  } catch (e) {
    throw new Error(
      `${e instanceof Error ? e.message : String(e)}; ${await describeCitegeistAddon()}`,
    );
  }
  if (outcome === "appDisabled") {
    throw new Error(
      `Zotero ${Zotero.version} marked Citegeist incompatible (manifest strict_min/max_version), so it never started`,
    );
  }
}

/** Enable Citegeist if an earlier step left it disabled, then wait until it is ready. */
export async function ensureCitegeistReady(): Promise<void> {
  const addon = await getCitegeistAddon();
  if (!addon) throw new Error(`${ADDON_ID} is not installed`);
  if (!addon.isActive) await addon.enable();
  await waitForCitegeistReady("Citegeist to be enabled and ready", STARTUP_WAIT_TIMEOUT_MS);
}

/** A saved journal article; the caller erases it. */
export async function createJournalArticle(title: string, doi?: string) {
  const item = new Zotero.Item("journalArticle");
  item.setField("title", title);
  if (doi) item.setField("DOI", doi);
  await item.saveTx({ skipSelect: true });
  return item;
}

/** Create a journal article with the stub's DOI, run `body` with it, and erase it however `body` ends. */
export async function withStubItem<T>(
  title: string,
  body: (item: SpecItem) => Promise<T>,
): Promise<T> {
  const item: SpecItem = await createJournalArticle(title, STUB_DOI);
  try {
    return await body(item);
  } finally {
    await item.eraseTx();
  }
}

/**
 * The suite-scoped form of withStubItem. Call inside a describe: it registers a
 * before hook that creates the item (and with `select`, selects it in My
 * Library) and an after hook that erases it. Read `.item` from tests and later
 * hooks only.
 */
export function useStubItem(
  title: string,
  options: { select?: boolean } = {},
): { readonly item: SpecItem } {
  let item: SpecItem | undefined;
  before(async function () {
    this.timeout(BUDGETS.selectStubItem.timeoutMs);
    item = await createJournalArticle(title, STUB_DOI);
    if (options.select) await selectInLibrary(item.id);
  });
  after(async function () {
    await item?.eraseTx();
  });
  return {
    get item(): SpecItem {
      if (!item) throw new Error(`the stub item "${title}" was never created`);
      return item;
    },
  };
}

/** Replace `target[name]` with `wrap(original)`. Call the returned function to put the original back. */
export function patchMethod<T extends object, K extends keyof T>(
  target: T,
  name: K,
  wrap: (original: T[K]) => T[K],
): () => void {
  const original = target[name];
  target[name] = wrap(original);
  return () => {
    target[name] = original;
  };
}

/** Show My Library in the main window, without selecting any item. */
export async function showLibrary(): Promise<void> {
  const pane = mainWindow().ZoteroPane;
  await pane.collectionsView.waitForLoad();
  await pane.collectionsView.selectLibrary(Zotero.Libraries.userLibraryID);
  await pane.itemsView.waitForLoad();
}

/** Show My Library and select `itemID`, waiting until the item pane holds it. */
export async function selectInLibrary(itemID: number): Promise<void> {
  await showLibrary();
  const pane = mainWindow().ZoteroPane;
  await waitFor(
    `item ${itemID} to appear in the items tree`,
    () => pane.itemsView.getRowIndexByID(itemID) !== false,
  );
  await pane.selectItem(itemID);
  const details = mainWindow().document.getElementById("zotero-item-details");
  await waitFor(`item ${itemID} to load in the item pane`, () => details?.item?.id === itemID);
}

/** Zotero's registry key for something Citegeist registers: `CSS.escape(pluginID-id)`. */
export function namespacedKey(id: string): string {
  return mainWindow().CSS.escape(`${ADDON_ID}-${id}`);
}

/** Every Citegeist section element in the main window's item pane. */
export function citegeistSections() {
  const key = namespacedKey(PANE_ID);
  return [...mainWindow().document.querySelectorAll("item-pane-custom-section")].filter(
    (el) => el.dataset.pane === key,
  );
}

/** Every Citegeist button in the main window's item-pane sidenav. */
export function citegeistSidenavButtons() {
  const key = namespacedKey(PANE_ID);
  return [
    ...mainWindow().document.querySelectorAll("#zotero-view-item-sidenav .btn[custom]"),
  ].filter((el) => el.dataset.pane === key);
}

/**
 * Rebuild the item context menu the way a right-click does and count Citegeist
 * entries by l10nID, including any MenuManager moved into its overflow submenu.
 */
export async function citegeistItemMenuCounts(): Promise<Map<string, number>> {
  const win = mainWindow();
  if (typeof win.ZoteroPane.buildItemContextMenu !== "function") {
    throw new Error(`ZoteroPane.buildItemContextMenu is missing on Zotero ${Zotero.version}`);
  }
  await win.ZoteroPane.buildItemContextMenu();
  const popup = win.document.getElementById("zotero-itemmenu");
  const entries: Element[] = [...popup.querySelectorAll(":scope > .zotero-custom-menu-item")];
  // When plugin entries would push the popup past 80% of the screen height,
  // MenuManager moves the ones that do not fit into a group submenu, and fills
  // that submenu only when it starts to open.
  for (const group of popup.querySelectorAll(":scope > .zotero-custom-menu-group-submenu")) {
    const groupPopup = group.querySelector(":scope > menupopup");
    if (!groupPopup) continue;
    groupPopup.dispatchEvent(new win.Event("popupshowing"));
    entries.push(...groupPopup.querySelectorAll(":scope > .zotero-custom-menu-item"));
  }
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const l10nID = entry.getAttribute("data-l10n-id") ?? "";
    if (l10nID.startsWith("citegeist-")) counts.set(l10nID, (counts.get(l10nID) ?? 0) + 1);
  }
  return counts;
}

/** Debug Output lines containing `mark`, oldest first. */
export function debugLinesContaining(mark: string): string[] {
  return Zotero.Debug.getConsoleViewerOutput().filter((line: string) => line.includes(mark));
}

/** The `[Citegeist] ERROR` lines in Debug Output. */
export function citegeistErrorLines(): string[] {
  return debugLinesContaining(ERROR_DEBUG_MARK);
}

/** Wait for a Debug Output line containing `mark` that `before` (from debugLinesContaining) did not hold. */
export async function waitForNewDebugLine(
  what: string,
  mark: string,
  before: readonly string[],
  timeoutMs: number,
): Promise<string> {
  return waitFor(what, () => linesAdded(before, debugLinesContaining(mark))[0], timeoutMs);
}

interface GeckoConsoleMessage {
  message?: string;
  errorMessage?: string;
  sourceName?: string;
  flags?: number;
}

function toConsoleRecord(message: unknown): ConsoleRecord {
  const scriptError = Components.interfaces.nsIScriptError;
  const gecko = message as GeckoConsoleMessage;
  if ((message as object) instanceof scriptError) {
    const notAnError = scriptError.warningFlag | scriptError.infoFlag;
    return {
      message: String(gecko.errorMessage ?? ""),
      sourceName: String(gecko.sourceName ?? ""),
      isError: ((gecko.flags ?? 0) & notAnError) === 0,
    };
  }
  return { message: String(gecko?.message ?? message), sourceName: "", isError: false };
}

/**
 * Record console errors and chrome-registration messages for the rest of the
 * run. The console service keeps only a bounded backlog, so this starts before
 * any spec runs: it takes the backlog from Citegeist's startup, then listens.
 */
export function startConsoleRecorder(): void {
  const state = harnessState();
  if (state.consoleListener) return;
  const record = (message: unknown): void => {
    state.consoleMessagesSeen++;
    const entry = toConsoleRecord(message);
    if (entry.isError || entry.message.includes(UNREGISTERED_CHROME_MESSAGE)) {
      state.consoleRecords.push(entry);
    }
  };
  for (const message of Services.console.getMessageArray() ?? []) record(message);
  const listener = {
    observe: record,
    QueryInterface: ChromeUtils.generateQI(["nsIConsoleListener"]),
  };
  Services.console.registerListener(listener);
  state.consoleListener = listener;
}

async function citegeistRootURI(): Promise<string | null> {
  try {
    const addon = await getCitegeistAddon();
    const spec: string | undefined = addon?.getResourceURI("manifest.json")?.spec;
    return spec?.endsWith("manifest.json") ? spec.slice(0, -"manifest.json".length) : null;
  } catch {
    return null;
  }
}

/** Stop recording, and return the recorded console problems Citegeist caused that no test allowed. */
export async function stopConsoleRecorder(): Promise<ConsoleRecord[]> {
  const state = harnessState();
  if (state.consoleListener) {
    try {
      Services.console.unregisterListener(state.consoleListener);
    } catch {
      // The console service can already be gone while Zotero shuts down.
    }
    state.consoleListener = undefined;
  }
  const markers = ["chrome://citegeist/", "[Citegeist]", ADDON_ID];
  const rootURI = await citegeistRootURI();
  if (rootURI) markers.push(rootURI);
  return state.consoleRecords.filter(
    (record) =>
      isCitegeistConsoleProblem(record, markers) &&
      !state.allowedForRun.some((pattern) => pattern.test(record.message)),
  );
}

interface ItemTreeColumns {
  _columns: { dataKey: string; hidden?: boolean }[];
  toggleHidden(index: number): void;
}

/** The parts of Zotero's items view (itemTree.jsx and its virtualized table) these helpers read. */
export interface ItemsView {
  getRowIndexByID(itemID: number): number | false | undefined;
  tree?: {
    _columns?: ItemTreeColumns;
    _jsWindow?: { getElementByIndex(index: number): Element | undefined };
    scrollToRow?(index: number): void;
  };
}

function itemTreeColumn(view: ItemsView, dataKey: string) {
  const columns = view.tree?._columns;
  const index = columns?._columns?.findIndex((column) => column.dataKey === dataKey) ?? -1;
  if (!columns || typeof columns.toggleHidden !== "function" || index < 0) {
    throw new Error(`the items tree on Zotero ${Zotero.version} has no column ${dataKey}`);
  }
  return { columns, index };
}

/**
 * Make an items-tree column visible, the way the column picker does
 * (`tree._columns.toggleHidden`), and return a function that hides it again if
 * it started hidden. Private Zotero API, so a change of shape fails by name.
 */
export function showItemTreeColumn(view: ItemsView, dataKey: string): () => void {
  const { columns, index } = itemTreeColumn(view, dataKey);
  if (!columns._columns[index].hidden) return () => {};
  columns.toggleHidden(index);
  return () => {
    const shown = itemTreeColumn(view, dataKey);
    if (!shown.columns._columns[shown.index].hidden) shown.columns.toggleHidden(shown.index);
  };
}

/**
 * The text painted in `dataKey`'s cell on the items-tree row for `itemID`, or
 * null while that row or cell is not rendered. Reads the DOM, not the column's
 * dataProvider, so it sees what the user sees.
 */
export function renderedCellText(view: ItemsView, itemID: number, dataKey: string): string | null {
  const index = view.getRowIndexByID(itemID);
  if (typeof index !== "number") return null;
  const row = view.tree?._jsWindow?.getElementByIndex(index);
  if (!row) {
    view.tree?.scrollToRow?.(index);
    return null;
  }
  const cell = Array.from(row.querySelectorAll(".cell")).find((el) =>
    el.classList.contains(dataKey),
  );
  return cell ? (cell.textContent ?? "") : null;
}

/** Switch Zotero's appearance and wait until the main window has restyled. */
export async function setTheme(theme: "light" | "dark"): Promise<void> {
  const win = mainWindow();
  const dark = theme === "dark";
  Services.prefs.setIntPref(THEME_PREF, dark ? 0 : 1);
  await waitFor(
    `the main window to switch to the ${theme} theme`,
    () => win.matchMedia("(prefers-color-scheme: dark)").matches === dark,
  );
  await new Promise<void>((resolve) =>
    win.requestAnimationFrame(() => win.requestAnimationFrame(() => resolve())),
  );
}

export function resetTheme(): void {
  Services.prefs.clearUserPref(THEME_PREF);
}

/** The URL inside a computed CSS `url("…")` image value, or null for anything else. */
export function cssImageUrl(value: string): string | null {
  const match = /^url\((["']?)(.*)\1\)$/.exec(value.trim());
  return match ? match[2] : null;
}

/** The loopback stub's origin, as the harness wrote it into the test profile. */
export function stubBaseUrl(): string {
  return Zotero.Prefs.get(PREF_OPENALEX_BASE_URL, true);
}

/** Path and query of every request the loopback stub has received, oldest first. */
export async function stubRequestLog(): Promise<string[]> {
  const xhr = await Zotero.HTTP.request("GET", `${stubBaseUrl()}${STUB_REQUEST_LOG_PATH}`, {
    responseType: "text",
  });
  return JSON.parse(xhr.responseText).requests;
}

/** Requests the stub received after `before`, an earlier stubRequestLog(). The log only grows. */
export async function stubRequestsSince(before: readonly string[]): Promise<string[]> {
  return (await stubRequestLog()).slice(before.length);
}

/**
 * Collect garbage deterministically: a precise GC (scheduled for when no JS is
 * on the stack), a cycle collection, and a second precise GC, with main-thread
 * turns after each GC. A dropped `registerChrome` handle is finalized and its
 * chrome package unregistered before the caller looks, instead of whenever
 * GC happens to run.
 */
export async function preciseGarbageCollection(): Promise<void> {
  const utils = Components.utils;
  for (let pass = 0; pass < 2; pass++) {
    await new Promise<void>((resolve) => utils.schedulePreciseGC(() => resolve()));
    for (let tick = 0; tick < GC_SETTLE_TICKS; tick++) await Zotero.Promise.delay(0);
    if (pass === 0) utils.forceCC();
  }
}

/**
 * Set an OpenAlex API key under both pref spellings: the full name the settings
 * pane writes, and the doubly-prefixed name `Zotero.Prefs.get(PREF_OPENALEX_API_KEY)`
 * resolves to (Zotero prepends `extensions.zotero.` unless `global` is passed).
 * Whichever one Citegeist reads, it sees the key, so an assertion about where
 * the key goes cannot pass just because no key was read.
 */
export function setApiKeyPrefs(value: string): void {
  Zotero.Prefs.set(PREF_OPENALEX_API_KEY, value, true);
  Zotero.Prefs.set(PREF_OPENALEX_API_KEY, value);
}

export function clearApiKeyPrefs(): void {
  Services.prefs.clearUserPref(PREF_OPENALEX_API_KEY);
  Services.prefs.clearUserPref(`extensions.zotero.${PREF_OPENALEX_API_KEY}`);
}

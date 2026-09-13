/**
 * Host helpers for specs running INSIDE Zotero. Every helper talks to the real
 * application; nothing is mocked. Waits are deadline-based, so a hang fails with
 * the name of what it was waiting for rather than Mocha's bare timeout.
 */
import { PREF_OPENALEX_API_KEY, PREF_OPENALEX_BASE_URL } from "../../../src/constants";
import { STUB_REQUEST_LOG_PATH } from "../harness/fixture";
import { ADDON_ID, PANE_ID } from "./citegeist";

/** Longest a spec waits on one host condition; well inside Mocha's per-test timeout. */
export const WAIT_TIMEOUT_MS = 20_000;
/** Plugin startup after enable or upgrade reopens the SQLite cache on a CI disk. */
export const STARTUP_WAIT_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 50;
const THEME_PREF = "browser.theme.toolbar-theme";

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

/** A saved journal article; the caller erases it. */
export async function createJournalArticle(title: string, doi?: string) {
  const item = new Zotero.Item("journalArticle");
  item.setField("title", title);
  if (doi) item.setField("DOI", doi);
  await item.saveTx({ skipSelect: true });
  return item;
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

/** Zotero's registry key for Citegeist's section: `CSS.escape(pluginID-paneID)`. */
export function paneKey(): string {
  return mainWindow().CSS.escape(`${ADDON_ID}-${PANE_ID}`);
}

/** Every Citegeist section element in the main window's item pane. */
export function citegeistSections() {
  const key = paneKey();
  return [...mainWindow().document.querySelectorAll("item-pane-custom-section")].filter(
    (el) => el.dataset.pane === key,
  );
}

/** Every Citegeist button in the main window's item-pane sidenav. */
export function citegeistSidenavButtons() {
  const key = paneKey();
  return [
    ...mainWindow().document.querySelectorAll("#zotero-view-item-sidenav .btn[custom]"),
  ].filter((el) => el.dataset.pane === key);
}

/** Rebuild the item context menu the way a right-click does and count Citegeist entries by l10nID. */
export async function citegeistItemMenuCounts(): Promise<Map<string, number>> {
  const win = mainWindow();
  if (typeof win.ZoteroPane.buildItemContextMenu !== "function") {
    throw new Error(`ZoteroPane.buildItemContextMenu is missing on Zotero ${Zotero.version}`);
  }
  await win.ZoteroPane.buildItemContextMenu();
  const popup = win.document.getElementById("zotero-itemmenu");
  const counts = new Map<string, number>();
  for (const entry of popup.querySelectorAll(":scope > .zotero-custom-menu-item")) {
    const l10nID = entry.getAttribute("data-l10n-id") ?? "";
    if (l10nID.startsWith("citegeist-")) counts.set(l10nID, (counts.get(l10nID) ?? 0) + 1);
  }
  return counts;
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

/** Path and query of every request the loopback stub has received. */
export async function stubRequestLog(): Promise<string[]> {
  const xhr = await Zotero.HTTP.request("GET", `${stubBaseUrl()}${STUB_REQUEST_LOG_PATH}`, {
    responseType: "text",
  });
  return JSON.parse(xhr.responseText).requests;
}

/**
 * Set an OpenAlex API key under both pref spellings: the full name the settings
 * pane writes, and the doubly-prefixed name `Zotero.Prefs.get(PREF_OPENALEX_API_KEY)`
 * resolves to (Zotero prepends `extensions.zotero.` unless `global` is passed).
 * Whichever one Citegeist reads, it sees the key, so an assertion that the key
 * never leaves for a stub cannot pass just because no key was read.
 */
export function setApiKeyPrefs(value: string): void {
  Zotero.Prefs.set(PREF_OPENALEX_API_KEY, value, true);
  Zotero.Prefs.set(PREF_OPENALEX_API_KEY, value);
}

export function clearApiKeyPrefs(): void {
  Services.prefs.clearUserPref(PREF_OPENALEX_API_KEY);
  Services.prefs.clearUserPref(`extensions.zotero.${PREF_OPENALEX_API_KEY}`);
}

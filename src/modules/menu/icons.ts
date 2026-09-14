/**
 * Icon URLs for the menus and their progress windows.
 *
 * Built off the plugin's rootURI as `jar:` URLs. `chrome://citegeist/…` is
 * unregistered on some Zotero 9 installs ("No chrome package registered"), which
 * made the menu-item icons fail to load and, with them, the right-click menu.
 */

let rootURI = "";

/** Set once at startup, before any menu registers. */
export function setMenuRootURI(uri: string): void {
  rootURI = uri;
}

/** The URL of `content/icons/<name>` inside the plugin. */
export function menuIconURL(name: string): string {
  return `${rootURI}content/icons/${name}`;
}

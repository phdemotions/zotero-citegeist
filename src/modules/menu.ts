/**
 * Citegeist's right-click menus: the public surface of `src/modules/menu/`.
 *
 * `menu/registration.ts` registers the menus and holds the handlers Zotero calls,
 * `menu/batchActions.ts` runs the commands, and `menu/visibility.ts` decides which
 * entries show.
 */

export {
  registerMenus,
  setMenuPluginID,
  unregisterGlobalMenus,
  unregisterMenus,
} from "./menu/registration";
export { setMenuRootURI } from "./menu/icons";

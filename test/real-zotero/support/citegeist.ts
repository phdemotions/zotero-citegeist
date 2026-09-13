/**
 * Identifiers Citegeist registers with Zotero, for the specs running inside it.
 *
 * They are module-private in src/, so they are mirrored here instead of
 * imported: importing citationPane.ts or menu.ts would bundle plugin code into
 * the spec window. test/realZoteroHarness.test.ts reads src/ and fails if any
 * of these drift from the source.
 */
import pkg from "../../../package.json";

export const ADDON_ID: string = pkg.config.addonID;

/** `PANE_ID` in src/modules/citationPane.ts. */
export const PANE_ID = "citegeist-citation-details";

/** File name of the colour icon the section header and sidenav both register. */
export const PANE_ICON_FILE = "icon-20-color.svg";

/** The `COL_*` dataKeys in src/modules/citationColumn.ts. */
export const COLUMN_DATA_KEYS = [
  "citegeist-citation-count",
  "citegeist-fwci",
  "citegeist-percentile",
  "citegeist-citedness-2yr",
  "citegeist-journal-hindex",
  "citegeist-utd24",
  "citegeist-ft50",
  "citegeist-abdc",
  "citegeist-ajg",
] as const;

export const CITATIONS_COLUMN_DATA_KEY = "citegeist-citation-count";

/** l10nIDs of the item context-menu entries registered through Zotero.MenuManager. */
export const ITEM_MENU_L10N_IDS = [
  "citegeist-menu-fetch",
  "citegeist-menu-citing",
  "citegeist-menu-refs",
  "citegeist-menu-resolve-authors",
] as const;

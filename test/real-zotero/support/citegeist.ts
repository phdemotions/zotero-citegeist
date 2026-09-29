/**
 * Identifiers Citegeist registers with Zotero, for the specs running inside it.
 *
 * They are module-private in src/, so they are mirrored here instead of
 * imported: importing citationPane.ts or menu.ts would bundle plugin code into
 * the spec window. test/realZoteroHarness.test.ts reads src/ and fails if any
 * of these drift from the source.
 */
import pkg from "../../../package.json";
import { CACHE_SCHEMA_MAJOR } from "../../../src/constants";

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

/** The Debug Output line `onStartup` in src/hooks.ts writes once startup has finished. */
export const STARTUP_COMPLETE_DEBUG_LINE = "[Citegeist] Startup complete";

/** The Debug Output line `onShutdown` in src/hooks.ts writes after the cache has closed. */
export const SHUTDOWN_COMPLETE_DEBUG_LINE = "[Citegeist] Shutdown complete";

/** How `logError` in src/modules/utils.ts starts the Debug Output line for every Citegeist failure. */
export const ERROR_DEBUG_MARK = "[Citegeist] ERROR";

/**
 * The one ERROR line a startup on a database stamped one schema major ahead
 * logs: CG-DB03 from `openReadOnly` in src/modules/cache/db.ts. Spec 91 allows
 * exactly this line; test/cache.test.ts checks it against what init really logs.
 */
export const READ_ONLY_STARTUP_ERROR = new RegExp(
  `\\[Citegeist\\] ERROR cache schema check: schema major ${CACHE_SCHEMA_MAJOR + 1}; ` +
    `this build writes schema major ${CACHE_SCHEMA_MAJOR}; cache writes disabled`,
);

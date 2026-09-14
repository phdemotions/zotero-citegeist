/**
 * Environment variables the real-Zotero workflow sets. scaffold spawns Zotero
 * with its own environment, so specs read them inside Zotero with
 * `Services.env.get`.
 */

/** Directory the root after hook writes Debug Output, Zotero's errors and console problems to. */
export const LOG_DIR_ENV = "CITEGEIST_REAL_ZOTERO_LOG_DIR";

/**
 * The Zotero version a pull-request matrix cell pinned. When set, the activation
 * spec requires `Zotero.version` to equal it. A scheduled watch that runs beta
 * and dev builds leaves it unset.
 */
export const EXPECTED_ZOTERO_VERSION_ENV = "CITEGEIST_EXPECT_ZOTERO_VERSION";

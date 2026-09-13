/**
 * Citegeist's preferences: the one module that reads or writes them.
 *
 * Every `PREF_*` constant is a full pref name (`extensions.zotero.citegeist.*`),
 * the name `addon/prefs.js` gives its defaults and the settings pane binds.
 * `Zotero.Prefs.get` and `.set` prepend `extensions.zotero.` unless their
 * `global` argument is true, so a call without it reaches
 * `extensions.zotero.extensions.zotero.citegeist.*` instead. Every earlier build
 * called them that way: the settings pane and the `prefs.js` defaults were never
 * read, and the flags Citegeist wrote for itself landed under that doubled name.
 *
 * Those flags still matter. A profile that migrated its Extra fields in v2.0.x
 * has `migrationV1Complete` only under the doubled name, and ignoring it would
 * run the migration again. {@link getPref} therefore falls back to the doubled
 * name for the flags in {@link LEGACY_DOUBLED_PREFS} and copies the value to the
 * real name. It leaves the doubled key in place: a downgraded copy reads only
 * that name, and without it v2.0.5 would run its migration again and strip the
 * `Citegeist match ID:` lines that carry confirmed matches through Zotero sync.
 *
 * `test/prefs-invariants.test.ts` fails if any other src/ module touches
 * `Zotero.Prefs` or `Services.prefs`.
 */

import {
  DEFAULT_CACHE_LIFETIME_DAYS,
  DEFAULT_NETWORK_PAGE_SIZE,
  NETWORK_PAGE_SIZE_MAX,
  PREF_AUTHOR_RELATIONS_PURGED,
  PREF_AUTO_FETCH,
  PREF_CACHE_LIFETIME_DAYS,
  PREF_LAST_BACKUP_PATH,
  type PREF_LAST_ORPHAN_GC_AT,
  PREF_MIGRATION_COMPLETE,
  PREF_NETWORK_PAGE_SIZE,
  PREF_OPENALEX_API_KEY,
  type PREF_OPENALEX_BASE_URL,
} from "../constants";
import { logError } from "./utils";

/** A Citegeist pref, by the full name its constant holds. */
export type CitegeistPref =
  | typeof PREF_AUTHOR_RELATIONS_PURGED
  | typeof PREF_AUTO_FETCH
  | typeof PREF_CACHE_LIFETIME_DAYS
  | typeof PREF_LAST_BACKUP_PATH
  | typeof PREF_LAST_ORPHAN_GC_AT
  | typeof PREF_MIGRATION_COMPLETE
  | typeof PREF_NETWORK_PAGE_SIZE
  | typeof PREF_OPENALEX_API_KEY
  | typeof PREF_OPENALEX_BASE_URL;

/** What a Zotero pref holds: a boolean, a string or a 32-bit integer. */
export type PrefValue = boolean | string | number;

/** Zotero's `ZOTERO_CONFIG.PREF_BRANCH`, which `Zotero.Prefs` prepends to a name read without `global`. */
export const ZOTERO_PREF_BRANCH = "extensions.zotero.";

/**
 * Internal flags earlier builds stored under the doubled name, which
 * {@link getPref} still honours. The settings pane always wrote the user-facing
 * settings under their real names, so those have no legacy value to find.
 *
 * {@link PREF_LAST_ORPHAN_GC_AT} is left out on purpose. Earlier builds stored
 * `Date.now()` in it, and an integer pref holds 32 bits, so what they stored is
 * a wrapped number unrelated to the time. Copying it forward would also create
 * the real name as an integer pref, which would wrap every later write.
 */
export const LEGACY_DOUBLED_PREFS: ReadonlySet<CitegeistPref> = new Set<CitegeistPref>([
  PREF_MIGRATION_COMPLETE,
  PREF_LAST_BACKUP_PATH,
  PREF_AUTHOR_RELATIONS_PURGED,
]);

/**
 * Read a pref under its real name: the user's value, else the `prefs.js`
 * default, else `undefined`. A flag in {@link LEGACY_DOUBLED_PREFS} that is
 * unset under its real name is answered from the doubled name and copied to the
 * real one. Throws when Zotero cannot read the pref, as `Zotero.Prefs.get` does.
 */
export function getPref(name: CitegeistPref): PrefValue | undefined {
  const value = Zotero.Prefs.get(name, true) as PrefValue | undefined;
  if (value !== undefined || !LEGACY_DOUBLED_PREFS.has(name)) return value;

  const legacy = Zotero.Prefs.get(ZOTERO_PREF_BRANCH + name, true) as PrefValue | undefined;
  if (legacy === undefined) return undefined;
  try {
    Zotero.Prefs.set(name, legacy, true);
  } catch (e) {
    // The legacy value still answers this read, and the next read tries the copy again.
    logError(`copy legacy pref forward: ${name} (non-fatal)`, e);
  }
  return legacy;
}

/** Write a pref under its real name. Throws when Zotero cannot save it, e.g. on a locked profile. */
export function setPref(name: CitegeistPref, value: PrefValue): void {
  Zotero.Prefs.set(name, value, true);
}

/** Whether the item-tree columns fetch missing or stale metrics on their own. Off unless the pref is `true`. */
export function isAutoFetchEnabled(): boolean {
  return getPref(PREF_AUTO_FETCH) === true;
}

/** The opt-in OpenAlex API key, trimmed; empty when none is set. */
export function getOpenAlexApiKey(): string {
  const key = getPref(PREF_OPENALEX_API_KEY);
  return typeof key === "string" ? key.trim() : "";
}

/** Days before cached metrics go stale: {@link DEFAULT_CACHE_LIFETIME_DAYS} unless the pref is a positive number. */
export function getCacheLifetimeDays(): number {
  const days = getPref(PREF_CACHE_LIFETIME_DAYS);
  return typeof days === "number" && Number.isFinite(days) && days > 0
    ? days
    : DEFAULT_CACHE_LIFETIME_DAYS;
}

/**
 * Results per citation-browser page: {@link DEFAULT_NETWORK_PAGE_SIZE} unless
 * the pref is a positive integer, and never more than {@link NETWORK_PAGE_SIZE_MAX}.
 */
export function getNetworkPageSize(): number {
  const size = getPref(PREF_NETWORK_PAGE_SIZE);
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1) {
    return DEFAULT_NETWORK_PAGE_SIZE;
  }
  return Math.min(size, NETWORK_PAGE_SIZE_MAX);
}

/**
 * A millisecond timestamp stored as {@link timestampPrefValue}, or 0 when the
 * pref is unset or holds anything else. An integer pref holds 32 bits and
 * `Date.now()` needs 41, so timestamps are stored as decimal strings; a number
 * here was wrapped on the way in and says nothing about when it was written.
 */
export function getTimestampPref(name: CitegeistPref): number {
  const raw = getPref(name);
  return typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : 0;
}

/** The stored form of a millisecond timestamp; see {@link getTimestampPref}. */
export function timestampPrefValue(ms: number): string {
  return String(Math.trunc(ms));
}

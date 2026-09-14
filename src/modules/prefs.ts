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
 * Those flags still matter, in both directions. A profile that migrated its
 * Extra fields in v2.0.x has `migrationV1Complete` only under the doubled name,
 * so {@link getPref} falls back to that name for the flags in
 * {@link LEGACY_DOUBLED_PREFS}. A downgraded copy reads only the doubled name, so
 * this module never removes a doubled key, and {@link setPref} keeps one current
 * for the flags in {@link DOWNGRADE_COPY_PREFS}.
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

/**
 * A pref that holds a millisecond timestamp. Only {@link setTimestampPref}
 * writes one, so it is always stored in the form {@link getTimestampPref} reads
 * back exactly.
 */
export type TimestampPref = typeof PREF_LAST_ORPHAN_GC_AT;

/** Every other Citegeist pref, which {@link setPref} writes as given. */
export type PlainPref = Exclude<CitegeistPref, TimestampPref>;

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
 * Flags {@link setPref} also writes under the doubled name, for a downgraded
 * copy. Write-only: {@link getPref} prefers the real name, which is always set
 * alongside.
 *
 * v2.0.5 reads `migrationV1Complete` only under the doubled name. A profile that
 * first migrates in this build would have no flag there, so a downgrade to
 * v2.0.5 would run its migration again and strip the `Citegeist match ID:`
 * lines that carry confirmed matches through Zotero sync.
 */
const DOWNGRADE_COPY_PREFS: ReadonlySet<PlainPref> = new Set<PlainPref>([PREF_MIGRATION_COMPLETE]);

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

/**
 * Write a pref under its real name, and a flag in {@link DOWNGRADE_COPY_PREFS}
 * under the doubled name too. Throws when Zotero cannot save the real name, e.g.
 * on a locked profile. A copy that fails is logged and does not throw, since
 * this build never reads it. A timestamp goes through {@link setTimestampPref}.
 */
export function setPref(name: PlainPref, value: PrefValue): void {
  Zotero.Prefs.set(name, value, true);
  if (!DOWNGRADE_COPY_PREFS.has(name)) return;
  try {
    Zotero.Prefs.set(ZOTERO_PREF_BRANCH + name, value, true);
  } catch (e) {
    logError(`write downgrade copy of pref: ${name} (non-fatal)`, e);
  }
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
 * The millisecond timestamp {@link setTimestampPref} stored, or 0 ("never").
 *
 * An integer pref holds 32 bits and `Date.now()` needs 41, so a timestamp is
 * stored as a decimal string, and a number found here was wrapped on the way in.
 * A time later than now also reads as never: a clock that was once set ahead, or
 * a hand edit of `prefs.js`, would otherwise hold off whatever the timestamp
 * gates for as long as the error lasts.
 */
export function getTimestampPref(name: TimestampPref): number {
  const raw = getPref(name);
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return 0;
  const ms = Number(raw);
  return Number.isSafeInteger(ms) && ms <= Date.now() ? ms : 0;
}

/** Store a millisecond timestamp that {@link getTimestampPref} reads back exactly. Throws as {@link setPref} does. */
export function setTimestampPref(name: TimestampPref, ms: number): void {
  const stored = encodeTimestamp(ms);
  Zotero.Prefs.set(name, stored, true);
}

/** A timestamp as a decimal string: a string pref holds all of it, where an integer pref would wrap. */
function encodeTimestamp(ms: number): string {
  return String(Math.trunc(ms));
}

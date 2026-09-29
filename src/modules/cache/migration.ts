/**
 * The one-time import of confirmed title matches from Extra, and orphan-row
 * garbage collection.
 *
 * Through v1.3.x Citegeist kept what it cached about a paper in the item's
 * Extra field, as `Citegeist.<key>: <value>` lines. v2.0.0 moved the cache into
 * citegeist.sqlite and shipped a migration to copy those lines into it and strip
 * them from Extra, but that migration never ran: it handed its loop to
 * `Zotero.Sync.Runner.delaySync`, which takes milliseconds and never calls a
 * function (BUG-MIGRATION in docs/ISSUES.md). No item was changed.
 *
 * What replaces it only reads. It copies into the cache the one thing in Extra
 * that can't be fetched again, the OpenAlex work the user confirmed as an item's
 * title match, and writes nothing to any item. The metrics beside it are months
 * old and free to fetch again, so they stay where they are. Taking the old lines
 * out of Extra, a synced field the v2.0.0 rewrite never touched on a real
 * library, is left to a command the user starts.
 *
 * Both pieces walk every library at startup and are data hygiene rather than the
 * runtime read/write API, so they live here together.
 */

import {
  ORPHAN_GC_CHUNK_SIZE,
  ORPHAN_GC_MIN_INTERVAL_MS,
  PREF_EXTRA_MATCH_IMPORT_COMPLETE,
  PREF_LAST_ORPHAN_GC_AT,
  PREF_MIGRATION_COMPLETE,
} from "../../constants";
import {
  getPref,
  getTimestampPref,
  setPref,
  setTimestampPref,
  type PlainPref,
  type PrefValue,
  type TimestampPref,
} from "../prefs";
import { CacheWriteRefusedError, logError, normalizeError } from "../utils";
import {
  cacheWriteRefusalCode,
  deleteMirrorEntries,
  mirrorSnapshot,
  mutateRow,
  requireWritableDb,
  runWrite,
  skipMaintenanceOnReadOnlyCache,
} from "./db";
import { deleteOrphanItemAuthors, deleteUnreferencedAuthors } from "./authors/db";
import {
  CONFIRMED_MATCH_EXTRA_PREFIX,
  emptyRow,
  isMatchTier,
  type ItemCacheRow,
  LEGACY_PREFIX,
  type MatchTier,
  mirrorKey,
  parseWorkId,
  type SqliteBindValue,
} from "./types";

// ── The Citegeist lines in Extra ────────────────────────────────────────────

/**
 * Every key v1.x wrote as a `Citegeist.<key>: <value>` line, after the user's own
 * lines (src/modules/cache.ts at each v1 tag). v1.0.0 to v1.1.2 wrote the first
 * thirteen; v1.2.0 to v1.3.0 added the title-match keys. A `Citegeist.` line with
 * any other key, such as `Citegeist.note: …`, is the user's own text.
 */
const LEGACY_FIELDS = [
  "openAlexId",
  "citedByCount",
  "fwci",
  "percentile",
  "isTop1Percent",
  "isTop10Percent",
  "isRetracted",
  "lastFetched",
  "sourceId",
  "citedness2yr",
  "journalHIndex",
  "sourceISSNs",
  "issnL",
  "noMatch",
  "noMatchTimestamp",
  "matchMethod",
  "matchConfidence",
  "confirmedOpenAlexId",
  "pendingSuggestionId",
  "pendingSuggestionTitle",
  "pendingSuggestionCount",
  "pendingSuggestionFwci",
  "pendingSuggestionYear",
  "pendingSuggestionTier",
  "pendingSuggestionConfidence",
  "pendingSuggestionDoi",
] as const;

type LegacyField = (typeof LEGACY_FIELDS)[number];

function isLegacyField(key: string): key is LegacyField {
  return (LEGACY_FIELDS as readonly string[]).includes(key);
}

/** The Citegeist lines one item's Extra holds. */
interface CitegeistLines {
  /** Each v1.x key present, with every value it was given: a hand edit can repeat a key. */
  readonly legacy: ReadonlyMap<LegacyField, readonly string[]>;
  /** Work ids from `Citegeist match ID: W…` lines, which v2.0.0 and later write on a confirm. */
  readonly matchIds: readonly string[];
}

/**
 * Read the Citegeist lines out of an item's Extra, the way v1.3.x read its own:
 * a line starts at column 0, and its value follows the first `: `. Values are
 * trimmed, and a byte-order mark and CRLF or CR line ends, which an edit on
 * Windows can leave, are normalized first. A `Citegeist match ID:` line whose
 * value is not a work id is the user's own note, the rule `setExtraConfirmedMatch`
 * in write.ts applies too.
 */
function readCitegeistLines(extra: string): CitegeistLines {
  const legacy = new Map<LegacyField, string[]>();
  const matchIds: string[] = [];
  const matchPrefix = `${CONFIRMED_MATCH_EXTRA_PREFIX}:`;
  for (const line of extra.replace(/^﻿/, "").split(/\r\n?|\n/)) {
    if (line.startsWith(matchPrefix)) {
      const id = parseWorkId(line.slice(matchPrefix.length).trim());
      if (id) matchIds.push(id);
      continue;
    }
    if (!line.startsWith(LEGACY_PREFIX)) continue;
    const separator = line.indexOf(": ");
    if (separator < 0) continue;
    const key = line.slice(LEGACY_PREFIX.length, separator);
    if (!isLegacyField(key)) continue;
    const values = legacy.get(key) ?? [];
    values.push(line.slice(separator + 2).trim());
    legacy.set(key, values);
  }
  return { legacy, matchIds };
}

/** What an item's lines say about the work the user confirmed as its title match. */
type LineMatch =
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "confirmed"; readonly workId: string; readonly tier: MatchTier | null };

const distinct = <T>(values: readonly T[]): T[] => [...new Set(values)];

/**
 * The confirmed work, when the lines name exactly one.
 *
 * A `Citegeist match ID:` line wins over v1.x's `Citegeist.confirmedOpenAlexId`.
 * Only v2.0.0 and later write it, when the user confirms a match, so an item
 * carrying both was confirmed again after the v1.x line was written. Lines of one
 * kind that name different works come only from hand edits, and such an item is
 * left for the user rather than resolved by a guess. v1.x's
 * `Citegeist.matchConfidence` describes its own confirmation, so it is kept only
 * for that work.
 */
function confirmedMatch(lines: CitegeistLines): LineMatch {
  const mirrored = distinct(lines.matchIds);
  const legacy = distinct(
    (lines.legacy.get("confirmedOpenAlexId") ?? [])
      .map((value) => parseWorkId(value))
      .filter((id): id is string => id !== null),
  );
  const candidates = mirrored.length > 0 ? mirrored : legacy;
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length > 1) return { kind: "ambiguous" };
  const workId = candidates[0];
  const tiers = distinct((lines.legacy.get("matchConfidence") ?? []).filter(isMatchTier));
  const tier = legacy.length === 1 && legacy[0] === workId && tiers.length === 1 ? tiers[0] : null;
  return { kind: "confirmed", workId, tier };
}

/**
 * The row `existing` becomes with the confirmed match imported, or null to keep
 * it. The import only fills a gap, and never overrides what the cache holds:
 * - no row: a new one holding just the confirmation, with no metrics, so the
 *   next lookup fetches them for the confirmed work;
 * - a confirmation, or a no-match (a title search that found nothing, or the
 *   user's "Not this paper": the row doesn't say which): the user decided since,
 *   or may have, and the row is kept;
 * - metrics for another work: a later lookup resolved the item differently, and
 *   it stands;
 * - otherwise, a pending suggestion or metrics for this same work: the
 *   confirmation is added and any suggestion cleared, as confirming it in the
 *   pane does (write.ts, confirmTitleMatch).
 */
function withImportedMatch(
  existing: ItemCacheRow | undefined,
  libraryID: number,
  itemKey: string,
  workId: string,
  tier: MatchTier | null,
): ItemCacheRow | null {
  if (existing) {
    if (existing.confirmed_open_alex_id !== null || existing.no_match === 1) return null;
    if (existing.open_alex_id !== null && existing.open_alex_id !== workId) return null;
  }
  return {
    ...(existing ?? emptyRow(libraryID, itemKey)),
    confirmed_open_alex_id: workId,
    match_method: "title-match",
    match_confidence: tier,
    no_match: null,
    no_match_timestamp: null,
    pending_open_alex_id: null,
    pending_title: null,
    pending_cited_by_count: null,
    pending_fwci: null,
    pending_year: null,
    pending_tier: null,
    pending_confidence: null,
    pending_doi: null,
  };
}

// ── The import ──────────────────────────────────────────────────────────────

/** Debug Output line a pass writes when it starts (test/real-zotero/93-legacy-migration.spec.ts). */
const MIGRATION_STARTED = "[Citegeist] migration started";
/** Debug Output line a pass writes when it has read every library (specs 92 and 93). */
const MIGRATION_COMPLETE = "[Citegeist] migration complete";

/**
 * `Zotero.Library.waitForDataLoad`, which typings/zotero.d.ts does not declare.
 * It loads the data of every item in the library unless Zotero already has
 * (library.js 7.0.10 line 397, 8.0.4 line 399, 9.0.6 line 407, 10.0.2 line 434).
 */
interface ItemDataLoader {
  waitForDataLoad(objectType: "item"): Promise<void>;
}

/** What a pass saw, for its Debug Output summary. */
interface PassCounts {
  /** Regular items read. */
  items: number;
  /** Items whose Extra carries a v1.x line or a `Citegeist match ID:` line. */
  withLines: number;
  /** Confirmations copied into the cache. */
  imported: number;
  /** Items whose cache row stayed as it was (see withImportedMatch). */
  kept: number;
  /** Items whose lines name two different works. */
  ambiguous: number;
  /** Items Zotero could not read. */
  unreadable: number;
}

/**
 * How a pass ended. Only `complete` sets the flag. A pass that stopped because
 * the cache closed under it (Citegeist disabled or Zotero quitting during
 * startup), or after a failure, runs again from the start at the next launch.
 */
type PassEnd = "complete" | "cache-closed" | "failed";

/**
 * Import the title matches users confirmed under v1.3.x and v2.x, once per
 * profile. Nothing in the user's library changes: see this module's header.
 *
 * The first pass that reads every library, including one that finds nothing to
 * import, sets {@link PREF_EXTRA_MATCH_IMPORT_COMPLETE}, and no later launch
 * scans again. A pass that stops early leaves it unset, and the next launch
 * runs the whole pass again, which is safe because the import is idempotent: a
 * match an earlier pass imported is a confirmation the next pass keeps.
 *
 * {@link PREF_MIGRATION_COMPLETE}, which every v2.0.x profile holds because the
 * v2.0.0 migration set it without running, no longer decides anything. A
 * finished pass sets it as well, under its real and its doubled name (prefs.ts,
 * DOWNGRADE_COPY_PREFS), so a copy downgraded to v2.0.x starts no migration of
 * its own.
 *
 * Resolves false, since there is nothing to tell the user: the caller's one-time
 * notice announced a v2.0.0 migration that changed Extra. Throws only CG-DB02,
 * on a closed cache (a caller that didn't await initCache, or a shutdown during
 * startup), before it reads a pref or an item. Every other failure is logged and
 * left for the next launch.
 */
export async function migrateFromExtraV1(): Promise<false> {
  // A read-only cache (CG-DB03/CG-DB04) can't take the import; a later launch
  // that opens the cache writable runs it.
  if (skipMaintenanceOnReadOnlyCache("migrateFromExtraV1")) return false;
  requireWritableDb("migrateFromExtraV1");

  try {
    if (getPref(PREF_EXTRA_MATCH_IMPORT_COMPLETE) === true) return false;
    Zotero.debug(
      `${MIGRATION_STARTED}: importing confirmed title matches from Extra, which is not changed`,
    );
    const counts: PassCounts = {
      items: 0,
      withLines: 0,
      imported: 0,
      kept: 0,
      ambiguous: 0,
      unreadable: 0,
    };
    const end = await withSyncHeld(() => importMatches(counts));
    if (end !== "complete") {
      const why = end === "cache-closed" ? "the cache closed" : "a failure, logged above";
      Zotero.debug(
        `[Citegeist] migration stopped by ${why}: matches imported ${counts.imported}; ` +
          `the next launch runs it again`,
      );
      return false;
    }
    trySetPref(PREF_MIGRATION_COMPLETE, true);
    trySetPref(PREF_EXTRA_MATCH_IMPORT_COMPLETE, true);
    Zotero.debug(
      `${MIGRATION_COMPLETE}: items read ${counts.items}, with Citegeist lines ${counts.withLines}, ` +
        `matches imported ${counts.imported}, kept as cached ${counts.kept}, ` +
        `naming two works ${counts.ambiguous}, unreadable ${counts.unreadable}; Extra unchanged`,
    );
  } catch (e) {
    logError("migration", e);
  }
  return false;
}

/**
 * Run `pass` while Zotero holds every sync that starts, so no download changes
 * the libraries it reads. `delayIndefinite` returns the function that lets them
 * go (syncRunner.js 7.0.10 lines 1045-1052, 8.0.4 lines 1047-1052, 9.0.6 lines
 * 1076-1081, 10.0.2 lines 1091-1096), and a held sync waits before it contacts
 * the server (10.0.2 lines 167-171). A sync already past that wait runs on,
 * which the import tolerates because it never writes an item. `delaySync` is not
 * this API: it takes milliseconds and never calls a function (10.0.2 lines
 * 1081-1083), which is why the v2.0.0 migration never ran.
 */
async function withSyncHeld<T>(pass: () => Promise<T>): Promise<T> {
  const release = Zotero.Sync.Runner.delayIndefinite();
  try {
    return await pass();
  } finally {
    release();
  }
}

/**
 * One pass over every library but feeds, which Citegeist never wrote to. A library
 * that fails to load leaves the pass incomplete and the others are still read, so
 * what can be imported now is. Once the cache stops taking writes (Citegeist
 * disabled, or Zotero quitting, during startup), the pass stops before the next
 * library or item, so it loads no more data and lets sync go at once.
 */
async function importMatches(counts: PassCounts): Promise<PassEnd> {
  let failed = false;
  for (const library of Zotero.Libraries.getAll()) {
    if (library.libraryType === "feed") continue;
    if (cacheWriteRefusalCode() !== null) return "cache-closed";
    let items: _ZoteroTypes.Item[];
    try {
      // Zotero loads a library's items when it is first shown (zotero.js 10.0.2,
      // lines 760-768); until then getField throws for every one of them.
      await (library as _ZoteroTypes.Library & ItemDataLoader).waitForDataLoad("item");
      items = await Zotero.Items.getAll(library.libraryID, false);
    } catch (e) {
      logError(`migration: read library ${library.libraryID}`, e);
      failed = true;
      continue;
    }
    for (const item of items) {
      if (cacheWriteRefusalCode() !== null) return "cache-closed";
      const end = await importItem(item, counts);
      if (end) return end;
    }
  }
  return failed ? "failed" : "complete";
}

/**
 * Import one item's confirmed match. Resolves a {@link PassEnd} only when the
 * pass has to stop: the cache closed, or a write failed, which the next launch
 * retries. An item that can't be read, or whose lines are ambiguous, is skipped
 * for good: retrying it at every launch would bring back the every-launch scan.
 */
async function importItem(item: _ZoteroTypes.Item, counts: PassCounts): Promise<PassEnd | null> {
  const match = matchOf(item, counts);
  if (match.kind !== "confirmed") return null;
  const libraryID = item.libraryID;
  const itemKey = item.key;
  let imported = false;
  try {
    await mutateRow(libraryID, itemKey, (existing) => {
      const next = withImportedMatch(existing, libraryID, itemKey, match.workId, match.tier);
      imported = next !== null;
      return next;
    });
  } catch (e) {
    // The write gate already logged the refusal once.
    if (e instanceof CacheWriteRefusedError) return "cache-closed";
    logError(`migration: import item ${item.id}`, e);
    return "failed";
  }
  if (imported) counts.imported++;
  else counts.kept++;
  return null;
}

/** Read an item's Extra and count what it holds. Never throws. */
function matchOf(item: _ZoteroTypes.Item, counts: PassCounts): LineMatch {
  let lines: CitegeistLines;
  try {
    if (item.deleted || !item.isRegularItem()) return { kind: "none" };
    counts.items++;
    lines = readCitegeistLines(item.getField("extra") ?? "");
  } catch (e) {
    counts.unreadable++;
    Zotero.debug(
      `[Citegeist] migration: skipped item ${item.libraryID}/${item.key}, which Zotero could not read: ${normalizeError(e)}`,
    );
    return { kind: "none" };
  }
  if (lines.legacy.size === 0 && lines.matchIds.length === 0) return { kind: "none" };
  counts.withLines++;
  const match = confirmedMatch(lines);
  if (match.kind === "ambiguous") {
    counts.ambiguous++;
    Zotero.debug(
      `[Citegeist] migration: item ${item.libraryID}/${item.key} names more than one confirmed work; left for the user`,
    );
  }
  return match;
}

/** A pref write lands in `prefs.js` and can throw on a locked profile. */
function trySetPref(name: PlainPref, value: PrefValue): void {
  try {
    setPref(name, value);
  } catch (e) {
    logError(`Prefs.set('${name}') (non-fatal)`, e);
  }
}

/** {@link trySetPref} for a timestamp, stored in the form that reads back exactly. */
function trySetTimestampPref(name: TimestampPref, ms: number): void {
  try {
    setTimestampPref(name, ms);
  } catch (e) {
    logError(`Prefs.set('${name}') (non-fatal)`, e);
  }
}

// ── Orphan garbage collection ───────────────────────────────────────────────

/**
 * Remove SQLite rows whose `item_key` no longer exists in *any* library
 * the user has access to (personal + group libraries). Rate-limited via
 * `ORPHAN_GC_MIN_INTERVAL_MS`; pass `{ force: true }` to bypass the gate.
 *
 * Queries every library because the runtime write path is library-agnostic
 * — group-library items get SQLite rows too, and we must not purge them.
 */
export async function garbageCollectOrphans(options: { force?: boolean } = {}): Promise<void> {
  if (skipMaintenanceOnReadOnlyCache("garbageCollectOrphans")) return;
  const lastRun = getTimestampPref(PREF_LAST_ORPHAN_GC_AT);
  if (!options.force && Date.now() - lastRun < ORPHAN_GC_MIN_INTERVAL_MS) return;

  const writable = requireWritableDb("garbageCollectOrphans");

  // Build the live key set as (libraryID, itemKey) tuples so we don't
  // mistake a same-named key in a different library for an orphan.
  const liveComposites = new Set<string>();
  for (const lib of Zotero.Libraries.getAll()) {
    const items = await Zotero.Items.getAll(lib.libraryID, false);
    for (const i of items) liveComposites.add(mirrorKey(i.libraryID, i.key));
  }

  // Snapshot the mirror before iterating. Concurrent writes during GC could
  // otherwise yield entries that didn't exist when `liveComposites` was
  // built, leading to spurious orphan detection.
  //
  // ADV-002 guard: rows carrying user-curated state (confirmed_open_alex_id
  // OR no_match=1) are NEVER deleted, even if their item appears absent
  // from `liveComposites`. Zotero.Items.getAll excludes trashed items by
  // default, so an item trashed-then-restored more than ORPHAN_GC_MIN_INTERVAL_MS
  // later would otherwise lose its curation. Refetchable metrics get
  // re-fetched cheaply; user decisions cannot be re-derived.
  const orphans: Array<{ libraryID: number; itemKey: string; composite: string }> = [];
  for (const [composite, row] of mirrorSnapshot()) {
    if (liveComposites.has(composite)) continue;
    if (row.confirmed_open_alex_id !== null) continue;
    if (row.no_match === 1) continue;
    orphans.push({ libraryID: row.library_id, itemKey: row.item_key, composite });
  }

  if (orphans.length === 0) {
    trySetTimestampPref(PREF_LAST_ORPHAN_GC_AT, Date.now());
    return;
  }

  for (let i = 0; i < orphans.length; i += ORPHAN_GC_CHUNK_SIZE) {
    const slice = orphans.slice(i, i + ORPHAN_GC_CHUNK_SIZE);
    // Two-param `WHERE (library_id, item_key) IN ((?,?), (?,?), …)` is the
    // canonical SQLite shape for composite key lookups.
    const tuplePlaceholders = slice.map(() => "(?, ?)").join(",");
    const params: SqliteBindValue[] = [];
    for (const o of slice) {
      params.push(o.libraryID, o.itemKey);
    }
    // One transaction per chunk: the chunk's rows leave all three tables
    // together, and the mirror follows only once they have committed.
    await writable.transaction(async (tx) => {
      await runWrite(
        tx,
        `DELETE FROM item_cache WHERE (library_id, item_key) IN (${tuplePlaceholders})`,
        params,
      );
      await runWrite(
        tx,
        `DELETE FROM migration_progress WHERE (library_id, item_key) IN (${tuplePlaceholders})`,
        params,
      );
      await deleteOrphanItemAuthors(tx, slice);
    });
    deleteMirrorEntries(slice.map((o) => o.composite));
  }
  // Then any author no item_authors row references any more.
  await writable.transaction((tx) => deleteUnreferencedAuthors(tx));
  trySetTimestampPref(PREF_LAST_ORPHAN_GC_AT, Date.now());
  Zotero.debug(`[Citegeist] orphan GC removed ${orphans.length} rows`);
}

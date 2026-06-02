/**
 * Public write API.
 *
 * All async. Writes go to SQLite first, then update the in-memory mirror.
 * The only side-effect outside the cache file is `writeConfirmedMatchToExtra`,
 * which mirrors a single user-curated field (the OpenAlex ID of a confirmed
 * title match) back to the item's Extra under a non-`Citegeist.` prefix.
 */

import {
  type CacheItemKey,
  type CachePendingSuggestionInput,
  type CacheSourceStatsInput,
  type CacheWorkInput,
  CONFIRMED_MATCH_EXTRA_PREFIX,
  emptyRow,
  type ItemCacheRow,
  type DbBool,
  type MatchTier,
  parseSourceId,
  parseWorkId,
  toDbBool,
} from "./types";
import { deleteRow, mutateRow } from "./db";
import { isMigrationInProgress } from "./migration";

/** Pending-suggestion fields cleared together on confirm/dismiss. */
const PENDING_CLEARED = {
  pending_open_alex_id: null,
  pending_title: null,
  pending_cited_by_count: null,
  pending_fwci: null,
  pending_year: null,
  pending_tier: null,
  pending_confidence: null,
  pending_doi: null,
} as const satisfies Partial<ItemCacheRow>;

/**
 * Coerce an untrusted numeric to a finite value or null. Rejects NaN and
 * ±Infinity — these would round-trip to SQLite as text-`NaN`/`Infinity`
 * (REAL affinity is forgiving) and then poison every downstream comparison.
 * A null is honest about the absence.
 */
function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Same as `finiteOrNull` but also requires the value to be a non-negative integer. */
function nonNegIntOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && Number.isInteger(v) ? v : null;
}

/**
 * Pure helper deriving the four citation-derived metric fields from an
 * OpenAlex work. Works with zero citations have no metrics — that invariant
 * lives in one place so future writers can't accidentally diverge.
 */
function deriveCitationMetrics(work: CacheWorkInput): {
  fwci: number | null;
  percentile: number | null;
  isTop1Percent: DbBool;
  isTop10Percent: DbBool;
} {
  if (work.cited_by_count <= 0) {
    return { fwci: null, percentile: null, isTop1Percent: null, isTop10Percent: null };
  }
  const cnp = work.citation_normalized_percentile;
  return {
    fwci: finiteOrNull(work.fwci),
    percentile: cnp ? finiteOrNull(cnp.value * 100) : null,
    isTop1Percent: cnp ? (cnp.is_in_top_1_percent ? 1 : 0) : null,
    isTop10Percent: cnp ? (cnp.is_in_top_10_percent ? 1 : 0) : null,
  };
}

export async function cacheWorkData(
  item: CacheItemKey,
  work: CacheWorkInput,
  sourceStats: CacheSourceStatsInput | null,
): Promise<void> {
  // Validate IDs at the trust boundary. A malformed value would otherwise
  // flow into Zotero's Extra field via writeConfirmedMatchToExtra and could
  // spoof CSL metadata read by other plugins.
  const openAlexId = parseWorkId(work.id);
  if (!openAlexId) {
    Zotero.debug(
      `[Citegeist] cacheWorkData rejecting malformed work ID: ${JSON.stringify(work.id)}`,
    );
    return;
  }
  const sourceId = parseSourceId(work.primary_location?.source?.id);
  const metrics = deriveCitationMetrics(work);
  // Snapshot libraryID at call time so a concurrent cross-library move
  // can't split the SQLite write and any downstream Extra write across
  // two libraries.
  const libraryID = item.libraryID;
  const itemKey = item.key;

  await mutateRow(libraryID, itemKey, (existing) => {
    const base = existing ?? emptyRow(libraryID, itemKey);
    return {
      ...base,
      open_alex_id: openAlexId,
      cited_by_count: nonNegIntOrNull(work.cited_by_count),
      fwci: metrics.fwci,
      percentile: metrics.percentile,
      is_top_1_percent: metrics.isTop1Percent,
      is_top_10_percent: metrics.isTop10Percent,
      is_retracted: toDbBool(work.is_retracted),
      last_fetched: new Date().toISOString(),
      source_id: sourceId,
      citedness_2yr: sourceStats ? finiteOrNull(sourceStats.citedness2yr) : base.citedness_2yr,
      journal_h_index: sourceStats ? nonNegIntOrNull(sourceStats.hIndex) : base.journal_h_index,
      source_issns:
        sourceStats && sourceStats.issns.length > 0
          ? [...sourceStats.issns].join(",")
          : base.source_issns,
      issn_l: work.primary_location?.source?.issn_l ?? base.issn_l,
    };
  });
}

/**
 * Clear all Citegeist-managed data for an item.
 *
 * Wide semantics (preserved from v1.3.0): removes work data, match meta,
 * AND pending suggestion in one call. `citationPane.ts` depends on this
 * coupling — don't narrow the semantics without auditing pane refresh paths.
 *
 * Also strips the `Citegeist match ID: Wxxx` mirror line from the item's
 * Extra field if present. Without this, a refresh after a user-confirmed
 * title match would leave SQLite saying "no confirmation" while Extra still
 * claimed one — a future migration / SQLite-loss recovery would resurrect
 * the confirmation the user intentionally cleared. Plain-typed callers
 * (just `{ libraryID, key }`) skip the Extra strip; only callers that pass
 * a full `_ZoteroTypes.Item` get the mirror cleanup.
 */
export async function clearCache(item: CacheItemKey | _ZoteroTypes.Item): Promise<void> {
  await deleteRow(item.libraryID, item.key);
  // Detect whether the caller passed a full Item (with getField/saveTx) vs.
  // just the structural { libraryID, key } shape used by tests + internal code.
  const maybeFull = item as Partial<_ZoteroTypes.Item>;
  if (typeof maybeFull.getField === "function" && typeof maybeFull.saveTx === "function") {
    const fullItem = item as _ZoteroTypes.Item;
    const extra = fullItem.getField("extra") ?? "";
    if (extra.includes(CONFIRMED_MATCH_EXTRA_PREFIX)) {
      const stripped = setExtraConfirmedMatch(extra.split("\n"), null)
        .join("\n")
        .replace(/\n+$/, "");
      if (stripped !== extra) {
        fullItem.setField("extra", stripped);
        await fullItem.saveTx();
      }
    }
  }
}

export async function writeNoMatch(item: CacheItemKey): Promise<void> {
  const libraryID = item.libraryID;
  const itemKey = item.key;
  await mutateRow(libraryID, itemKey, (existing) => ({
    ...(existing ?? emptyRow(libraryID, itemKey)),
    no_match: 1,
    no_match_timestamp: new Date().toISOString(),
  }));
}

/**
 * Atomic "user dismissed this suggestion" write. Clears the pending block
 * AND sets no_match=1 in a single mutateRow so a concurrent runtime fetch
 * cannot interleave between them and produce a row carrying both real
 * work data AND no_match=1 (internally contradictory state).
 */
export async function dismissAsNoMatch(item: CacheItemKey): Promise<void> {
  const libraryID = item.libraryID;
  const itemKey = item.key;
  await mutateRow(libraryID, itemKey, (existing) => ({
    ...(existing ?? emptyRow(libraryID, itemKey)),
    ...PENDING_CLEARED,
    no_match: 1,
    no_match_timestamp: new Date().toISOString(),
  }));
}

/**
 * Confirm a title match: mark matchMethod/Confidence and store confirmedOpenAlexId
 * so future fetches go directly to the work by ID, bypassing title search.
 *
 * The confirmed ID is also mirrored to the Zotero Extra field under
 * `Citegeist match ID: W…` so that:
 *   • The match survives plugin downgrade to v1.3.x.
 *   • Across-device users see their confirmation respected (Extra syncs).
 *
 * Caller invariant: there must be either a pending suggestion or an
 * already-cached OpenAlex ID. If neither exists this is a caller bug — we
 * log and no-op rather than persist a malformed row.
 */
export async function confirmTitleMatch(item: _ZoteroTypes.Item, tier: MatchTier): Promise<void> {
  // Snapshot libraryID + key at call time so a concurrent cross-library
  // move can't split the SQLite write and the Extra mirror across libraries.
  const libraryID = item.libraryID;
  const itemKey = item.key;
  let confirmedId: string | null = null;

  await mutateRow(libraryID, itemKey, (existing) => {
    const base = existing ?? emptyRow(libraryID, itemKey);
    const pendingId = base.pending_open_alex_id ?? base.open_alex_id;
    if (!pendingId) {
      Zotero.debug(
        `[Citegeist] confirmTitleMatch on ${itemKey} with no pending or existing ID — ignored`,
      );
      return null;
    }
    // Guard against silent overwrite of a prior user-confirmed match.
    // A pending suggestion arriving after a confirmation may legitimately
    // replace it (e.g. user fixed a typo), but it should be a deliberate
    // user action — refuse the implicit overwrite and let the caller
    // explicitly clear the pending or re-confirm with intent.
    if (
      base.confirmed_open_alex_id &&
      base.pending_open_alex_id &&
      base.confirmed_open_alex_id !== base.pending_open_alex_id
    ) {
      Zotero.debug(
        `[Citegeist] confirmTitleMatch on ${itemKey} would overwrite confirmed ` +
          `${base.confirmed_open_alex_id} with pending ${base.pending_open_alex_id} — ignored. ` +
          `Caller must clearPendingSuggestion first to acknowledge the replacement.`,
      );
      return null;
    }
    confirmedId = pendingId;
    return {
      ...base,
      no_match: null,
      no_match_timestamp: null,
      match_method: "title-match",
      match_confidence: tier,
      confirmed_open_alex_id: pendingId,
      ...PENDING_CLEARED,
    };
  });

  if (confirmedId) {
    await writeConfirmedMatchToExtra(item, confirmedId);
  }
}

export async function writePendingSuggestion(
  item: CacheItemKey,
  work: CachePendingSuggestionInput,
  tier: MatchTier,
  confidence: number,
): Promise<void> {
  const pendingId = parseWorkId(work.id);
  if (!pendingId) {
    Zotero.debug(
      `[Citegeist] writePendingSuggestion rejecting malformed work ID: ${JSON.stringify(work.id)}`,
    );
    return;
  }
  const libraryID = item.libraryID;
  const itemKey = item.key;
  await mutateRow(libraryID, itemKey, (existing) => ({
    ...(existing ?? emptyRow(libraryID, itemKey)),
    pending_open_alex_id: pendingId,
    pending_title: sanitizeForDisplay(work.display_name),
    pending_cited_by_count: nonNegIntOrNull(work.cited_by_count),
    pending_fwci: finiteOrNull(work.fwci),
    pending_year: nonNegIntOrNull(work.publication_year),
    pending_tier: tier,
    pending_confidence: finiteOrNull(confidence),
    pending_doi: work.doi ? sanitizeForDisplay(work.doi) : null,
  }));
}

export async function clearPendingSuggestion(item: CacheItemKey): Promise<void> {
  await mutateRow(item.libraryID, item.key, (existing) =>
    existing ? { ...existing, ...PENDING_CLEARED } : null,
  );
}

// ── Extra-field downgrade mirror ───────────────────────────────────────────

/**
 * Returns a copy of `lines` with any existing `Citegeist match ID:` line
 * removed and `openAlexId` (if non-null) appended as a fresh entry.
 *
 * Pure — no side effects. Shared by the runtime confirm-match path and the
 * one-shot legacy migration, both of which need the same line-rewrite rule.
 */
export function setExtraConfirmedMatch(lines: string[], openAlexId: string | null): string[] {
  const filtered = lines.filter((l) => !l.startsWith(`${CONFIRMED_MATCH_EXTRA_PREFIX}:`));
  if (openAlexId) filtered.push(`${CONFIRMED_MATCH_EXTRA_PREFIX}: ${openAlexId}`);
  return filtered;
}

/**
 * Write the confirmed OpenAlex match ID back to the item's Extra field.
 * The only piece of user-curated state we mirror; everything else can be
 * reconstructed from OpenAlex on a fresh device.
 */
async function writeConfirmedMatchToExtra(
  item: _ZoteroTypes.Item,
  openAlexId: string,
): Promise<void> {
  // Defer Extra writes while migration is mid-loop. Without this, the
  // runtime saveTx could race with migration's Step 2 strip and either
  // (a) resurrect legacy `Citegeist.*` lines that migration was about
  // to remove, or (b) clobber a stripped Extra with the pre-strip
  // contents. SQLite still got updated by the caller's `mutateRow`, so
  // the user's confirmation is persisted; the Extra mirror just waits
  // for the next confirmTitleMatch (or skips this round entirely —
  // acceptable, the mirror is only used for downgrade/cross-device).
  if (isMigrationInProgress()) {
    Zotero.debug(
      `[Citegeist] writeConfirmedMatchToExtra deferred while migration is running (item ${item.key})`,
    );
    return;
  }
  // openAlexId is already validated by cacheWorkData / writePendingSuggestion /
  // buildRowFromLegacy at the row's write boundary — no re-check here.
  const extra = item.getField("extra") ?? "";
  const newLines = setExtraConfirmedMatch(extra.split("\n"), openAlexId);
  const cleaned = newLines.join("\n").replace(/\n+$/, "");
  item.setField("extra", cleaned);
  await item.saveTx();
}

/**
 * Strip line-breaking characters that would render badly in UI strings or
 * split into spurious lines if the value ever round-trips through a
 * newline-sensitive sink (Extra field, BibTeX export, log line). Covers
 * ASCII `\r\n` plus Unicode line separators (U+0085, U+2028, U+2029).
 */
function sanitizeForDisplay(s: string): string {
  return s.replace(/[\r\n\u0085\u2028\u2029]/g, " ").trim();
}

/**
 * One-shot migration from legacy Extra-field storage (v1.3.x → v2.0.0)
 * and orphan-row garbage collection.
 *
 * Both pieces live here because:
 *   • Both touch every item in the user library at startup.
 *   • Both are data-hygiene operations — distinct from the runtime
 *     read/write API in `read.ts` and `write.ts`.
 *   • This module can be deleted as a unit when v2.x drops backward-compat
 *     support, without disturbing the runtime cache.
 *
 * The migration's three-step ordering (SQLite write → Extra strip → checkpoint)
 * is the load-bearing crash-safety property. Don't reorder without thinking
 * carefully about what state survives a mid-loop kill.
 */

import {
  MAX_BACKUP_FILES,
  MIGRATION_ITEM_TIMEOUT_MS,
  MIGRATION_PROGRESS_TICK,
  ORPHAN_GC_CHUNK_SIZE,
  ORPHAN_GC_MIN_INTERVAL_MS,
  PREF_LAST_BACKUP_PATH,
  PREF_LAST_ORPHAN_GC_AT,
  PREF_MIGRATION_COMPLETE,
  SHOW_PROGRESS_UI_THRESHOLD,
} from "../../constants";
import { logError, normalizeError, safeParseFloat, safeParseIntOrNull } from "../utils";
import { deleteMirrorEntries, mirrorSnapshot, requireDb, upsertRow } from "./db";
import { setExtraConfirmedMatch } from "./write";
import {
  CONFIRMED_MATCH_EXTRA_PREFIX,
  emptyRow,
  isMatchMethod,
  isMatchTier,
  type ItemCacheRow,
  LEGACY_PREFIX,
  mirrorKey,
  parseSourceId,
  parseWorkId,
  type SqliteBindValue,
} from "./types";

// ── Runtime/migration coordination ────────────────────────────────────────

/**
 * Set to `true` while `migrateFromExtraV1` is running. Runtime write
 * paths that touch the Extra field (currently only
 * `writeConfirmedMatchToExtra`) check this and defer to avoid
 * resurrecting legacy lines that the migration is in the middle of
 * stripping. The flag lives in this module rather than `db.ts` so the
 * migration owns the coordination and removing the legacy parser also
 * removes the flag.
 */
let migrationInProgress = false;
function setMigrationInProgress(v: boolean): void {
  migrationInProgress = v;
}
export function isMigrationInProgress(): boolean {
  return migrationInProgress;
}

// ── Legacy parser ──────────────────────────────────────────────────────────

/**
 * Strict allowlist of v1.3.x Citegeist field names. Lines with a
 * `Citegeist.<key>: …` prefix whose key is NOT in this set are treated as
 * user content (e.g. a researcher who typed `Citegeist.note: still useful`
 * into Extra as a free-form note) and pushed to `otherLines` so they
 * survive migration verbatim. Without this guard, the parser would
 * happily consume any `Citegeist.*` line and the migration's Step-2 strip
 * would silently destroy it.
 */
const KNOWN_LEGACY_FIELDS = new Set([
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
]);

interface LegacyParse {
  citegeistFields: Map<string, string>;
  otherLines: string[];
}

/**
 * Strips a leading BOM and folds CRLF / CR to LF so downstream split/match
 * logic doesn't have to think about either. Callers should always run this
 * before `parseExtraLegacy`; without it, Windows-edited Extra would leave a
 * `\r` on every value, fail every `parseWorkId` validation, and silently
 * null the entire row.
 */
function normalizeExtraForParse(extra: string): string {
  return extra.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/**
 * Parse the legacy `Citegeist.*` namespace out of a normalized Extra field.
 * Values for known keys are `.trim()`'d so a stray space after the colon
 * doesn't fail validators downstream. Lines whose key is not in
 * `KNOWN_LEGACY_FIELDS` are preserved in `otherLines` so user content
 * starting with `Citegeist.` survives migration verbatim.
 */
function parseExtraLegacy(extra: string): LegacyParse {
  const citegeistFields = new Map<string, string>();
  const otherLines: string[] = [];
  if (!extra) return { citegeistFields, otherLines };
  for (const line of extra.split("\n")) {
    if (line.startsWith(LEGACY_PREFIX)) {
      const idx = line.indexOf(": ");
      if (idx > 0) {
        const key = line.substring(LEGACY_PREFIX.length, idx);
        if (KNOWN_LEGACY_FIELDS.has(key)) {
          // .trim() defends against whitespace-padded values
          // (`Citegeist.openAlexId:  W123 `) that would otherwise fail
          // strict validators like `parseWorkId`.
          citegeistFields.set(`${LEGACY_PREFIX}${key}`, line.substring(idx + 2).trim());
          continue;
        }
      }
      // Unknown field name OR no `: ` separator — treat as user content.
      otherLines.push(line);
    } else {
      otherLines.push(line);
    }
  }
  return { citegeistFields, otherLines };
}

/**
 * Round-trip invariant: every line of the original Extra (including duplicates)
 * must appear in the parsed-then-reassembled output. Ordering is allowed to
 * change because the v1.3.x writer always pushed `Citegeist.*` lines to the
 * end. The guard catches silent line loss or mutation — sorted-multiset
 * comparison preserves duplicate counts so a collapsed duplicate trips the check.
 */
function verifyParseRoundTrip(extra: string, parse: LegacyParse): boolean {
  // Compare with per-line trimming because `parseExtraLegacy` trims values
  // on known Citegeist fields. The reassembled form is byte-equal to the
  // input modulo trailing whitespace, which is cosmetic; the invariant
  // this guards is "no line lost or its identity mutated."
  const norm = (s: string) => s.trim();
  const cgLines: string[] = [];
  for (const [k, v] of parse.citegeistFields) cgLines.push(`${k}: ${v}`);
  const reassembled = [...parse.otherLines, ...cgLines]
    .map(norm)
    .filter((l) => l !== "")
    .sort();
  const original = extra
    .split("\n")
    .map(norm)
    .filter((l) => l !== "")
    .sort();
  if (reassembled.length !== original.length) return false;
  for (let i = 0; i < original.length; i++) {
    if (reassembled[i] !== original[i]) return false;
  }
  return true;
}

/**
 * Run `item.saveTx({ skipDateModifiedUpdate: true })` against a deadline.
 *
 * Two failure modes must be distinguished:
 *   • Synchronous / fast rejection → propagate so the per-item try/catch
 *     increments `unresolvedSkips` and the item is NOT checkpointed. Without
 *     this, a saveTx that rejects in the first event-loop tick (locked
 *     metadata, validation throw, read-only profile) would be silently
 *     swallowed and the item would be marked complete with stale Extra.
 *   • Late rejection (after the timeout has already fired and the outer
 *     catch incremented unresolvedSkips) → swallow + log, so Zotero's
 *     error console doesn't surface an unhandled-rejection warning that
 *     the user has no way to act on.
 *
 * Also clears the timer on the success path so we don't leak a closure
 * per loop iteration on large libraries.
 */
async function saveTxWithDeadline(item: _ZoteroTypes.Item): Promise<void> {
  let finished = false;
  const saveTxPromise = item.saveTx({ skipDateModifiedUpdate: true });
  // Attach the late-rejection swallow AFTER the race-winner is decided —
  // catches only rejections arriving once `finished === true`.
  saveTxPromise.catch((late) => {
    if (finished) {
      Zotero.debug(
        `[Citegeist] late saveTx rejection for ${item.libraryID}:${item.key} (already timed out): ${normalizeError(late)}`,
      );
    }
  });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      saveTxPromise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`saveTx timed out after ${MIGRATION_ITEM_TIMEOUT_MS}ms`)),
          MIGRATION_ITEM_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    finished = true;
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

/**
 * Extract a v2.0.0-runtime `Citegeist match ID: Wxxx` line and build a
 * minimal row carrying just the confirmed match. Returns null when no such
 * line exists OR the work ID fails validation. Used by the migration loop's
 * "no legacy fields" branch to recover user-curated confirmation state on
 * profile-restore paths where citegeist.sqlite is missing but the Extra
 * mirror survived.
 */
function recoverConfirmedMatchOnly(
  libraryID: number,
  itemKey: string,
  extra: string,
): ItemCacheRow | null {
  const prefix = `${CONFIRMED_MATCH_EXTRA_PREFIX}:`;
  const matches: string[] = [];
  for (const line of extra.split("\n")) {
    if (line.startsWith(prefix)) matches.push(line);
  }
  // Multiple mirror lines is incoherent — runtime writer always replaces
  // any prior line on confirm. The presence of two means either a buggy
  // upstream client or a hand-edit we don't understand. Bail rather than
  // pick one arbitrarily and silently strip the others.
  if (matches.length !== 1) return null;
  const id = parseWorkId(matches[0].substring(prefix.length).trim());
  if (!id) return null;
  const row = emptyRow(libraryID, itemKey);
  row.confirmed_open_alex_id = id;
  row.match_method = "title-match";
  // Tier is intentionally null: runtime confirmation didn't persist the
  // original tier across downgrade, so the recovered row carries no
  // tier rather than fabricating one. Readers branch on null gracefully.
  row.match_confidence = null;
  return row;
}

function buildRowFromLegacy(
  libraryID: number,
  itemKey: string,
  fields: Map<string, string>,
): ItemCacheRow {
  const get = (k: string) => fields.get(`${LEGACY_PREFIX}${k}`);
  const row = emptyRow(libraryID, itemKey);

  // Validate IDs at the legacy trust boundary, symmetric with v2.0.0 runtime
  // writes. Malformed values (hand-edited Extra, corrupted v1.3.x write) must
  // not flow into SQLite where readers would treat them as real OpenAlex IDs.
  row.open_alex_id = parseWorkId(get("openAlexId"));

  // Use safeParseIntOrNull (not safeParseInt) at the legacy trust boundary:
  // a hand-edited `Citegeist.citedByCount: garbage` would otherwise coerce to
  // 0 and become indistinguishable from a real zero-citation work.
  row.cited_by_count = safeParseIntOrNull(get("citedByCount"));

  const fwci = get("fwci");
  if (fwci) row.fwci = safeParseFloat(fwci);

  const pct = get("percentile");
  if (pct) row.percentile = safeParseFloat(pct);

  if (get("isTop1Percent") !== undefined) {
    row.is_top_1_percent = get("isTop1Percent") === "true" ? 1 : 0;
  }
  if (get("isTop10Percent") !== undefined) {
    row.is_top_10_percent = get("isTop10Percent") === "true" ? 1 : 0;
  }
  if (get("isRetracted") !== undefined) {
    row.is_retracted = get("isRetracted") === "true" ? 1 : 0;
  }
  row.last_fetched = get("lastFetched") ?? null;
  row.source_id = parseSourceId(get("sourceId"));
  const c2y = get("citedness2yr");
  if (c2y) row.citedness_2yr = safeParseFloat(c2y);
  row.journal_h_index = safeParseIntOrNull(get("journalHIndex"));
  row.source_issns = get("sourceISSNs") ?? get("issnL") ?? null;
  row.issn_l = get("issnL") ?? null;

  if (get("noMatch") === "true") row.no_match = 1;
  row.no_match_timestamp = get("noMatchTimestamp") ?? null;
  const mm = get("matchMethod");
  if (mm && isMatchMethod(mm)) row.match_method = mm;
  const mc = get("matchConfidence");
  if (mc && isMatchTier(mc)) row.match_confidence = mc;
  row.confirmed_open_alex_id = parseWorkId(get("confirmedOpenAlexId"));

  const psid = parseWorkId(get("pendingSuggestionId"));
  if (psid) {
    row.pending_open_alex_id = psid;
    row.pending_title = get("pendingSuggestionTitle") ?? null;
    row.pending_cited_by_count = safeParseIntOrNull(get("pendingSuggestionCount"));
    const pfwci = get("pendingSuggestionFwci");
    if (pfwci) row.pending_fwci = safeParseFloat(pfwci);
    const py = safeParseIntOrNull(get("pendingSuggestionYear"));
    if (py !== null && py > 0) row.pending_year = py;
    const pt = get("pendingSuggestionTier");
    if (pt && isMatchTier(pt)) row.pending_tier = pt;
    const pc = get("pendingSuggestionConfidence");
    if (pc) row.pending_confidence = safeParseFloat(pc);
    row.pending_doi = get("pendingSuggestionDoi") ?? null;
  }

  return row;
}

// ── Progress UI ─────────────────────────────────────────────────────────────

interface MigrationProgressUI {
  update(done: number, total: number): void;
  close(): void;
}

function buildProgressUI(total: number): MigrationProgressUI | null {
  if (total < SHOW_PROGRESS_UI_THRESHOLD) return null;
  let win: _ZoteroTypes.ProgressWindow | null = null;
  let progressItem: _ZoteroTypes.ProgressWindowItem | null = null;
  try {
    win = new Zotero.ProgressWindow({ closeOnClick: false });
    win.changeHeadline("Citegeist: migrating cache (one-time)");
    progressItem = new win.ItemProgress(
      "chrome://citegeist/content/icons/icon-16.svg",
      `0 / ${total}`,
    );
    win.show();
  } catch (e) {
    logError("migration progress UI unavailable", e);
    return null;
  }
  return {
    update(done, totalN) {
      if (!progressItem) return;
      progressItem.setProgress((done / totalN) * 100);
      progressItem.setText(`${done} / ${totalN}`);
    },
    close() {
      win?.startCloseTimer(1000);
    },
  };
}

// ── Migration entry point ───────────────────────────────────────────────────

/**
 * Compares two semver-ish version strings (Zotero versions are dotted decimals).
 * Returns true iff `a` >= `b`. Numeric segment comparison; non-numeric suffixes
 * are treated as zero-prefixes so `7.0.10-beta` compares as `7.0.10`.
 */
function versionGTE(a: string, b: string): boolean {
  const parse = (s: string) => s.split(".").map((p) => parseInt(p, 10) || 0);
  const av = parse(a);
  const bv = parse(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const x = av[i] ?? 0;
    const y = bv[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Minimum Zotero version that honors `item.saveTx({ skipDateModifiedUpdate: true })`. */
const MIN_ZOTERO_VERSION_FOR_MIGRATION = "7.0.10";

/**
 * Migrate per-item Citegeist data from Extra fields to SQLite.
 *
 * Runs once, gated by the `migrationV1Complete` pref. Iterates **every**
 * library the user has access to (personal + group), matching the scope
 * of `garbageCollectOrphans` and the runtime write path.
 *
 * **Idempotent and crash-safe.** Each item moves through (1) SQLite write
 * → (2) Extra strip → (3) checkpoint write in that order. A crash between
 * any two steps is recovered on the next launch:
 *   • Between 1 and 2 → next run re-strips Extra; `INSERT OR REPLACE` is a no-op.
 *   • Between 2 and 3 → next run sees empty parse, writes a checkpoint
 *     anyway so the item is not retried indefinitely.
 *
 * **Sync coordination.** Wrapped in `Zotero.Sync.Runner.delaySync` so the
 * sync engine can't resurrect stripped lines via a server merge mid-loop.
 *
 * **Version gate.** `item.saveTx({ skipDateModifiedUpdate: true })` is only
 * honored on Zotero 7.0.10+. On older builds the option is silently ignored,
 * which would mark every migrated item as "locally modified" and trigger a
 * full-library upload on the next Zotero Sync. We refuse to migrate on
 * older builds — the user keeps their existing Extra data and an upgrade
 * prompt appears.
 */
export async function migrateFromExtraV1(): Promise<void> {
  // REL-002 silent-data-loss guard: the pref says "we already migrated", but
  // if SQLite is empty AND any library still contains legacy Citegeist data
  // in Extra, something went wrong (manual SQLite deletion, antivirus
  // quarantine, partial profile restore). Clear the pref and re-run rather
  // than silently leaving the user with stripped Extra and no cache.
  if (Zotero.Prefs.get(PREF_MIGRATION_COMPLETE)) {
    if (await shouldForceRerun()) {
      Zotero.debug(
        "[Citegeist] migration pref says complete but state mismatch detected — re-running",
      );
      trySetPref(PREF_MIGRATION_COMPLETE, false);
    } else {
      return;
    }
  }

  // Verify init even though we don't keep the connection — we want a clear
  // error here if a caller forgot to await initCache() first.
  requireDb();

  // Version gate.
  const zVersion = Zotero.version ?? "0.0.0";
  if (!versionGTE(zVersion, MIN_ZOTERO_VERSION_FOR_MIGRATION)) {
    Zotero.debug(
      `[Citegeist] migration deferred: Zotero ${zVersion} < ${MIN_ZOTERO_VERSION_FOR_MIGRATION}. ` +
        `saveTx({skipDateModifiedUpdate}) is not honored on this build; running migration would ` +
        `trigger a full library re-sync. Update Zotero to enable migration.`,
    );
    return;
  }

  // Hoisted so the pref-completion decision below can see it. Migration
  // marks complete only when every candidate processed cleanly; anything
  // left unresolved (parse skip, salvage-only, per-item error) defers
  // completion until the next launch retries.
  let unresolvedSkips = 0;

  setMigrationInProgress(true);
  try {
    await runMigrationLoop();
  } finally {
    setMigrationInProgress(false);
  }

  /**
   * Inner closure so the outer try/finally guarantees the in-progress
   * flag is cleared even if `delaySync`, candidate collection, or the
   * backup write throws — without the wrap, an unexpected throw would
   * leave `isMigrationInProgress()` permanently true for the rest of
   * the session, silently disabling `writeConfirmedMatchToExtra`.
   */
  async function runMigrationLoop(): Promise<void> {
    await Zotero.Sync.Runner.delaySync(async () => {
      // Collect candidates across every library the user can write to. Skip
      // read-only group libraries: Step 1 (SQLite write) would succeed but
      // Step 2 (saveTx) would throw on every item, leaving migration
      // permanently unresolved and re-scanning the same items every launch.
      // Items in read-only libraries still get SQLite rows lazily via the
      // runtime fetch path; only the Extra strip is impossible.
      // Candidates: items containing the legacy `Citegeist.*` namespace
      // OR a runtime `Citegeist match ID:` line. The latter exists only
      // on items whose user confirmed a title match during a v2.0.0+
      // session and then downgraded to v1.3.x before re-upgrading; the
      // line carries recoverable confirmation state we want to migrate
      // even though there's no `Citegeist.` prefix anywhere on the item.
      const candidates: _ZoteroTypes.Item[] = [];
      for (const lib of Zotero.Libraries.getAll()) {
        if (!lib.editable) continue;
        const items = await Zotero.Items.getAll(lib.libraryID, false);
        for (const item of items) {
          if (item.deleted) continue;
          if (!item.isRegularItem()) continue;
          const extra = item.getField("extra");
          if (!extra) continue;
          if (extra.includes(LEGACY_PREFIX) || extra.includes(CONFIRMED_MATCH_EXTRA_PREFIX)) {
            candidates.push(item);
          }
        }
      }

      const total = candidates.length;

      // SAFETY NET: before touching a single Extra field, write a JSON
      // snapshot of every candidate's pre-migration Extra to the data dir.
      // If anything goes wrong — round-trip parse failure misdiagnosed,
      // saveTx silently corrupts metadata, user reports lost notes — the
      // user has a full audit log + restoration source.
      //
      // The file is also the user's escape hatch: they can manually walk
      // the JSON entries and re-paste any lost content. We surface the
      // path to the user via an alert after migration succeeds.
      if (total > 0) {
        await writeExtraBackup(candidates);
      }

      const ui = buildProgressUI(total);
      let done = 0;

      // Adaptive progress tick: small libraries fire every 50 items (snappy);
      // large libraries throttle to ~200 updates total so we don't thrash the
      // UI with 1000+ paints during a 50k-item migration.
      const progressTick = Math.max(MIGRATION_PROGRESS_TICK, Math.floor(total / 200) || 1);

      // Load every already-migrated key into a Set once. Replaces N
      // per-item SELECTs with one SELECT — order-of-magnitude win on first
      // run of a 50k-item library where every candidate would otherwise pay
      // a SQLite round trip just to confirm "not yet migrated."
      const conn0 = requireDb();
      const checkpointed = new Set<string>();
      {
        const rows = await conn0.queryAsync<{ library_id: number; item_key: string }>(
          `SELECT library_id, item_key FROM migration_progress`,
        );
        for (const r of rows) checkpointed.add(mirrorKey(r.library_id, r.item_key));
      }

      // Each iteration is wrapped in its own try/catch. A single "poison"
      // item — corrupt Extra, locked metadata, transient saveTx rejection —
      // must not block the entire migration. We log and move on; the next
      // launch will retry that item only (others already have checkpoints).
      let failureCount = 0;
      for (const item of candidates) {
        done++;
        if (done % progressTick === 0) ui?.update(done, total);

        try {
          const conn = requireDb();

          if (checkpointed.has(mirrorKey(item.libraryID, item.key))) continue;

          const rawExtra = item.getField("extra") ?? "";
          // Normalize line endings + strip BOM once. parseExtraLegacy and
          // verifyParseRoundTrip both expect a clean LF-delimited string;
          // working off the raw `\r\n`-mixed value would corrupt values
          // (every parseWorkId would fail) AND fail the round-trip check.
          const extra = normalizeExtraForParse(rawExtra);
          const parse = parseExtraLegacy(extra);

          // Defensive checkpoint: zero Citegeist fields means either the item
          // was already stripped by a prior partial migration, or the file once
          // had Citegeist data and a user removed it manually. BEFORE giving
          // up, recover the downgrade-safety `Citegeist match ID: Wxxx` line
          // (written by v2.0.0 runtime confirmTitleMatch) — without this step
          // a profile-restore that drops citegeist.sqlite silently erases
          // every user-confirmed title match, defeating the whole point of
          // mirroring confirmation state to Extra.
          if (parse.citegeistFields.size === 0) {
            // Only strip the `Citegeist match ID:` line(s) when recovery
            // succeeded. A user maintaining free-form notes might include
            // `Citegeist match ID: see footnote 3` as their own annotation
            // — destroying that line would be silent data loss with the
            // pre-migration JSON backup as the only recovery path. If the
            // line doesn't parse as a valid W-ID we leave it alone: a
            // false-positive in the candidate filter is harmless, a
            // false-positive in the strip is destructive.
            const recovered = recoverConfirmedMatchOnly(item.libraryID, item.key, extra);
            if (recovered) {
              await upsertRow(recovered);
              const stripped = setExtraConfirmedMatch(extra.split("\n"), null)
                .join("\n")
                .replace(/\n+$/, "");
              if (stripped !== rawExtra) {
                item.setField("extra", stripped);
                // Race against deadline — recovery-branch items get the
                // same hung-item protection the main path does. Without
                // it, one locked item in this branch could stall every
                // subsequent candidate (REL-M-001).
                await saveTxWithDeadline(item);
              }
            }
            await checkpointItem(conn, item.libraryID, item.key);
            checkpointed.add(mirrorKey(item.libraryID, item.key));
            continue;
          }

          if (!verifyParseRoundTrip(extra, parse)) {
            // Best-effort salvage: the parse identified Citegeist fields but
            // the round-trip safety check refused (typically duplicate keys
            // or ambiguous ordering). Persist the SQLite row anyway so the
            // user keeps their cached metrics, but DO NOT strip Extra — the
            // ambiguity may indicate the user's data we don't fully
            // understand. We also don't checkpoint, so the next run revisits
            // the item. Track the count and refuse to mark migration complete
            // — round-trip skips must be investigated before we trust the
            // legacy data is fully migrated.
            unresolvedSkips++;
            Zotero.debug(
              `[Citegeist] migration: salvaging ${item.libraryID}:${item.key} to SQLite but leaving Extra intact — round-trip parse ambiguous`,
            );
            try {
              const salvaged = buildRowFromLegacy(item.libraryID, item.key, parse.citegeistFields);
              await upsertRow(salvaged);
            } catch (salvageErr) {
              Zotero.debug(
                `[Citegeist] migration: salvage write failed for ${item.libraryID}:${item.key} — ${normalizeError(salvageErr)}`,
              );
            }
            continue;
          }

          const row = buildRowFromLegacy(item.libraryID, item.key, parse.citegeistFields);

          // Step 1: SQLite write
          await upsertRow(row);

          // Step 2 (must follow step 1): Extra strip — non-Citegeist content
          // preserved; the single surviving `Citegeist match ID:` line is
          // re-emitted for confirmed matches so the user's manual curation
          // survives plugin downgrade. If we stripped Extra before SQLite has
          // the row, a crash here loses the user's data.
          const newLines = setExtraConfirmedMatch(parse.otherLines, row.confirmed_open_alex_id);
          const newExtra = newLines.join("\n").replace(/\n+$/, "");
          item.setField("extra", newExtra);
          // Race saveTx against a deadline. Fast rejections propagate so
          // the outer try/catch increments unresolvedSkips and the item
          // is NOT checkpointed. See `saveTxWithDeadline`.
          await saveTxWithDeadline(item);

          // Step 3 (must follow step 2): checkpoint. Mark the in-memory
          // `checkpointed` Set BEFORE the SQL write — a successful
          // saveTx means the item's data is fully migrated; if the
          // checkpoint INSERT itself throws (transient SQLite hiccup),
          // the next launch's defensive `parse.citegeistFields.size === 0`
          // branch will re-checkpoint cheaply. The previous ordering
          // would have flipped a successful migration into a permanent
          // `unresolvedSkips` state, blocking the completion pref forever.
          checkpointed.add(mirrorKey(item.libraryID, item.key));
          try {
            await checkpointItem(conn, item.libraryID, item.key);
          } catch (cpErr) {
            Zotero.debug(
              `[Citegeist] migration: checkpoint INSERT failed for ${item.libraryID}:${item.key} — ${normalizeError(cpErr)} (item is fully migrated; next launch will re-checkpoint)`,
            );
          }
        } catch (e) {
          failureCount++;
          unresolvedSkips++;
          Zotero.debug(
            `[Citegeist] migration: error on ${item.libraryID}:${item.key} — ${normalizeError(e)} (continuing)`,
          );
        }
      }
      if (failureCount > 0) {
        Zotero.debug(`[Citegeist] migration: ${failureCount} items skipped due to errors`);
      }

      ui?.close();
      Zotero.debug(`[Citegeist] migration complete: ${total} items processed`);
    });
  }

  // Mark complete only when every candidate processed cleanly. Round-trip
  // skips, salvage-only writes, and per-item errors all increment
  // `unresolvedSkips` — anything > 0 leaves the pref unset so the next
  // launch retries the stragglers.
  if (unresolvedSkips === 0) {
    trySetPref(PREF_MIGRATION_COMPLETE, true);
  } else {
    Zotero.debug(
      `[Citegeist] migration: ${unresolvedSkips} items left unresolved; ` +
        `migrationV1Complete will remain unset until they succeed on a future run`,
    );
  }

  // Only drop the checkpoint table on a clean run. If `unresolvedSkips > 0`
  // we leave checkpoints in place so the next launch can re-iterate only
  // the unresolved stragglers instead of re-scanning every candidate —
  // matters on 50k-item libraries with 1% transient errors.
  if (unresolvedSkips === 0) {
    try {
      const conn = requireDb();
      await conn.queryAsync(`DELETE FROM migration_progress`);
    } catch (e) {
      logError("migration_progress cleanup (non-fatal)", e);
    }
  }
}

/**
 * REL-002 helper: detects the state where the completion pref is set but
 * SQLite is empty AND legacy `Citegeist.*` data still lives in Extra. This
 * happens when the SQLite file is deleted (antivirus quarantine, manual
 * cleanup, partial profile restore) but `prefs.js` survives. Without this
 * guard the user would see stripped Extra fields AND empty cache columns
 * — silent total data loss.
 */
async function shouldForceRerun(): Promise<boolean> {
  try {
    // Use the in-memory mirror as the cache-emptiness probe — it's the
    // source of truth for read-side state and avoids a parallel SQL query
    // whose result has to be kept in sync with the mirror anyway.
    if (mirrorSnapshot().length > 0) return false;
    // Cache is empty — is there still legacy data anywhere?
    for (const lib of Zotero.Libraries.getAll()) {
      const items = await Zotero.Items.getAll(lib.libraryID, false);
      for (const item of items) {
        if (item.deleted || !item.isRegularItem()) continue;
        const extra = item.getField("extra");
        if (extra && extra.includes(LEGACY_PREFIX)) return true;
      }
    }
    return false;
  } catch (e) {
    logError("shouldForceRerun probe (non-fatal)", e);
    return false;
  }
}

/**
 * Write a pre-migration JSON snapshot of every candidate's full Extra
 * field to `<dataDir>/citegeist-migration-backup-{ISO timestamp}.json`.
 *
 * Goal: an irreversible audit trail. If migration loses or alters any
 * user content, the snapshot is the source of truth — the user can
 * manually restore by opening the JSON, finding the item by
 * `library_id` + `item_key`, and pasting `extra` back into the item's
 * Extra field via Zotero's UI.
 *
 * Failure to write the backup file does NOT block migration — we log
 * loudly so the user sees it in the debug output and surface it via
 * the post-migration alert, but proceeding without a backup is better
 * than refusing to migrate (which would leave the plugin permanently
 * broken on a profile where the data dir is read-only).
 */
async function writeExtraBackup(candidates: _ZoteroTypes.Item[]): Promise<void> {
  try {
    const payload = {
      schema: "citegeist-migration-backup/v1",
      plugin_version: "2.0.0",
      zotero_version: Zotero.version,
      timestamp: new Date().toISOString(),
      note: "Restore by copying the `extra` field back to the matching item via Zotero's UI.",
      items: candidates.map((item) => ({
        library_id: item.libraryID,
        item_key: item.key,
        extra: item.getField("extra") ?? "",
      })),
    };
    // Defense-in-depth for shared multi-user POSIX systems: place backups
    // inside a per-plugin subdir created with mode 0700 so even if a single
    // file lands at the umask default (0644) before chmod runs, the parent
    // directory denies traversal. On Windows the chmod is a no-op but the
    // ACL inheritance follows the parent dir, so the same protection holds
    // in spirit.
    const backupDir = PathUtils.join(Zotero.DataDirectory.dir, "citegeist-backups");
    try {
      await IOUtils.makeDirectory(backupDir, { permissions: 0o700, ignoreExisting: true });
      await IOUtils.setPermissions?.(backupDir, { unixMode: 0o700 });
    } catch (dirErr) {
      logError("backup directory creation (non-fatal)", dirErr);
    }
    const filename = `citegeist-migration-backup-${payload.timestamp.replace(/[:.]/g, "-")}.json`;
    const path = PathUtils.join(backupDir, filename);
    // Atomic write: stage to `.tmp`, then rename onto the final path.
    // A crash between the write and the rename leaves the partial `.tmp`
    // file behind, which pruneOldBackups sweeps on next migration.
    const tmpPath = `${path}.tmp`;
    await Zotero.File.putContentsAsync(tmpPath, JSON.stringify(payload, null, 2));
    // Chmod the .tmp BEFORE the rename so the final file inherits the
    // restricted mode in one atomic transition. The parent-dir 0700 above
    // provides defense-in-depth for builds lacking setPermissions.
    try {
      await IOUtils.setPermissions?.(tmpPath, { unixMode: 0o600 });
    } catch (permErr) {
      logError("chmod backup file (non-fatal)", permErr);
    }
    await IOUtils.move(tmpPath, path);
    Zotero.debug(
      `[Citegeist] wrote pre-migration Extra backup: ${path} (${candidates.length} items)`,
    );
    trySetPref(PREF_LAST_BACKUP_PATH, path);
    await pruneOldBackups();
  } catch (e) {
    logError("FAILED to write pre-migration Extra backup", e);
  }
}

/**
 * Cap the number of `citegeist-migration-backup-*.json` files in the data
 * directory to `MAX_BACKUP_FILES`. Filenames embed an ISO-8601 timestamp
 * (sortable lexically), so the lex-sorted list has the newest at the end.
 * Best-effort: failures are logged but don't propagate — the latest
 * backup succeeded, which is what the user needs for recovery.
 */
async function pruneOldBackups(): Promise<void> {
  try {
    const backupDir = PathUtils.join(Zotero.DataDirectory.dir, "citegeist-backups");
    const entries = await IOUtils.getChildren(backupDir).catch(() => [] as string[]);
    // Sweep stranded `.tmp` files from prior crashes — they'd otherwise
    // accumulate across migration retries. Drop unconditionally; a `.tmp`
    // is by definition mid-write and never authoritative.
    for (const p of entries) {
      if (/citegeist-migration-backup-.+\.json\.tmp$/.test(p)) {
        await IOUtils.remove(p).catch(() => {});
      }
    }
    const backups = entries.filter((p) => /citegeist-migration-backup-.+\.json$/.test(p)).sort();
    const excess = backups.length - MAX_BACKUP_FILES;
    if (excess <= 0) return;
    for (const oldPath of backups.slice(0, excess)) {
      try {
        await IOUtils.remove(oldPath);
        Zotero.debug(`[Citegeist] pruned old backup: ${oldPath}`);
      } catch (e) {
        logError(`prune-old-backup failed for ${oldPath}`, e);
      }
    }
  } catch (e) {
    logError("backup pruning skipped (non-fatal)", e);
  }
}

/** `Zotero.Prefs.set` writes to `prefs.js` and can throw on a locked profile. */
function trySetPref(name: string, value: unknown): void {
  try {
    Zotero.Prefs.set(name, value);
  } catch (e) {
    logError(`Prefs.set('${name}') (non-fatal)`, e);
  }
}

async function checkpointItem(
  conn: _ZoteroTypes.DBConnection,
  libraryID: number,
  itemKey: string,
): Promise<void> {
  await conn.queryAsync(
    `INSERT OR REPLACE INTO migration_progress (library_id, item_key, migrated_at) VALUES (?, ?, ?)`,
    [libraryID, itemKey, new Date().toISOString()],
  );
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
  const lastRunRaw = Zotero.Prefs.get(PREF_LAST_ORPHAN_GC_AT);
  const lastRun = typeof lastRunRaw === "number" ? lastRunRaw : 0;
  if (!options.force && Date.now() - lastRun < ORPHAN_GC_MIN_INTERVAL_MS) return;

  const conn = requireDb();

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
    trySetPref(PREF_LAST_ORPHAN_GC_AT, Date.now());
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
    await conn.queryAsync(
      `DELETE FROM item_cache WHERE (library_id, item_key) IN (${tuplePlaceholders})`,
      params,
    );
    await conn.queryAsync(
      `DELETE FROM migration_progress WHERE (library_id, item_key) IN (${tuplePlaceholders})`,
      params,
    );
    deleteMirrorEntries(slice.map((o) => o.composite));
  }
  trySetPref(PREF_LAST_ORPHAN_GC_AT, Date.now());
  Zotero.debug(`[Citegeist] orphan GC removed ${orphans.length} rows`);
}

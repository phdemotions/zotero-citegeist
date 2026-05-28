/**
 * One-shot migration from legacy Extra-field storage (v1.3.x → v1.4.0)
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
  MIGRATION_PROGRESS_TICK,
  ORPHAN_GC_CHUNK_SIZE,
  ORPHAN_GC_MIN_INTERVAL_MS,
  SHOW_PROGRESS_UI_THRESHOLD,
} from "../../constants";
import { safeParseFloat, safeParseInt } from "../utils";
import { deleteMirrorEntries, mirrorSnapshot, requireDb, upsertRow } from "./db";
import { setExtraConfirmedMatch } from "./write";
import { emptyRow, isMatchMethod, isMatchTier, type ItemCacheRow, LEGACY_PREFIX } from "./types";

// ── Legacy parser (private — kept until v1.5.x once migration is verified) ──

interface LegacyParse {
  citegeistFields: Map<string, string>;
  otherLines: string[];
}

/**
 * Parse the legacy `Citegeist.*` namespace out of an Extra field.
 * Byte-for-byte compatible with the v1.3.0 parser.
 *
 * Note: a `Citegeist.X` line without a `": "` separator is treated as
 * non-data and pushed into `otherLines` — that way it survives the
 * migration verbatim instead of being silently dropped.
 */
function parseExtraLegacy(extra: string): LegacyParse {
  const citegeistFields = new Map<string, string>();
  const otherLines: string[] = [];
  if (!extra) return { citegeistFields, otherLines };
  for (const line of extra.split("\n")) {
    if (line.startsWith(LEGACY_PREFIX)) {
      const idx = line.indexOf(": ");
      if (idx > 0) {
        citegeistFields.set(line.substring(0, idx), line.substring(idx + 2));
      } else {
        otherLines.push(line);
      }
    } else {
      otherLines.push(line);
    }
  }
  return { citegeistFields, otherLines };
}

/**
 * Round-trip invariant: every line of the original Extra (including duplicates)
 * must appear in the parsed-then-reassembled output. Ordering is allowed to
 * change because the legacy writer always pushed `Citegeist.*` lines to the
 * end. What we defend against is *silent line loss or mutation* — a parser
 * bug that eats user content or transforms it.
 *
 * Implementation: sorted multiset comparison preserves duplicate counts so
 * a repeated user line (real-world case: BibTeX round-trips can leave
 * duplicate `PMID:` lines) is detected if the parser collapses it.
 */
function verifyParseRoundTrip(extra: string, parse: LegacyParse): boolean {
  const cgLines: string[] = [];
  for (const [k, v] of parse.citegeistFields) cgLines.push(`${k}: ${v}`);
  const reassembled = [...parse.otherLines, ...cgLines].filter((l) => l !== "").sort();
  const original = extra
    .split("\n")
    .filter((l) => l !== "")
    .sort();
  if (reassembled.length !== original.length) return false;
  for (let i = 0; i < original.length; i++) {
    if (reassembled[i] !== original[i]) return false;
  }
  return true;
}

function buildRowFromLegacy(
  libraryID: number,
  itemKey: string,
  fields: Map<string, string>,
): ItemCacheRow {
  const get = (k: string) => fields.get(`${LEGACY_PREFIX}${k}`);
  const row = emptyRow(libraryID, itemKey);

  const oid = get("openAlexId");
  if (oid) row.open_alex_id = oid;

  const cbc = get("citedByCount");
  if (cbc !== undefined) row.cited_by_count = safeParseInt(cbc);

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
  row.source_id = get("sourceId") ?? null;
  const c2y = get("citedness2yr");
  if (c2y) row.citedness_2yr = safeParseFloat(c2y);
  const hidx = get("journalHIndex");
  if (hidx) row.journal_h_index = safeParseInt(hidx);
  row.source_issns = get("sourceISSNs") ?? get("issnL") ?? null;
  row.issn_l = get("issnL") ?? null;

  if (get("noMatch") === "true") row.no_match = 1;
  row.no_match_timestamp = get("noMatchTimestamp") ?? null;
  const mm = get("matchMethod");
  if (mm && isMatchMethod(mm)) row.match_method = mm;
  const mc = get("matchConfidence");
  if (mc && isMatchTier(mc)) row.match_confidence = mc;
  row.confirmed_open_alex_id = get("confirmedOpenAlexId") ?? null;

  const psid = get("pendingSuggestionId");
  if (psid) {
    row.pending_open_alex_id = psid;
    row.pending_title = get("pendingSuggestionTitle") ?? null;
    const pcbc = get("pendingSuggestionCount");
    if (pcbc) row.pending_cited_by_count = safeParseInt(pcbc);
    const pfwci = get("pendingSuggestionFwci");
    if (pfwci) row.pending_fwci = safeParseFloat(pfwci);
    const py = get("pendingSuggestionYear");
    if (py) {
      const n = safeParseInt(py);
      row.pending_year = n > 0 ? n : null;
    }
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
    Zotero.debug(`[Citegeist] migration progress UI unavailable: ${String(e)}`);
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
  if (Zotero.Prefs.get("extensions.zotero.citegeist.migrationV1Complete")) return;

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

  await Zotero.Sync.Runner.delaySync(async () => {
    // Collect candidates across every library the user has access to.
    const candidates: _ZoteroTypes.Item[] = [];
    for (const lib of Zotero.Libraries.getAll()) {
      const items = await Zotero.Items.getAll(lib.libraryID, false);
      for (const item of items) {
        if (item.deleted) continue;
        const extra = item.getField("extra");
        if (extra && extra.includes(LEGACY_PREFIX)) candidates.push(item);
      }
    }

    const total = candidates.length;
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
      for (const r of rows) checkpointed.add(`${r.library_id}:${r.item_key}`);
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

        if (checkpointed.has(`${item.libraryID}:${item.key}`)) continue;

        const extra = item.getField("extra") ?? "";
        const parse = parseExtraLegacy(extra);

        // Defensive checkpoint: zero Citegeist fields means either the item
        // was already stripped by a prior partial migration, or the file once
        // had Citegeist data and a user removed it manually. Checkpoint so we
        // don't keep paying the parse cost on future runs.
        if (parse.citegeistFields.size === 0) {
          await checkpointItem(conn, item.libraryID, item.key);
          checkpointed.add(`${item.libraryID}:${item.key}`);
          continue;
        }

        if (!verifyParseRoundTrip(extra, parse)) {
          Zotero.debug(
            `[Citegeist] migration: skipping ${item.libraryID}:${item.key} — round-trip parse failed`,
          );
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
        await item.saveTx({ skipDateModifiedUpdate: true });

        // Step 3 (must follow step 2): checkpoint
        await checkpointItem(conn, item.libraryID, item.key);
        checkpointed.add(`${item.libraryID}:${item.key}`);
      } catch (e) {
        failureCount++;
        Zotero.debug(
          `[Citegeist] migration: error on ${item.libraryID}:${item.key} — ${String(e)} (continuing)`,
        );
      }
    }
    if (failureCount > 0) {
      Zotero.debug(`[Citegeist] migration: ${failureCount} items skipped due to errors`);
    }

    ui?.close();
    Zotero.debug(`[Citegeist] migration complete: ${total} items processed`);
  });

  trySetPref("extensions.zotero.citegeist.migrationV1Complete", true);

  // The checkpoint table has served its purpose; reclaim space.
  // Wrap in try/catch so a cleanup failure doesn't unset the completion pref.
  try {
    const conn = requireDb();
    await conn.queryAsync(`DELETE FROM migration_progress`);
  } catch (e) {
    Zotero.debug(`[Citegeist] migration_progress cleanup failed (non-fatal): ${String(e)}`);
  }
}

/** `Zotero.Prefs.set` writes to `prefs.js` and can throw on a locked profile. */
function trySetPref(name: string, value: unknown): void {
  try {
    Zotero.Prefs.set(name, value);
  } catch (e) {
    Zotero.debug(`[Citegeist] Prefs.set('${name}') failed (non-fatal): ${String(e)}`);
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
 * the user has access to (personal + group libraries).
 *
 * Gated by `ORPHAN_GC_MIN_INTERVAL_MS` so we don't pay the per-library
 * scan cost on every launch. Pass `{ force: true }` to override the gate
 * (e.g., from a future "Citegeist → Rebuild cache" menu).
 *
 * Note: queries every library because the runtime write path (`cacheWorkData`)
 * is library-agnostic — group-library items get SQLite rows too, and we
 * must not purge them as "orphans."
 */
export async function garbageCollectOrphans(options: { force?: boolean } = {}): Promise<void> {
  const lastRunRaw = Zotero.Prefs.get("extensions.zotero.citegeist.lastOrphanGcAt");
  const lastRun = typeof lastRunRaw === "number" ? lastRunRaw : 0;
  if (!options.force && Date.now() - lastRun < ORPHAN_GC_MIN_INTERVAL_MS) return;

  const conn = requireDb();

  // Build the live key set as (libraryID, itemKey) tuples so we don't
  // mistake a same-named key in a different library for an orphan.
  const liveComposites = new Set<string>();
  for (const lib of Zotero.Libraries.getAll()) {
    const items = await Zotero.Items.getAll(lib.libraryID, false);
    for (const i of items) liveComposites.add(`${i.libraryID}:${i.key}`);
  }

  // Snapshot the mirror before iterating. Concurrent writes during GC could
  // otherwise yield entries that didn't exist when `liveComposites` was
  // built, leading to spurious orphan detection.
  const orphans: Array<{ libraryID: number; itemKey: string; composite: string }> = [];
  for (const [composite, row] of mirrorSnapshot()) {
    if (!liveComposites.has(composite)) {
      orphans.push({ libraryID: row.library_id, itemKey: row.item_key, composite });
    }
  }

  if (orphans.length === 0) {
    trySetPref("extensions.zotero.citegeist.lastOrphanGcAt", Date.now());
    return;
  }

  for (let i = 0; i < orphans.length; i += ORPHAN_GC_CHUNK_SIZE) {
    const slice = orphans.slice(i, i + ORPHAN_GC_CHUNK_SIZE);
    // Two-param `WHERE (library_id, item_key) IN ((?,?), (?,?), …)` is the
    // canonical SQLite shape for composite key lookups.
    const tuplePlaceholders = slice.map(() => "(?, ?)").join(",");
    const params: unknown[] = [];
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
  trySetPref("extensions.zotero.citegeist.lastOrphanGcAt", Date.now());
  Zotero.debug(`[Citegeist] orphan GC removed ${orphans.length} rows`);
}

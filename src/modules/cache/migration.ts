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
import { deleteMirrorKeys, mirrorKeys, requireDb, upsertRow } from "./db";
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

function buildRowFromLegacy(itemKey: string, fields: Map<string, string>): ItemCacheRow {
  const get = (k: string) => fields.get(`${LEGACY_PREFIX}${k}`);
  const row = emptyRow(itemKey);

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
 * Migrate per-item Citegeist data from Extra fields to SQLite.
 *
 * Runs once, gated by the `migrationV1Complete` pref. Idempotent and
 * crash-safe: each item goes through (1) SQLite write → (2) Extra strip
 * → (3) checkpoint write in that order. A crash between any two steps
 * is recovered on the next launch because `INSERT OR REPLACE` is a no-op
 * for completed items and `migration_progress` lets us skip ahead.
 *
 * Wrapped in `Zotero.Sync.Runner.delaySync` to prevent the sync engine
 * from resurrecting stripped lines via a server merge mid-loop.
 *
 * Note on `item.saveTx({ skipDateModifiedUpdate: true })`: the option is
 * honored on Zotero 7.0.10+ and silently ignored on older builds. Older
 * builds bump `dateModified` on every migrated item; harmless but worth
 * knowing if a user reports unexpected modification timestamps.
 */
export async function migrateFromExtraV1(): Promise<void> {
  if (Zotero.Prefs.get("extensions.zotero.citegeist.migrationV1Complete")) return;
  // Verify init even though we don't keep the connection — we want a clear
  // error here if a caller forgot to await initCache() first.
  requireDb();

  Zotero.Prefs.set("extensions.zotero.citegeist.migrationV1InProgress", true);

  try {
    await Zotero.Sync.Runner.delaySync(async () => {
      const items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, false);

      // Pre-filter so the UI count reflects actual work, not library size.
      const candidates: _ZoteroTypes.Item[] = [];
      for (const item of items) {
        const extra = item.getField("extra");
        if (extra && extra.includes(LEGACY_PREFIX)) candidates.push(item);
      }

      const total = candidates.length;
      const ui = buildProgressUI(total);
      let done = 0;

      for (const item of candidates) {
        done++;
        if (done % MIGRATION_PROGRESS_TICK === 0) ui?.update(done, total);

        // Skip items we've already migrated (idempotency)
        const conn = requireDb();
        const already = await conn.queryAsync<{ item_key: string }>(
          `SELECT item_key FROM migration_progress WHERE item_key = ?`,
          [item.key],
        );
        if (already.length > 0) continue;

        const extra = item.getField("extra") ?? "";
        const parse = parseExtraLegacy(extra);
        if (parse.citegeistFields.size === 0) continue;

        if (!verifyParseRoundTrip(extra, parse)) {
          Zotero.debug(`[Citegeist] migration: skipping ${item.key} — round-trip parse failed`);
          continue;
        }

        const row = buildRowFromLegacy(item.key, parse.citegeistFields);

        // Step 1: SQLite write
        await upsertRow(row);

        // Step 2: Extra strip — non-Citegeist lines preserved; the single
        // surviving `Citegeist match ID:` line is re-emitted for confirmed
        // matches so the user's manual curation survives downgrade.
        const newLines = setExtraConfirmedMatch(parse.otherLines, row.confirmed_open_alex_id);
        const newExtra = newLines.join("\n").replace(/\n+$/, "");
        item.setField("extra", newExtra);
        await item.saveTx({ skipDateModifiedUpdate: true });

        // Step 3: checkpoint
        await conn.queryAsync(
          `INSERT OR REPLACE INTO migration_progress (item_key, migrated_at) VALUES (?, ?)`,
          [item.key, new Date().toISOString()],
        );
      }

      ui?.close();
      Zotero.debug(`[Citegeist] migration complete: ${total} items processed`);
    });

    Zotero.Prefs.set("extensions.zotero.citegeist.migrationV1Complete", true);
  } finally {
    Zotero.Prefs.set("extensions.zotero.citegeist.migrationV1InProgress", false);
  }
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

  const liveKeys = new Set<string>();
  const libraries = Zotero.Libraries.getAll();
  for (const lib of libraries) {
    const items = await Zotero.Items.getAll(lib.libraryID, false);
    for (const i of items) liveKeys.add(i.key);
  }

  const orphans: string[] = [];
  for (const key of mirrorKeys()) if (!liveKeys.has(key)) orphans.push(key);

  if (orphans.length === 0) {
    Zotero.Prefs.set("extensions.zotero.citegeist.lastOrphanGcAt", Date.now());
    return;
  }

  for (let i = 0; i < orphans.length; i += ORPHAN_GC_CHUNK_SIZE) {
    const slice = orphans.slice(i, i + ORPHAN_GC_CHUNK_SIZE);
    const placeholders = slice.map(() => "?").join(",");
    await conn.queryAsync(`DELETE FROM item_cache WHERE item_key IN (${placeholders})`, slice);
    await conn.queryAsync(
      `DELETE FROM migration_progress WHERE item_key IN (${placeholders})`,
      slice,
    );
    deleteMirrorKeys(slice);
  }
  Zotero.Prefs.set("extensions.zotero.citegeist.lastOrphanGcAt", Date.now());
  Zotero.debug(`[Citegeist] orphan GC removed ${orphans.length} rows`);
}

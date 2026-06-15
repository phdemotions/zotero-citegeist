---
type: plan
title: "SQLite cache migration (Extra → plugin-owned DB) — v2"
description: Approved implementation plan for moving cached metrics from Zotero Extra fields to a plugin-owned SQLite database.
timestamp: 2026-05-27
status: approved
tags: [citegeist, plan, cache, sqlite, migration]
---

# Plan — SQLite Cache Migration (Extra → Plugin-Owned DB) — v2

> **Date:** 2026-05-27
> **Status:** Approved (post-review, v2)
> **Owner:** Josh Gonzales
> **Type:** Architectural refactor — storage layer
> **Supersedes:** v1 (this file, reviewed by document-review skill 2026-05-27)

---

## Review record

v1 reviewed in parallel by five document-review personas (coherence, feasibility, scope-guardian, adversarial, product-lens). All findings incorporated. Major changes v1 → v2:

- **Blocker fix:** Sync vs async API mismatch resolved via in-memory mirror loaded at startup.
- **Blocker fix:** Two-database transaction model replaced with per-item ordering + checkpoint table for crash recovery.
- **Blocker fix:** Zotero typings added explicitly.
- **High-impact fixes:** Sync engine pause, downgrade-safety mirror for confirmed match IDs, progress UI, orphan row GC, round-trip invariant.
- **Scope cut:** 3 tables → 1 wide table. Drop `library_id`. Drop schema-version framework. Drop `preserveExtraOnMigration` pref. Drop group library handling from v1.1.0. Drop `MIGRATION_BATCH_SIZE`. Merge `db.ts` into `cache.ts`.

---

## 1. Goal

Move all Citegeist-managed data out of Zotero's per-item `Extra` field into a plugin-owned SQLite database (`citegeist.sqlite`) attached via `Zotero.DBConnection`. Provide a one-shot, idempotent migration. Public API of `cache.ts` is preserved.

## 2. Why

User feedback (2026-05-27) flagged Extra-field writes as risky. The structural concern is real for the long term:

1. **Orphan data on uninstall.** Removing Citegeist leaves `Citegeist.*` lines forever in user libraries.
2. **Tenancy collision risk.** BBT, Zutilo, CSL processors all touch Extra. Namespacing minimizes but does not eliminate.
3. **CSL leakage risk.** Misconfigured user templates can surface bibliometric fields in citations.
4. **Backup/restore staleness.** Old library backup overwrites fresher cached values.

The canonical Zotero 7+ pattern is plugin-owned SQLite via `Zotero.DBConnection('<name>')`. Officially recommended ([Zotero forum](https://forums.zotero.org/discussion/113117)). Used by Better BibTeX. Documented in the [sample plugin](https://www.zotero.org/support/dev/sample_plugin).

## 3. Non-goals

- **Cross-device sync.** SQLite cache is profile-local. Mitigations in §8.
- **Group library migration.** Deferred to v1.2.x; v1.1.0 reads/writes user library only.
- **Changes to OpenAlex client or fetch orchestration.**
- **Replacing `Zotero.Prefs` use** for plugin preferences.

## 4. Storage design

### 4.1 Database

- File: `<profile>/citegeist.sqlite` (auto-created by `new Zotero.DBConnection('citegeist')`).
- Singleton connection, opened on startup, closed on shutdown.
- All queries via `await db.queryAsync(...)`.

### 4.2 Schema

One wide table mirrors the current flat `Citegeist.*` namespace. No premature normalization.

```sql
CREATE TABLE IF NOT EXISTS item_cache (
  item_key                  TEXT PRIMARY KEY,
  -- work data
  open_alex_id              TEXT,
  cited_by_count            INTEGER,
  fwci                      REAL,
  percentile                REAL,
  is_top_1_percent          INTEGER,            -- 0/1
  is_top_10_percent         INTEGER,            -- 0/1
  is_retracted              INTEGER,            -- 0/1
  last_fetched              TEXT,               -- ISO-8601
  source_id                 TEXT,
  citedness_2yr             REAL,
  journal_h_index           INTEGER,
  source_issns              TEXT,               -- comma-joined
  issn_l                    TEXT,
  -- match meta
  no_match                  INTEGER,            -- 0/1
  no_match_timestamp        TEXT,
  match_method              TEXT,               -- doi | pmid | arxiv | isbn | title-match
  match_confidence          TEXT,               -- high | medium
  confirmed_open_alex_id    TEXT,
  -- pending suggestion
  pending_open_alex_id      TEXT,
  pending_title             TEXT,
  pending_cited_by_count    INTEGER,
  pending_fwci              REAL,
  pending_year              INTEGER,
  pending_tier              TEXT,
  pending_confidence        REAL,
  pending_doi               TEXT
);

CREATE INDEX IF NOT EXISTS idx_item_cache_last_fetched ON item_cache (last_fetched);

-- Migration checkpoint table. Per-item flag survives crashes.
CREATE TABLE IF NOT EXISTS migration_progress (
  item_key   TEXT PRIMARY KEY,
  migrated_at TEXT NOT NULL                     -- ISO-8601
);
```

**Why one table:** every call site that reads work data also reads match-meta or pending-suggestion in the same parse (see `getCachedMetrics` in cache.ts:125-159). Splitting forces LEFT JOINs that add complexity for no behavior gain.

**Why no `library_id`:** v1.1.0 reads user library only. When group libraries ship in v1.2.x, an additive `ALTER TABLE … ADD COLUMN library_id INTEGER` runs once.

**Why no schema_version table for v1.1.0:** there is one schema. Future bumps add an explicit version table in the migration that introduces the second schema.

### 4.3 In-memory mirror (critical for sync-API call sites)

`citationColumn.ts` calls `getCachedMetrics` inside Zotero's `dataProvider`, which is **synchronous** (return type `string`, not `Promise<string>`). SQLite queries are async.

**Solution:** Load all rows into a `Map<itemKey, ItemCacheRow>` at startup. Reads hit the map (sync). Writes hit SQLite (async) and update the map atomically.

```ts
// In cache.ts
let mirror: Map<string, ItemCacheRow> = new Map();
let db: Zotero.DBConnection | null = null;

export async function initCache(): Promise<void> {
  db = new Zotero.DBConnection('citegeist');
  await ensureSchema(db);
  const rows = await db.queryAsync<ItemCacheRow>(`SELECT * FROM item_cache`);
  mirror = new Map(rows.map((r) => [r.item_key, r]));
}

// Sync read — used by column dataProvider
export function getCachedMetrics(item: _ZoteroTypes.Item): AllMetrics {
  const row = mirror.get(item.key);
  if (!row) return EMPTY_METRICS;
  return rowToMetrics(row);
}

// Async write — updates SQLite then mirror
async function persistRow(row: ItemCacheRow): Promise<void> {
  await db!.queryAsync(`INSERT OR REPLACE INTO item_cache (...) VALUES (...)`, [...]);
  mirror.set(row.item_key, row);
}
```

Memory cost: ~25 columns × ~50 bytes avg × 50k items ≈ 60 MB worst case. For a 5k-item median library: ~6 MB. Acceptable.

### 4.4 Typings

Add to `typings/zotero.d.ts`:

```ts
declare namespace Zotero {
  class DBConnection {
    constructor(name: string);
    queryAsync<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
    executeTransaction<T>(fn: () => Promise<T>): Promise<T>;
    tableExists(name: string): Promise<boolean>;
    closeDatabase(): Promise<void>;
  }
  const DB: DBConnection;
  namespace Libraries {
    const userLibraryID: number;
    function getAll(): Library[];
  }
  namespace Sync {
    namespace Runner {
      function delaySync<T>(fn: () => Promise<T>): Promise<T>;
    }
  }
}
```

Verify exact signatures against Better BibTeX repo before merging.

## 5. Module API — preserved surface

All exported functions keep current signatures. Three are now **async** that were sync:

| Function | v1.0 | v1.1.0 |
| --- | --- | --- |
| `cacheWorkData` | async | async (unchanged) |
| `clearCache` | async | async (unchanged) |
| `writeNoMatch` | async | async (unchanged) |
| `confirmTitleMatch` | async | async (unchanged) |
| `writePendingSuggestion` | async | async (unchanged) |
| `clearPendingSuggestion` | async | async (unchanged) |
| **Read fns** — all currently sync, all stay sync | sync | sync (hit mirror) |

Read sites unchanged. Write sites unchanged (already async, awaited).

**`clearCache` semantics fix** (coherence finding): keep current wide-clear behavior — deletes work data, match_meta, AND pending_suggestion for the item. `citationPane.ts:447` depends on this. Plan v1 narrowed it incorrectly.

**`sanitizeCacheValue` retention** (coherence nit fix): SQL parameter binding handles SQL escaping. Newline scrub still applied at the **fetch boundary** (after OpenAlex response parse) so display layer never sees raw newlines in journal names etc. Helper moves to `openalex.ts`.

## 6. Migration — one-shot, crash-safe

### 6.1 Trigger

- Runs on `onStartup` after `initCache`, before pane/column registration.
- Pref `extensions.zotero.citegeist.migrationV1Complete` (boolean). True = skip.
- In-progress pref `extensions.zotero.citegeist.migrationV1InProgress` (boolean) — protects against concurrent startup race.

### 6.2 Algorithm — per-item ordering (B2 fix)

```ts
async function migrateFromExtraV1(): Promise<void> {
  if (Zotero.Prefs.get('extensions.zotero.citegeist.migrationV1Complete')) return;

  Zotero.Prefs.set('extensions.zotero.citegeist.migrationV1InProgress', true);

  // Pause sync engine during migration to prevent server-merge resurrecting stripped lines.
  await Zotero.Sync.Runner.delaySync(async () => {
    const items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, false);
    const total = items.length;
    let i = 0;

    showProgressUI({ total });

    for (const item of items) {
      i++;
      if (i % 50 === 0) updateProgressUI({ done: i, total });

      const extra = item.getField('extra');
      if (!extra || !extra.includes('Citegeist.')) continue;

      // Skip if already migrated (idempotency)
      const already = await db!.queryAsync<{ item_key: string }>(
        `SELECT item_key FROM migration_progress WHERE item_key = ?`, [item.key]
      );
      if (already.length > 0) continue;

      const { citegeistFields, otherLines } = parseExtraLegacy(extra);
      if (citegeistFields.size === 0) continue;

      // Round-trip invariant (F6): parse → reconstruct must equal input.
      if (!verifyParseRoundTrip(extra, citegeistFields, otherLines)) {
        Zotero.debug(`[Citegeist] migration: skipping ${item.key} — round-trip failed`);
        continue;
      }

      const row = buildRowFromLegacy(item.key, citegeistFields);

      // Per-item ordering: SQLite first, then Extra strip, then checkpoint.
      // If we crash between any two steps, the next run re-attempts cleanly.
      await db!.queryAsync(`INSERT OR REPLACE INTO item_cache (...) VALUES (...)`, rowParams(row));
      mirror.set(item.key, row);

      // Mirror confirmed_open_alex_id to non-Citegeist Extra key (F2: downgrade safety).
      const newExtra = stripCitegeistLines(otherLines, row.confirmed_open_alex_id);
      item.setField('extra', newExtra);
      await item.saveTx({ skipDateModifiedUpdate: true });

      await db!.queryAsync(
        `INSERT OR REPLACE INTO migration_progress (item_key, migrated_at) VALUES (?, ?)`,
        [item.key, new Date().toISOString()]
      );
    }

    hideProgressUI();
  });

  Zotero.Prefs.set('extensions.zotero.citegeist.migrationV1Complete', true);
  Zotero.Prefs.clearUserPref('extensions.zotero.citegeist.migrationV1InProgress');
}
```

### 6.3 Safety properties

- **Idempotent.** `migration_progress` row per item; re-running is a no-op for migrated items.
- **Crash-safe.** Step ordering = SQLite write → Extra strip → checkpoint. Crash at any boundary re-runs the item; `INSERT OR REPLACE` makes the SQL retry a no-op.
- **Sync-safe.** Entire loop runs inside `Zotero.Sync.Runner.delaySync` (F1 fix). Server-side merge cannot resurrect stripped lines mid-loop.
- **Round-trip verified.** Items where `parseExtraLegacy` cannot reproduce original Extra byte-for-byte are skipped with a debug log (F6 fix).
- **Concurrent-startup guard.** `migrationV1InProgress` pref + per-item `migration_progress` check.

### 6.4 Confirmed-match downgrade mirror (F2)

The single user-curated field — `confirmed_open_alex_id` — is mirrored back to Extra under a non-`Citegeist.` prefix: `OpenAlex match ID: W123456789`. This survives downgrade (1.0.x ignores unknown keys) and reduces cross-device confirmation re-prompting. Done in `stripCitegeistLines` during migration AND on every subsequent `confirmTitleMatch` call.

This is the **only** mirrored field. All other data refetches from OpenAlex on cache miss.

### 6.5 Progress UI

`Zotero.ProgressWindow` modal with: title "Citegeist: migrating cache (one-time)", progress bar, cancel button. Cancel sets `migrationV1Complete = false` and resumes next launch from `migration_progress` checkpoint.

For libraries < 500 items, skip UI entirely (instant). Threshold: `SHOW_PROGRESS_UI_THRESHOLD = 500`.

### 6.6 Orphan row GC (F5)

After migration completes (and on every subsequent startup), run:

```sql
DELETE FROM item_cache
WHERE item_key NOT IN (SELECT key FROM items.items)
```

Implementation: query Zotero for all valid item keys, `DELETE FROM item_cache WHERE item_key NOT IN (...)`. Bounded by library size; runs once per startup post-init.

## 7. Group library policy (v1.1.0)

- Migration scope: **user library only**.
- Group library items: read path returns `EMPTY_METRICS` from mirror → falls through to existing fetch flow → OpenAlex re-fetches and caches in SQLite.
- This avoids the split-brain failure mode (S3 finding). All read paths uniformly hit SQLite-or-fetch.
- v1.2.x will add `library_id` column + group library migration as a separate plan.

## 8. Cross-device sync — explicit user communication

§7 v1 was too quiet. Replace with:

- **README:** new section "Citegeist data is per-device" explaining: data refetches automatically on a new machine; expect a brief loading period; FWCI/citation values may differ slightly across devices reflecting OpenAlex updates between fetches.
- **Changelog 1.1.0:** lead with "Your library data is now untouched by Citegeist — we store everything in our own local cache file" as the *headline*, not a footnote.
- **Confirmed title matches survive sync** via Extra mirror (§6.4).

## 9. Test plan

### Unit tests (vitest)

`cache.sqlite.test.ts`:
- Round-trip: `cacheWorkData` then `getCachedMetrics` returns equal payload.
- `getCachedMetrics` returns suggestion only when count is null.
- `clearCache` removes all three logical groups (work, match, pending).
- `confirmTitleMatch` promotes pending → confirmed.
- `isCacheStale` honors lifetime pref; corrupt date → stale.
- Mirror stays in sync across writes.

`cache.migration.test.ts`:
- Migrates synthetic Extra payload covering all 15+ legacy keys.
- Preserves `otherLines` byte-for-byte (CSL vars, BBT keys, manual notes).
- Idempotent: second run = no-op.
- Crash recovery: simulate interrupt after Step 1 / after Step 2 / after Step 3 → resume completes correctly.
- Round-trip invariant: malformed Extra → item skipped, not corrupted.
- `confirmed_open_alex_id` mirrored to Extra under correct prefix.

### Manual QA

- Fresh profile, no prior data → install → pane + column work.
- Existing v1.0.3 profile → install v1.1.0 → migration runs → Extra clean → metrics present.
- Mid-migration kill → restart → resumes from checkpoint.
- 5k-item library on 2020 MBP → progress UI visible → completes < 60s.
- BBT installed alongside → BBT keys untouched.
- Confirm a title match → restart → match persists (mirror works).
- Restore library backup from before install → orphan rows GC'd on next start.
- Uninstall plugin → grep library for `Citegeist.` → zero matches.

### Acceptance criteria

- All 159 existing tests pass + new tests (target +30 cases).
- `npm run typecheck && npm test && npm run lint && npm run format:check && npm run build` clean.
- Cold-cache pane fetch < 500ms p95 (no regression).
- 5k-item migration < 60s with progress UI visible.
- XPI size delta < +15 KB.

## 10. Rollout

| Version | Change |
| --- | --- |
| 1.1.0   | Migration + SQLite store + Extra strip. Legacy parser retained, gated by pref. |
| 1.1.1   | Legacy parser removed once confirmed quiet (≥ 2 weeks, ≥ 0 blocking issues). |

## 11. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| `Zotero.DBConnection` API differs across Zotero 7 / 8 | Test on 7.0.32 and 8.x before tagging release |
| Migration locks UI on 50k+ libraries | Progress UI with cancel; mirror-load is the hot path, not the strip |
| Corrupt Extra (multi-line values, JSON blobs) | Round-trip invariant assertion (§6.2); skip-with-log on failure |
| User downgrades 1.1.0 → 1.0.x after migration | `confirmed_open_alex_id` mirror in Extra preserves user curation; bibliometric data refetches |
| Plugin DB file corruption | On open failure: log error, refuse to start, prompt reinstall. User Extra is now read-only via legacy parser fallback so no data lost. |
| Group library data invisible until v1.2.x | Read path falls through to OpenAlex fetch + SQLite cache; user sees data, just locally |
| Multi-device value divergence | README section explains expected behavior |

## 12. File-level changes

- **EDIT:** `src/modules/cache.ts` — owns DB connection, mirror, all reads/writes. Adds `initCache()`, `closeCache()`, `migrateFromExtraV1()`. Legacy `parseExtra`/`writeExtra` retained as private migration helpers, removed in 1.1.1.
- **EDIT:** `src/hooks.ts` — `onStartup`: `await initCache(); await migrateFromExtraV1(); await garbageCollectOrphans();` before pane/column registration. `onShutdown`: `await closeCache();`.
- **EDIT:** `typings/zotero.d.ts` — add `DBConnection`, `Libraries.getAll`, `Sync.Runner.delaySync`, expand `Items.getAll` signature.
- **EDIT:** `src/constants.ts` — add `SHOW_PROGRESS_UI_THRESHOLD = 500`. No `MIGRATION_BATCH_SIZE` (chunking not needed inside `delaySync`).
- **EDIT:** `addon/manifest.json` — version → 1.1.0.
- **EDIT:** `package.json`, `package-lock.json` (top + `packages[""]`), `CITATION.cff`.
- **EDIT:** `CHANGELOG.md` — 1.1.0 entry leading with "Your library data is now untouched."
- **EDIT:** `README.md` — new "Multi-device behavior" section.
- **EDIT:** `docs/STATUS.md`, `docs/DESIGN.md` — storage architecture section.
- **NEW:** `docs/solutions/storage/2026-05-27-sqlite-cache-migration.md` — pattern doc.

## 13. Out of scope (tracked separately)

- **Group library migration** — v1.2.x plan, post-v1.1.0 release.
- **Cache export/import JSON** — v1.2.x optional, separate plan.
- **Telemetry to verify rollout** — out, conflicts with free/local promise.

## Appendix A — Why not alternatives

| Alternative | Why rejected |
| --- | --- |
| Plain JSON file | No SQL queryability; no transactions; harder to extend |
| IndexedDB | Non-canonical for Zotero plugins; `Zotero.DBConnection` is documented pattern |
| Child note attachment | Clutters item tree; still touches user-visible data |
| In-memory only | Burns rate limit on column scans |
| External sync service | Contradicts free/local promise |
| Keep Extra + add opt-out pref only | Doesn't solve orphan-on-uninstall; doesn't future-proof |

## Appendix B — Reference implementations

- Better BibTeX: <https://github.com/retorquere/zotero-better-bibtex>
- Zotero sample plugin: <https://www.zotero.org/support/dev/sample_plugin>
- Forum guidance: <https://forums.zotero.org/discussion/113117>
- SQLite access docs: <https://www.zotero.org/support/dev/client_coding/direct_sqlite_database_access>

---

## v3 amendments (post-implementation, after 4 review rounds)

The plan above describes the design as approved for implementation. The
following behaviors were added during four iterative review rounds applied
to commits 1–6 on `feat/sqlite-cache-migration`. Treat this section as the
authoritative description of what actually ships in v2.0.0.

### Schema

- **Composite primary key.** `item_cache` and `migration_progress` both use
  `PRIMARY KEY (library_id, item_key)` instead of `item_key` alone. Zotero
  item keys are unique within a library but NOT across libraries; without
  the composite key, same-key items in different libraries would silently
  collide.
- **`schema_meta` table** introduced (currently records `version='1'`).
  Establishes the version-tracking convention for future schema changes.
- **No `idx_item_cache_last_fetched` index.** The original plan declared
  one; staleness checks happen against the in-memory mirror and never query
  SQLite, so the index was pure write-amplification. Init now runs
  `DROP INDEX IF EXISTS` to clean up any alpha-built database.

### Concurrency

- **`initCache` is race-safe.** Concurrent callers share an in-flight
  promise so Zotero's update-restart sequence can't open two
  `DBConnection`s.
- **Per-key write serialization** via a small promise-tail map in `db.ts`.
  Writes to different `(libraryID, itemKey)` keys run in parallel; same-key
  writes queue. Prevents mirror/SQLite divergence under contention.
- **`closeCache` drains pending writes** with a 5-second timeout. A hung
  SQLite write can't block Zotero shutdown.
- **`confirmTitleMatch` atomically promotes pending → confirmed** AND
  clears the pending block in a single upsert. No window where a reader can
  see both fields populated.

### Migration hardening

- **Zotero version gate.** Migration refuses to run on Zotero < 7.0.10
  (where `saveTx({ skipDateModifiedUpdate: true })` is silently ignored).
  `addon/manifest.json` also raises `strict_min_version` to `7.0.10` so the
  plugin doesn't even load on older builds.
- **Per-item try/catch** around the migration loop. One poison item logs and
  is skipped; future launches retry it without re-attempting completed work.
- **`MIGRATION_MAX_CANDIDATES = 200_000` cap** and `isRegularItem()` filter
  defuse malicious-import explosions.
- **Batch checkpoint load.** A single `SELECT library_id, item_key FROM
  migration_progress` replaces N per-item SELECTs.
- **Adaptive progress tick.** Scales with library size so 50k migrations
  produce ~200 UI updates, not 1000.
- **Throttled error logs** capped at `MIGRATION_LOG_CAP = 50`.
- **Post-migration spot check** verifies a sample of items still have
  stripped Extra fields. Detects hypothetical `delaySync` regression.
- **REL-002 silent-data-loss guard.** `shouldForceRerun` detects the state
  where the completion pref is set but SQLite is empty AND legacy data
  still lives in Extra. Clears the pref and re-runs.
- **Round-trip salvage.** Items whose Extra parse round-trip is ambiguous
  now have their SQLite row written best-effort (cached metrics preserved)
  but Extra is left intact and migration refuses to mark complete until the
  ambiguity is resolved.
- **`item.deleted` filter** in both migration AND `fetchAndCacheItem` so
  trashed items don't get SQLite rows written for them.

### Security

- **OpenAlex ID validation** at every cache-write boundary (`/^W\d+$/`,
  `/^S\d+$/`). Malformed IDs are rejected rather than persisted to the
  Extra-field mirror where they could spoof CSL metadata.
- **`sanitizeForDisplay` extended** to strip Unicode line separators
  (U+0085, U+2028, U+2029) in addition to ASCII `\r\n`.

### API & types

- **`AllMetrics.suggestion`** typed via `SuggestionPreview` referencing the
  canonical `MatchTier` instead of an inline literal union.
- **Cache-owned input types** (`CacheWorkInput`, `CacheSourceStatsInput`,
  `CachePendingSuggestionInput`). Cache module no longer imports OpenAlex
  types — callers pass them, structural assignability handles the rest.
- **Structural `CacheItemKey` type** replaces `_ZoteroTypes.Item` on
  read-only signatures.
- **Dead exports removed:** `mirrorEntries`, `_resetForTesting` from
  `index.ts`, `cacheReady`, unused `executeTransaction`/`tableExists` from
  typings.

### Performance

- **`UPSERT_SQL` constant** hoisted; no per-call string concatenation.
- **WeakMap-cached `sourceISSNs` parsing.** The comma-joined string is
  split once per row, cached against row identity.
- **Pref memoization** on `cacheLifetimeDays` (1s TTL) so column rendering
  doesn't call `Zotero.Prefs.get` thousands of times per tick.
- **`writeTails` Map** now self-cleaning. Entries drop when no subsequent
  writer chained on them.
- **`Object.freeze(EMPTY_METRICS)`** + frozen inner `sourceISSNs` array.
  Caller mutation throws instead of cascading across uncached items.
- **`garbageCollectOrphans` rate-limited** to once per 7 days via
  `lastOrphanGcAt` pref; `{ force: true }` overrides for explicit
  rebuild flows.

# Migrating from v1.3.x to v2.0.0

> v2.0.0 moves cached citation data out of Zotero item `Extra` fields into a plugin-owned SQLite database. Storage format changed; UI and feature set didn't.

## Why this change

v1.3.x stored cached metrics in each item's `Extra` field as namespaced lines:

```
Citegeist.openAlexId: W12345678
Citegeist.citedByCount: 42
Citegeist.fwci: 2.31
…
```

Four problems with that:

1. **Tenancy collision.** Better BibTeX, Zutilo, and CSL processors all touch Extra. Shared namespace was a known footgun.
2. **CSL template leakage.** Templates can pull from Extra. A misconfigured template could surface bibliometric data inside generated citations.
3. **Orphan data on uninstall.** Removing Citegeist left `Citegeist.*` lines in every item forever.
4. **Backup-restore staleness.** Restoring an older library backup overwrote fresher cached values silently.

v2.0.0 uses the documented Zotero 7+ plugin storage pattern: a plugin-owned SQLite file opened via `Zotero.DBConnection`. Better BibTeX uses the same pattern.

## What v2.0.0 does

### On first launch

1. Refuses to load on Zotero older than 7.0.10. (Older builds silently ignore the metadata flag the migration needs.)
2. Creates `<profile>/citegeist.sqlite` and its tables.
3. Scans every regular item in every library. For each item with `Citegeist.*` lines in Extra:
   - Parses the lines.
   - Writes parsed values to SQLite.
   - Removes the `Citegeist.*` lines from Extra.
   - Checkpoints the item.
4. Re-emits one line — `Citegeist match ID: W…` — to Extra for items with a previously confirmed title match. This is the only data that survives plugin downgrade and propagates across devices via Zotero Sync.

### On every subsequent launch

- Loads the SQLite cache into an in-memory mirror. Column rendering hits the mirror; no SQL per row.
- Garbage-collects orphan rows (items deleted while the plugin was offline). Rate-limited to once per 7 days.

### When the plugin is removed

- Pane and columns unregister.
- `<profile>/citegeist.sqlite` stays on disk; delete it manually if you want a clean uninstall.
- The `Citegeist match ID:` line in Extra survives. Plain text; delete manually if unwanted.

## Before upgrading

Back up your Zotero data directory:

1. In Zotero: right-click anywhere in the library tree → **Show Data Directory**.
2. Quit Zotero on every device.
3. Copy that folder somewhere safe (Time Machine, Dropbox version history, or a sibling `Zotero.backup-pre-v2.0.0`).
4. Restart Zotero, install v2.0.0.

To roll back: quit Zotero, swap the folders, reinstall v1.3.x.

## After upgrading

Open `Help → Debug Output Logging → View Output` and check for:

```
[Citegeist] cache initialized: N rows
[Citegeist] migration complete: M items processed
```

- `N` is current SQLite row count. First migration: `N == M`.
- `migration deferred: Zotero X.Y.Z < 7.0.10` → update Zotero, restart.
- `cache not initialized` → SQLite file can't open. Usually antivirus quarantine of `<profile>/citegeist.sqlite`. Whitelist, restart.

## UI changes

- Citation columns: same data, now sourced from SQLite via the in-memory mirror.
- 3-tile metric pane (Citations / FWCI / Percentile) now adapts to Zotero theme. v1.3.x hardcoded dark-theme colors that rendered invisibly on light theme; v2.0.0 inherits the active theme.

## Recovery paths

### "Migration ran but my data is gone"

1. Check an item's Extra for a `Citegeist match ID: W…` line. If present, your confirmed matches survived — restart and let auto-fetch refill column data.
2. If not: the debug log shows why migration skipped the item. Usually round-trip parse refused (Extra left intact) or per-item save error (logged).

### Roll back to v1.3.x

1. Quit Zotero.
2. Download a v1.3.x XPI from [GitHub Releases](https://github.com/phdemotions/zotero-citegeist/releases).
3. Restart, then install via **Tools → Plugins → gear icon → Install Plugin From File**.
4. `Citegeist match ID:` lines sit harmlessly; v1.3.x doesn't read them.
5. `citegeist.sqlite` stays on disk unused. Delete if wanted.

Items v1.3.x can't refetch automatically need a manual right-click → **Fetch Citation Counts**.

### Clean slate

1. Quit Zotero.
2. Delete `<profile>/citegeist.sqlite`.
3. Restart.

Cache rebuilds from OpenAlex as you scroll. No data loss; every value can be re-fetched.

## Internals

- Mirror: `Map<\`${libraryID}:${itemKey}\`, ItemCacheRow>` loaded at startup from `SELECT * FROM item_cache`.
- Schema: composite PK `(library_id, item_key)`. Items in different libraries with the same Zotero key don't collide.
- Crash-safe: per-item ordering is SQLite write → Extra strip → checkpoint. Crash between any two steps re-runs the item on next launch.
- Migration loop runs inside `Zotero.Sync.Runner.delaySync` so the sync engine can't merge stripped lines back mid-migration.

See [`docs/plans/2026-05-27-001-feat-sqlite-cache-migration-plan.md`](plans/2026-05-27-001-feat-sqlite-cache-migration-plan.md) for full design and the `v3 amendments` section documenting refinements applied across review rounds.

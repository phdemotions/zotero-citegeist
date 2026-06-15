---
type: migration
title: Migrating from v1.3.x to v2.0.0
description: v2.0.0 moves cached citation data from Zotero Extra fields to a plugin-owned SQLite database.
timestamp: 2026-06-07
tags: [citegeist, migration, cache, sqlite]
---

# Migrating from v1.3.x to v2.0.0

> v2.0.0 moves cached citation data out of Zotero item `Extra` fields into a plugin-owned SQLite database. Storage format changed; UI and feature set didn't.

## If you're upgrading from 1.x — the short version

Citegeist 1.x wrote everything it cached about a paper — citation count, FWCI, percentile, journal metrics, and any title match you confirmed — into that item's **Extra** field, tagged with `Citegeist.` prefixes. 2.0 stops doing that. All of it now lives in a separate database file Citegeist owns (`citegeist.sqlite`, in your Zotero profile folder), and the `Citegeist.` lines are cleaned out of your items. Same columns, same pane, same features — only the storage underneath changed.

**What you need to do**

1. Update Zotero to **7.0.10 or newer** if you haven't. 2.0 won't load on older builds — the migration relies on a metadata flag they quietly ignore, and running without it would mark your whole library as modified and trigger a full re-sync.
2. **Back up your Zotero data directory** before you update — see [Before upgrading](#before-upgrading). Citegeist writes its own safety-net snapshot first, but a full backup is the right habit for a storage change.
3. Install 2.0 and start Zotero. The migration runs once, on its own — instant for most libraries, a short progress window for large ones (500+ Citegeist items).

**What carries forward, and what doesn't**

| What you had in 1.x | What happens in 2.0 |
| --- | --- |
| **Title matches you confirmed by hand** | Kept. The OpenAlex ID is preserved and also written back to Extra as a single `Citegeist match ID: W…` line, so it survives a downgrade and syncs to your other devices. You won't have to re-confirm anything. |
| **Citation counts, FWCI, percentile, journal metrics** | Re-fetched automatically from OpenAlex the first time you view each item, on each device. Expect a brief "loading" beat on first scroll — nothing is lost, every value is re-derivable. |
| **The `Citegeist.` lines in your items' Extra** | Removed. This is the point of the release: your bibliographic records stop carrying Citegeist's bookkeeping. |
| **Everything else in your library** | Untouched. Citegeist never writes anything else to your items, and uninstalling now leaves your library exactly as it was. |

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

## What Citegeist does automatically to keep your data safe

Before the migration touches a single item, Citegeist writes a JSON snapshot to your Zotero data directory at:

```
<dataDir>/citegeist-migration-backup-<ISO-timestamp>.json
```

The file contains the **full pre-migration Extra contents** of every item Citegeist is about to modify, keyed by `library_id` and `item_key`. Schema:

```json
{
  "schema": "citegeist-migration-backup/v1",
  "plugin_version": "2.0.0",
  "zotero_version": "7.0.10",
  "timestamp": "2026-05-28T...",
  "note": "Restore by copying the `extra` field back to the matching item via Zotero's UI.",
  "items": [
    { "library_id": 1, "item_key": "ABC12345", "extra": "...full Extra text..." }
  ]
}
```

A one-time alert after the migration tells you the exact path. The file is plain JSON — open it in any text editor.

**To restore a specific item by hand:**

1. Find the item in Zotero. Note its 8-character item key (right-click → Show File → the key is in the filename, or copy from the item URL).
2. Open the backup JSON. Search for the `"item_key": "<KEY>"` line.
3. Copy the `"extra": "..."` string value.
4. In Zotero, select the item → click **Extra** in the right pane → paste.

Citegeist will see your `Citegeist.*` lines again on the next launch and re-migrate them idempotently (the SQLite row already exists from the first migration; only the Extra strip needs to re-run).

**The backup file is never deleted automatically.** Delete it yourself once you're confident the migration was clean. Keeping it indefinitely is harmless — it's a single JSON file, typically a few hundred KB to a few MB.

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

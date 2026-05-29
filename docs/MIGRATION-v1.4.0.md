# Migrating from v1.3.x to v1.4.0

> Citegeist v1.4.0 moves cached citation data out of Zotero item `Extra` fields and into a plugin-owned SQLite database. This is the largest internal change since v1.0 and the biggest user-visible change in plugin behavior.

## Why this change

Until v1.3.x, Citegeist stored cached metrics in each item's `Extra` field as namespaced lines:

```
Citegeist.openAlexId: W12345678
Citegeist.citedByCount: 42
Citegeist.fwci: 2.31
…
```

User feedback flagged four real problems with that approach:

1. **Tenancy collision.** Better BibTeX, Zutilo, and CSL processors all read or write Extra. The shared namespace was a known footgun.
2. **CSL template leakage.** Citation-style templates can pull from `Extra`. A misconfigured template could surface Citegeist's bibliometric data inside generated citations.
3. **Orphan data on uninstall.** Removing Citegeist left `Citegeist.*` lines in every item forever. There was no clean way to take it back.
4. **Backup-restore staleness.** Restoring an older library backup would overwrite fresher cached values without any signal to the user.

v1.4.0 follows the canonical Zotero 7+ plugin storage pattern — a plugin-owned SQLite database opened via `Zotero.DBConnection`, identical to what Better BibTeX has used for years.

## What v1.4.0 actually does

### On first launch

1. Verifies you're on Zotero 7.0.10 or newer. (Older builds silently ignore the metadata flag the migration needs; the plugin refuses to load on those builds so it never corrupts your data.)
2. Creates `<profile>/citegeist.sqlite` and its tables.
3. Scans every regular item in every library you have access to. For each item that contains `Citegeist.*` lines in its Extra:
   - Parses the lines.
   - Writes the parsed values to SQLite.
   - Removes the `Citegeist.*` lines from the Extra field.
   - Checkpoints the item so it isn't re-processed.
4. Re-emits a single line — `Citegeist match ID: W…` — to the Extra field of items where you previously confirmed a title match. This is the only data that survives plugin downgrade and propagates across devices via Zotero Sync.

### On every subsequent launch

- Loads the SQLite cache into an in-memory mirror. Column rendering hits the mirror directly (no SQL query per row).
- Garbage-collects orphan rows (rate-limited to once per 7 days) — rows whose item no longer exists in any library.

### When the plugin is removed

- The plugin's icon disappears and its sidebar pane and columns are unregistered.
- `<profile>/citegeist.sqlite` stays on disk but is no longer opened. Delete it yourself if you want a clean uninstall.
- The `Citegeist match ID:` line we wrote to Extra survives. It's plain text; you can delete it manually.

## Before upgrading

**Back up your Zotero data directory.** This is the standard recommendation for any plugin update that touches stored data:

1. In Zotero: right-click anywhere in the library tree → **Show Data Directory**.
2. Quit Zotero completely on every device.
3. Copy that folder somewhere safe — Time Machine, Dropbox version history, or a sibling `Zotero.backup-pre-v1.4.0` directory.
4. Restart Zotero and install v1.4.0.

If anything goes wrong, you can restore the backup by quitting Zotero, swapping the folders, and reinstalling v1.3.x.

## After upgrading

**Open `Help → Debug Output Logging → View Output`** and look for two lines on startup:

```
[Citegeist] cache initialized: N rows
[Citegeist] migration complete: M items processed
```

- `N` is the number of items currently in the SQLite cache. For a first migration `N` will be `M`.
- If you see `migration deferred: Zotero X.Y.Z < 7.0.10`, you're on an unsupported build. Update Zotero, then restart.
- If you see `cache not initialized`, the plugin can't open its SQLite file. Most common cause is antivirus quarantine of `<profile>/citegeist.sqlite`. Whitelist the file and restart.

## What changed in the UI

- The citation count column still shows. Same data path; just reads from SQLite via the in-memory mirror instead of from Extra.
- The pane redesign you might remember from v1.3.0 (the 3-tile metric grid) now adapts to your Zotero theme. Light theme renders dark text; dark theme renders light text. Previously the tile values were hardcoded for dark theme and invisible on light.

## Recovery paths

### "Migration ran but my data is gone"

1. Look at one of your items. Is there a `Citegeist match ID: W…` line in Extra? If yes, your confirmed matches survived — the cache just hasn't been populated yet. Restart Zotero and let the auto-fetch refill column data.
2. If not, your debug log will show why migration skipped that item. Common reasons: round-trip parse refused (item had ambiguously-shaped legacy data — Citegeist preserved your Extra unchanged), or per-item save error (rare; logged with a one-line reason).

### "I want to roll back to v1.3.x"

1. Quit Zotero.
2. Download a v1.3.x XPI from [GitHub Releases](https://github.com/phdemotions/zotero-citegeist/releases).
3. Restart Zotero. Install the older XPI via **Tools → Plugins → gear icon → Install Plugin From File**.
4. The `Citegeist match ID:` lines we wrote will sit harmlessly in Extra. v1.3.x doesn't read them.
5. The `citegeist.sqlite` file stays on disk, unused. Delete it if you want.

You'll be back where you started, minus any items v1.3.x couldn't refetch (those will need a manual **Fetch Citation Counts** right-click).

### "I want a clean slate"

1. Quit Zotero.
2. Delete `<profile>/citegeist.sqlite` (from the same Show Data Directory location).
3. Restart Zotero.

Citegeist will rebuild the cache from scratch as you scroll through your library. No data loss — every value comes from OpenAlex and can always be re-fetched.

## Internals (if you're curious)

- Mirror: `Map<\`${libraryID}:${itemKey}\`, ItemCacheRow>` loaded at startup from `SELECT * FROM item_cache`.
- Schema: composite primary key `(library_id, item_key)`. Two items in different libraries with the same Zotero key don't collide.
- Migration is crash-safe: per-item ordering is SQLite write → Extra strip → checkpoint. A crash between any two steps re-runs the item on next launch with no data loss.
- The migration loop runs inside `Zotero.Sync.Runner.delaySync` so the sync engine doesn't merge the stripped lines back from a server snapshot mid-migration.

See [`docs/plans/2026-05-27-001-feat-sqlite-cache-migration-plan.md`](plans/2026-05-27-001-feat-sqlite-cache-migration-plan.md) for the full design, review record, and `v3 amendments` section documenting every refinement applied across the iterative review rounds.

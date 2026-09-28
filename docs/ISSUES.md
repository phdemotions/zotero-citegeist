---
type: issues
title: Citegeist — open issues
description: Open bugs, verification gates, and technical debt, tracked by priority.
timestamp: 2026-09-28
tags: [citegeist, issues]
---

# Citegeist — Open Issues

> **Last Updated:** 2026-09-28 (plan consolidation: BUG-Z10-INSTALL still live after 42 days; BUG-ROWPROXY filed, a suspected shipped bug found by review on 2026-09-14 and never recorded; BUG-PREFS carries its open round-2 findings; the live plan is `docs/plans/2026-09-13-001-fix-zotero-10-compat-host-bugs-plan.md`.)
> **Previously:** 2026-08-13 (planning unification: FEAT-003/FEAT-004 moved out — feature requests live in `BACKLOG.md` + GitHub `enhancement` issues; this tracker carries bugs, verification gates, and debt only.)
> 2026-08-02 (GitHub-issue reconcile: the right-click-menu bug (#67/#72) is confirmed STILL OPEN on the released v2.0.5 by 3 users — the internal tracker had it marked fixed; added BUG-MENU + BUG-QUIT (#78) + OKF drift #79. **v2.0.5 is the last released version**, 2026-07-09.)
> 2026-07-20 (DIAG-001 + DEBT-010 closed: diagnostic codes and guards now cover the network dialog; settings pane swapped the dead `mailto` field for the `api_key` field). 2026-07-18 (author-identity layer **v3.0.0 merged to `main`** #75, untagged — see STATUS.md). Closed issues archived to `docs/archive/issues-closed.jsonl`.

---

## Summary

| Priority     | Open |
| ------------ | ---- |
| P0 (Blocker) | 3    |
| P1 (High)    | 3    |
| P2 (Medium)  | 8    |
| P3 (Low)     | 7    |

Feature requests are not tracked here — they live in [`BACKLOG.md`](BACKLOG.md) (curated detail) and GitHub `enhancement` issues (public intake).

---

## P0 — Blockers

### BUG-Z10-INSTALL: Citegeist cannot be installed on Zotero 10

**Impact:** Every Zotero 10 user is locked out. v2.0.5's manifest and the live `update.json` both cap the plugin at `strict_max_version: "9.*"`, so Zotero 10.0.x refuses the install ("could not be installed. It may be incompatible with this version of Zotero") and disables an existing copy after upgrading. Zotero 10.0 shipped 2026-08-17; the first report arrived 2026-09-13 on the Zotero forums ([comment 518143](https://forums.zotero.org/discussion/comment/518143#Comment_518143), Zotero 10.0.2, Windows 11). No GitHub issue exists yet.
**Status (2026-09-28):** Still live, 42 days after Zotero 10.0 shipped. The planned bridge (raising 2.0.5's cap in `update.json`) was withdrawn after its smoke run failed: on Zotero 10.0.4, and on Zotero 9.0.6 as a baseline, released v2.0.5 renders no pane (BUG-PANE-XML), shows blank menu labels (BUG-MENU) and crashes Zotero on quit (BUG-QUIT), so re-enabling it would harm Zotero 10 users. On draft PR [#93](https://github.com/phdemotions/zotero-citegeist/pull/93), the manifest takes its range from `package.json` (capped `10.0.*`) and Zotero 10's throwing selection getters are replaced (U1, U2). Zotero is at 10.0.3 (Linux, Windows) and 10.0.4 (macOS), all inside `10.0.*`.
**Fix:** v2.0.6 (plan U3, Decisions item 2), proved with the local smoke run on Zotero 9 and 10 before release; the scheduled Zotero watch (U10) catches the next cap lockout before users do.
**Found:** 2026-09-13.

### BUG-PANE-XML: The item pane never renders in v2.0.4 and v2.0.5, and hides other plugins' panes

**Impact:** Zotero parses an item-pane section's body as XML. Since v2.0.4 the pane's embedded `<style>` has held a `<strong>` inside two CSS comments, with no CDATA wrapper, so Zotero reports "not well-formed XML" and never initialises Citegeist's section: no pane, no sidenav button. Other plugins' item-pane sections stop rendering too: a control section rendered without Citegeist and did not render beside v2.0.5. Reproduced on 2026-09-28 in fresh profiles on Zotero 9.0.6 and 10.0.4 (`itemPaneSection.js` at 9.0.6, line 288; `itemPaneCustomSection.js` at 10.0.4, line 140). A June memory note said the CDATA fix shipped in v2.0.5; the v2.0.5 tag has no CDATA, and only `main` has the fix.
**Fix:** v2.0.6 wraps the `<style>` in CDATA as `main` does, with the no-`<`/`&` guard test `main` already has.
**Found:** 2026-06 (fix on `main` only); confirmed in released v2.0.5 on 2026-09-28.

### BUG-QUIT: Zotero 9.0.6 hangs on quit → force-quit required (#78)

**Impact:** With Citegeist enabled, quitting Zotero 9.0.6 shows a spinning loader and never exits; the user must force-quit. Reported on v2.0.5 / macOS. A hang on every quit is severe.
**Status:** Not yet reproduced or root-caused. The v3.0.0 shutdown rework on `main` (bounded cache drain, explicit `chromeHandle.destruct()`) does **not** run on quit: `addon/bootstrap.js` returns early on `APP_SHUTDOWN` in both v2.0.5 and `main`, so `onShutdown` and `closeCache()` never execute when the user quits, and the plugin's own `Zotero.DBConnection("citegeist")` is still open at exit. Treat #78 as open on `main`. Planned as U6 in `docs/plans/2026-09-13-001-fix-zotero-10-compat-host-bugs-plan.md`.
**Reproduced (2026-09-28):** in fresh isolated profiles on Zotero 9.0.6 and 10.0.4 on macOS, quitting with v2.0.5 took 61 s and ended in a crash (exit code 139), while quitting without Citegeist took 0.5 s with exit code 0. The 60 s matches Firefox's shutdown watchdog, which aborts when a database connection is still open: `addon/bootstrap.js` returns early on `APP_SHUTDOWN`, so `citegeist.sqlite` is never closed. Josh's own Mac runs the reporter's setup, Zotero 9.0.6 on macOS. A round-B reviewer expects every real-Zotero CI cell's closing quit to stall on the still-open `citegeist.sqlite`, which would reproduce the hang on Linux too. After the U17 bridge, Zotero 10 users meet it as well.
**Fix:** Reproduce on real Z9.0.6 (macOS) with Debug Output and confirm the blocker in Zotero/Firefox source before changing code. Leads, none confirmed: the open SQLite connection at quit; `bootstrap.js` dropping the promise from `citegeist.shutdown()`; unbounded awaits in `closeCache()`; fetch batches that cannot be cancelled.
**Found:** 2026-07-23.

---

## P1 — High Priority

### BUG-PREFS: Settings-pane choices are never read (doubled pref prefix)

**Impact:** Changing auto-fetch, cache lifetime, or citation-network page size in Zotero → Settings → Citegeist has no effect, and on `main` the optional OpenAlex API key is never sent. Zotero's `Zotero.Prefs.get(pref, global)` and `set(pref, value, global)` prepend `extensions.zotero.` unless `global` is `true` (Zotero `chrome/content/zotero/xpcom/prefs.js` at tag 10.0.2). Citegeist's pref constants are already full names (`extensions.zotero.citegeist.*`) and every call omits `true`, so each read looks up `extensions.zotero.extensions.zotero.citegeist.*`, which is never set. Released v2.0.5 carries the same pattern. Internal flags (migration done, relation purge done, last orphan GC, last backup path) were written and read under the same doubled name, so a naive fix would re-run the one-shot migration and purge for every user.
**Status:** Landed on `fix/zotero-10-compat` (draft PR [#93](https://github.com/phdemotions/zotero-citegeist/pull/93)) as plan unit U18: commit 6215ec0 and the review-round-1 fix commit after it. `src/modules/prefs.ts` is the only module that reads or writes a Citegeist pref, always under its real name, and `test/prefs-invariants.test.ts` bans direct `Zotero.Prefs` calls elsewhere. Three internal flags (migration done, relation purge done, last backup path) are read from the doubled name when the real name is unset and copied forward. The doubled keys are kept on purpose, for downgrade safety: v2.0.5 reads only that name, so Citegeist never removes one, and it writes `migrationV1Complete` there too, or a downgrade would migrate again and strip `Citegeist match ID:` lines. `lastOrphanGcAt` is excluded from the fallback: earlier builds wrote `Date.now()` into a 32-bit integer pref, so the doubled value is a wrapped number unrelated to the time, and copying it would make the real name an integer pref that wraps every later write. It is now stored as a decimal string. Because the settings are now read, auto-fetch runs for the first time; U18 limits it to free identifier lookups and stops it on a rejected key, a spent budget or a read-only cache. Found by the real-Zotero harness work (U4), confirmed against Zotero source.
**Open on the branch (2026-09-28):** review round 2 (2026-09-14) is not clean and nothing from it is fixed yet, including a P1: every background lookup that lands reloads the whole item list in every window. The fix batch is listed under "Open findings" in the live plan. Because no v2.x user ever had auto-fetch, v3.0.0 switches it on for everyone for the first time; the plan gates that on the P1 fix and a timing check on a large library.
**Fix:** Ship in v3.0.0; not in v2.0.6, whose scope stays minimal.
**Found:** 2026-09-13.

### SEC-001: Security fix in the citation browser (details held until the fix ships)

**Impact:** A markup-handling defect in the citation-network browser, present in every released version. Details are held in a private GitHub security advisory until users have the fix, following coordinated-disclosure practice; the maintainer's notes are in the advisory. It supersedes DEBT-011.
**Fix:** Ships in v2.0.6 and v3.0.0, with a regression test; the advisory and this entry are completed when the fix is released.
**Found:** recorded as DEBT-011 in the #77 review (merged 2026-08-02); re-rated 2026-09-28.

### BUG-MENU: Right-click menu stops responding after one use on Zotero 8/9 (#67, #72)

**Impact:** On Zotero 8/9, the Citegeist context-menu entries can render without labels, and after using one entry the right-click menu stops opening on **any** item until the plugin is toggled off/on or Zotero restarts. Breaks a core surface for Z8/9 users. **Confirmed STILL BROKEN on the released v2.0.5 by three users** (MattGiulP, bwegge, scolino — latest confirmation 2026-07-23), after two fix attempts (the v2.0.5 hotfix per [#67](https://github.com/phdemotions/zotero-citegeist/issues/67); registration-lifecycle plan `docs/plans/2026-07-06-001-fix-menu-manager-registration-lifecycle-plan.md`). The stray-empty-section half of #72 appears addressed; the "menu dies after use" half is not.
**Status:** `main`/v3.0.0 carries further MenuManager registration + teardown work (the code cites #67/#72), but it is **unverified on a real Zotero 9** and unreleased — so from a user's view it is still open. This is the top item on the `docs/RELEASE-CHECKLIST.md` right-click-menu gate; do not claim fixed until confirmed on a real Z9 install.
**Reproduced (2026-09-28):** in fresh profiles on Zotero 9.0.6 and 10.0.4, v2.0.5's three item entries appear with blank labels, five opens of five: v2.0.5 loads its strings only when a window opens, and the main window is already open when it starts (the Zotero 9 write-up's root cause 2).
**Lead (2026-09-28, round-B review):** every released version unregisters its MenuManager menus with the raw id (`citegeist-item-menu`), but Zotero stores and removes them only under `CSS.escape(pluginID + "-" + menuID)`. Teardown and rollback therefore remove nothing, and a later registration refused as a duplicate falls back to DOM entries beside the stale MenuManager set: the dual-menu state the v2.0.5 plan suspected. Confirmed by running Zotero 9.0.6's own `pluginAPIBase.mjs`; v2.0.5 `menu.ts:377`, `main` `menu.ts:587` and `:801`. In normal use Zotero's own cleanup removes the menus on disable, so this alone may not explain the first-use death; it is where U7 starts.
**Second lead (2026-09-28, first CI run):** a main window that keeps Citegeist's translation link after the plugin's translation source is unregistered makes every context-menu build reject until the source returns (BUG-DISABLE-L10N). Toggling the plugin off and on, the workaround reporters use, re-registers that source.
**Fix:** Needs a real-Zotero-9 debug session to find why the popup stops responding after the first `onCommand`/`onShowing` (likely a MenuManager `onShowing`/DOM-fallback interaction that corrupts the native popup). Keep #67 and #72 open until users confirm.
**Found:** #67 2026-06-25, #72 2026-07-14.

---

## P2 — Medium Priority

### JOSS-001: Paper submission not yet filed

**Impact:** JOSS citation credibility + discoverability
**Fix:** Confirm target journal, run final checks on `paper/paper.md`, submit
**Found:** 2026-04-08 — paper.md exists and is complete, submission is the remaining step

### BUG-ROWPROXY: Refreshing an item cached in an earlier session may fail on v2.0.x (suspected)

**Impact:** If real, re-fetching any item whose metrics were cached in an earlier session fails on every v2.0.x install, and the pane keeps showing the old numbers. v2.0.0 to v2.0.5 load Zotero's query rows straight into the in-memory mirror. Zotero wraps each row in a Proxy with only `get` and `has` traps (`db.js` at 9.0.6, line 683), so spreading one (`...base` in `cache/write.ts`) keeps none of its columns, and the write that follows lacks `library_id` and `item_key`. Found by reading Zotero's and Gecko's source during review on 2026-09-14; not reproduced, and no user has reported it.
**Status:** Fixed on `fix/zotero-10-compat` by copying rows at load (318885c).
**Fix:** A real-Zotero spec that spreads a row from Citegeist's own `DBConnection` on Zotero 8, 9 and 10 confirms or refutes it (plan: next steps, step 5). If confirmed, raise to P1 and ship the row copy in v2.0.6.
**Found:** 2026-09-14 (review); filed 2026-09-28.

### BUG-GROUPADD: With a group-library collection selected, every Add in the citation browser fails

**Impact:** The citation browser takes the selected collection as its default filing target. When that collection belongs to a group library, "Add" creates the new item in My Library and files it into the group collection, which Zotero's database trigger refuses (`fki_collectionItems_libraryID`), so every row shows "Add failed — please try again" until the user picks the Library root in the picker. Released v2.0.5 does the same (`dialog.ts:203`, `getSelectedCollection()`). Found by the round-B adversarial review on 2026-09-28 against Zotero 9.0.6 source, with the trigger run in SQLite.
**Fix:** Default only to collections in the user library, the only library the dialog adds to; add a test with a group collection selected. v2.0.6 rewrites the same line for Zotero 10 and takes this fix too.
**Found:** 2026-09-28.

### BUG-MIGRATION: The v1.3.x → v2 cache migration has never run

**Impact:** Since v2.0.0 (c99ef8f, 2026-06-07), `cache/migration.ts` calls `await Zotero.Sync.Runner.delaySync(async () => { … })`. Zotero's `delaySync(ms)` takes a number of milliseconds and never calls a function (`syncRunner.js` at 8.0.4, line 1037, unchanged since), so the migration loop has never run on any install: no v1.3.x profile's confirmed matches were imported, no backup was written, and the done flag was set anyway. While the cache is empty, the scan repeats at every launch. Nothing was stripped from anyone's Extra field. The typings declare a signature Zotero lacks, and three unit-test mocks call the function, which hid it. Found by the first real-Zotero CI run (spec 92) and its triage on 2026-09-28.
**Status (2026-09-28):** Fixed on `fix/zotero-10-compat` as an import only, per the plan's Decisions, item 8. `migrateFromExtraV1` holds sync with `Zotero.Sync.Runner.delayIndefinite()` and releases it in a `finally` (the API exists and returns the release function at 7.0.10, 8.0.4, 9.0.6 and 10.0.2), loads each library's items before reading them, and copies one value into the cache: the confirmed title match, from v1.x's `Citegeist.confirmedOpenAlexId` or the `Citegeist match ID:` line, which wins. It writes no item and no backup file, keeps any confirmation, no-match or other work's metrics the cache already holds, and runs once per profile under a new flag, `extraMatchImportComplete`. The old `migrationV1Complete` no longer gates it, and a finished pass still writes it under both names for a downgraded copy. A pass cut short runs again at the next launch. The typing and the three test mocks now behave like Zotero, and real-Zotero spec 93 seeds v1.3.x items and checks the imported rows, byte-identical Extra and no second scan.
**Follow-ups:** (1) Removing the old lines from Extra becomes an explicit command with its own backup. It is a visible surface, so it waits on a mockup and Josh's approval. (2) `docs/MIGRATION-v2.0.0.md` and the one-time startup alert in `hooks.ts` still describe the strip and its backup file; the alert can no longer fire, because `migrateFromExtraV1` resolves false. (3) The runtime never reads a `Citegeist match ID:` line, so a match confirmed on another device after this one imported, or one lost with a cache deleted after the import, is not picked up; reading the line at fetch time would cover both. (4) Same class, not fixed here: `purgeAllAuthorRelations` (`cache/authors/relations.ts`) reads each item's relations without loading its library first, and Zotero throws for an item whose library has not been shown yet (`dataObject.js` at 10.0.2, `_requireData`), so on a real library the purge can fail and retry at every launch.
**Found:** 2026-09-28.

### BUG-DISABLE-L10N: Disabling or removing Citegeist breaks the main window's text until restart

**Impact:** Citegeist's shutdown leaves its `<link rel="localization" href="citegeist.ftl">` in the main window (only window unload removes it, in v2.0.5 and on `main`). Zotero then unregisters the plugin's translation source, and every translation the window rebuilds fails: the right-click menu build rejects before other plugins' entries refresh, and newly rendered text shows blank until Zotero restarts. On Zotero 8.0.x stale Citegeist menu entries also stay. Seen on Zotero 8.0.4, 9.0.6 and 10.0.2 in the first real-Zotero CI run (spec 90), traced through Zotero and Gecko source on 2026-09-28.
**Fix:** Before `onShutdown`'s first `await`, remove the link and Citegeist's rendered menu items from every main window, as Zotero's sample plugin does, and unregister menus with the key `registerMenu` returns (see BUG-MENU).
**Found:** 2026-09-28.

### BUG-ERRFLOOD: Each startup fills Zotero's Report Errors buffer

**Impact:** On Zotero 8, 9 and 10, `Zotero.warn` lands in Help → Report Errors as an error, because Zotero's logger passes Gecko 115's argument list to Gecko 140's `scriptError.init`. Citegeist unregisters each column and its pane section before registering them, which logs 10 "Can't remove unknown option" warnings per startup (in v2.0.5 too), and Zotero's own `defaultIn`/`disableIn` check adds 18 more for Citegeist's nine columns. The buffer holds 25 entries, so every startup pushes out the errors a user's report is meant to carry.
**Fix:** Unregister only what exists (`Zotero.ItemTreeManager.isCustomColumn`, `Zotero.ItemPaneManager.customSectionData`, both available since Zotero 7.0.10). The other 18 entries and the logger fault need a Zotero fix; the plan's Decisions, item 7, lists the reports.
**Found:** 2026-09-28.

### BUG-STARTUP-TX: Startup column registration can make Zotero's own writes time out

**Impact:** Each of Citegeist's nine `registerColumn` calls makes Zotero's plugin API open a main-database transaction to queue a tree refresh. In two of eight smoke startups on 2026-09-28, one of those transactions stayed open about 30 s and ten of Zotero's own transactions timed out waiting ("Timed out waiting for transaction", `TimeoutError` at `db.js` line 2638, Zotero 10.0.4). The branch registers columns the same way.
**Fix:** Find why the refresh transaction runs long (read `pluginAPIBase.mjs` `_refresh` and the item tree's refresh at 9.0.6 and 10.0.4); if registering nine columns one by one is the cause, register them in one pass or defer registration until startup's database work settles. U8.
**Found:** 2026-09-28.

### VERIFY-001: v3.0.0 pane needs a real-Zotero visual-verify before release

**Impact:** The v3.0.0 unified pane rebuild + the Zotero 8/9 context-fill sidenav icon are code-verified (451 tests, two review rounds) but not yet eyeballed in a running Zotero. Release gate.
**Also (2026-09-28):** the first real-Zotero CI run timed out waiting for the pane's hero on Zotero 8.0.4, 9.0.6 and 10.0.2. The triage traced it to the test: a scripted click never scrolled the section into view, so it never rendered. The visual check itself is still open.
**Fix:** Install `citegeist-3.0.0.xpi`, confirm the composition (hero → metric line → explore buttons → author link rows), the wide-pane cap, and that the sidenav icon renders in the Zotero 8/9 strip; fix any spacing/contrast issue as a follow-up commit to `main`.
**Found:** 2026-07-18 — merged to `main` (#75); pending before tagging v3.0.0.

---

## P3 — Low Priority

### OKF-DRIFT: Upstream OKF spec has drifted from the pinned commit (#79)

**Impact:** `npm run okf:drift` reports drift — pinned `ee67a5c` vs upstream `3fcbb9f` ([compare](https://github.com/GoogleCloudPlatform/knowledge-catalog/compare/ee67a5ca27044ebe7c38385f5b6cffc2305a9c1a...3fcbb9f828c2f23d109c855ee403c3a4c81f3a96)). Docs-only; no code impact.
**Fix:** The deliberate monthly action — review the `okf/SPEC.md` diff, update conforming docs if needed, then re-pin in `~/developer/docs/standards/okf-adoption.md` (canonical) + `docs/STANDARDS.md`. Never auto-follow `main`.
**Found:** 2026-07-25 (#79).

### VERIFY-002: author-relation purge + sync-safety — 2-device check

**Impact:** The native `openalex:author` item relation was **disabled before release** (it halts Zotero sync — server rejects the custom predicate) and replaced by a direct `citegeist.sqlite` read; a one-time startup purge (`purgeAllAuthorRelations`, pref-guarded) strips any stray relations left by pre-release builds. This hasn't been confirmed on a real 2-device sync — the check is now that the purge runs and library sync stays clean, **not** that a relation round-trips (it no longer should).
**Fix:** On device A that ran a pre-release build (or after resolving authors), confirm library sync completes with no 400 / "Made no progress during upload", and device B syncs clean. Confirm author data is present on B via the pane (SQLite is per-device; not synced — that's expected).
**Effort:** Low (manual check)

### DEBT-015: Diagnostics redaction misses home folders outside `/Users` and `/home`

**Impact:** `normalizeError` appends a stack line that carries the add-on's file URL inside the user's profile. Redaction strips `/Users/<name>`, `/home/<name>` and `X:\Users\<name>` only, so a university layout such as `/homes/<name>`, `/afs/…/<name>` or a redirected Windows profile share keeps the account name in the report users paste into public issues, although the settings pane promises the report carries no username. The redaction dates from #77 on `main` (unreleased); U2 adds new automatic entries that reach it. Round-B security review, 2026-09-28 (RB-SEC-3).
**Fix:** Replace the exact known prefixes (the add-on's `rootURI`, `Zotero.Profile.dir`, the data directory and the home directory, as paths and as encoded file URLs), or cut each stack frame to what follows `!/content/`; add tests for each layout.
**Effort:** Small.

### DEBT-014: Menu batch-runners duplicate a ~30-line skeleton four ways

**Impact:** `menu.ts` has four near-identical batch handlers — `runFetchSelected`, `runFetchCollection` (pre-existing on `main`) and `runResolveAuthorsSelected`, `runResolveAuthorsCollection` (added this branch) — each repeating the ProgressWindow + ItemProgress setup, empty-eligible alert, try/batch/catch "…failed — see Debug Output", and setProgress(100)+summary+close-timer. A later fix to the boilerplate in one silently misses the other three (the same drift class the "Done — 0 updated" summary fix already had to chase). The branch widened it 2→4.
**Fix:** extract one `runBatchOverItems(win, { gather, headline, itemLabel, run, summarize })` helper and route all four actions through it. Deferred out of the review PR: it also refactors two pre-existing `main` functions, so it belongs in its own single-concern change, not the diagnostics branch.
**Effort:** Small–medium.

### DEBT-013: Preferences update-check status colours are hardcoded hex

**Impact:** `addon/content/preferences.xhtml`'s `showStatus()` sets the update-check status line colour inline (`#c0392b` / `#27ae60` / `#e67e22`) rather than via `--cg-*` tokens, so those three states don't adapt to the Zotero light/dark theme — the same class of issue the component CSS is guarded against. Pre-existing on `main`; the pane is the legacy update-checker, not the diagnostics UI this branch touched. Surfaced by the multi-round review, carved out to keep the review PR single-concern.
**Fix:** route the three states through theme-aware tokens (danger / success / warning) instead of inline hex.
**Effort:** Small.

### DEBT-012: Debounced column repaint can fire after column teardown

**Impact:** `citationColumn.ts` `unregisterCitationColumn` clears `fetchTimer` but not `repaintTimer`, so a repaint debounced within `COLUMN_REPAINT_DEBOUNCE_MS` (150ms) of teardown still fires against a torn-down column. Blast radius is tiny (one `refreshAndMaintainSelection` on an unregistered column, already null-guarded) and it is pre-existing on `main`, so the review verifier ruled it a non-defect — but it is a real stray-timer leak worth tidying. Carved out to keep the review PR single-concern.
**Fix:** clear `repaintTimer` in `unregisterCitationColumn` alongside `fetchTimer`.
**Effort:** Trivial.

### DEBT-009: v3.0.0 review advisory residuals

**Impact:** Minor, non-blocking items surfaced by the v3.0.0 code review (all verified non-defects): a dangling `aria-labelledby="cg-tab-citing"` on the author-mode dialog body, the duplicated 6-row skeleton loop in `dialog.ts`, and `persistProfileMetrics` able to null-overwrite a cached exact metric. (The inline `ProgressWindow` dwell-timer literals noted here previously are now extracted to `constants.ts`.)
**Fix:** Address opportunistically; none affect correctness.
**Effort:** Low

---

## Closed

Closed issues are archived as machine-readable JSONL in [`docs/archive/issues-closed.jsonl`](archive/issues-closed.jsonl) — 16 records as of 2026-06-10. When closing an issue, append a line there (`{"id","title","resolution","date","archived_at"}`) instead of growing a table in this file, so the active tracker stays focused on open work.

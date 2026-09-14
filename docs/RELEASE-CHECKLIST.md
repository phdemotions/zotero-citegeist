---
type: checklist
title: Citegeist — release gate checklist
description: Manual verification gates that must pass before tagging any v* release.
timestamp: 2026-09-13
tags: [citegeist, release, checklist, quality-gate, review-loop]
---

# Citegeist — Release Gate Checklist

Run this **before every `v*` tag**, in order. It is not optional and it is not
the automated gate.

**Why a manual gate exists.** Two structural facts raise the bar:

1. **Auto-update hits 100% of users, with no canary.** `manifest.json` points
   `update_url` at the `release` floating tag; every installed copy updates on
   next Zotero restart. A bad tag is a fleet-wide incident, not a staged one.
2. **The tests mock Zotero.** All 519 vitest tests run against a mocked host, so
   the highest-risk surface — does the pane actually draw, does the icon show,
   does sync survive — has **zero real-runtime coverage** until a human installs
   the XPI. This surface has silently regressed in production before (the blank-UI
   / broken-sync incident that created the whole diagnostics branch).

Each check below is tied to a **known failure mode** — this is a regression
gate, not a formality. Install the **built XPI** (`npm run build`), not a proxy
file (proxy install is unreliable in practice).

---

## Review loop — every code change, before merge

The maintainer runs this on every pull request that changes code, and posts the
round log as a comment on the pull request. Outside contributors are not asked to
run it. It is the bar #77 cleared before merge, written down so every change
meets it.

**Lenses, one finder each:**

- **Correctness** — logic errors, edge cases, intent versus implementation.
- **Adversarial** — construct the input or sequence that breaks the change.
- **Security** — the API key, redaction, the update channel, CI tokens.
- **Reliability** — shutdown, timers, unawaited promises, retries, cleanup.
- **Host compatibility** — every Zotero or Firefox API the change touches,
  checked against Zotero's own source. The finding names the source file and
  the Zotero tag it was read at, such as `chrome/content/zotero/xpcom/pluginAPI/menuManager.js`
  at `10.0.2`.
- **Testing** — missing scenarios, weak assertions, mocks hiding a host contract.
- **Maintainability** — duplication, dead code, names that hide intent.

**Each round:**

1. Every finder reviews the full diff and reports findings with a quoted line
   of evidence and a severity from P0 to P3.
2. Each finding goes to a separate verifier told to refute it. Only findings the
   verifier fails to refute count as confirmed.
3. Fix every confirmed P0, P1 and P2 finding before the next round starts.

**Exit rule:** the loop ends after **two consecutive full rounds with no
confirmed P2 or higher finding**. A confirmed P0 or P1 resets the count to zero.

**Round log** (one line per round in the pull request comment):

```text
Round 3 · 7 lenses · raised 9, confirmed 2 (P2 ×1, P3 ×1) · fixed in 1a2b3c4 · not clean
Round 4 · 7 lenses · raised 4, confirmed 0 · clean (1 of 2)
Round 5 · 7 lenses · raised 3, confirmed 1 (P3 ×1) · clean (2 of 2) · exit
```

---

## 0. Automated gate — must be green first

- [ ] `npm run typecheck && npm test && npm run lint && npm run format:check && npm run okf:check && npm run build`
      (on **Node ≥22** — vitest 4's ESM config can't be `require()`d on Node 20).
      If `npm test` flakes, re-run with `--no-file-parallelism` to separate real
      failures from the known parallel-timeout flakiness.
- [ ] Build produced `build/citegeist-x.y.z.xpi`.

If the automated gate is red, stop — nothing below matters yet.

CI enforces the same commands, plus the real-Zotero matrix, on every pull request
(`ci.yml`), and `release.yml` runs them again on the tag before anything
publishes. On a tag, every real-Zotero cell tests the XPI `Verify` built, so the
suite tests the bytes that ship.

### Branch protection (maintainer, one-time)

Set once in GitHub → **Settings → Branches**, as a protection rule (or ruleset)
for `main`:

- **Require a pull request before merging.**
- **Require status checks to pass before merging**, with **Require branches to
  be up to date before merging** on.
- **Required check: `CI gate`** (from `ci.yml`). It passes only when `test (22)`
  and every real-Zotero cell (`Real Zotero / Zotero 8.0.4`,
  `Real Zotero / Zotero 9.0.6`, `Real Zotero / Zotero 10.0.2`) succeeded, so
  adding or bumping a Zotero cell needs no settings change. Do not require the
  cells individually: a renamed cell would leave a required check that never
  reports, and every merge would block on it.
- **Do not allow bypassing the above settings**, so release commits go through a
  pull request too.
- **Require review from Code Owners** is a separate maintainer setting.
  `.github/CODEOWNERS` assigns `.github/workflows/` and the two scripts
  `Publish` runs to `@phdemotions`, and GitHub enforces that only while this
  setting is on. GitHub does not let an author approve their own pull request,
  so confirm a sole maintainer can still merge their own changes to those paths
  before turning it on.

Enable the rule only after `CI gate` has completed successfully on a pull request
within the past seven days. GitHub lets a rule require a check only once it has
reported in that window, and requiring `CI gate` before then blocks every merge.

### First CI run proofs (once billing is unlocked)

None of the workflow behaviour above has run on GitHub yet: Actions is blocked on
billing. The first time it can run, prove each gate blocks:

- [ ] **A lint error blocks a pull request.** Open a pull request with a
      deliberate lint error: `test (22)` and `CI gate` are both red.
- [ ] **A real-Zotero failure blocks a pull request.** Open a pull request that
      makes one real-Zotero spec fail: that cell and `CI gate` are both red.
- [ ] **A failing spec blocks a tag.** In a throwaway fork, push a tag that
      matches `package.json`, on the commit that bumps it, with one spec failing:
      `Verify` is green, that `Real Zotero / Zotero <version>` cell is red,
      `Publish` is skipped, no Release is created, and the fork's `release`
      channel is unchanged.
- [ ] **A prerelease tag is refused.** In the fork, push `vX.Y.Z-rc.1`: `Verify`
      fails and names plan U15.
- [ ] **Verify's token cannot push.** In the fork, add a temporary last step to
      `Verify` that runs
      `git push "https://x-access-token:${{ github.token }}@github.com/${{ github.repository }}" HEAD:refs/tags/token-probe`:
      it fails with a 403, and no `token-probe` tag appears.
- [ ] **A clean pull request passes.** Every check and `CI gate` are green.
- [ ] **Pin the Zotero tarballs.** Each real-Zotero cell of that clean run warns
      with its tarball's SHA-256. Copy the three values into
      `ZOTERO_TARBALL_SHA256` in `real-zotero.yml` through a pull request; from
      then on a changed tarball fails its cell.

Recording each run's URL in `docs/STATUS.md` is the maintainer's job.

---

## 1. Real-Zotero smoke — run on Zotero **7, 8, AND 9**

The three supported hosts diverge exactly where it hurts (MenuManager, icon
paint, FTL, `context-fill`). Install the XPI in each and verify:

- [ ] **The pane section appears** in the item pane, and its **sidenav icon is
      visible in BOTH light and dark mode.** — _Failure modes: `registerSection`
      must use `l10nID` not `label` (Z9 throws → pane vanishes); must set `icon`
      AND `darkIcon` (omitting `darkIcon` → blank icon in dark mode); FTL must
      load by bare filename in `onStartup` and `onMainWindowLoad`;
      `bootstrap.js` must retain the `registerChrome` handle._
- [ ] **The pane renders its composition** (impact hero → metric line → two
      explore buttons → author rows), **not blank.** — _Failure mode: a raw `<`
      or `&` in the `bodyXHTML` embedded `<style>` aborts the XML parse and the
      pane silently vanishes (columns survive)._
- [ ] **Theme follows Zotero, not the OS.** Set Zotero to light while the OS is
      dark (and vice versa); the pane AND the citation-network dialog must match
      Zotero's theme. — _Failure mode: UI that inherits `color-scheme` follows
      the OS; both surfaces must force it via `resolveHostScheme` (`ui/theme.ts`)._
- [ ] **No raw-hex contrast bugs.** Eyeball links, chips, the picker checkmark,
      and any status text in both themes — all legible. — _Failure mode: raw hex
      in component CSS doesn't adapt to theme (caused two v2.0.4 contrast bugs);
      a `light-dark()` arm that `var()`s its own property collapses to transparent._
- [ ] **Right-click menu** shows the Citegeist items with real labels (no blank
      or duplicate entries). — _Failure modes: Z8+ `MenuManager` items need
      `l10nID` (bare `label` → textless item); Z7 uses the DOM fallback;
      registration is process-global (guard against double-register)._
- [ ] **Fetch works end to end:** run "Fetch Citation Counts" on an item →
      columns populate and the pane hero shows the count. Run it on a small
      collection → columns fill progressively. — _Failure mode: columns only
      repaint via `refreshAndMaintainSelection`, per-item-invalidated + debounced._
- [ ] **Both dialogs open:** citation-network (citing / references) and the
      author-works view from an author row.
- [ ] **No console errors** in Zotero's Debug Output on startup, item-select, or
      shutdown.

---

## 2. Diagnostics end-to-end — the new subsystem, never exercised live before

The diagnostics layer is unit-tested but has never met a real user hitting a
real error in real Zotero. Force each class and confirm the coded UI:

- [ ] **Bad API key** (enter a garbage key in settings, fetch an item) → the
      pane shows a coded failure with **`CG-API01`** and a "Copy report" button.
- [ ] **Offline** (disable network, fetch an uncached item) → **`CG-NET01`**.
- [ ] **Copy report works** and the pasted report is **clean**: it contains no
      paper title, DOI, OpenAlex id, API key, or your username. Paste it and read
      it. — _This is the redaction promise; a leak here is a privacy incident._
- [ ] **No surface hangs on a spinner** through any of the above — every failure
      resolves to a terminal state with something to quote.
- [ ] A bulk "Fetch All" with the bad key **stops** and says to check the key,
      rather than grinding through the whole library.

---

## 3. Sync integrity — 2-device round-trip (**P0 blast radius — non-negotiable**)

The `openalex:author` relation once halted the user's **entire** Zotero sync
(the server rejects the custom predicate: "Unsupported predicate
'openalex:author'" → "Made no progress during upload"). A regression here breaks
the user's whole library, not just Citegeist.

- [ ] **Device A:** run "Resolve Author Identities" on an item, then sync.
- [ ] **Device B:** sync, and confirm the library sync **completes** — no 400,
      no "Made no progress during upload," no stall.
- [ ] Confirm author data is present on Device B (via the pane, or a direct
      `citegeist.sqlite` read — the documented fallback).

Do not tag if this gate has not been run against a real second device.

---

## 4. Sequencing / risk judgment — decide before you tag

- [ ] **Is this release bundling too much?** A fat major (e.g. author identity +
      diagnostics + pane rebuild in one tag) is a lot of independent risk behind
      one irreversible auto-update. Prefer shipping the **diagnostics safety net
      as its own smaller release first** — then the next, riskier release lands
      with the net already in users' hands and every failure is addressable.
- [ ] **Self-dogfood first.** Install the dev build for your own daily use for a
      day or two before the auto-update tag — the cheapest canary available.

---

## 5. Tag + release — mechanical (canonical; `CLAUDE.md` → Release Process links here)

`main` is protected (section 0), so the release commit lands through a pull
request, and the tag goes on that pull request's merge commit.

- [ ] Branch from an up-to-date `main`:
      `git switch main && git pull --ff-only && git switch -c release/vX.Y.Z`
- [ ] Update `CITATION.cff` (`version`, `date-released`) and move `[Unreleased]`
      in `CHANGELOG.md` to the new version with today's date; add the comparison
      link. Leave both uncommitted.
- [ ] `npm run release`. It first refuses to run while a tracked file other than
      `CHANGELOG.md` and `CITATION.cff` has uncommitted changes, because bumpp
      commits every tracked change. bumpp then asks for the version, bumps
      `package.json` and `package-lock.json` (top-level + `packages[""]`), and
      commits as `release: vX.Y.Z`. It does not tag or push. Confirm
      `package.json`, `package-lock.json` and `CITATION.cff` all match.
- [ ] `git push -u origin release/vX.Y.Z`, open a pull request to `main`, and
      merge once `CI gate` is green.
- [ ] Tag the merge commit by its SHA, not whatever `main` points at now:
      `git fetch origin`, then
      `sha=$(gh pr view <pull-request-number> --json mergeCommit --jq .mergeCommit.oid)`,
      confirm `git show "$sha:package.json"` shows `"version": "X.Y.Z"`, then
      `git tag vX.Y.Z "$sha" && git push origin vX.Y.Z`. `Verify` refuses a tag
      on any commit that does not itself change `package.json`'s version to
      `X.Y.Z`, such as a pull request merged after the release. Only final
      versions publish: `Verify` refuses `vX.Y.Z-rc.N` until plan U15 adds tag
      classification.
- [ ] Watch the `Build & Release` run. `Verify` checks the tag, runs every
      automated gate and builds the XPI, and every `Real Zotero / Zotero <version>`
      cell tests that XPI. `Publish` starts only after all of them pass, one
      publish at a time across tags. It refuses a tag that no longer points at
      the run's commit and a version not newer than every version the live
      `update.json` lists, and it never overwrites a published versioned
      release. **A failed gate publishes nothing.**
- [ ] **Re-run only the newest tag's run.** If a job flaked, use **Re-run failed
      jobs** on that run's page, which also re-runs `Publish`. Never re-run a
      superseded tag's run: `Publish` refuses it once the tag has moved or the
      channel carries a newer version.
- [ ] **A real failure spends the version.** A fix merged afterwards cannot carry
      the same tag, because `Verify` accepts only the commit that bumps the
      version. Delete the failed tag
      (`git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z`), fix the problem
      on `main` through a pull request, and release the next patch version from
      the top of this section, folding the unreleased `X.Y.Z` CHANGELOG entry
      into it.

---

## 6. Post-release watch

- [ ] `Build & Release` passed `Verify`, every real-Zotero cell and `Publish`:
      the Release carries the XPI and `update.json`, and the `release` floating
      tag serves the fresh `update.json`.
- [ ] Install an older copy and confirm it auto-updates on restart.
- [ ] Zenodo archived the new `v*`.
- [ ] Triage incoming issues **by `CG-*` code** — users can now quote them; a
      code maps straight to `docs/ERROR-CODES.md` and the producing module.

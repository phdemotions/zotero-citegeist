---
type: checklist
title: Citegeist — release checklist
description: The steps of every release, in order, from the automated gate to the post-release watch.
timestamp: 2026-09-28
tags: [citegeist, release, checklist, quality-gate]
---

# Citegeist — Release Checklist

Run this for every release, in order. Every installed copy takes a published
release on its next update check, with no canary, and the tests mock Zotero,
so the host checks below are the only real-runtime gate. Install the built
XPI (`npm run build`), not a proxy file.

Everything that is not a per-release step lives in
[RELEASE-RUNBOOK.md](RELEASE-RUNBOOK.md): what each refusal means, re-run
recovery, one-time repository setup, the review loop, the fork proofs and the
break-glass release.

---

## 0. Automated gate — must be green first

- [ ] `npm run verify` passes on **Node ≥22**. If `npm test` flakes, re-run it
      with `--no-file-parallelism` to separate real failures from the known
      parallel-timeout flakiness.
- [ ] `CI gate` is green on the release pull request. It passes only when
      `test (22)`, the workflow audit and every real-Zotero cell
      (`Real Zotero / Zotero 8.0.4`, `Real Zotero / Zotero 9.0.6`,
      `Real Zotero / Zotero 10.0.3`) succeeded.

---

## 1. Real-Zotero smoke — on every version in `real-zotero.yml`'s `zotero-versions`

Today that is Zotero 8, 9 and 10. Install the XPI in each and check:

- [ ] **The pane section appears** and its **sidenav icon shows in light and
      dark mode**. — _`registerSection` uses `l10nID`, sets `icon` and
      `darkIcon`; the FTL loads by bare filename; `bootstrap.js` keeps the
      `registerChrome` handle._
- [ ] **The pane renders its composition** (impact hero, metric line, the two
      explore buttons, author rows), not blank. — _A raw `<` or `&` in the
      `bodyXHTML` style aborts the XML parse._
- [ ] **Theme follows Zotero, not the OS**, in the pane and the
      citation-network dialog. — _Both surfaces force it via
      `resolveHostScheme`._
- [ ] **No contrast bugs**: links, chips, the picker checkmark and status text
      are legible in both themes. — _Raw hex, or a `light-dark()` arm that
      `var()`s its own property._
- [ ] **The right-click menu** shows Citegeist's items with real labels, once.
      — _MenuManager items need `l10nID`; registration is process-global._
- [ ] **Fetch works end to end** on one item (columns fill, the hero shows the
      count) and on a small collection (columns fill as it goes). — _Columns
      repaint only through `refreshAndMaintainSelection`._
- [ ] **Both dialogs open**: the citation network and an author's works.
- [ ] **No console errors** in Debug Output at startup, item select or
      shutdown.

## 2. Diagnostics end to end

- [ ] A garbage API key shows **`CG-API01`** with a **Copy report** button.
- [ ] Offline, an uncached item shows **`CG-NET01`**.
- [ ] Paste the copied report and read it: it holds no title, DOI, OpenAlex id,
      API key or username. A leak here is a privacy incident.
- [ ] No surface hangs on a spinner; a bulk fetch with the bad key stops and
      says to check the key.

## 3. Sync integrity — two devices (P0 blast radius)

- [ ] **Device A:** run "Resolve Author Identities" on an item, then sync.
- [ ] **Device B:** sync; it **completes**, with no 400 and no "Made no progress
      during upload", and the author data is there, in the pane or read straight
      from `citegeist.sqlite`. — _The `openalex:author` relation once halted a
      user's whole library sync._

Do not release if this has not run against a real second device.

## 4. Before you release

- [ ] **Is this release bundling too much?** A fat release is a lot of
      independent risk behind one irreversible auto-update; ship the safety net
      first when you can.
- [ ] **Dogfood first**: run the dev build for a day or two.

---

## 5. Release

Between releases `main` carries the next version's development version,
`X.Y.Z-alpha.0`. The release pull request changes it to `X.Y.Z`, and the
**Publish release** workflow releases that pull request's merge commit. No one
pushes a `v*` tag: ruleset 24140405 refuses it, and Publish creates the tag
once every gate has passed.

- [ ] Branch from an up-to-date `main`:
      `git switch main && git pull --ff-only && git switch -c release/vX.Y.Z`.
      `package.json` there has `"version": "X.Y.Z-alpha.0"`; if it does not,
      first merge a pull request that sets it.
- [ ] Update `CITATION.cff` (`version`, `date-released`) and move
      `[Unreleased]` in `CHANGELOG.md` to the new version with today's date and
      its comparison link. Leave both uncommitted.
- [ ] `npm run release -- X.Y.Z`. It refuses to run while any other tracked
      file has changes, then changes `package.json` and `package-lock.json`
      from `X.Y.Z-alpha.0` to `X.Y.Z` and commits `release: vX.Y.Z`, with no
      tag and no push. Confirm the three files agree.
- [ ] `git push -u origin release/vX.Y.Z`, open a pull request to `main`, and
      **Squash and merge** it once `CI gate` is green.
- [ ] **Actions → Publish release → Run workflow**, on `main`, with **version**
      `X.Y.Z`. Leave **commit** empty to release `main` as it stands, which is
      right when nothing has merged since the release pull request; otherwise
      give that pull request's merge commit:
      `gh pr view <number> --json mergeCommit --jq .mergeCommit.oid`.
- [ ] Watch the run. `Build` refuses a run from any branch but `main`, and a
      commit or version the release pull request did not produce, before
      installing anything, then builds; `Verify` and every
      `Real Zotero / Zotero <version>` cell test that build; `Publish` checks the
      bytes and the live channel, attests the assets, creates the `vX.Y.Z` tag,
      publishes the release and moves the channel; `README badges` runs last.
      **A failed gate publishes nothing.** If a job fails, see
      [RELEASE-RUNBOOK.md, "Re-run recovery"](RELEASE-RUNBOOK.md#re-run-recovery)
      before re-running anything.
- [ ] **Confirm the channel serves the release:**
      `curl -sL https://github.com/phdemotions/zotero-citegeist/releases/download/release/update.json`
      lists `X.Y.Z`.
- [ ] **Confirm the provenance:** download the XPI from the release and run
      `gh attestation verify citegeist-X.Y.Z.xpi --repo phdemotions/zotero-citegeist`.
- [ ] **Start the next version on `main`:** a pull request that runs
      `npm version --no-git-tag-version X.Y.(Z+1)-alpha.0`, or the `-alpha.0` of
      whichever version comes next, and commits
      `chore: start X.Y.(Z+1) development`. Until it merges, `main` carries a
      shipped version and the next release's guard refuses. A later pull
      request can change the development version if the plan changes; the guard
      reads only the one `main` carries just before the release pull request.

---

## 6. After the release

- [ ] Every job of the run passed, and the release carries the XPI and
      `update.json`.
- [ ] An older installed copy auto-updates on restart.
- [ ] Zenodo archived the new `vX.Y.Z`.
- [ ] Triage incoming issues **by `CG-*` code**; each maps to
      `docs/ERROR-CODES.md` and the module that raised it.

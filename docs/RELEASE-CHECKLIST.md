---
type: checklist
title: Citegeist — release gate checklist
description: Manual verification gates that must pass before tagging any v* release.
timestamp: 2026-08-02
tags: [citegeist, release, checklist, quality-gate]
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

## 0. Automated gate — must be green first

- [ ] `npm run typecheck && npm test && npm run lint && npm run format:check && npm run okf:check && npm run build`
      (on **Node ≥22** — vitest 4's ESM config can't be `require()`d on Node 20).
      If `npm test` flakes, re-run with `--no-file-parallelism` to separate real
      failures from the known parallel-timeout flakiness.
- [ ] Build produced `build/citegeist-x.y.z.xpi`.

If the automated gate is red, stop — nothing below matters yet.

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

## 5. Tag + release — mechanical (canonical steps in `CLAUDE.md` → Release Process)

- [ ] Bump the version in `package.json`, `package-lock.json` (top-level +
      `packages[""]`, via `npm install`), and `CITATION.cff` — all three match.
- [ ] Move `[Unreleased]` in `CHANGELOG.md` to the new version with today's date;
      add the comparison link.
- [ ] Commit, then `git tag vX.Y.Z && git push origin main && git push origin vX.Y.Z`
      (or `npm run release`).

---

## 6. Post-release watch

- [ ] GitHub Actions built the XPI, created the Release, and force-updated the
      `release` floating tag with a fresh `update.json`.
- [ ] Install an older copy and confirm it auto-updates on restart.
- [ ] Zenodo archived the new `v*`.
- [ ] Triage incoming issues **by `CG-*` code** — users can now quote them; a
      code maps straight to `docs/ERROR-CODES.md` and the producing module.

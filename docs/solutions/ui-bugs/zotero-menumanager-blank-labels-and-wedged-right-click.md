---
type: solution
title: "Zotero MenuManager: blank menu labels and wedged right-click menu"
date: 2026-07-09
category: docs/solutions/ui-bugs
module: menu
problem_type: ui_bug
component: frontend_stimulus
severity: high
symptoms:
  - Citegeist right-click menu entries render with no visible label on Zotero 8/9 (blank, but still clickable)
  - After using one Citegeist menu item once, the right-click menu stops opening on any item until the plugin is disabled and re-enabled
  - Closing a second library window removes Citegeist's menu from the other open windows
root_cause: logic_error
resolution_type: code_fix
tags:
  - zotero-plugin
  - menumanager
  - fluent-l10n
  - context-menu
  - process-global-registration
  - idempotency-guard
  - lifecycle
---

# Zotero MenuManager: blank menu labels and wedged right-click menu

## Problem

On Zotero 8 and 9, Citegeist's context-menu items rendered with no visible label, and after invoking one item once the right-click menu stopped responding on any item until the plugin was toggled off and on. Reported by two independent users on Zotero 9.0.5 / Windows ([issue #67](https://github.com/phdemotions/zotero-citegeist/issues/67)), fixed in v2.0.5. Two distinct root causes, both specific to the Zotero-8+ `Zotero.MenuManager` path (the Zotero-7.0.x DOM fallback was never affected).

## Symptoms

- Menu entries (Fetch Citation Counts, View Citing Works, View References, Fetch All) appeared blank but were still clickable.
- After one use, the right-click menu no longer opened on any item; only disable/re-enable restored it.
- (Found while verifying) closing a secondary library window stripped the menu from every other open window for the rest of the session.

## What Didn't Work

The v2.0.1 MenuManager integration carried two assumptions that were both wrong, and neither surfaces on a single happy-path registration:

1. That an FTL `l10nID` fills a menu item's text the way a bare message fills a normal element. It does not — see below.
2. That a `false` return from `registerMenu()` means "MenuManager is unavailable, fall back to the DOM path." A `false` is also returned for an *already-registered* duplicate, which is a completely different condition.

Neither shows up when `registerMenus()` runs exactly once against an empty registry, which is why it passed review and shipped.

## Solution

Both root causes were confirmed by reading Zotero core source (`zotero/zotero`), not inferred.

**1. FTL labels must use Fluent attribute syntax.** MenuManager applies `l10nID` by setting `menuElem.dataset.l10nId` on a XUL `<menuitem>` (`chrome/content/zotero/xpcom/pluginAPI/menuManager.js`, `_initMenu`). A menuitem has no text node, so Fluent can only fill its `label`/`accesskey` **attributes** — a bare message value has nowhere to land and renders empty.

```fluent
# Before — renders blank on a menuitem
citegeist-menu-fetch = Fetch Citation Counts

# After — attribute syntax fills the menuitem's label attribute
citegeist-menu-fetch =
    .label = Fetch Citation Counts
    .accesskey = G
```

**2. Guard the process-global registration + split teardown.** `menuID` is a process-global registry key (`pluginAPIBase.mjs`, `_validate`); a repeat `registerMenus()` (File → New Window fires `onMainWindowLoad` again; dev hot-reload) gets a `false` from the duplicate, which the old code misread as failure and "fell back" to injecting a second, uncoordinated DOM menu onto the same popup MenuManager still owns. Two systems mutating one popup wedged the right-click menu.

```ts
// menu.ts — module-level guard (mirrors citationColumn.ts's `registered`)
let menuManagerRegistered = false;

export function registerMenus(win: Window): void {
  if (menuManagerRegistered) return;            // repeat call: no-op, no DOM fallback
  const mm = getMenuManager();
  if (mm && menuPluginID) {
    try {
      if (registerViaMenuManager(mm, menuPluginID)) {
        menuManagerRegistered = true;
        return;
      }
    } catch (e) { logError("menu MenuManager register", e); }
  }
  registerViaDOM(win);                           // only a genuine first-call failure reaches here
}

// unregisterMenus(win) — PER-WINDOW DOM cleanup only, runs every window unload
// unregisterGlobalMenus() — PROCESS-GLOBAL MenuManager teardown + flag reset,
//   called once, unconditionally, at plugin shutdown (NOT inside the `if (win)` guard)
```

## Why This Works

MenuManager registration and teardown are **process-scoped**; window open/close events are **per-window**. The original code conflated the two on both sides — registering as if each window needed its own copy, and tearing down the global registration on any single window close. The `menuManagerRegistered` flag makes registration idempotent across the process, and splitting `unregisterMenus` (per-window DOM) from `unregisterGlobalMenus` (process-global, shutdown only) matches each teardown to the scope of the thing it removes. The FTL fix is orthogonal: it targets the actual DOM attribute MenuManager writes to, instead of a text node the menuitem doesn't have.

## Prevention

- **Static FTL guard.** `test/menu.test.ts` asserts every `citegeist-menu-*` message uses `.label` attribute syntax (and that fetch actions carry `.accesskey`, view actions don't) — a cheap regex check that can't regress silently.
- **Idempotency + teardown tests.** `registerMenus()` called twice invokes `registerMenu` only on the first call and injects no DOM nodes; `unregisterMenus(win)` alone never calls `mm.unregisterMenu`; `unregisterGlobalMenus()` tears down both and resets the flag. Because the flag is module-global, `menu.test.ts` loads a fresh module per test via `vi.resetModules()` + dynamic import (mirrors `citationColumn.test.ts`) so it can't leak.
- **General rule.** For any Zotero plugin-API registration (menus, columns, panes): the registry is process-global. Guard repeat registration with a module flag, and never tear down a process-global registration from a per-window unload handler. Element type dictates l10n form: menuitems **and** pane-section headers use `.label` (+ `.accesskey`); sidenav entries and section-button tooltips use `.tooltiptext`. All of them require an `l10nID` plus attribute-syntax FTL — **bare values render blank everywhere**, Zotero 9 `registerSection` *throws* on a plain `label`, and MenuManager silently drops one. (This corrects an earlier version of this note that claimed pane header/sidenav "take bare values" — they do not; see the Zotero-9 cluster doc below.)
- **Verify on real Zotero 8/9.** vitest mocks the registration bookkeeping but cannot observe live popup/window behavior; the actual blank-label and wedged-menu symptoms only reproduce in a multi-window Zotero session.

## Related

- Broader Zotero-9 host-contract cluster (chrome-handle GC, `registerSection` l10nID, FTL attribute syntax + `insertFTLIfNeeded`, MenuManager l10nID, context-fill icons, sync-breaking relation predicate) that extends this menu fix and corrected the l10n-form rule above: [zotero-9-plugin-blank-ui-and-sync-break.md](../integration-issues/zotero-9-plugin-blank-ui-and-sync-break.md).
- Menu architecture + Zotero-7-vs-8 feature gating: `src/modules/menu.ts`.
- Sibling module-flag pattern this fix mirrors: `registered` in `src/modules/citationColumn.ts`.
- Release process for the isolated hotfix that shipped this (v2.0.5 off `main`, native-UI branch renumbered to v2.0.6): `docs/plans/2026-07-06-001-fix-menu-manager-registration-lifecycle-plan.md`.

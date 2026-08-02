---
type: solution
title: "Zotero 9 plugin host-contract regressions: blank UI (icon, pane, menu) and broken library sync"
date: 2026-07-18
category: docs/solutions/integration-issues
module: citegeist-zotero9-integration
problem_type: integration_issue
component: frontend_stimulus
symptoms:
  - Item-pane sidenav icon paints blank (transparent) on Zotero 9
  - 'Item-pane section fails to register: "Option must have .header[l10nID]"'
  - Right-click context menu renders blank or missing menu items
  - FTL-driven header, sidenav, and menu labels render as empty text
  - 'Library-wide Zotero sync halts with HTTP 400 "Unsupported predicate openalex:author"'
root_cause: wrong_api
resolution_type: code_fix
severity: critical
related_components:
  - rails_view
  - database
  - tooling
tags:
  - zotero-9
  - item-pane-registration
  - sidenav-icon
  - context-menu
  - fluent-l10n
  - registerchrome-raii
  - sync-predicate-rejection
  - plugin-api-contract
---

# Zotero 9 plugin host-contract regressions: blank UI (icon, pane, menu) and broken library sync

## Problem

After Citegeist's v3.0.0 author-identity work, the plugin broke on real Zotero 9.0.6 across four surfaces at once: the sidenav/header icon rendered blank, the item-pane section intermittently failed to register (vanished), the right-click context menu was empty, and — most seriously — the author layer's `openalex:author` item relations made Zotero's sync server reject the whole library upload, halting sync entirely. The four visible symptoms trace to **six** distinct Zotero-9 platform-contract violations plus **one** sync-server constraint.

## Symptoms

Observable on real Zotero 9 (Help → Debug Output); none reproduce in the unit suite:

- `No chrome package registered for chrome://citegeist/…` — chrome resources (icons, FTL link) 404 after startup.
- `Option must have .header["l10nID"]` / `Option ["header"] is invalid` — thrown from `registerSection`; the entire pane section fails to register and disappears (columns survive).
- Item-pane collapsible section header renders **blank**; sidenav strip icon renders **blank/transparent**.
- Right-click on an item shows Citegeist's menu items as **textless/empty** — "right-click shows nothing." No error is logged (registration *succeeds*).
- Sync fails: `Error 400 … ZoteroObjectUploadError: Unsupported predicate 'openalex:author'` followed by `Made no progress during upload -- stopping`. The user's **entire library** sync halts, not just Citegeist's data.

## What Didn't Work (the expensive detours)

The first ~3 fixes were **guessed from reading the plugin's own code and repeatedly declared "solved" without ever confirming on the real Zotero 9 target.** Each guess was either inert or actively worse:

1. **Swapping the pane header from `l10nID` to a plain `label` string.** Reasoning: "the l10nID resolves to nothing, so the label is blank — just hardcode the text." On Zotero 9 this is *strictly worse*: `registerSection`'s schema has no `label` field on `header`/`sidenav`, so `_validateObject` in `pluginAPIBase.mjs` throws `Option must have .header["l10nID"]` and the section **fails to register at all**. The guess turned a blank-but-present header into a vanished pane.

2. **Adding the FTL via a `chrome://citegeist/locale/...` `<link rel="localization">` in `onMainWindowLoad`.** Two compounding failures: (a) the `chrome://` URL depends on the chrome registration that root cause #1 was silently tearing down, so it could not resolve; and (b) `onMainWindowLoad` **does not fire for a main window that is already open** when the plugin starts (the normal case on upgrade/enable), so the link was never inserted. The l10nIDs stayed unresolved regardless of FTL syntax.

3. **Fixing only the FTL *values* while leaving bare-value syntax.** Even once l10nID + loading were sorted, `citegeist-pane-header = Citation Intelligence` (a bare value) still rendered blank, because Zotero pulls the section title from the message's **`.label` attribute** and the sidenav/tooltips from **`.tooltiptext`** — a bare value produces no attribute node for these to bind to.

4. **Assuming the blank menu was another label/FTL problem.** The MenuManager menu *registered successfully* (no error, no `false` return), sending debugging down the FTL path again. The real cause was orthogonal: a plain `label` on a MenuManager entry is silently dropped because `_initMenu` in `menuManager.js` only wires text through `dataset.l10nId`. **Registration succeeding with no visible text is the trap.**

5. **Assuming `context-fill` SVGs would theme themselves like every other Zotero icon.** They do inside XUL chrome (`-moz-context-properties: fill`), but the pane/sidenav icon is painted as a plain `url()` image where `context-fill` resolves to **transparent** — a blank icon, no error.

**Meta-lesson:** the breakthrough came *only* after reading the actual Zotero 9 primary source (`pluginAPIBase.mjs`, `itemPaneManager.js`, `menuManager.js`, `plugins.js`, `AddonManagerStartup.cpp`) alongside the user's real Debug Output. Code-reading the plugin in isolation produced confident, wrong, self-certified "fixes." **A platform-contract bug cannot be closed against the plugin's own source; it must be closed against the host's source plus a run on the real target.**

## Solution (per root cause)

### 1. Retain the `registerChrome` RAII handle for the plugin's lifetime

`addon/bootstrap.js` — the return of `registerChrome` is an `nsIJSRAIIHelper` whose destructor deregisters chrome. Dropping it lets GC finalize it and tear `chrome://citegeist/` down at an unpredictable time.

```js
// BEFORE — return discarded → GC finalizes → chrome:// deregisters
aomStartup.registerChrome(manifestURI, [ ... ]);

// AFTER — retained module-wide, destructed explicitly on shutdown (make-it-red pattern)
var chromeHandle;                       // module scope
chromeHandle = aomStartup.registerChrome(manifestURI, [
  ["content", "__addonRef__", "content/"],
  ["locale", "__addonRef__", "en-US", "locale/en-US/"],
]);
// shutdown(): if (chromeHandle) { chromeHandle.destruct(); chromeHandle = undefined; }
```

### 2. `registerSection` header/sidenav require `l10nID` (no `label`)

`src/modules/citationPane.ts`:

```ts
header:  { l10nID: "citegeist-pane-header",  icon: `${rootURI}content/icons/icon-20-color.svg` },
sidenav: { l10nID: "citegeist-pane-sidenav", icon: `${rootURI}content/icons/icon-20-color.svg` },
```

Section buttons likewise take `l10nID`, not `label`.

### 3. FTL must use attribute syntax, per surface

`addon/locale/en-US/citegeist.ftl` — `.label` for the section header, `.tooltiptext` for the sidenav strip and section-button tooltips:

```ftl
# BEFORE (bare value → blank)
citegeist-pane-header = Citation Intelligence

# AFTER
citegeist-pane-header =
    .label = Citation Intelligence
citegeist-pane-sidenav =
    .tooltiptext = Citations
citegeist-pane-refresh =
    .tooltiptext = Refresh citation data
```

Menu messages use `.label` (+ `.accesskey`), matching MenuManager's `dataset.l10nId` rendering.

### 4. Attach the FTL by bare filename, in both startup paths

`src/hooks.ts` — Zotero auto-registers `locale/<locale>/*.ftl` into its Fluent registry *before* startup (`plugins.js` `registerLocales`, chrome-independent), addressable by bare name. Attach it via `insertFTLIfNeeded` in **both** `onStartup` (for the already-open window) **and** `onMainWindowLoad`:

```ts
const FTL_FILE = "citegeist.ftl";        // bare — NOT chrome://citegeist/locale/...
function ensureCitegeistFTL(win: Window): void {
  (win as { MozXULElement?: { insertFTLIfNeeded(f: string): void } }).MozXULElement
    ?.insertFTLIfNeeded(FTL_FILE);
}
// onStartup, when a main window is already open: ensureCitegeistFTL(mainWin); registerMenus(mainWin);
// onMainWindowLoad:                              ensureCitegeistFTL(win);     registerMenus(win);
```

### 5. MenuManager entries require `l10nID`; the DOM fallback keeps plain `label`

`src/modules/menu.ts` — the Zotero 8+ MenuManager path uses `l10nID` (text via FTL); the Zotero 7 DOM fallback correctly keeps `setAttribute("label", …)`:

```ts
// MenuManager path — text ONLY via l10nID
{ menuType: "menuitem", l10nID: "citegeist-menu-fetch", icon: iconURL("icon-16.svg"), onCommand: … }

// DOM fallback path — plain label is correct here
fetchItem.setAttribute("label", "Fetch Citation Counts");
```

### 6. Icon needs BOTH an explicit-fill SVG AND a `darkIcon`

Two independent faults blanked the sidenav/header icon; you need both fixes.

**(a) `context-fill` doesn't paint as a `url()` image.** Zotero renders the sidenav icon via `background-image: var(--custom-sidenav-icon-*)` (a real image, not a mask), so `fill/stroke="context-fill"` — which resolves only in a XUL chrome context with `-moz-context-properties: fill` — falls back to transparent. Use an explicit-fill colour SVG. `addon/content/icons/icon-20-color.svg` uses an explicit sage fill instead of `context-fill`:

```svg
<!-- BEFORE icon-20.svg: stroke="context-fill" fill="context-fill" → transparent as a url() image -->
<!-- AFTER icon-20-color.svg -->
<svg … stroke="#8FAD9F" …>
  <circle cx="10" cy="5" r="3" fill="#8FAD9F" fill-opacity="0.45"/> …
```

(The ProgressWindow already used a color PNG, `icon-16-color.png`, for the same reason.)

**(b) `darkIcon` is required, and Zotero does not default it.** `itemPaneSidenav.js` emits `--custom-sidenav-icon-dark: url('<darkIcon>')` literally, and the sidenav SCSS applies that property under `@media (prefers-color-scheme: dark)` with no fallback. `registerSection` does NOT copy `icon` → `darkIcon` (its JSDoc claims it does — the code doesn't). So passing only `icon` yields `url('undefined')` and a **blank icon for every dark-mode OS user**, regardless of the icon file — this was the *actual* persistent blank-sidenav bug (fix (a) alone is necessary but not sufficient). Pass `darkIcon` on both `header` and `sidenav`; the sage art reads on both themes, so reuse the same file:

```ts
header:  { l10nID: "…", icon: `${rootURI}…/icon-20-color.svg`, darkIcon: `${rootURI}…/icon-20-color.svg` },
sidenav: { l10nID: "…", icon: `${rootURI}…/icon-20-color.svg`, darkIcon: `${rootURI}…/icon-20-color.svg` },
```

### 7. Stop writing the custom relation predicate; purge the ones already written

`src/modules/cache/authors/relations.ts` — the SQLite `item_authors` table is the sole author-identity store; the relation-write path (`setItemAuthorRelations` / `syncItemAuthorRelations`) is no longer called from any production code (only tests + re-exports reference it). A one-time, pref-gated startup purge strips the predicate so sync recovers. The purge exposed a **mutate-during-iteration** bug caught by a unit test — `removeRelation` splices the item's live relation array, so iterating it directly skips every other entry:

```ts
// BEFORE would skip alternate URIs:  for (const uri of uris) item.removeRelation(PRED, uri);
// AFTER — iterate a snapshot:
for (const uri of [...uris]) item.removeRelation(AUTHOR_RELATION_PREDICATE, uri);
```

`src/hooks.ts` gates the pass behind `PREF_AUTHOR_RELATIONS_PURGED`, setting the pref **only after a fully successful pass** so a mid-pass failure (locked item) retries next launch rather than leaving a stray relation that keeps sync stuck.

## Why This Works (grounded in Zotero 9 source)

- **RAII chrome handle** — `amIAddonManagerStartup.idl` types `registerChrome`'s return as an `nsIJSRAIIHelper`; in `AddonManagerStartup.cpp` the `RegistryEntries` destructor (`~RegistryEntries(){ Destruct(); }`) unregisters chrome. The handle *is* the registration's lifetime; a module-wide JS reference pins it, `destruct()` releases it deterministically.
- **`registerSection` schema** — `pluginAPIBase.mjs`'s `_validateObject` enforces the `itemPaneManager.js` schema, where `header`/`sidenav` declare `{ l10nID, icon }` and no `label`. A missing required key throws, and `registerSection` propagates the throw — the section never mounts.
- **FTL attribute rendering** — Zotero's built-ins confirm the binding: `section-abstract =\n .label = …` and `sidenav-abstract =\n .tooltiptext = …` in `zotero.ftl`. The collapsible title reads `.label`; the sidenav/button tooltip reads `.tooltiptext`. A bare value has no attribute node to bind.
- **Bare-filename FTL** — `plugins.js` `registerLocales` mirrors the plugin's `locale/<locale>/*.ftl` into the app's L10nRegistry ahead of `onStartup`, keyed by bare filename and independent of chrome. `insertFTLIfNeeded("citegeist.ftl")` matches that source key; a `chrome://` href does not.
- **MenuManager text** — `menuManager.js`'s `_initMenu` wires label text exclusively through `dataset.l10nId`. A `label` property is not read, so registration succeeds and the item is textless — which is exactly why this one produced no error to chase.
- **`context-fill`** — resolves only where `-moz-context-properties: fill` is supplied (XUL chrome image contexts). As a CSS `url()` background (`--custom-sidenav-icon-*`) there are no context properties, so it falls back to transparent.
- **Sync predicate allowlist** — the local `setRelations` validation only checks `letters:letters` shape (so `openalex:author` passes client-side), but the Zotero sync **server** allowlists relation predicates to `dc:relation` / `dc:replaces` / `owl:sameAs`. A custom predicate is a hard, server-side rejection that aborts the whole upload — not something the client can negotiate.

## Prevention

**Rules**

- For any Zotero item-pane section, sidenav entry, section button, or MenuManager menu, **use `l10nID` + a `.label`/`.tooltiptext` FTL message — never a plain `label` string.** Match the attribute to the surface: section title → `.label`; sidenav/button tooltip → `.tooltiptext`; menuitem → `.label` (+ `.accesskey`).
- **Load plugin FTL by bare filename via `insertFTLIfNeeded`, in both `onStartup` (already-open window) and `onMainWindowLoad`.** Never rely on `onMainWindowLoad` alone; never use a `chrome://` localization link.
- **Never discard the `registerChrome` return value.** Retain it for the plugin lifetime, `destruct()` on shutdown.
- **Icons painted as `url()` images (pane/sidenav/ProgressWindow) need explicit-fill assets**, not `context-fill`. Reserve `context-fill` SVGs for XUL chrome contexts.
- **Always pass `darkIcon` on a `registerSection` `header`/`sidenav`** — Zotero does not default it to `icon` despite its JSDoc, and the sidenav SCSS uses the dark property under `prefers-color-scheme: dark` with no fallback, so omitting it blanks the icon in dark mode (`url('undefined')`).
- **Never write custom Zotero item-relation predicates you intend to sync** — only `dc:relation` / `dc:replaces` / `owl:sameAs` survive the sync server. Use plugin-owned storage (here, `citegeist.sqlite`) for external handoffs.
- **When removing while iterating a Zotero live relation/collection array, iterate a snapshot** (`[...arr]`).
- **A platform-contract bug is not "solved" until confirmed against the host's own source plus a run on the real target.** Reading the plugin's own code is necessary but never sufficient; do not self-certify from code-reading alone.

**Regression tests added** (in the 458-test suite):

- `test/menu.test.ts` — "context-menu FTL uses attribute syntax": every menu message header ends in `=\s*$` (no inline value) and defines `^\s+\.label\s*=\s*\S`.
- `test/menu.test.ts` — "item-pane section FTL uses the right attribute per surface": table-driven `it.each` pinning `citegeist-pane-header` → `.label`, `-sidenav`/`-refresh`/`-settings` → `.tooltiptext`, each with no inline value.
- `test/menu.test.ts` — MenuManager path asserts `item.menus.map(m => m.l10nID)` equals the expected IDs **and** `item.menus.every(m => m.label === undefined)` (blocks a revert to plain labels).
- `test/authorRelations.test.ts` — `purgeAllAuthorRelations` strips the predicate from every item, saves only affected items, skips items whose `saveTx` throws (read-only/locked) while counting the rest, and returns 0 when nothing carries the relation (exercises the snapshot-iteration path with a two-URI item).

**Files touched:** `addon/bootstrap.js`, `src/modules/citationPane.ts`, `addon/locale/en-US/citegeist.ftl`, `src/hooks.ts`, `src/modules/menu.ts`, `src/modules/cache/authors/relations.ts`, `src/modules/citationService.ts`, `addon/content/icons/icon-20-color.svg`, `src/constants.ts` (`PREF_AUTHOR_RELATIONS_PURGED`), with tests in `test/menu.test.ts` and `test/authorRelations.test.ts`.

## Related Issues

- [zotero-menumanager-blank-labels-and-wedged-right-click.md](../ui-bugs/zotero-menumanager-blank-labels-and-wedged-right-click.md) — the #67 menu-lifecycle fix (v2.0.5). This cluster's root cause #5 **extends** its MenuManager l10n finding; note that doc's prevention rule was corrected here (pane header/sidenav also require `l10nID`, not bare values).
- [zotero-plugin-dev-install-proxy-vs-xpi-2026-04-19.md](../workflow-issues/zotero-plugin-dev-install-proxy-vs-xpi-2026-04-19.md) — install-via-XPI is the reproduction/verification path; these Zotero-9-only symptoms surface only in a real Zotero session.
- [openalex-metered-api-handling.md](../best-practices/openalex-metered-api-handling.md) — context for root cause #7 (the author-identity layer that introduced the `openalex:author` relation).
- GitHub: **#72** (empty right-click section — RC5), **#67** (right-click menu broken — predecessor), **#22** (Zotero 9 compatibility umbrella — RC1–RC7).

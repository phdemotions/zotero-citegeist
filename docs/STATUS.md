---
type: status
title: Citegeist — project status
description: Current project state, last session's work, and upcoming priorities.
timestamp: 2026-09-28
tags: [citegeist, status]
---

# Citegeist — Status

> **Last Updated:** 2026-09-28 (plan consolidation and review of draft PR #93. The one live plan is `docs/plans/2026-09-13-001-fix-zotero-10-compat-host-bugs-plan.md`; its "Status on 2026-09-28" section holds the unit ledger, the open review findings, the next steps and the decisions waiting on Josh. Older plans are bannered as shipped or superseded.)
> **Phase:** **Zotero 10 compatibility and the path to v3.0.0.** Every Zotero 10 user has been locked out since Zotero 10.0 shipped on 2026-08-17, because v2.0.5 caps the plugin at `9.*`; the no-code bridge (plan U17) is prepared and waits on a smoke run and Josh's approval. Draft PR #93 (`fix/zotero-10-compat`, 30 commits written 2026-09-13) carries the Zotero 10 selection fix, the single-sourced compatibility range, a real-Zotero test suite, hardened CI and release workflows, the cache schema stamp and the preference-name fix. GitHub Actions ran nothing from 2026-08-27 to 2026-09-15 because of a billing lock; the first real-Zotero run, on 2026-09-28, passed 23 of 27 specs on each of Zotero 8.0.4, 9.0.6 and 10.0.2. `main` still stages the unreleased v3.0.0 work (#75, #77). **v2.0.5 is the last released version** (2026-07-09).
> **Build (branch, `8a8ef46`):** typecheck clean · **1,574 tests** · lint 0 errors (3 old `any` warnings) · format · OKF · build → `citegeist-3.0.0-alpha.0.xpi` (110.4 KB, Zotero 7.0.10 to `10.0.*`), on **Node ≥22**. On GitHub the unit-test job passes and the real-Zotero cells fail four specs, the same four on every Zotero version: two test bugs and two real bugs that date back to released versions (BUG-DISABLE-L10N, and BUG-MIGRATION from v2.0.0).

---

## Current State

| Attribute        | Value                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Version**      | 2.0.5 released (2026-07-09); `main` stages 3.0.0 untagged; draft PR #93 carries `3.0.0-alpha.0`                    |
| **Build Status** | Branch: 1,574 tests and every local gate green; real-Zotero CI 23 of 27 on Zotero 8, 9 and 10 (Node ≥22)            |
| **Open Issues**  | P0: 3, P1: 3, P2: 8, P3: 7 (see ISSUES.md; P0 = BUG-Z10-INSTALL, BUG-PANE-XML, BUG-QUIT)                              |
| **Stack**        | TypeScript 6, esbuild, vitest 4.1, ESLint 10, SQLite, Node 22; Zotero 7.0.10–9 released, 7.0.10–`10.0.*` on #93     |
| **Data Source**  | OpenAlex (CC0; metered since July 2026: lookups by ID or DOI free, search metered; optional API key)               |
| **Distribution** | GitHub Releases → auto-update via `release` Release (self-maintaining); Zenodo-archived                              |

---

## In Progress

**Zotero 10 compatibility, host bugs and the path to v3.0.0 — draft PR [#93](https://github.com/phdemotions/zotero-citegeist/pull/93).** The plan is `docs/plans/2026-09-13-001-fix-zotero-10-compat-host-bugs-plan.md`, and its "Status on 2026-09-28" section is the current state of record: which units are done, the open findings from review rounds that never finished (U5 round 3, U18 round 2) and from round B, the first real-Zotero run, and the decisions waiting on Josh. Nothing here is released, and no `v*` tag may be pushed until the release trigger moves to a dispatch from `main` (plan R3-1).

**Merged to `main`, unreleased: author identity (#75) and the diagnostics + Zotero-9 + pane-rebuild branch (#77).** No feature work is active. Both ship in v3.0.0 (plan U13), whose gates include the pane visual check (VERIFY-001) and the 2-device sync check (VERIFY-002); the release itself follows the live plan, not a hand-pushed tag. Origin docs: `docs/brainstorms/2026-07-16-author-identity-layer-requirements.md` + `docs/plans/2026-07-16-001-feat-author-identity-layer-plan.md`.

**Diagnostics + Zotero-9 host contracts + pane rebuild — merged to `main` ([#77](https://github.com/phdemotions/zotero-citegeist/pull/77), squash `277444b`, 2026-08-01; untagged).** A user-facing diagnostics layer so every failure is addressable, plus the Zotero-9 host-contract fixes and the item-pane rebuild.

- **Diagnostics:** append-only `CG-*` error-code registry (`src/modules/diagnostics/codes.ts`) with plain-language copy a user can quote in an issue; an in-memory ring buffer; `logError` as the single funnel; `guard`/`guardAsync`/`bindGuarded` boundaries on every Zotero-invoked callback; total service functions (never throw); a coded failure UI with a Copy-report button. A central redaction net keeps titles/DOIs/OpenAlex-ids/api-key/usernames out of the shareable report. Locked by `test/diagnostics-guard-invariants.test.ts`; human mirror in `docs/ERROR-CODES.md`.
- **Metered-OpenAlex discrimination:** budget (`CG-API42`) vs auth (`CG-API01`) vs response (`CG-API50`) vs network (`CG-NET01`); bulk fetch/resolve passes stop cleanly on a spent budget or a rejected key rather than grinding through the library.
- **Silent-hang classes closed:** the item-save leak and the `onAsyncRender` `"cached"` fall-through (both left the spinner up forever); the DB-write-leak class closed with a structural no-raw-`saveTx` invariant test. See `project_render_terminal_state` in memory.
- **Process:** 12 escalating adversarial review rounds (diverse-lens finders → default-refute verifiers); converged with two consecutive full-panel rounds clean of P2+. Non-blocking residuals recorded as DEBT-011..014.

**Author identity layer — merged to `main` as v3.0.0 ([#75](https://github.com/phdemotions/zotero-citegeist/pull/75), 2026-07-18; supersedes #73/#74; untagged).** Resolve and surface OpenAlex author identity across the library, plus a Scholar-style author view in the pane.

- **Phase A (U1–U2):** metered-OpenAlex key handling (opt-in `api_key` pref, key redaction in `normalizeError`, budget/auth/network error discrimination, `resolveCanonicalId` for 301 merges) + the `cache/authors/` sub-module (`authors` + `item_authors` tables, `cacheItemAuthors` curated-wins under the shared `withKeyLock`, two-level orphan GC).
- **Phase B (U3–U5):** identity resolution piggybacks the metrics fetch (no new API call, failure-isolated); an opt-in "Resolve Author Identities" backfill (item + collection menu, resumable, budget-aware, cancellable). The external handoff is a **direct `citegeist.sqlite` read** (the `item_authors` table). The native `openalex:author` relation was **disabled before release** — it halts Zotero sync — and a one-time startup purge strips any stray relations. **VERIFY-002 (release gate):** on a real 2-device setup, confirm the purge runs and library sync stays clean.
- **Phase C (U6–U7 + the pane rebuild):** the `openalexAuthors.ts` client (`fetchAuthorProfile` hybrid metrics per KTD2 + `fetchAuthorWorks` cursor paging); the item pane **rebuilt into one unified section** per `docs/design-system/pane-composition-language.md` (impact hero → one supporting-metric line → two explore buttons → author link rows), each author opening a Scholar-style author-works dialog (a third mode of the citation-network browser, reusing the add-to-folder machinery). **Curation was cut** — the confirm/override UI proved unused and confusing in testing, replaced by author _links_; `setCuratedItemAuthor` is retained and de-exported as the v2 "My Authors" write primitive. A two-round adversarial code review fixed a `showAuthorWorks` re-entrancy race and an author-backfill isolation gap; the stray-empty-section half of #72 was addressed (the broader "menu stops responding" bug #67/#72 is confirmed still open on 2.0.5 — see ISSUES.md BUG-MENU). 451 tests green on Node ≥22 (at #75; now 519).
- "My Authors" library-wide index is the planned v2 follow-up (see BACKLOG).

**Released v2.0.4 — 2026-06-10 (#57, DEBT-008 done):** finished the shared-primitive unification. Badges/chips → one canonical `.cg-chip` uppercase pill (pane + dialog); the title-match suggestion card → `.cg-card`; banners/eyebrows → shared `.cg-banner`/`.cg-eyebrow`; the dialog "Done" button → `.cg-btn`. All in `src/modules/ui/components.ts`. Two guard tests: token-purity (primitives use `var(--cg-*)`, no raw hex, so they always follow the forced `color-scheme`) and gallery-parity (every shipped primitive class is documented in `docs/design-system/citegeist-primitives.html`, reconciled to the code as the canonical source). Also fixed two light-mode contrast bugs (the match-verify OpenAlex link, the picker checkmark) and removed dead `.cg-match-banner` + unused pane token aliases.

**Released v2.0.3 — merged to `main` 2026-06-10 (#56):** (1) a settings shortcut (gear) in the pane header opens Zotero → Settings → Citegeist directly; (2) the section header/sidenav icon now renders (self-colored SVG — Zotero 7 supplies no `context-fill` paint for full-color section icons); (3) **light/dark theme fix** — the network dialog rendered in the wrong theme when the OS appearance and Zotero's theme disagreed (it mounts on the main window and inherited the OS `color-scheme`); both surfaces now force `color-scheme` to Zotero's resolved theme via the new `src/modules/ui/theme.ts` (`resolveHostScheme`: sample `--fill-primary` luminance → window bg → OS fallback); (4) the pane's buttons now compose from a shared `.cg-btn` primitive in the new `src/modules/ui/components.ts`. Visually confirmed; released as v2.0.3.

**Merged to `main` 2026-06-10 (in [Unreleased], not yet tagged):** the citation-network browser now opens for **any** resolved identifier — DOI → PMID → arXiv → ISBN → confirmed title match — not just DOI, so "View Citing Works"/"View References" no longer dead-end on a "requires a DOI" alert (#50). The browser always queried OpenAlex by work id, so the DOI gate was an unnecessary limitation (an old audit's "genuinely needs a DOI" assumption was wrong). Resolution centralized in `canResolveWork`/`resolveWorkForItem`/`fetchWorkByIdentifier`; menu gating unified on `canResolveWork`. Hardened across four `ce-review` passes (correctness · adversarial · maintainability/perf/standards · security/api-contract) — zero P0–P2; added book-aware empty-state copy, menu/`getRow` hot-path perf, item-scoped resolve-error logging. Earlier the same session: static license badge + full README claim audit (#49 — fixed the stale device-sync FAQ, default-collection picker location, migration-backup path/retention).

**Merged to `main` 2026-06-10 (DEBT-007, follow-up to #50):** keyed citation-network library-membership and collection filing on the OpenAlex work id instead of DOI (#52). Fixes two pre-existing bugs for DOI-less works (books, preprints): a prior-session library item no longer renders as "+ Add" → silent duplicate, and the "File" button no longer no-ops. New `getAllCachedOpenAlexIds()` + `existingWorkIds` for dedup; `resolveLibraryItem()` (createdItemIds → cached-work-id reverse lookup → DOI search) for filing.

Also this session: closed issues moved to a machine-readable archive `docs/archive/issues-closed.jsonl` (#51).

**Shipped 2026-06-08 (v2.0.2):** dark-mode citation-network tint fix — the dialog's sage-tint scale had a self-referential dark-theme arm (`light-dark(…, var(--cg-sage-tint-NN))`), invalid at computed-value time, so every dark-mode tint collapsed to transparent; now defined correctly. Design tokens (spacing, radii, type, motion, color ramps) consolidated into a canonical module `src/modules/ui/tokens.ts` that both the item pane and the network dialog consume; `docs/design-system/citegeist-primitives.html` added as the design reference (#45). Pane visually unchanged.

**Shipped 2026-06-08 (v2.0.1):** batch/collection/library column repaint fix (#35), redesigned title-match confirm/discard card (#36), citation network browser improvements — new sort modes (first author, not-in-library) + hide-in-library filter + source-metadata header (#32), Zotero 8+ MenuManager with DOM fallback (#33), Zenodo DOI surfacing (#34), TS6/ESLint10/action-gh-release-v3 deps (#37). v2.0.0 (SQLite cache migration) shipped 2026-06-08 (#30).

---

## What's Done (v1.0.3 — 2026-04-09)

### Non-DOI identifiers, ISBN support, and full rankings refresh

**Identifier resolution (`openalex.ts`, `citationService.ts`):**

- `extractIdentifier(item)` — priority-ordered resolver: DOI → PMID (Extra field) → arXiv (Extra / archiveID / URL) → ISBN
- `normalizePMID`, `normalizeArxivId`, `normalizeISBN` added alongside existing `normalizeDOI`
- `getWorkByPMID`, `getWorkByArxivId`, `getWorkByISBN` — three new OpenAlex lookup functions
- `FetchError` renamed from `"no-doi"` to `"no-identifier"`; all UI layers updated
- `extractIdentifier` is the single source of truth — shared by service, pane, and columns

**ISBN / book support (`citationColumn.ts`, `citationPane.ts`):**

- Books and book sections resolve via `works/isbn:` endpoint
- Zero citation counts suppressed in all three columns (blank cell) for book types with 0 citations
- Pane shows "Citation tracking for books is limited in OpenAlex." when count is 0; non-zero counts display normally

**Journal rankings (`journalRankings.ts`):**

- Rebuilt from master-journals.csv (single source of truth): 3177 primary entries + 2398 e-ISSN aliases
- AJG updated from 2021 → **2024** edition (1885 journals); column label → "AJG '24"
- ABDC updated from 2022 → **2025** edition (2684 journals); column label → "ABDC '25"
- UTD24 and FT50 flags preserved; `RANKING_VERSIONS = { utd24: "2024", ft50: "2024", abdc: "2025", ajg: "2024" }`
- `ISSN_ALIASES` table enables lookup by either print or electronic ISSN

**Tests:**

- 113 → 159 tests: `normalizePMID` (6), `normalizeArxivId` (10), `normalizeISBN` (9), `extractIdentifier` (15), `fetchAndCacheItem` coverage extended for all 4 identifier types
- `journalRankings.test.ts` updated to reflect new data (Journal of Finance, MIS Quarterly fixtures; AJG 2024 tiers; version strings)

---

## What's Done (v1.0.2 — 2026-04-08)

### Design polish + FWCI/percentile sort

Applied Opus Vita family design language (sage accent, ink-ramp neutrals, Slate dark palette) across the citation pane and network dialog. Added FWCI and percentile sort to the network browser.

**Design (`styles.ts`, `citationPane.ts`):**

- Sage accent (`#8FAD9F`) replaces blue throughout; ink-ramp neutrals replace macOS grey system colours
- Dialog background is now `#141D18` (family Slate palette), distinct from Zotero's chrome
- Citation pane buttons redesigned as equal-width ghost/outline buttons with sage accent
- All button hover/badge colours hardcoded to defeat Zotero CSS variable overrides (`--accent-blue` etc.)
- Open Access badge contrast bumped to WCAG AA; tab hit targets meet WCAG 2.5.8

**Features (`openalex.ts`, `dialog.ts`, `results.ts`):**

- `fwci` and `citation_normalized_percentile` added to `LIST_SELECT`
- Sort dropdown: "Highest FWCI" and "Top percentile" options added
- Nulls sort last in both new sort modes

---

## What's Done (v1.0.1 — 2026-04-08)

### Quality pass — error handling, tooling, tests, docs

Audit-driven hardening pass across the full codebase. No new user-facing features except a distinct "OpenAlex is currently unavailable" error message.

**Code:**

- `src/constants.ts` — all magic numbers centralized
- `src/modules/utils.ts` — `normalizeError`, `logError`, `OpenAlexNetworkError`, `safeHTML` tagged template, `rawHTML`
- `src/modules/openalex.ts` — `normalizeDOI` handles 6 URL forms; `reconstructAbstract` validates types/bounds/caps; `fetchJson` retries on 5xx; network errors propagate as `OpenAlexNetworkError`
- `src/modules/citationService.ts` — `FetchError` union type; graceful network vs. 404 distinction
- `src/modules/citationPane.ts` — real `<button>` elements with `:focus-visible`; graceful degradation messages
- `src/modules/citationNetwork/dialog.ts` — explicit `DialogPhase` state machine prevents close-mid-fetch races
- All caught errors now flow through `normalizeError`/`logError`

**Tests:** 86 → 113 (added `normalizeError`, `normalizeDOI`, `reconstructAbstract` hardening, `safeHTML`)

**Tooling:**

- ESLint + Prettier configured (`.eslintrc.json`, `.prettierrc.json`, `.prettierignore`)
- `lint`, `lint:fix`, `format`, `format:check` scripts added to `package.json`
- Dependabot weekly npm + monthly GitHub Actions updates
- Node 22 added to CI matrix
- CI/release workflows switched from `npm ci` to `npm install` (EBADPLATFORM workaround for openharmony optional dep)

**Docs:**

- `README.md` — intro rewritten in plain researcher language; comprehensive troubleshooting section added
- `CONTRIBUTING.md` — full developer setup, command reference, pre-PR checklist, architecture overview
- `BACKLOG.md` — created from ROADMAP_ISSUES.md (9 curated enhancement ideas)
- GitHub issue forms (bug report, feature request), PR template

**Infrastructure:**

- `CITATION.cff` version bumped to 1.0.1

---

## What's Done (v1.0.0 — 2026-04-05)

Initial public release. See `CHANGELOG.md` for full feature list.

---

## Blockers

- **Zotero 10 users are locked out** (BUG-Z10-INSTALL), and released v2.0.5 is broken on the hosts it supports: on Zotero 9.0.6 and 10.0.4 it renders no pane and hides other plugins' panes (BUG-PANE-XML), shows blank menu labels, and crashes Zotero on quit after 61 s (BUG-QUIT). The no-code bridge was withdrawn after its smoke run on 2026-09-28; v2.0.6 is the fix (plan U3).
- **SEC-001**, a security defect in the citation browser, reaches every released version. Its details are held in a private security advisory until v2.0.6 ships the fix (plan, next steps, step 3).

---

## Upcoming

The order lives in the plan's "Next steps", and the detail of each item lives in exactly one place: bugs, verification gates and debt in `ISSUES.md`; feature ideas in `BACKLOG.md`; release gates in `RELEASE-CHECKLIST.md`. In short:

| #   | Step                                                            | Detail lives in                             |
| --- | --------------------------------------------------------------- | ------------------------------------------- |
| 1   | v2.0.6 for Zotero 7–10 (the bridge's smoke run failed)          | Plan U3, "U17 smoke run"; `ISSUES.md` P0     |
| 2   | Tag ruleset blocking `v*` tags: done 2026-09-28 (24140405)      | Plan, next steps, step 2                    |
| 3   | Fix SEC-001 privately; publish with v2.0.6                     | `ISSUES.md` SEC-001; plan step 3            |
| 4   | Green real-Zotero CI; fix the open findings on #93; merge it    | Plan, "First real-Zotero run" and "Open findings" |
| 5   | Small Zotero watch with an outside heartbeat                    | Plan U10                                    |
| 6   | Quit hang (#78) on macOS; menu (#67, #72) on Windows            | Plan U6, U7; `ISSUES.md` BUG-QUIT, BUG-MENU |
| 7   | Host hardening, drop Zotero 7, republish workflow               | Plan U8, U9, U15                            |
| 8   | v3.0.0 and the reporter loop                                    | Plan U13, U14; `RELEASE-CHECKLIST.md`       |
| 9   | JOSS submission, OKF pin review (#79), debt tail                | `ISSUES.md` JOSS-001, OKF-DRIFT, DEBT-*     |
| 10  | Next feature from the backlog                                   | `BACKLOG.md`                                |

---

## Release History

| Version     | Date                    | Summary                                                                                                        |
| ----------- | ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| 2.0.5       | 2026-07-09              | Right-click-menu hotfix — MenuManager labels + registration lifecycle (#67)                                    |
| 2.0.4       | 2026-06-10              | Shared-primitive unification (.cg-chip/.cg-card/.cg-banner); contrast fixes                                    |
| 2.0.3       | 2026-06-10              | Settings shortcut, section icon fix, forced color-scheme theme fix, .cg-btn                                    |
| 2.0.2       | 2026-06-08              | Dark-mode dialog tint fix; canonical design-token module (both surfaces)                                       |
| 2.0.1       | 2026-06-08              | Column repaint fix, redesigned title-match card, network browser sort/filter                                   |
| 2.0.0       | 2026-06-07              | SQLite-backed cache (migrated from Extra-field storage)                                                        |
| 1.1.0–1.3.0 | 2026-04-09 – 2026-04-19 | Title-match fallback + confirm/dismiss (1.2.0), Zotero 9 compat (1.2.1), pane redesign (1.3.0) — see CHANGELOG |
| 1.0.3       | 2026-04-09              | Non-DOI identifiers (PMID/arXiv/ISBN), rankings refresh (ABDC '25, AJG '24)                                    |
| 1.0.2       | 2026-04-08              | Family design language, FWCI/percentile sort                                                                   |
| 1.0.1       | 2026-04-08              | Quality pass: error handling, tooling, tests, docs                                                             |
| 1.0.0       | 2026-04-05              | Initial public release                                                                                         |

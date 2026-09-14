# Citegeist

A free Zotero 7, 8 & 9 plugin that shows citation counts, field-weighted impact, and journal rankings alongside the items in your library, and lets you follow citations forward and backward without leaving Zotero. Powered by [OpenAlex](https://openalex.org).

---

## Quick Reference

```bash
npm install                # Install dependencies (use this, not npm ci — see CI notes below)
npm run build:dev          # Dev build → build/addon (no minification)
npm run build              # Production build → build/citegeist-x.y.z.xpi
npm test                   # Run all tests (vitest)
npm run test:watch         # Re-run on file changes
npm run typecheck          # tsc --noEmit (strict)
npm run lint               # ESLint
npm run lint:fix           # ESLint --fix
npm run format             # Prettier write
npm run format:check       # Prettier check (no write)
npm run okf:check          # OKF docs-conformance (every docs/ file has a `type`)
npm run okf:drift          # Compare OKF spec upstream HEAD vs the pinned commit
npm run release            # Bump version + commit locally (no tag, no push); refuses unrelated changes
```

**Pre-commit checklist:** `npm run typecheck && npm test && npm run lint && npm run format:check && npm run okf:check && npm run build`

---

## Project Structure

```
src/
  index.ts                      # Bootstrap entry point
  constants.ts                  # All tunable constants (rate limits, timeouts, sizes)
  hooks.ts                      # Zotero lifecycle hooks
  modules/
    openalex.ts                 # OpenAlex API client — fetch, parse, rate limit, retry
    openalexAuthors.ts          # OpenAlex Authors client — profiles + works (shares the rate limiter)
    cache/                      # SQLite-backed cache (v2.0.0+)
      db.ts                     # Connection, in-memory mirror, lifecycle (init/close)
      read.ts                   # Sync read API (mirror only)
      write.ts                  # Async write API (SQLite first, then mirror)
      migration.ts              # One-shot Extra→SQLite migration + orphan GC
      types.ts                  # Public types + internal row shape + column list
      index.ts                  # Public surface (re-exports)
    citationService.ts          # Orchestration: fetch + cache + error handling
    titleSearch.ts              # Metadata matching — title/year/author-scored fallback
    authorProfile.ts            # Author profile + view-model layer (pure logic, no DOM)
    citationColumn.ts           # Sortable item-tree columns
    citationPane.ts             # Item-detail sidebar pane
    menu.ts                     # Right-click context menus
    utils.ts                    # Shared: escapeHTML, normalizeError, logError, safeHTML
    diagnostics/                # CG-* error codes, guards, ring buffer, redacted report
      codes.ts                  # Append-only CG-* code registry
      guard.ts                  # guard/guardAsync/bindGuarded callback boundaries
      record.ts                 # In-memory diagnostics ring buffer
      report.ts                 # Copyable, redacted failure report
      surface.ts                # Coded failure UI helpers
    citationNetwork/
      dialog.ts                 # Modal lifecycle (explicit DialogPhase state machine)
      results.ts                # Result rendering, pagination, infinite scroll
      actions.ts                # Add-to-library, undo, collection filing
      collectionPicker.ts       # Collection selection UI
      types.ts                  # Shared types, constants, DialogPhase enum
      styles.ts                 # CSS-in-JS for the dialog
      index.ts                  # Public API
    ui/                         # Canonical design system (CSS-in-JS, both surfaces)
      tokens.ts                 # cgDesignTokens — single source for --cg-* colour/space/type tokens
      components.ts             # cgComponents — shared primitives (.cg-btn/.cg-chip/.cg-card/.cg-banner/.cg-eyebrow)
      theme.ts                  # resolveHostScheme — forces color-scheme to Zotero's actual theme
  data/
    journalRankings.ts          # Static ISSN → ranking lookup (UTD24, FT50, ABDC, AJG)

test/                           # vitest unit tests
addon/                          # Static addon files (manifest.json, prefs.xhtml, icons)
scripts/                        # build.mjs, release helpers
tools/                          # okf-check.sh, okf-drift-check.sh (docs OKF standard)
typings/                        # Zotero type declarations
```

---

## Architecture Principles

**Error handling:** All caught errors flow through `normalizeError(e)` / `logError(context, e)` from `utils.ts`. Never use `"" + e` or template-string coercion — it drops stack traces.

**Network errors vs. 404:** `OpenAlexNetworkError` (from `utils.ts`) signals "service unreachable". A `null` return from `getWorkByDOI` signals "not found". UI layers check `result.error === "network"` to show the appropriate message.

**Constants:** Every magic number lives in `src/constants.ts`. Do not hardcode timeouts, sizes, or thresholds inline.

**Caching (v2.0.0+):** Cached metrics live in a plugin-owned SQLite database at `<profile>/citegeist.sqlite`. Reads hit a synchronous in-memory mirror loaded at startup (Zotero's column `dataProvider` is sync). Writes go to SQLite first, then update the mirror. Only the user-curated `Citegeist match ID: W…` line is mirrored back to Zotero's `Extra` field for downgrade safety and cross-device sync. See `src/modules/cache/` and `docs/MIGRATION-v2.0.0.md`. The one-shot migration from v1.3.x Extra-namespaced fields is in `cache/migration.ts`. Author identity lives in a separate normalized sub-module `cache/authors/` (`authors` + `item_authors` tables, curated-wins writes under the shared exported `withKeyLock`, no sync mirror — reads are async, pane-only). The `item_authors` table is the **sole** author store and the external handoff is a direct read of `citegeist.sqlite`. A native Zotero `openalex:author` item relation was intended as the handoff but is **disabled and never written**: Zotero's sync server rejects the custom predicate (`Error 400 — Unsupported predicate 'openalex:author'`) and halts the user's whole library sync. A one-time, pref-guarded startup purge (`purgeAllAuthorRelations`, `cache/authors/relations.ts`) strips any stray relations left by pre-release builds. Do not re-enable the relation without a sync-safe predicate.

**Rate limiting + metered API:** All OpenAlex calls go through a single `rateLimitedFetch` (8 req/s, 125ms interval, exponential backoff on transient 429/5xx). Never call the API directly. OpenAlex is metered as of July 2026 (singleton lookups free, list+filter metered; `mailto` is dead) — an optional, opt-in `api_key` pref rides the query string and is redacted centrally in `normalizeError`. A budget-exhausted `429` (`X-RateLimit-Remaining: 0`) raises `OpenAlexBudgetError` (no retry) and `401/403` raises `OpenAlexAuthError` — both distinct from `OpenAlexNetworkError`.

**Diagnostics — every failure is addressable (guarded, do not regress):** A user who hits a bug must end up with something to quote. Every distinguishable failure has a **stable, append-only code** in `src/modules/diagnostics/codes.ts` (`CG-NET01`, `CG-API42`, `CG-DB01`, …) with plain-language copy — a code is a permanent public identifier, so never renumber, reuse, or repurpose one (retire by leaving the entry with a note); the human-facing mirror is `docs/ERROR-CODES.md`. `CitegeistError` carries its own code, so a throw travels from the fetch layer to the UI without anyone re-deriving intent from a message string — never sniff message text to classify. `logError()` is the SINGLE funnel that records into the in-memory ring buffer (`diagnostics/record.ts`); nothing may call `recordDiagnostic` directly, because redaction only happens inside `normalizeError`. **Every callback Zotero invokes is wrapped in `guard`/`guardAsync`** — Zotero does nothing useful with an exception from one (a rejected `onAsyncRender` hangs the pane on its spinner, a throwing `dataProvider` blanks a column, a throwing `onCommand` does nothing at all), so columns and menus are guarded at their registration choke points and a new entry point inherits protection automatically. Service functions the UI awaits (e.g. `fetchAndCacheItem`) are **total** — they resolve to an error result, never throw. Error surfaces are neutral: sage means ACTION and amber means EVIDENCE, so neither may be spent on a failure. Both contracts are locked by `test/diagnostics-guard-invariants.test.ts` (a hard `npm test` / CI gate). If it fails, fix the code — never weaken the test.

**HTML safety:** Use `escapeHTML()` for interpolating user data into HTML strings. Use the `safeHTML` tagged template for new code. Never set `.innerHTML` directly — use `safeInnerHTML()` from `utils.ts` which uses DOMParser to handle Zotero's XUL document context correctly.

**Design system (UI colour + theming):** All UI colours come from the canonical `--cg-*` tokens in `src/modules/ui/tokens.ts` (`cgDesignTokens`), consumed by the shared primitives in `ui/components.ts` (`cgComponents`: `.cg-btn` / `.cg-chip` / `.cg-card` / `.cg-banner` / `.cg-eyebrow`). **Colour roles are load-bearing:** sage (`--cg-sage-accent`/`--cg-sage-tint-*`) means ACTION (buttons, links, hover, focus, selection) and is never a surface, hairline or badge; amber (`--cg-amber-*`) is EVIDENCE only at two intensities (`.cg-chip--amber` notable, `.cg-chip--amber-strong` exceptional); everything structural uses the neutral tokens (`--cg-surface-*`, `--cg-hairline`, `--cg-neutral-tint`). Metrics ALWAYS compose the shared `.cg-hero*` + `.cg-metricline*` primitives — never a row of boxed stat tiles — so the item pane and the network dialog read as one product. Never hardcode hex or rely on Zotero `--accent-*`/`--fill-*` fallbacks in component CSS — `test/ui-primitives.test.ts` fails on raw hex in a primitive and requires every primitive to be documented in the `docs/design-system/citegeist-primitives.html` gallery (the gallery mirrors the code, which is canonical). Both surfaces force `color-scheme` to Zotero's real theme via `ui/theme.ts` (`resolveHostScheme`) so `light-dark()` follows the host, not the OS; any UI portaled onto `doc.body` must do the same. **Pane composition** (layout, hierarchy, spacing rhythm) follows `docs/design-system/pane-composition-language.md` — the composition rubric that sits _on top of_ the tokens (one hero, near-cardless, 8pt rhythm, one accent, dividers over boxes) and is the arbiter for item-pane layout.

**UI visibility invariants (Zotero 9) — guarded, do not regress:** A few Zotero-9 plugin-API contracts decide whether the item-pane section, its sidenav icon, and the right-click menu render _at all_ — and they have silently regressed mid-session before. They are locked by `test/ui-visibility-invariants.test.ts` (a hard `npm test` / CI gate) plus a local Stop hook (`.claude/hooks/verify-ui-invariants.sh`) that blocks a turn from ending while they are red. The contracts: (1) `registerSection` `header`/`sidenav` MUST use `l10nID`, never a plain `label` (Z9 throws on `label` → the whole pane vanishes); (2) both MUST set `icon` AND `darkIcon` — Zotero does not default `darkIcon`, so omitting it blanks the icon in dark mode (`url('undefined')`) — pointing at an explicit-fill `*-color.svg` (a `context-fill` SVG paints transparent as a `background-image`); (3) section buttons and `Zotero.MenuManager` menu items use `l10nID`, never `label` (MenuManager silently drops `label` → a textless/blank menu); (4) FTL messages use attribute syntax — `.label` for the section header + menu items, `.tooltiptext` for the sidenav + section buttons — never a bare `id = value`; (5) the FTL loads by BARE filename via `MozXULElement.insertFTLIfNeeded("citegeist.ftl")` in BOTH `onStartup` (for a window already open before startup) and `onMainWindowLoad`, never a `chrome://citegeist/locale` link; (6) `addon/bootstrap.js` RETAINS the `registerChrome` handle and `destruct()`s it on shutdown (dropping it lets GC unregister `chrome://citegeist/` → blank icons + unresolved FTL). Full root-cause writeup: `docs/solutions/integration-issues/zotero-9-plugin-blank-ui-and-sync-break.md`. If a guard test fails, fix the code — never weaken the test.

**Documentation standard (OKF — docs only, NOT code):** Every file under `docs/` conforms to the Open Knowledge Format (OKF v0.1), **pinned** to spec commit `ee67a5c` — markdown with YAML frontmatter carrying a required `type`. OKF is a knowledge/metadata format for docs; it is **not a coding standard** — code style stays with `tsc` strict + ESLint + Prettier + `src/constants.ts`. "OKF for our coding" means the code's _knowledge_ (architecture in `docs/DESIGN.md`, the principles here) is captured as OKF docs, not that OKF governs `.ts` syntax. Validate with `npm run okf:check`; compare the upstream spec to the pin with `npm run okf:drift` (monthly review — **never auto-follow `main`**, bump the pin deliberately). Scope, `type` vocabulary, and cadence live in `docs/STANDARDS.md`; the canonical org pin is `~/developer/docs/standards/okf-adoption.md`.

---

## Release Process

**Gate first.** Before tagging any `v*`, run `docs/RELEASE-CHECKLIST.md` — the manual host-verification gates (real-Zotero smoke, diagnostics end-to-end, and the 2-device sync round-trip). CI runs the real-Zotero suite on Linux only and nothing automated exercises sync, so those surfaces still need a human; auto-update hits 100% of users with no canary, so a bad tag is fleet-wide. The mechanical steps below only run once those gates pass.

Shipping to users requires a **tagged release**, not just a merge to `main`. The steps are in **`docs/RELEASE-CHECKLIST.md` section 5, which is canonical**; this file does not repeat them. In outline: between releases `main` carries the next version's `X.Y.Z-alpha.0`, a release pull request changes it to `X.Y.Z` and is squash-merged, and the tag goes on that pull request's merge commit, named by SHA.

What `release.yml` enforces. A change to it must keep each of these true; `test/workflow-invariants.test.ts` fails if a workflow breaks one, and `test/release-guard.test.ts` and `test/release-scripts.test.ts` test the scripts:

- **`Build`** (`contents: read`, `pull-requests: read`) runs `scripts/release-guard-cli.mjs` before installing anything. It refuses a tag unless it is `vMAJOR.MINOR.PATCH`, `package.json` at the tagged commit has that version, the commit is on `main`'s first-parent history, it is the merge commit GitHub recorded for a merged pull request into `main` (squash, merge commit or rebase), and that pull request changed the version. It then installs with `--ignore-scripts`, builds, and records the SHA-256 of the XPI and `update.json`; esbuild is the only third-party code it runs. The artifact name carries the run attempt, and every later job reads the name and digests from Build's outputs.
- **`Verify`** (read-only) runs typecheck, lint, format, OKF, shellcheck and the unit tests.
- **The real-Zotero matrix** (read-only) tests the XPI `Build` made, after checking its SHA-256.
- **`Publish`** needs all three and holds `contents: write`. Before anything writes, `scripts/verify-release-assets.sh` proves the downloaded assets are Build's bytes. It runs one at a time across tags (the `release-channel` concurrency group), refuses a tag that has moved off the run's commit, and runs `scripts/check-channel-version-cli.mjs`, which refuses a version older than the live channel's newest and the same version from other bytes. `scripts/publish-versioned-release.sh` creates the release, publishes or replaces a draft an earlier attempt left, and never changes a published one. The channel step moves the `release` tag and uploads `update.json` through `scripts/publish-update-channel.sh`, and does nothing when the channel already serves these bytes, so a re-run finishes a half-done publish. It runs no npm, test code, Zotero binary or third-party action, and the invariants test allowlists every command it and the scripts it calls run.
- **`README badges`** (`contents: write`) runs after `Publish` and can fail and be re-run alone.

`addon/manifest.json` points `update_url` at `releases/download/release/update.json` — installed Zotero copies auto-update on next restart.

**Dev copy** (proxy-file install): `npm run build:dev` + restart Zotero. Does not auto-update.

---

## CI Notes

**Gates and permissions.** `ci.yml` runs typecheck, lint, format, OKF, shellcheck, unit tests and build (the `test (22)` job) beside the real-Zotero matrix, which is defined once in `real-zotero.yml` and also called by `release.yml`. Branch protection on `main` requires the single `CI gate` check, which passes only when every other `ci.yml` job succeeded, so adding or bumping a Zotero cell needs no settings change. Every workflow declares least-privilege `permissions:`, and `test/workflow-invariants.test.ts` holds each job to an exact table: jobs that run npm dependencies, scaffold or a Zotero binary hold `contents: read` (Build adds `pull-requests: read`), only `release.yml`'s `Publish` and `README badges` hold `contents: write`, and `okf-watch.yml`'s job holds `issues: write` (KTD13 in `docs/plans/2026-09-13-001-fix-zotero-10-compat-host-bugs-plan.md`). A new workflow, job or scope fails the test until the table lists it.

**Why GitHub Actions, not Vercel.** The real-Zotero suite needs a runner that can launch the Zotero desktop app, and the repository is public, so Actions minutes cost nothing. The monorepo's Vercel-first CI rule targets Vercel-deployed sites, and Citegeist has none.

**Supply chain.** Every third-party action is pinned to a full commit SHA with a `# vX.Y.Z` comment; update both together. Every job runs on `ubuntu-24.04`, every workflow sets `defaults: run: shell: bash` so pipelines fail on any failing command, no `run:` script contains a `${{ }}` expression (values reach scripts through `env:`), and workflows use no YAML anchors, aliases or merge keys. Every checkout sets `persist-credentials: false` except in `Publish` and `README badges`, which push and run no dependency. Workflows install with `npm install --no-audit --no-fund --ignore-scripts`, then fail if the install changed `package-lock.json`. Each Zotero tarball is checked against `ZOTERO_TARBALL_SHA256` in `real-zotero.yml`: a pinned hash that differs fails the cell, and `UNPINNED` only warns and prints the hash to pin. `real-zotero.yml` takes `workflow_call` inputs (`xpi-artifact` with `xpi-sha256`, `zotero-versions`, `negative-control-version`); `ci.yml` passes none and builds its own XPI, `release.yml` passes Build's artifact and digest, and neither overrides the versions or the negative control. `test/workflow-invariants.test.ts` reads every file in `.github/workflows/` and locks in these properties plus gate wiring, step order, digest checks, concurrency, lockfile checks and step deadlines. If it fails, fix the workflow — never weaken the test.

Workflows use `npm install --no-audit --no-fund`, **not** `npm ci`. This is intentional — `npm ci` fails with `EBADPLATFORM` on `@esbuild/openharmony-arm64@0.28.0` (a transitive optional dep from vitest → vite → esbuild). Do not "fix" this back to `npm ci`.

Locally, always verify with `rm -rf node_modules && npm install` before releasing.

**Tests require Node ≥22** (`.nvmrc` = 22.22.3; CI pins 22). vitest 4 + std-env 4 are ESM-only and vitest's `config.cjs` `require()`s std-env, so on Node 20 `npm test` fails to load `vitest.config.ts` (`ERR_REQUIRE_ESM`) **before any test runs** — a config-load crash, not a test failure. If a shell defaults to Node 20, prefix the Node-22 bin (`export PATH="$HOME/.nvm/versions/node/vXX/bin:$PATH"`) or `nvm use`.

---

## Code Style

- TypeScript strict mode, no `any` (warn on violations)
- Prettier for formatting, ESLint 9 (flat config, `eslint.config.mjs`) for correctness — both enforced in CI
- Prefer pure functions and small modules
- Put magic numbers in `src/constants.ts`
- Catch `unknown`, pass through `normalizeError()` / `logError()` — never log raw errors
- User-facing strings: plain language, consistent with existing copy

---

## Key Files

| File                        | Purpose                                                                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/STATUS.md`            | Current project state, what was done last session, upcoming work                                                                                                                        |
| `docs/ISSUES.md`            | Open bugs and feature requests with priorities                                                                                                                                          |
| `docs/RELEASE-CHECKLIST.md` | Manual verification gates that must pass before tagging any `v*` (real-Zotero smoke on every `zotero-versions` host, diagnostics end-to-end, 2-device sync) — run before the Release Process steps |
| `docs/solutions/`           | Documented fixes to past problems (bugs, patterns), by category with YAML frontmatter (`module`, `tags`, `problem_type`) — relevant when debugging or implementing in a documented area |
| `docs/BACKLOG.md`           | Curated longer-term enhancement ideas                                                                                                                                                   |
| `docs/STANDARDS.md`         | OKF documentation standard — pin, scope (docs-only), cadence                                                                                                                            |
| `docs/index.md`             | OKF bundle catalog (reserved index of every docs/ file)                                                                                                                                 |
| `CHANGELOG.md`              | Keep-a-Changelog format, one entry per release                                                                                                                                          |
| `docs/DESIGN.md`            | Architecture decisions and trade-offs                                                                                                                                                   |
| `CONTRIBUTING.md`           | Dev setup, commands, PR guidelines                                                                                                                                                      |
| `docs/paper/paper.md`       | JOSS paper (in progress)                                                                                                                                                                |
| `CITATION.cff`              | Machine-readable citation metadata                                                                                                                                                      |

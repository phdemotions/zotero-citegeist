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
npm run release            # Bump version, tag, push (triggers GitHub Actions release)
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
    cache/                      # SQLite-backed cache (v2.0.0+)
      db.ts                     # Connection, in-memory mirror, lifecycle (init/close)
      read.ts                   # Sync read API (mirror only)
      write.ts                  # Async write API (SQLite first, then mirror)
      migration.ts              # One-shot Extra→SQLite migration + orphan GC
      types.ts                  # Public types + internal row shape + column list
      index.ts                  # Public surface (re-exports)
    citationService.ts          # Orchestration: fetch + cache + error handling
    citationColumn.ts           # Sortable item-tree columns
    citationPane.ts             # Item-detail sidebar pane
    menu.ts                     # Right-click context menus
    utils.ts                    # Shared: escapeHTML, normalizeError, logError, safeHTML
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

**Caching (v2.0.0+):** Cached metrics live in a plugin-owned SQLite database at `<profile>/citegeist.sqlite`. Reads hit a synchronous in-memory mirror loaded at startup (Zotero's column `dataProvider` is sync). Writes go to SQLite first, then update the mirror. Only the user-curated `Citegeist match ID: W…` line is mirrored back to Zotero's `Extra` field for downgrade safety and cross-device sync. See `src/modules/cache/` and `docs/MIGRATION-v2.0.0.md`. The one-shot migration from v1.3.x Extra-namespaced fields is in `cache/migration.ts`.

**Rate limiting:** All OpenAlex calls go through a single `rateLimitedFetch` (8 req/s, 125ms interval, exponential backoff on 429/5xx). Never call the API directly.

**HTML safety:** Use `escapeHTML()` for interpolating user data into HTML strings. Use the `safeHTML` tagged template for new code. Never set `.innerHTML` directly — use `safeInnerHTML()` from `utils.ts` which uses DOMParser to handle Zotero's XUL document context correctly.

**Design system (UI colour + theming):** All UI colours come from the canonical `--cg-*` tokens in `src/modules/ui/tokens.ts` (`cgDesignTokens`), consumed by the shared primitives in `ui/components.ts` (`cgComponents`: `.cg-btn` / `.cg-chip` / `.cg-card` / `.cg-banner` / `.cg-eyebrow`). Never hardcode hex or rely on Zotero `--accent-*`/`--fill-*` fallbacks in component CSS — `test/ui-primitives.test.ts` fails on raw hex in a primitive and requires every primitive to be documented in the `docs/design-system/citegeist-primitives.html` gallery (the gallery mirrors the code, which is canonical). Both surfaces force `color-scheme` to Zotero's real theme via `ui/theme.ts` (`resolveHostScheme`) so `light-dark()` follows the host, not the OS; any UI portaled onto `doc.body` must do the same.

**Documentation standard (OKF — docs only, NOT code):** Every file under `docs/` conforms to the Open Knowledge Format (OKF v0.1), **pinned** to spec commit `ee67a5c` — markdown with YAML frontmatter carrying a required `type`. OKF is a knowledge/metadata format for docs; it is **not a coding standard** — code style stays with `tsc` strict + ESLint + Prettier + `src/constants.ts`. "OKF for our coding" means the code's _knowledge_ (architecture in `docs/DESIGN.md`, the principles here) is captured as OKF docs, not that OKF governs `.ts` syntax. Validate with `npm run okf:check`; compare the upstream spec to the pin with `npm run okf:drift` (monthly review — **never auto-follow `main`**, bump the pin deliberately). Scope, `type` vocabulary, and cadence live in `docs/STANDARDS.md`; the canonical org pin is `~/developer/docs/standards/okf-adoption.md`.

---

## Release Process

Shipping to users requires a **tagged release**, not just a push to `main`:

1. Bump versions in `package.json`, `package-lock.json` (top-level + `packages[""]`), and `CITATION.cff` — all three must match
2. Move `[Unreleased]` in `CHANGELOG.md` to the new version with today's date, add comparison link at bottom
3. Commit, then: `git tag vX.Y.Z && git push origin main && git push origin vX.Y.Z`
4. GitHub Actions builds the XPI, creates a GitHub Release, and force-updates the `release` floating tag
5. `addon/manifest.json` points `update_url` at `releases/download/release/update.json` — installed Zotero copies auto-update on next restart

Or just run `npm run release` (uses bumpp) and then push the tag.

**Dev copy** (proxy-file install): `npm run build:dev` + restart Zotero. Does not auto-update.

---

## CI Notes

Workflows use `npm install --no-audit --no-fund`, **not** `npm ci`. This is intentional — `npm ci` fails with `EBADPLATFORM` on `@esbuild/openharmony-arm64@0.28.0` (a transitive optional dep from vitest → vite → esbuild). Do not "fix" this back to `npm ci`.

Locally, always verify with `rm -rf node_modules && npm install` before releasing.

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

| File                  | Purpose                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `docs/STATUS.md`      | Current project state, what was done last session, upcoming work |
| `docs/ISSUES.md`      | Open bugs and feature requests with priorities                   |
| `docs/solutions/`     | Documented fixes to past problems (bugs, patterns), by category with YAML frontmatter (`module`, `tags`, `problem_type`) — relevant when debugging or implementing in a documented area |
| `docs/BACKLOG.md`     | Curated longer-term enhancement ideas                            |
| `docs/STANDARDS.md`   | OKF documentation standard — pin, scope (docs-only), cadence     |
| `docs/index.md`       | OKF bundle catalog (reserved index of every docs/ file)          |
| `CHANGELOG.md`        | Keep-a-Changelog format, one entry per release                   |
| `docs/DESIGN.md`      | Architecture decisions and trade-offs                            |
| `CONTRIBUTING.md`     | Dev setup, commands, PR guidelines                               |
| `docs/paper/paper.md` | JOSS paper (in progress)                                         |
| `CITATION.cff`        | Machine-readable citation metadata                               |

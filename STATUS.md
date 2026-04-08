# Citegeist — Status

> **Last Updated:** 2026-04-08
> **Phase:** Post-v1.0.0 — Quality & JOSS Preparation
> **Build:** Clean

---

## Current State

| Attribute | Value |
|-----------|-------|
| **Version** | 1.0.1 |
| **Build Status** | Clean (113 tests passing, typecheck clean, XPI 25.5 KB) |
| **Open Issues** | P0: 0, P1: 0, P2: 3, P3: 4 |
| **Stack** | TypeScript, esbuild, vitest, Zotero 7/8 bootstrap API |
| **Data Source** | OpenAlex (free, unauthenticated, CC0) |
| **Distribution** | GitHub Releases → auto-update via `release` floating tag |

---

## In Progress

*None currently.*

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

*None currently.*

---

## Upcoming

| Task | Priority | Notes |
|------|----------|-------|
| JOSS paper submission | P2 | `paper/paper.md` exists; needs journal confirmation |
| AJG rankings → 2024 edition | P2 | 2021 edition currently bundled; 2024 available |
| ABDC rankings → 2025/2026 edition | P2 | Monitor ABDC for release |
| Non-DOI identifiers (PMID, arXiv) | P3 | OpenAlex supports `works/pmid:` and `works/arxiv:` |
| Sort citation network by FWCI | P3 | Data already in response, needs UI wire-up |
| Export citation metrics (CSV) | P3 | Right-click collection → export for tenure packets |
| Collection-level analytics | P3 | Aggregate FWCI/percentile for a folder |

See `BACKLOG.md` for full details.

---

## Release History

| Version | Date | Summary |
|---------|------|---------|
| 1.0.1 | 2026-04-08 | Quality pass: error handling, tooling, tests, docs |
| 1.0.0 | 2026-04-05 | Initial public release |

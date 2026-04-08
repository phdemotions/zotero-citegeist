# Changelog

All notable changes to Citegeist will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- ESLint upgraded from v8 (legacy `.eslintrc.json`) to v9 (flat config `eslint.config.mjs`)
- `eslint-config-prettier` upgraded to v10
- `globals` package added for ESLint flat config environment definitions
- `actions/setup-node` bumped from v4 → v6 in CI and release workflows
- Release workflow now builds on Node 22 (was 20); CI matrix tests 20 + 22
- `engines.node` bumped to `>=22.0.0` (Node 20 reaches EOL 2026-04-30)
- `moduleDetection: "force"` added to `tsconfig.json`
- `STATUS.md`, `ISSUES.md`, and `CLAUDE.md` created for the project

## [1.0.1] — 2026-04-07

### Added

- Graceful network-error handling: UI now distinguishes "OpenAlex is currently unavailable" from "work not found on OpenAlex", so transient outages no longer look like permanent missing data
- `src/constants.ts` — every tunable (rate limit, cache lifetimes, timeouts, page sizes, abstract safety caps) is now declared in one place
- ESLint + Prettier configuration with `lint`, `lint:fix`, `format`, and `format:check` scripts
- Dependabot config for weekly npm and monthly GitHub Actions updates
- GitHub issue forms (bug report, feature request) and a pull-request template
- Node 22 added to the CI matrix (in addition to Node 20)
- `BACKLOG.md` — curated roadmap of planned enhancements
- Expanded test coverage: `normalizeError`, `normalizeDOI`, hardened `reconstructAbstract` (malformed input, absurd positions, length cap), and the `safeHTML` tagged template

### Changed

- Citation pane buttons are now real `<button>` elements with `:focus-visible` outlines, replacing div-based click targets
- `reconstructAbstract` validates the OpenAlex inverted index more strictly: skips empty keys, non-array positions, non-integer and out-of-range offsets, and caps final abstract length
- `normalizeDOI` now handles `http://`, `https://`, `dx.doi.org`, `doi:` scheme, `%2F` encoding, and trailing slashes
- `citationNetwork` dialog uses an explicit phase state machine (`loading-skeleton` → `loading-data` → `ready` → `closed`) to eliminate races when the user closes the dialog mid-fetch
- All caught errors now flow through `normalizeError()` / `logError()` so stack traces survive in Zotero's debug output
- README intro rewritten in plain researcher language
- CONTRIBUTING.md expanded with dev-install instructions, full command reference, pre-PR checklist, and architecture overview

### Fixed

- `normalizeError(undefined)` previously returned `undefined` despite its `string` return type — now returns `"undefined"`
- OpenAlex 5xx responses are now retried instead of surfacing immediately as hard errors

## [1.0.0] — 2026-04-05

### Added

- **Nine sortable columns** in the Zotero item list:
  - Article metrics: Citations, FWCI, Percentile
  - Journal metrics: 2-year Mean Citedness, Journal H-Index
  - Journal rankings: UTD24 (2024), FT50 (2024), ABDC (2022), AJG (2021)
- **Citation Intelligence pane** in the item sidebar showing citation count, FWCI with plain-language explanation, percentile ranking, top 1%/10% badges, and year-over-year citation trend
- **Citation network browser** for forward and backward citation chaining, with sortable results, expandable abstracts, open-access and retraction badges
- **One-click import** from the citation browser with full metadata, default collection filing, and per-item collection picker
- **Right-click context menus** for fetching citations on individual items, multi-selections, and entire collections (including subcollections)
- **Settings panel** with configurable OpenAlex polite-pool email, auto-fetch toggle, cache lifetime, and results per page
- Centralized rate limiter (8 req/s with exponential backoff on 429s)
- Bundled ISSN ranking table (~180 journals) with 3-tier ISSN matching (item ISSN, cached OpenAlex ISSNs, in-memory source cache)
- Namespaced Extra field caching that syncs across devices via Zotero Sync
- Automatic update checking via GitHub Releases
- Retraction detection and open-access badges in the network browser
- Duplicate detection — papers already in your library are flagged and cannot be re-added
- Zotero 7 and Zotero 8 compatibility
- Test suite covering utilities, OpenAlex parsing, cache logic, journal rankings, and service orchestration
- CI pipeline with build, typecheck, and test stages
- JOSS paper, DESIGN.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md

[1.0.1]: https://github.com/phdemotions/zotero-citegeist/releases/tag/v1.0.1
[1.0.0]: https://github.com/phdemotions/zotero-citegeist/releases/tag/v1.0.0

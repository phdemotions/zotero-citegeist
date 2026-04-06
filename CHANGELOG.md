# Changelog

All notable changes to Citegeist will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://github.com/phdemotions/zotero-citegeist/releases/tag/v1.0.0

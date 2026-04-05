# Changelog

All notable changes to Citegeist will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-04-04

### Added

- **Sortable columns** for Citations, FWCI, and Percentile in the Zotero item list
- **Citation Intelligence pane** showing citation count, FWCI, percentile ranking, top 1%/10% badges, and year-over-year trend
- **Citation network browser** for exploring citing works and references, with search, sort, and one-click "Add to Zotero" import
- **Right-click context menus** for fetching citations on individual items, multi-selections, and entire collections (including subcollections)
- **Settings panel** with configurable OpenAlex polite-pool email, auto-fetch toggle, cache lifetime, and results per page
- Background fetching with rate limiting (2 concurrent requests, 500 ms between batches)
- Automatic update checking via GitHub Releases
- Retraction detection and open-access badges in the network browser
- Duplicate detection — papers already in your library are flagged and cannot be re-added

[1.0.0]: https://github.com/phdemotions/zotero-citegeist/releases/tag/v1.0.0

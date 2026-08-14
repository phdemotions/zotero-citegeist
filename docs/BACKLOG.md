---
type: backlog
title: Citegeist — backlog
description: Curated longer-term enhancement ideas, each a candidate GitHub issue.
timestamp: 2026-08-13
tags: [citegeist, backlog, enhancements]
---

# Citegeist Backlog

A curated list of planned enhancements and ideas for Citegeist. Each item is a candidate for — or already tracked as — a GitHub issue (linked where one exists); contributions are welcome on any of them. If you'd like to pick one up, open an issue (or comment on an existing one) to coordinate.

Items are grouped loosely by theme, not priority. Shipped items leave this list (metadata-based title matching shipped as v1.2.0 — see `CHANGELOG.md`). See [CONTRIBUTING.md](CONTRIBUTING.md) before starting work.

---

## Expand journal rankings beyond business and management

**Labels:** `enhancement`, `rankings`, `help wanted`
**GitHub:** [#3](https://github.com/phdemotions/zotero-citegeist/issues/3)

Citegeist currently bundles ~180 journals across business, management, economics, finance, IS, marketing, and psychology. Researchers in other fields have their own widely-used ranking lists.

**Disciplines and lists to consider:**

- **Education:** ERA (Excellence in Research for Australia)
- **Law:** Washington & Lee Law Journal Rankings
- **Computer Science:** CORE Rankings
- **Medicine / Public Health:** Journal quartiles (Q1–Q4) from Scimago
- **Political Science / Sociology:** Scimago or field-specific lists
- **Engineering:** Various national ranking schemes

**How this would work:**

- Each discipline's ranking list would be a separate data file
- Users could enable/disable ranking columns by discipline in settings
- The column infrastructure already supports additional ranking types

If you use a ranking list in your field and would like to see it in Citegeist, please comment with:

1. The name of the list
2. A link to the official source
3. How many journals it covers (roughly)

---

## Automatic fallback to secondary citation data sources

**Labels:** `enhancement`
**GitHub:** [#71](https://github.com/phdemotions/zotero-citegeist/issues/71)

OpenAlex coverage is weakest exactly where many researchers work: older papers, non-English literature, and work outside the major commercial publishers. When OpenAlex has no record for an item, Citegeist currently shows nothing.

**Proposed feature (from #71):**

- If OpenAlex returns no result for an item, try one or more secondary sources in a configurable priority order (e.g. Crossref → Semantic Scholar → OpenCitations)
- Opt-in setting, default OFF — users satisfied with OpenAlex-only coverage see no change
- Stop at the first source that returns a result

**Scoping notes:** each source needs its own rate limiter, error discrimination, and response mapping (the `rateLimitedFetch` machinery is OpenAlex-specific today). FWCI, percentile, and the OpenAlex work-id graph don't exist in the fallback sources — a fallback hit fills citation counts, not the normalized metrics or the citation-network browser. Counts from different sources aren't directly comparable either, so a fallback result should be labeled with its source.

---

## Export citation metrics for tenure packets and grant reports

**Labels:** `enhancement`, `high-impact`
**GitHub:** [#4](https://github.com/phdemotions/zotero-citegeist/issues/4)

Researchers regularly need to compile citation metrics for tenure cases, promotion dossiers, annual reviews, and grant applications. Right now they have to manually copy numbers from Citegeist columns into a spreadsheet or document.

**Proposed feature:**

- Right-click a collection → "Export Citation Report (Citegeist)"
- Generates a formatted summary (CSV or simple table) with:
  - Title, Authors, Year, Journal
  - Citation count, FWCI, Percentile
  - Journal rankings (UTD24, FT50, ABDC, AJG)
- Optional: summary statistics for the collection (median FWCI, % of papers in top 10%, count of papers in ranked journals)

This would save researchers hours of manual work every review cycle.

---

## Collection-level analytics dashboard

**Labels:** `enhancement`, `high-impact`
**GitHub:** [#5](https://github.com/phdemotions/zotero-citegeist/issues/5)

When doing a literature review or preparing a meta-analysis, researchers often want to understand the overall profile of a collection — not just individual papers.

**Proposed feature:**

- Select a collection → see aggregate stats in the Citation Intelligence pane or a dedicated view:
  - Total papers, median citation count, median FWCI
  - Distribution of papers by percentile bracket (top 1%, top 10%, top 25%, etc.)
  - Breakdown by journal ranking tier
  - Year distribution of the collection
  - Top cited papers in the collection

This would help researchers characterize the quality and scope of their literature review at a glance, which is useful for methods sections and reviewer responses.

---

## Citation alerts — track papers gaining traction

**Labels:** `enhancement`, `idea`
**GitHub:** [#7](https://github.com/phdemotions/zotero-citegeist/issues/7)

Researchers want to know when a paper in their library starts getting noticed. Currently, Citegeist shows a snapshot of the trend, but doesn't proactively notify you.

**Idea:**

- On each data refresh, compare the new citation count to the cached count
- If a paper's citations jumped significantly since the last fetch (e.g., +50% or +10 citations), flag it with a visual indicator
- Optional: surface a "Trending in your library" summary when Zotero starts

This would be especially useful for:

- Tracking your own publications' impact
- Spotting emerging influential papers in a literature review collection
- Identifying when a sleeper paper suddenly gets attention

---

## Localization / i18n support

**Labels:** `enhancement`, `help wanted`
**GitHub:** [#8](https://github.com/phdemotions/zotero-citegeist/issues/8)

Citegeist's UI strings (column headers, pane labels, button text, tooltips) are currently English-only. Zotero has a large international user base and supports localization through `.ftl` (Fluent) files.

**What's needed:**

- Extract all user-facing strings into Fluent `.ftl` files
- Add locale folders for common languages (Spanish, Portuguese, Chinese, German, French, Japanese, Korean)
- Community contributions for translations

If you'd like to help translate Citegeist into your language, please comment with the language you can contribute.

---

## Server-side sort for the citation network browser

**Labels:** `enhancement`, `performance`

The citation network browser now sorts the **loaded page** of results client-side (`compareNetworkWorks` / `getVisibleNetworkWorks` in `src/modules/citationNetwork/results.ts`). For paginated result sets, sorting the whole set would require asking OpenAlex to sort server-side via its `sort=` parameter (e.g. `cited_by_count:desc`, `fwci:desc`, `publication_date:asc`) and re-fetching on sort change. Local-only modes (first-author surname, "not in my library first") stay client-side.

This is a refinement of the now-shipped redesign (header with source metadata + cited-by stat, new sort modes, hide-in-library filter — see the [toolbar mockup](mockups/citation-network-toolbar-ux.html)). It mainly matters for source papers with hundreds of citing works, where the most-cited result may sit beyond the first loaded page.

---

## Reference-list order in the citation network browser

**Labels:** `enhancement`
**GitHub:** [#29](https://github.com/phdemotions/zotero-citegeist/issues/29)

When viewing a paper's references, researchers often want them in the order the paper cites them — the numbered reference list — not ranked by citation count.

**Proposed feature (from #29):**

- A "Reference order" sort mode in the references view: a simple numbered list matching the paper's bibliography

**Scoping note:** OpenAlex's `referenced_works` isn't guaranteed to preserve the paper's reference-list order, so the true order needs a second source (e.g. the Crossref `reference` array, where publishers deposit it) — a cousin of the multi-source fallback item above.

---

## Show the candidate's authors in the title-match card

**Labels:** `enhancement`, `design`

The redesigned title-match confirm/discard card (shipped v2.0.1) shows the candidate's title, year, and estimated metrics, but **not its authors** — two papers with the same title/year are still hard to tell apart. The author data is available from `searchByMetadata`'s `candidate.authorships`, but surfacing it needs a new `pending_authors` column in the cache.

**Why deferred:** the cache schema is created with plain `CREATE TABLE IF NOT EXISTS` (`src/modules/cache/db.ts`) — there's no column-add migration path, so adding `pending_authors` requires a schema migration (`ALTER TABLE ADD COLUMN`) for existing v2.x users. Everything else in the card needed no schema change, so it shipped without authors.

**Scope:** add `pending_authors TEXT` + a one-shot `ALTER TABLE` migration; thread a formatted author string through `writePendingSuggestion` → `getPendingSuggestion` → `renderSuggestion` (from `match.work.authorships`).

---

## "My Authors" — a deduplicated author index for your library

**Labels:** `enhancement`, `high-impact`, `authors`

v2 follow-up to the author identity layer (see the [author-identity-layer requirements](brainstorms/2026-07-16-author-identity-layer-requirements.md)). Once each library item's authors are resolved to a curated OpenAlex identity, surface a browsable, deduplicated index of every author across the library — each with their Scholar-style profile and a count of how many of your items they wrote. Turns the per-item identity into a first-class way to navigate the library by person.

**Why deferred to v2:** it's a second major surface (its own view plus curation-at-scale) layered on the per-item pane profile and background identity resolution that ship in v1. The identity foundation should prove out before the aggregate view is worth building.

**Depends on:** the `authors` / `item_authors` tables and background identity resolution delivered in v1.

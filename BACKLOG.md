# Citegeist Backlog

A curated list of planned enhancements and ideas for Citegeist. Each item is a candidate for a GitHub issue — contributions are welcome on any of them. If you'd like to pick one up, open an issue (or comment on an existing one) to coordinate.

Items are grouped loosely by theme, not priority. See [CONTRIBUTING.md](CONTRIBUTING.md) before starting work.

---

## Update ABDC rankings when 2025/2026 edition is released

**Labels:** `enhancement`, `rankings`

The ABDC (Australian Business Deans Council) is currently revising their Quality Journal List. The next edition (expected 2025 or 2026) will replace the 2022 list currently bundled with Citegeist.

**What needs to happen:**

- Monitor ABDC for the official release of the new list
- Update `src/data/journalRankings.ts` with new tiers — journals may move between A\*, A, B, C or be added/removed
- Update column header label from "ABDC '22" to the new year
- Update README and JOSS paper references

If you have early access to the new list or know the expected release date, please comment here.

---

## Update AJG rankings to 2024 edition

**Labels:** `enhancement`, `rankings`

The Chartered ABS Academic Journal Guide released a 2024 edition. Citegeist currently bundles the 2021 edition.

**What needs to happen:**

- Source the AJG 2024 tier assignments
- Update `src/data/journalRankings.ts`
- Update column header label from "AJG '21" to "AJG '24"
- Note any journals that changed tiers

Contributions welcome — if you have access to the AJG 2024 list, please share the relevant ISSN-to-tier mappings.

---

## Expand journal rankings beyond business and management

**Labels:** `enhancement`, `rankings`, `help wanted`

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

## Export citation metrics for tenure packets and grant reports

**Labels:** `enhancement`, `high-impact`

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

## Support non-DOI identifiers (PMID, arXiv ID, ISBN)

**Labels:** `enhancement`

Citegeist currently requires a DOI to fetch citation data. Some items in a typical Zotero library don't have DOIs:

- **Preprints** often have arXiv IDs but no DOI
- **Older biomedical papers** may only have a PubMed ID (PMID)
- **Books and chapters** have ISBNs
- **Working papers and dissertations** may have none of the above

OpenAlex indexes works by multiple identifiers. We could fall back to PMID or arXiv ID when no DOI is present:

- `https://api.openalex.org/works/pmid:12345678`
- `https://api.openalex.org/works/arxiv:2205.01833`

This would expand coverage beyond journal articles without requiring any new data source.

---

## Citation alerts — track papers gaining traction

**Labels:** `enhancement`, `idea`

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

Citegeist's UI strings (column headers, pane labels, button text, tooltips) are currently English-only. Zotero has a large international user base and supports localization through `.ftl` (Fluent) files.

**What's needed:**

- Extract all user-facing strings into Fluent `.ftl` files
- Add locale folders for common languages (Spanish, Portuguese, Chinese, German, French, Japanese, Korean)
- Community contributions for translations

If you'd like to help translate Citegeist into your language, please comment with the language you can contribute.

---

## Sort citation network results by FWCI

**Labels:** `enhancement`

The citation network browser currently lets you sort results by citation count, year, and title. Adding FWCI as a sort option would let researchers find the most field-relevant citing works, not just the most cited ones.

This aligns with Citegeist's core value proposition: field-normalized metrics are more meaningful than raw counts. The FWCI data is already available in the OpenAlex response for each work — it just needs to be wired into the sort controls.

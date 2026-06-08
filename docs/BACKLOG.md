# Citegeist Backlog

A curated list of planned enhancements and ideas for Citegeist. Each item is a candidate for a GitHub issue — contributions are welcome on any of them. If you'd like to pick one up, open an issue (or comment on an existing one) to coordinate.

Items are grouped loosely by theme, not priority. See [CONTRIBUTING.md](CONTRIBUTING.md) before starting work.

---

## Metadata-based matching for items without a recognized identifier

**Labels:** `enhancement`, `high-impact`

When no DOI, PMID, arXiv ID, or ISBN is present — or when the identifier returns "not found" on OpenAlex — Citegeist currently shows blank cells with no explanation. Many items in a typical Zotero library fall into this category: older conference papers, working papers, grey literature, items imported from imperfect bibliographic databases.

**Proposed feature (fully specced in [DESIGN.md](DESIGN.md)):**

- Fall back to a title + year OpenAlex search when direct lookup fails
- Score the top candidate by word-level Dice similarity (title), year proximity, and author last-name overlap
- Two confidence tiers: high (≥ 0.92, data shown with `~` prefix) and medium (0.72–0.92, suggestion card in pane)
- Explicit Confirm / Not this paper controls — never auto-apply without researcher sign-off
- On confirm: store `Citegeist.openAlexId` so future refreshes go direct, bypassing title search
- Bonus: if the matched work has a DOI and the item doesn't, offer to add it with one click — permanently graduating the item out of the title-search pipeline

**Why this matters for researchers:**
Citation data for conference proceedings, working papers, and imported items from imperfect sources is currently invisible in Citegeist. Metadata matching closes this gap without requiring researchers to manually hunt for identifiers.

See the full design rationale, confidence thresholds, UI states, and module structure in [DESIGN.md](DESIGN.md).

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

## Citation network browser redesign — toolbar, sorting, and in-library filtering

**Labels:** `enhancement`, `design`

A planned redesign of the citation network browser's header and result controls. A UX mockup exists at [`mockups/citation-network-toolbar-ux.html`](mockups/citation-network-toolbar-ux.html) — open it in a browser to see the intended layout.

**Scope:**

- **Redesigned dialog header** — a compact command bar showing the source paper's own metadata (authors · venue · year) and citation count alongside the title, instead of just the title.
- **Richer sorting** — beyond the current citation-count / year / title options, add:
  - FWCI (field-normalized impact) — the data is already in each work's OpenAlex response; field-normalized metrics are more meaningful than raw counts, so this aligns with Citegeist's core value
  - Percentile
  - First-author surname (with multi-word surname-prefix handling: "de la Cruz", "van der Berg")
  - "Not in my library first" — surface works you haven't added yet
  - Server-side sorting via OpenAlex `sort=` params where supported, local sorting otherwise
- **Hide-in-library filter** — optionally drop works already in your library (by DOI or added-this-session ID) so the list shows only new discoveries.
- Unknown publication dates sort last regardless of direction.

**Note for implementers:** a previous session drafted vitest specs for the pure pieces of this (a sort comparator, an OpenAlex-sort mapping, an in-library visibility filter, and a `getItemSourceMetaLine` header formatter). They were removed from the 2.0 release to keep scope tight, but the contracts are a good starting point — extract the sort/filter logic currently inline in `src/modules/citationNetwork/results.ts` into pure, testable functions, add a `getItemSourceMetaLine(item)` helper in `dialog.ts`, and preserve every selector `bindDialogEvents` depends on when reworking the header.


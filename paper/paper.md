---
title: "Citegeist: Citation Intelligence for Zotero"
tags:
  - Zotero
  - citation analysis
  - bibliometrics
  - OpenAlex
  - literature review
  - scholarly communication
  - research tools
authors:
  - name: Josh Gonzales
    orcid: 0000-0001-8633-3380
    affiliation: 1
affiliations:
  - name: University of Guelph
    index: 1
date: 4 April 2026
bibliography: paper.bib
---

# Summary

Citegeist is a plugin for Zotero 7 that brings citation intelligence directly into the reference manager. For any item with a DOI, Citegeist retrieves data from OpenAlex [@priem2022openalex], a free and open index of over 250 million scholarly works, and displays:

1. A **sortable citation count column** in the item list.
2. A **Citation Intelligence pane** showing contextual metrics — field-weighted citation impact (FWCI), percentile ranking, top 1%/10% badges, and year-over-year citation trends — all explained in plain language within the interface.
3. A **citation network browser** for forward and backward citation chaining, with one-click import of discovered papers into Zotero.

No API key, institutional subscription, or account is required.

# Statement of Need

Citation analysis is a routine part of academic research. Researchers trace how ideas spread by following citation chains forward (who cites this paper?) and backward (what does this paper cite?) — a method known as snowballing [@wohlin2014guidelines]. During tenure cases, grant applications, and hiring decisions, committees examine citation metrics to assess impact. The Leiden Manifesto [@hicks2015leiden] has called for these metrics to be used responsibly, with field-level context rather than raw counts, yet the tools most researchers have access to make contextual comparison difficult.

Raw citation counts are misleading across disciplines: 50 citations for a consumer psychology paper may place it in the top 10% of its field, while 50 citations in biomedicine is below average [@waltman2016review]. What researchers need is a field-normalized measure. FWCI (Field-Weighted Citation Impact) provides this by comparing a paper's citation count to the expected average for papers in the same field, year, and document type. An FWCI of 1.0 means exactly the world average; 2.0 means twice the expected citations. Citegeist retrieves FWCI directly from OpenAlex and presents it alongside a percentile ranking (e.g., "85th percentile" means cited more than 85% of comparable papers), making these comparisons immediate and intuitive.

The typical workflow today involves leaving the reference manager, navigating to Web of Science, Scopus, or Google Scholar, searching for each paper individually, and manually recording results. This is especially burdensome during large-scale literature reviews common in fields where review articles are central [@palmatier2018review].

Zotero [@zotero] is the most widely used free, open-source reference manager, yet it provides no built-in citation metrics. Two existing plugins have attempted to address this gap. Zotero Scholar Citations [@zotero_scholar_citations] retrieves counts from Google Scholar but has not been updated for Zotero 7, is limited to raw counts without field context, and is subject to Google Scholar's aggressive rate limiting and bot detection. The scite Zotero plugin [@scite_zotero] provides smart citation classifications (supporting, mentioning, contrasting) but requires a paid subscription to scite.ai, putting it out of reach for many researchers and institutions.

Citegeist addresses these limitations. By using OpenAlex — a fully open, free-to-use index built on Crossref, PubMed, and institutional repositories — it requires no authentication and no payment. The citation network browser enables the kind of forward and backward citation chaining that is foundational to systematic literature discovery [@garfield1955citation; @wohlin2014guidelines], without leaving Zotero.

# Design

![The Citation Intelligence pane shows citation count, FWCI, percentile ranking, and a year-over-year citation trend for a selected paper.](figure-pane.png){width="100%"}

![The citation network browser displays papers that cite a selected work, sorted by citation count. Green checkmarks and "In Library" badges indicate papers already in the researcher's Zotero library. The "Add to Zotero" button imports selected papers with full metadata.](figure-network.png){width="80%"}

Citegeist adds three components to Zotero:

**A sortable Citations column** in the item list displays each item's citation count, fetched automatically in the background. Clicking the column header sorts the library by citation count.

**A Citation Intelligence pane** appears in the item detail sidebar. It displays the citation count, FWCI (with a plain-language explanation of what the number means), percentile ranking, top 1%/10% badges, and a year-over-year citation trend showing whether a paper's influence is growing or declining.

**A citation network browser** lets researchers explore citing works (forward chaining) and references (backward chaining). Results show title, authors, venue, year, citation count, open-access status, and retraction warnings. Researchers select papers and add them to Zotero with complete metadata in one click. Duplicate detection prevents re-importing items already in the library.

All data is cached in each item's Extra field using namespaced keys (e.g., `Citegeist.citedByCount: 42`), preserving data across sessions and through Zotero Sync.

# Implementation

Citegeist is implemented in TypeScript and built with esbuild. It uses Zotero 7's plugin APIs (`ItemPaneManager` for the sidebar pane, `ItemTreeManager` for the custom column) and communicates with the OpenAlex REST API. To respect rate limits, the plugin performs at most two concurrent requests with 500 ms spacing between batches. Responses are cached locally with a configurable expiration period (default: 7 days). Users can optionally provide an email to access OpenAlex's polite pool for higher rate limits.

The plugin is distributed as a standard Zotero `.xpi` file and supports automatic updates via GitHub Releases. Installation requires no command-line tools — researchers download a single file, open it in Zotero, and restart.

The project includes automated tests for utility functions, OpenAlex response parsing, author formatting, and cache read/write logic, run via Vitest in continuous integration. Full documentation, including installation instructions and a getting-started guide, is in the project README. Community contribution guidelines are in `CONTRIBUTING.md`.

# Acknowledgements

Citegeist relies on the OpenAlex open bibliometric index. The author thanks the OpenAlex team for providing free, comprehensive access to scholarly metadata and citation data.

# References

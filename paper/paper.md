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

Citegeist is a plugin for Zotero 7 that integrates citation intelligence directly into the reference manager. For any item with a DOI, Citegeist retrieves citation counts, field-weighted citation impact (FWCI), percentile rankings, and year-over-year citation trends from OpenAlex [@priem2022openalex], a free and open bibliometric index covering over 250 million scholarly works. The plugin also provides a citation network browser that lets researchers explore citing works and references, and add them to their Zotero library with full metadata in a single action.

# Statement of Need

Citation analysis is a routine part of academic research, used during literature reviews, tenure evaluations, grant applications, and research assessment. Researchers typically rely on Web of Science, Scopus, or Google Scholar to obtain citation metrics, all of which require leaving the reference manager, navigating to an external service, and manually cross-referencing results.

This workflow is inefficient and error-prone. Zotero [@zotero] is the most widely used free, open-source reference manager, yet it provides no built-in citation metrics. Existing Zotero plugins for citation data are either unmaintained, limited to raw counts without contextual metrics, or depend on proprietary APIs that require institutional subscriptions.

Citegeist addresses this gap by embedding citation intelligence directly in Zotero. By using OpenAlex as its data source, the plugin requires no API key, no institutional subscription, and no account creation. It provides not only raw citation counts but also field-normalized metrics (FWCI and percentile rankings) that allow meaningful comparison across disciplines. The citation network browser enables forward and backward citation chaining, a core method in systematic literature reviews [@wohlin2014guidelines], without leaving Zotero.

# Features

Citegeist adds three components to Zotero:

1. **A sortable Citations column** in the item list, displaying the citation count for each item. Counts are fetched in the background with rate limiting to respect API limits.

2. **A Citation Intelligence pane** in the item detail sidebar, showing:
   - Total citation count
   - Field-Weighted Citation Impact (FWCI), where 1.0 represents the world average for the item's field and publication year
   - Percentile ranking relative to all works in the same field and year
   - Top 1% and top 10% badges when applicable
   - Year-over-year citation trend with peak-year detection

3. **A citation network browser** for exploring citing works (forward chaining) and references (backward chaining). Results display title, authors, venue, year, citation count, open-access status, and retraction warnings. Researchers can select any number of results and add them to their Zotero library with full metadata in one click. Duplicate detection prevents re-importing items already present in the library.

All citation data is cached in each item's Extra field using namespaced keys, ensuring persistence across sessions and compatibility with Zotero Sync.

# Implementation

Citegeist is implemented in TypeScript and built with esbuild. It uses Zotero 7's plugin APIs (`ItemPaneManager`, `ItemTreeManager`) and communicates with the OpenAlex REST API. The plugin performs concurrent requests (two at a time with 500 ms spacing) and caches responses locally with a configurable expiration period (default: 7 days). Users can optionally provide an email address to access OpenAlex's polite pool, which provides higher rate limits.

The plugin is distributed as a standard Zotero `.xpi` file and supports automatic updates via GitHub Releases.

# Acknowledgements

Citegeist relies on the OpenAlex open bibliometric index. We thank the OpenAlex team for providing free, comprehensive access to scholarly metadata and citation data.

# References

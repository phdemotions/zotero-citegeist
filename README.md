<p align="center">
  <img src="assets/logo.png" width="200" alt="Citegeist logo" />
</p>

<h1 align="center">Citegeist</h1>

<p align="center">
  <strong>Citation intelligence for Zotero 7, powered by <a href="https://openalex.org">OpenAlex</a>.</strong><br>
  See how influential a paper really is. Explore what cites it. Add works to your library in one click.
</p>

<p align="center">
  <a href="https://github.com/phdemotions/zotero-citegeist/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/phdemotions/zotero-citegeist?style=flat-square&color=5a9cff" /></a>
  <a href="https://github.com/phdemotions/zotero-citegeist/releases/latest"><img alt="Downloads" src="https://img.shields.io/github/downloads/phdemotions/zotero-citegeist/total?style=flat-square&color=30d158" /></a>
  <a href="https://github.com/phdemotions/zotero-citegeist/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/phdemotions/zotero-citegeist?style=flat-square&color=8e8e93" /></a>
</p>

---

## What is Zotero?

[Zotero](https://www.zotero.org) is a free, open-source reference manager. It helps you collect, organize, and cite research papers. If you've never used it, [download Zotero 7](https://www.zotero.org/downloads/) and add a few papers to your library before installing Citegeist.

Key Zotero terms used in this guide:

- **Library** &mdash; Your collection of saved papers, articles, and books
- **Item** &mdash; A single entry in your library (a paper, book chapter, etc.)
- **Collection** &mdash; A folder you create to organize items by topic or project
- **DOI** &mdash; A Digital Object Identifier, a unique code assigned to most published papers (e.g., `10.1038/nature12373`). Citegeist uses the DOI to look up citation data.
- **Extra field** &mdash; A text field on each item where Zotero (and plugins) can store additional data

---

## What is Citegeist?

Citegeist is a plugin (an add-on that extends Zotero's features) that adds citation data to your library. For any paper with a DOI, you can see:

- How many times it's been cited by other papers
- How it compares to other papers in its field (is it above or below average?)
- Whether citations are increasing or decreasing over time
- Which papers cite it, and which papers it references
- Whether it's been retracted (formally withdrawn by the publisher)
- What journal ranking lists the venue appears on (UTD24, FT50, ABDC, AJG)

All of this data comes from [OpenAlex](https://openalex.org), a free and open index of hundreds of millions of scholarly works. Journal rankings are bundled with the plugin (no API calls). **No API key required.** You don't need to create an account or pay for anything.

---

## Install

> **Requires [Zotero 7](https://www.zotero.org/downloads/) or later.** Citegeist does not work with Zotero 6.

1. Download **[citegeist.xpi](https://github.com/phdemotions/zotero-citegeist/releases/latest)** from the latest release (click the `.xpi` file under "Assets" to download it)
2. Open Zotero 7
3. Go to **Tools &rarr; Add-ons** from the menu bar
4. Click the gear icon (**&#9881;**) in the top-right corner of the Add-ons window &rarr; **Install Add-on From File...**
5. Find and select the `.xpi` file you downloaded (it's probably in your Downloads folder)
6. **Restart Zotero** when prompted

That's it. Once Zotero restarts, Citegeist will begin fetching citation data automatically for papers in your library.

### Staying up to date

Citegeist checks for updates automatically via GitHub Releases. When a new version is available, Zotero will install it on the next restart.

---

## Getting Started

Once installed, Citegeist adds three things to Zotero:

1. **Nine sortable columns** for article metrics, journal metrics, and journal rankings
2. A **Citation Intelligence pane** in the item detail sidebar
3. **Right-click menu options** for fetching and exploring citations

Here's how to use each one.

---

### 1. Sortable Columns

Citegeist adds nine new columns to your item list, organized in three groups.

#### Article-level metrics (from OpenAlex)

| Column | What it shows |
|--------|--------------|
| **Citations** | Total citation count for each paper |
| **FWCI** | Field-Weighted Citation Impact &mdash; how the paper compares to the average for its field (1.0 = average, 2.0 = twice the average) |
| **Percentile** | Where the paper ranks among all papers in its field and year (e.g., 85.0 = cited more than 85% of comparable papers) |

#### Journal-level metrics (from OpenAlex Sources API)

| Column | What it shows |
|--------|--------------|
| **Citedness** | The journal's 2-year mean citedness (OpenAlex's open equivalent of Journal Impact Factor) |
| **J. H-Index** | The journal's h-index &mdash; how many papers have been cited at least that many times |

#### Journal ranking lists (bundled, no API calls)

| Column | What it shows |
|--------|--------------|
| **UTD24** | Checkmark if the journal is on the UT Dallas 24 list (2024) |
| **FT50** | Checkmark if the journal is on the Financial Times 50 list (2024) |
| **ABDC '22** | ABDC 2022 tier: A\*, A, B, or C |
| **AJG '21** | ABS Academic Journal Guide 2021 tier: 4\*, 4, 3, 2, or 1 |

**If you don't see the columns:**

1. Right-click on any column header in the item list (e.g., "Title", "Creator", "Date")
2. A dropdown will appear with all available columns
3. Check any Citegeist columns you want to enable
4. You can drag columns to reorder them, or click any header to sort

All data is fetched automatically in the background as you browse your library. Papers without a DOI will show blank cells. A dash (**&mdash;**) means data was fetched but that metric isn't available for this paper (common for very old or very recent publications). Journal ranking columns use a bundled lookup table matched by ISSN, so they appear instantly with no network requests.

**Tip:** Click the **FWCI** column header to sort your library by field-normalized impact. This is more meaningful than sorting by raw citation count because it accounts for differences between fields. For example, a paper in consumer psychology with 50 citations may have an FWCI well above 1.0, while the same count in biomedicine may be average.

---

### 2. The Citation Intelligence Pane

Select any item in your library and look at the right-hand detail panel. Scroll down (or look in the sidebar tabs) for the **Citation Intelligence** section.

You'll see:

| Element | What it means |
|---------|--------------|
| **Citation count** | The total number of times other published papers have referenced this one |
| **FWCI** | Field-Weighted Citation Impact &mdash; a way to compare papers across different fields fairly. A score of **1.0** means this paper has been cited the average amount for its field and year. **2.0** means twice the average. This matters because some fields (like biomedicine) cite more than others (like mathematics), so raw citation counts can be misleading. |
| **Percentile** | Where this paper ranks compared to all other papers in its field and year. For example, "85th %ile" means it's been cited more than 85% of comparable papers. |
| **Top 1% / Top 10%** | A badge appears if the paper is in the top 1% or top 10% most-cited papers in its field |
| **Trend** | How citation rates are changing over time (e.g., "45 citations in 2025, up 23% from last year"). This helps you see whether a paper's influence is growing or fading. |

Below the stats, you'll see two buttons:

- **View N citing works &rarr;** &mdash; Opens the citation network browser showing papers that cite this one
- **View references &rarr;** &mdash; Opens the citation network browser showing papers this one cites

**Refreshing data:** Click the refresh button (**&#8635;**) in the pane header to force-refresh from OpenAlex. By default, cached data expires after 7 days.

---

### 3. The Citation Network Browser

The citation network browser lets you explore the web of papers connected to any item in your library. "Citing works" are papers published *after* your paper that reference it. "References" are papers your paper cites &mdash; the older work it builds on. Exploring both directions is a common technique for finding relevant literature (sometimes called "snowballing").

Click either **"View citing works"** or **"View references"** to open the browser.

#### Browsing results

The browser shows a scrollable list of papers. Each result displays:

- **Paper title** (click to open on OpenAlex)
- **Authors** (first author listed; "et al." means "and others" when there are many authors)
- **Journal/venue and year**
- **Citation count** (color-coded: gold for highly cited, white for moderate, grey for low)
- **Badges:** Open Access (green), Retracted (red), In Library (blue)

Click any result to expand its **abstract** (fetched on demand from OpenAlex).

#### Switching between Cited By and References

At the top of the browser, you'll see two pill-shaped tabs:

- **Cited By** &mdash; Papers that cite the selected work
- **References** &mdash; Papers that the selected work cites

Click either tab to switch views.

#### Searching and sorting

Type in the search bar to filter results by title or author. Use the dropdown next to the search bar to sort by:

- **Most cited** (default) &mdash; Highest citation count first
- **Newest** &mdash; Most recent publications first
- **Oldest** &mdash; Oldest publications first

#### Adding papers to your Zotero library

Each result row has a split button:

1. **Click the main button** ("+ Add to *Collection Name*") to add the paper to your default collection with full metadata: title, authors, journal, volume, issue, pages, DOI, date, URL, and cached citation data.
2. **Click the dropdown arrow** (&blacktriangledown;) to choose specific collections using a folder picker.
3. **After adding**, the button briefly shows "Added &middot; Undo" (3 seconds) in case of a misclick, then transitions to a **File** button for managing which collections the paper belongs to.

Papers already in your library show a **File** button immediately, letting you move them between collections directly from the browser.

**Set a default collection:** Use the collection picker at the top of the browser to choose where new papers are added by default. This saves clicks when you're adding multiple papers to the same project folder.

**Tip:** This is especially useful for literature reviews. Open a key paper, view its citing works, sort by most cited, and add relevant results to your library &mdash; all without leaving Zotero.

---

### 4. Right-Click Menus

Citegeist adds options to Zotero's right-click context menus.

#### On individual items (or multiple items)

Right-click one or more items in your library to see:

| Menu item | What it does |
|-----------|-------------|
| **Fetch Citation Counts** | Fetches (or refreshes) citation data for the selected items. Works with multi-select &mdash; highlight 50 papers and fetch them all at once. |
| **View Citing Works...** | Opens the citation network browser in "Cited By" mode. Only appears for single items with a DOI. |
| **View References...** | Opens the citation network browser in "References" mode. Only appears for single items with a DOI. |

#### On collections (folders)

Right-click any collection in the left sidebar to see:

| Menu item | What it does |
|-----------|-------------|
| **Fetch All Citation Counts (Citegeist)** | Fetches citation data for every item in this collection **and all subcollections**. A progress bar shows how many items have been processed. |

**Tip:** Right-click your top-level collection after importing a batch of papers to populate all citation counts at once.

---

## Settings

Open Zotero's settings (**Zotero &rarr; Settings** on macOS, **Edit &rarr; Preferences** on Windows/Linux) and select the **Citegeist** tab to configure:

| Setting | Default | What it does |
|---------|---------|-------------|
| **Email for OpenAlex polite pool** | *(empty)* | OpenAlex offers faster speeds if you identify yourself with an email. This is optional but recommended if you have a large library (100+ papers). Your email is only sent to OpenAlex, not to us. |
| **Auto-fetch** | On | When enabled, citation data is fetched automatically as you browse items. Disable if you prefer to fetch manually via right-click. |
| **Cache lifetime** | 7 days | How many days before cached citation data is considered stale and re-fetched. Set higher (30-90) for large libraries to reduce API calls. |
| **Results per page** | 25 | How many results to load at a time in the citation network browser. Higher values load more at once but take longer. |

---

## FAQ

### What if a paper doesn't have a DOI?

Most journal articles, conference papers, and book chapters have a DOI. But some older papers, working papers, or dissertations may not. If a paper in your library doesn't have a DOI, Citegeist will show "No DOI available." You can sometimes find the DOI on the publisher's website and add it manually by editing the item's DOI field in Zotero.

### Where does the citation data come from?

All data comes from [OpenAlex](https://openalex.org), a free and open index of over 250 million scholarly works. OpenAlex aggregates data from Crossref, PubMed, institutional repositories, and other sources. Journal ranking columns (UTD24, FT50, ABDC, AJG) use a bundled lookup table matched by ISSN &mdash; no API calls needed.

### Is an API key required?

No. OpenAlex is free to use without any authentication. However, adding your email in Citegeist settings opts you into OpenAlex's "polite pool," which has higher rate limits and is recommended for large libraries.

### Where is the citation data stored?

Citation data is cached in each item's **Extra** field using namespaced keys (e.g., `Citegeist.citedByCount: 42`). This means:

- Data persists across Zotero restarts
- Data syncs to other devices via Zotero Sync
- Citegeist never modifies any other content in your Extra field

### How often is citation data updated?

By default, cached data expires after 7 days. You can change this in settings. You can also force-refresh any item by clicking the refresh button in the Citation Intelligence pane, or by right-clicking and selecting "Fetch Citation Counts."

### What does FWCI mean?

**Field-Weighted Citation Impact** (FWCI) compares a paper's citation count to the expected number of citations for papers in the same field, year, and document type.

- **FWCI = 1.0** &mdash; Exactly the world average
- **FWCI = 2.5** &mdash; 2.5x more citations than expected
- **FWCI = 0.5** &mdash; Half the expected citations

This is more meaningful than raw citation counts because it accounts for differences between fields (e.g., biomedical papers are cited more often than mathematics papers).

### What journal ranking lists are included?

Citegeist bundles four commonly used ranking lists for business, management, economics, and related fields:

- **UTD24** &mdash; UT Dallas 24 (2024): 24 premier research journals
- **FT50** &mdash; Financial Times 50 (2024): 50 journals used in business school research rankings
- **ABDC** &mdash; Australian Business Deans Council Quality List (2022): tiered A\*, A, B, C
- **AJG** &mdash; Chartered ABS Academic Journal Guide (2021): tiered 4\*, 4, 3, 2, 1

Rankings are matched by ISSN against a bundled table covering ~180 journals. If a journal you need is missing, contributions to the lookup table are welcome &mdash; see [CONTRIBUTING.md](CONTRIBUTING.md).

### Can I use Citegeist with Zotero 6?

No. Citegeist only works with Zotero 7 or later. If you're still on Zotero 6, you can [upgrade for free](https://www.zotero.org/downloads/).

### Will Citegeist slow down Zotero?

No. Citation data is fetched in the background with centralized rate limiting (8 requests/second max). Journal rankings use a local lookup table with zero network requests. Zotero remains responsive during fetches.

---

## Development

```bash
# Install dependencies
npm install

# Build for development (no minification, inline sourcemaps)
npm run build:dev

# Build for production (minified, creates .xpi)
npm run build

# Run tests
npm test

# Type-check
npm run typecheck
```

### Dev installation

For development, create a proxy file in your Zotero profile's `extensions/` folder. The file should be named `citegeist@opusvita.org` and contain the absolute path to `build/addon` in this repo.

**Zotero profile locations:**

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Zotero/Profiles/<PROFILE_ID>/extensions/` |
| Windows | `%APPDATA%\Zotero\Zotero\Profiles\<PROFILE_ID>\extensions\` |
| Linux | `~/.zotero/zotero/<PROFILE_ID>/extensions/` |

Rebuild and restart Zotero to see changes.

### Releasing

```bash
npm run release   # Bumps version, creates tag, pushes
```

GitHub Actions builds the XPI and creates a release automatically when a version tag is pushed.

---

## Community

- **Bug reports & feature requests:** [GitHub Issues](https://github.com/phdemotions/zotero-citegeist/issues)
- **Contributing:** See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines

## Support

Citegeist is **completely free** and always will be. If you find it useful, you can [sponsor the project on GitHub](https://github.com/sponsors/phdemotions). Donations go directly toward supporting the author's academic research.

## License

[GPL-3.0-or-later](LICENSE)

## Credits

Built by [Josh Gonzales](https://github.com/phdemotions). Citation data from [OpenAlex](https://openalex.org).

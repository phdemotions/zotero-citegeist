<p align="center">
  <img src="addon/content/icons/icon-96.png" width="72" alt="Citegeist icon" />
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

## What is Citegeist?

Citegeist turns Zotero into a citation intelligence tool. For any paper with a DOI, you can instantly see:

- How many times it's been cited
- How it ranks against every other paper in its field
- What the citation trend looks like year-over-year
- Which papers cite it, and which papers it cites
- Whether it's been retracted

All of this data comes from [OpenAlex](https://openalex.org), a free and open index of hundreds of millions of scholarly works. **No API key required.**

---

## Install

> **Requires [Zotero 7](https://www.zotero.org/downloads/) or later.** Citegeist does not work with Zotero 6.

1. Download **[citegeist.xpi](https://github.com/phdemotions/zotero-citegeist/releases/latest)** from the latest release
2. In Zotero, go to **Tools &rarr; Add-ons**
3. Click the gear icon (**&#9881;**) in the top-right &rarr; **Install Add-on From File...**
4. Select the `.xpi` file you downloaded
5. **Restart Zotero** when prompted

That's it. Citegeist will start fetching citation data automatically.

### Staying up to date

Citegeist checks for updates automatically via GitHub Releases. When a new version is available, Zotero will install it on the next restart.

---

## Getting Started

Once installed, Citegeist adds three things to Zotero:

1. A **Citations column** in your item list
2. A **Citation Intelligence pane** in the item detail sidebar
3. **Right-click menu options** for fetching and exploring citations

Here's how to use each one.

---

### 1. The Citations Column

A new **Citations** column appears in your item list showing the citation count for each paper.

**If you don't see the column:**

1. Right-click on any column header in the item list (e.g., "Title", "Creator", "Date")
2. A dropdown will appear with all available columns
3. Check **Citations** to enable it
4. You can drag the column to reorder it, or click the header to sort by citation count

Citation counts are fetched automatically in the background as you browse your library. Papers without a DOI will show a blank cell.

**Tip:** Click the **Citations** column header to sort your library by most-cited papers. Click again to reverse the sort order.

---

### 2. The Citation Intelligence Pane

Select any item in your library and look at the right-hand detail panel. Scroll down (or look in the sidebar tabs) for the **Citation Intelligence** section.

You'll see:

| Element | What it means |
|---------|--------------|
| **Citation count** | Total times this paper has been cited, displayed as a large number |
| **FWCI** | Field-Weighted Citation Impact. A score of **1.0** means world average for this field and year. **2.0** means twice the expected citations. |
| **Percentile** | Where this paper ranks among all papers in its field and year (e.g., "85th %ile" means it's cited more than 85% of comparable papers) |
| **Top 1% / Top 10%** | A badge appears if the paper is in the top 1% or top 10% of its field |
| **Trend** | Year-over-year citation change (e.g., "&#8599; 45 citations in 2025 (+23%)") and peak year if different |

Below the stats, you'll see two buttons:

- **View N citing works &rarr;** &mdash; Opens the citation network browser showing papers that cite this one
- **View references &rarr;** &mdash; Opens the citation network browser showing papers this one cites

**Refreshing data:** Click the refresh button (**&#8635;**) in the pane header to force-refresh from OpenAlex. By default, cached data expires after 7 days.

---

### 3. The Citation Network Browser

This is the core feature. Click either **"View citing works"** or **"View references"** to open the citation network browser.

#### Browsing results

The browser shows a scrollable list of papers. Each result displays:

- **Paper title** (click to open on OpenAlex)
- **Authors** (first author + "et al." for papers with many authors)
- **Journal/venue and year**
- **Citation count** (color-coded: gold for highly cited, white for moderate, grey for low)
- **Badges:** Open Access (green), Retracted (red), In Library (blue)

#### Switching between Cited By and References

At the top of the browser, you'll see two pill-shaped tabs:

- **Cited By** &mdash; Papers that cite the selected work
- **References** &mdash; Papers that the selected work cites

Click either tab to switch views.

#### Searching

Type in the search bar to filter results by title or author. The search filters the results that have already been loaded.

#### Sorting

Use the dropdown next to the search bar to sort by:

- **Most cited** (default) &mdash; Highest citation count first
- **Newest** &mdash; Most recent publications first
- **Oldest** &mdash; Oldest publications first

#### Adding papers to your Zotero library

This is where Citegeist saves you hours of manual work:

1. **Check the box** next to any paper you want to add
2. Select as many papers as you like
3. Click **"Add to Zotero"** in the bottom-right corner
4. Citegeist creates full Zotero items with all available metadata: title, authors, journal, volume, issue, pages, DOI, date, and URL

Papers already in your library are shown with a green checkmark (**&#10003;**) and an "In Library" badge. They can't be selected again, so you'll never create duplicates.

**Tip:** This is powerful for literature reviews. Open a seminal paper, view its citing works, sort by most cited, and add the top results to your library in seconds.

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

Go to **Zotero &rarr; Settings &rarr; Citegeist** (or **Edit &rarr; Preferences &rarr; Citegeist** on Windows/Linux) to configure:

| Setting | Default | What it does |
|---------|---------|-------------|
| **Email for OpenAlex polite pool** | *(empty)* | Enter your email to get into OpenAlex's faster API tier. Strongly recommended for large libraries. Your email is only sent to OpenAlex. |
| **Auto-fetch** | On | When enabled, citation data is fetched automatically as you browse items. Disable if you prefer to fetch manually via right-click. |
| **Cache lifetime** | 7 days | How many days before cached citation data is considered stale and re-fetched. Set higher (30-90) for large libraries to reduce API calls. |
| **Results per page** | 25 | How many results to load at a time in the citation network browser. Higher values load more at once but take longer. |

---

## FAQ

### What is a DOI and why does Citegeist need one?

A DOI (Digital Object Identifier) is a unique identifier for a published work, like `10.1038/nature12373`. Most journal articles, conference papers, and book chapters have one. Citegeist uses the DOI to look up citation data on OpenAlex.

If a paper in your library doesn't have a DOI, Citegeist will show "No DOI available." You can add a DOI manually by editing the item's DOI field in Zotero.

### Where does the citation data come from?

All data comes from [OpenAlex](https://openalex.org), a free and open index of over 250 million scholarly works. OpenAlex aggregates data from Crossref, PubMed, institutional repositories, and other sources.

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

### Can I use Citegeist with Zotero 6?

No. Citegeist requires Zotero 7 or later. It uses Zotero 7's plugin APIs (`ItemPaneManager`, `ItemTreeManager`) which don't exist in Zotero 6.

### Will Citegeist slow down Zotero?

No. Citation fetches happen in the background with rate limiting (2 requests at a time, 500ms between batches) to stay within OpenAlex's polite-pool limits. The UI remains responsive during fetches.

---

## Development

```bash
# Install dependencies
npm install

# Build for development (no minification, inline sourcemaps)
npm run build:dev

# Build for production (minified, creates .xpi)
npm run build

# Type-check
npm run typecheck
```

### Dev installation

For development, create a proxy file pointing to the build output:

```bash
# Find your Zotero profile
ls ~/Library/Application\ Support/Zotero/Profiles/

# Create proxy file (replace PROFILE_ID with your profile folder name)
echo "/path/to/citegeist/build/addon" > \
  ~/Library/Application\ Support/Zotero/Profiles/PROFILE_ID/extensions/citegeist@opusvita.org
```

Rebuild and restart Zotero to see changes.

### Releasing

```bash
npm run release   # Bumps version, creates tag, pushes
```

GitHub Actions builds the XPI and creates a release automatically when a version tag is pushed.

---

## License

[AGPL-3.0-or-later](LICENSE)

## Credits

Built by [Opus Vita](https://opusvita.org). Citation data from [OpenAlex](https://openalex.org).

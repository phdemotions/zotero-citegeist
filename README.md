<p align="center">
  <img src="assets/logo.png" width="200" alt="Citegeist logo" />
</p>

<h1 align="center">Citegeist</h1>

<p align="center">
  <strong>Citation intelligence for Zotero 7.</strong><br>
  See how influential a paper really is. Explore what cites it. Add works to your library in one click.
</p>

<p align="center">
  <a href="https://github.com/phdemotions/zotero-citegeist/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/phdemotions/zotero-citegeist?style=flat-square&color=5a9cff" /></a>
  <a href="https://github.com/phdemotions/zotero-citegeist/releases/latest"><img alt="Downloads" src="https://img.shields.io/github/downloads/phdemotions/zotero-citegeist/total?style=flat-square&color=30d158" /></a>
  <a href="https://github.com/phdemotions/zotero-citegeist/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/phdemotions/zotero-citegeist?style=flat-square&color=8e8e93" /></a>
</p>

---

## What Citegeist Does

Citegeist is a free plugin for [Zotero 7](https://www.zotero.org/downloads/) that shows you how important a paper is &mdash; and helps you find more like it &mdash; without leaving your library.

**For every paper in your library, you can:**

- **Sort by impact** &mdash; see citation counts, field-weighted impact (FWCI), and percentile rankings as sortable columns
- **Compare journals** &mdash; see journal impact metrics and check UTD24, FT50, ABDC, and AJG ranking lists at a glance
- **Spot trends** &mdash; see whether a paper's citations are rising or falling year over year
- **Discover related work** &mdash; browse papers that cite your paper (or that your paper cites), read their abstracts, and add them to your library in one click
- **Catch retractions** &mdash; retracted papers are flagged automatically

Everything is free. No account, no subscription, no API key.

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

Citegeist checks for updates automatically. When a new version is available, Zotero will install it on the next restart.

---

## Getting Started

Once installed, Citegeist adds three things to Zotero:

1. **Sortable columns** for article metrics, journal metrics, and journal rankings
2. A **Citation Intelligence pane** in the item detail sidebar
3. **Right-click menu options** for fetching and exploring citations

---

### 1. Sortable Columns

Citegeist adds nine new columns to your item list.

#### Article metrics

| Column | What it shows |
|--------|--------------|
| **Citations** | Total citation count |
| **FWCI** | Field-Weighted Citation Impact &mdash; how the paper compares to the world average for its field (1.0 = average, 2.0 = twice the average) |
| **Percentile** | Where the paper ranks among comparable papers (e.g., 85.0 = cited more than 85% of papers in the same field and year) |

#### Journal metrics

| Column | What it shows |
|--------|--------------|
| **Citedness** | The journal's 2-year mean citedness (an open equivalent of the Journal Impact Factor) |
| **J. H-Index** | The journal's h-index |

#### Journal rankings

| Column | What it shows |
|--------|--------------|
| **UTD24** | Checkmark if the journal is on the UT Dallas 24 list (2024) |
| **FT50** | Checkmark if the journal is on the Financial Times 50 list (2024) |
| **ABDC '22** | ABDC 2022 tier: A\*, A, B, or C |
| **AJG '21** | ABS Academic Journal Guide 2021 tier: 4\*, 4, 3, 2, or 1 |

**To enable columns:** Right-click any column header (e.g., "Title", "Creator") and check the columns you want. You can drag columns to reorder them, or click any header to sort.

Data is fetched automatically in the background. Papers without a DOI will show blank cells. A dash (**&mdash;**) means the metric isn't available for that paper.

**Tip:** Sort by **FWCI** to find the most impactful papers relative to their field, rather than papers that simply happen to be in high-citation disciplines.

---

### 2. The Citation Intelligence Pane

Select any item in your library and look at the right-hand detail panel. You'll find a **Citation Intelligence** section showing:

| Element | What it means |
|---------|--------------|
| **Citation count** | How many published papers reference this one |
| **FWCI** | How this paper compares to the world average for its field and year. **1.0** = average, **2.0** = twice the average. |
| **Percentile** | Where this paper ranks compared to all papers in its field and year. "85th %ile" means cited more than 85% of comparable papers. |
| **Top 1% / Top 10%** | A badge appears if the paper is among the most-cited in its field |
| **Trend** | Whether citation rates are rising or falling (e.g., "45 citations in 2025, +23%") |

Below the stats, two buttons let you explore the paper's citation network:

- **View N citing works &rarr;** &mdash; papers that cite this one
- **View references &rarr;** &mdash; papers this one cites

Click the refresh button (**&#8635;**) in the pane header to force-refresh. Cached data expires after 7 days by default (configurable in settings).

---

### 3. The Citation Network Browser

The citation network browser lets you explore papers connected to any item in your library &mdash; either papers that cite it (forward) or papers it cites (backward). This is sometimes called "snowballing" and is one of the most effective ways to find relevant literature.

#### Browsing results

Each result shows:

- **Title** (click to open the full record)
- **Authors, journal, and year**
- **Citation count** (color-coded by impact)
- **Badges:** Open Access, Retracted, In Library

Click any result to expand its **abstract**.

#### Adding papers to your library

Each result has a button to add it directly to your Zotero library:

1. **Click "+ Add to *Collection Name*"** to add with full metadata (title, authors, journal, DOI, etc.)
2. **Click the dropdown arrow** to choose specific collections
3. Papers already in your library show a **File** button for moving between collections

**Set a default collection** using the picker at the top of the browser. This saves clicks when adding multiple papers to the same project folder.

**Tip:** Open a key paper in your field, view its citing works, sort by most cited, and add the relevant ones to your library &mdash; all without leaving Zotero.

---

### 4. Right-Click Menus

#### On items

Right-click one or more items in your library:

| Menu item | What it does |
|-----------|-------------|
| **Fetch Citation Counts** | Fetches (or refreshes) citation data for selected items. Works with multi-select. |
| **View Citing Works...** | Opens the citation network browser (single items with a DOI only) |
| **View References...** | Opens the citation network browser in references mode |

#### On collections (folders)

Right-click any collection in the left sidebar:

| Menu item | What it does |
|-----------|-------------|
| **Fetch All Citation Counts (Citegeist)** | Fetches data for every item in this collection and all subcollections |

**Tip:** Right-click your top-level collection after importing a batch of papers to populate all citation counts at once.

---

## Settings

Open Zotero's settings (**Zotero &rarr; Settings** on macOS, **Edit &rarr; Preferences** on Windows/Linux) and select the **Citegeist** tab:

| Setting | Default | What it does |
|---------|---------|-------------|
| **Email** | *(empty)* | Optional. Providing an email gets you faster data speeds. Only shared with OpenAlex (our data source), never with us. |
| **Auto-fetch** | On | Fetches citation data automatically as you browse. Turn off to fetch manually via right-click. |
| **Cache lifetime** | 7 days | How long before cached data is refreshed. Set higher (30&ndash;90 days) for large libraries. |
| **Results per page** | 25 | How many results to load at a time in the citation network browser. |

---

## FAQ

<details>
<summary><strong>What if a paper doesn't have a DOI?</strong></summary>

Most journal articles and conference papers have a DOI. Some older papers, working papers, or dissertations may not. Citegeist will show "No DOI available" for these items. You can often find the DOI on the publisher's website and add it manually to the item's DOI field in Zotero.
</details>

<details>
<summary><strong>Where does the data come from?</strong></summary>

Citation data comes from [OpenAlex](https://openalex.org), a free, open index of over 250 million scholarly works. Journal rankings (UTD24, FT50, ABDC, AJG) are built into the plugin &mdash; no extra setup needed.
</details>

<details>
<summary><strong>What does FWCI mean?</strong></summary>

**Field-Weighted Citation Impact** compares a paper's citation count to the expected average for papers in the same field, year, and document type.

- **1.0** = exactly the world average
- **2.5** = 2.5x more cited than expected
- **0.5** = half the expected citations

This matters because citation norms vary widely between fields. A paper in marketing with 50 citations may be exceptional, while the same count in biomedicine may be unremarkable.
</details>

<details>
<summary><strong>What journal ranking lists are included?</strong></summary>

Citegeist includes four ranking lists commonly used in business, management, economics, and related fields:

- **UTD24** &mdash; UT Dallas 24 (2024): 24 premier research journals
- **FT50** &mdash; Financial Times 50 (2024): 50 journals used in business school research rankings
- **ABDC** &mdash; Australian Business Deans Council Quality List (2022): tiered A\*, A, B, C
- **AJG** &mdash; Chartered ABS Academic Journal Guide (2021): tiered 4\*, 4, 3, 2, 1

~180 journals are covered. If a journal you use is missing, [let us know](https://github.com/phdemotions/zotero-citegeist/issues).
</details>

<details>
<summary><strong>Do I need an API key or account?</strong></summary>

No. Everything is free, no sign-up required. Optionally add your email in settings for faster data speeds.
</details>

<details>
<summary><strong>Does my data sync across devices?</strong></summary>

Yes. Citation data is stored inside each item in your Zotero library, so it syncs automatically through Zotero Sync. Citegeist never modifies your existing data &mdash; it only adds its own fields.
</details>

<details>
<summary><strong>Will Citegeist slow down Zotero?</strong></summary>

No. Data is fetched in the background. Journal rankings are built into the plugin with no network requests needed. Zotero stays responsive.
</details>

<details>
<summary><strong>Can I use Citegeist with Zotero 6?</strong></summary>

No. Citegeist requires Zotero 7 or later. You can [upgrade for free](https://www.zotero.org/downloads/).
</details>

---

<details>
<summary><strong>New to Zotero? Key terms used in this guide</strong></summary>

[Zotero](https://www.zotero.org) is a free, open-source reference manager for collecting, organizing, and citing research. If you've never used it, [download Zotero 7](https://www.zotero.org/downloads/) and add a few papers before installing Citegeist.

- **Library** &mdash; Your collection of saved papers, articles, and books
- **Item** &mdash; A single entry in your library (a paper, book chapter, etc.)
- **Collection** &mdash; A folder you create to organize items by topic or project
- **DOI** &mdash; A Digital Object Identifier, a unique code assigned to most published papers (e.g., `10.1038/nature12373`). Citegeist uses the DOI to look up citation data.
</details>

---

## Community & Support

- **Bug reports & feature requests:** [GitHub Issues](https://github.com/phdemotions/zotero-citegeist/issues)
- **Contributing:** See [CONTRIBUTING.md](CONTRIBUTING.md)
- Citegeist is **completely free** and always will be. If you find it useful, you can [sponsor the project on GitHub](https://github.com/sponsors/phdemotions).

---

<details>
<summary><strong>For Developers</strong></summary>

### Building from source

```bash
npm install          # Install dependencies
npm run build:dev    # Development build (no minification)
npm run build        # Production build (creates .xpi)
npm test             # Run tests
npm run typecheck    # Type-check
```

### Dev installation

Create a proxy file in your Zotero profile's `extensions/` folder named `citegeist@opusvita.org` containing the absolute path to `build/addon` in this repo.

| OS | Profile path |
|----|-------------|
| macOS | `~/Library/Application Support/Zotero/Profiles/<ID>/extensions/` |
| Windows | `%APPDATA%\Zotero\Zotero\Profiles\<ID>\extensions\` |
| Linux | `~/.zotero/zotero/<ID>/extensions/` |

### Releasing

```bash
npm run release   # Bumps version, creates tag, pushes
```

GitHub Actions builds the XPI and creates a release automatically.

</details>

## License

[GPL-3.0-or-later](LICENSE)

## Credits

Built by [Josh Gonzales](https://github.com/phdemotions). Citation data from [OpenAlex](https://openalex.org).

# Citegeist

Citation intelligence for Zotero 7, powered by [OpenAlex](https://openalex.org).

See how many times a paper has been cited, explore its citation network, and add citing or cited works to your library with one click.

## Features

- **Citation count column** — Sortable column in the item list showing citation counts, fetched automatically in the background
- **Citation intelligence pane** — Shows citation count, Field-Weighted Citation Impact (FWCI), citation percentile, Top 1%/10% badges, and a yearly trend sparkline
- **Citation network browser** — Modal dialog to explore works that cite a paper or are cited by it, with search, sort, and infinite scroll
- **One-click import** — Select works from the citation network and add them to your Zotero library with full metadata (authors, journal, DOI, volume, pages, dates)
- **"In Library" detection** — Works already in your library are marked so you don't create duplicates
- **Open Access badges** — See which citing/cited works are freely available
- **Retraction alerts** — Retracted works are flagged in both the pane and the network browser
- **Smart caching** — Citation data is cached in the Extra field (configurable lifetime, default 7 days) so you don't hit the API repeatedly
- **Polite pool support** — Add your email in settings to get faster API responses from OpenAlex
- **Batch fetch** — Right-click a collection to fetch citation counts for all items at once

## Requirements

- **Zotero 7** (version 7.0 or later)
- Items must have a DOI for citation data to be available

## Installation

### From GitHub Releases (recommended)

1. Go to the [Releases page](https://github.com/opusvita/zotero-citegeist/releases)
2. Download the latest `citegeist-x.x.x.xpi` file
3. In Zotero, go to **Tools → Add-ons**
4. Click the gear icon (⚙) → **Install Add-on From File...**
5. Select the downloaded `.xpi` file
6. Restart Zotero

### Auto-updates

Once installed, Citegeist checks for updates automatically via GitHub releases. Updates are installed on restart.

## Usage

### Citation count column

After installation, a **Citations** column appears in the item list. Enable it via right-clicking the column header if it's hidden. Citation counts are fetched automatically for items with DOIs.

### Citation intelligence pane

Select any item with a DOI and scroll to the **Citation Intelligence** section in the right-hand detail pane. You'll see:

- **Citation count** — total number of times cited
- **FWCI** — Field-Weighted Citation Impact (1.0 = world average; higher = more impactful relative to field)
- **Percentile** — where this paper ranks among all papers in its field and year
- **Top 1% / Top 10%** — badge if applicable
- **Trend sparkline** — citation trend over the last 10 years (after first async load)

Click the refresh button (↻) in the section header to force-refresh data from OpenAlex.

### Citation network browser

Click **"View N citing works →"** or **"View references →"** in the citation pane to open the network browser. From there you can:

1. **Browse** — Scroll through works that cite this paper or are cited by it
2. **Search** — Filter by title, author, or keyword
3. **Sort** — By citation count, newest first, or oldest first
4. **Select** — Check the works you want to add
5. **Import** — Click "Add Selected to Zotero" to create items with full metadata

Works already in your library show a green checkmark and "In Library" badge.

### Batch fetch for collections

Right-click a collection in the left panel → **Fetch All Citation Counts (Citegeist)** to fetch citation data for every item with a DOI in that collection.

## Settings

Go to **Zotero → Settings → Citegeist** to configure:

| Setting | Default | Description |
|---------|---------|-------------|
| Email for polite pool | *(empty)* | Your email for OpenAlex's faster API tier. Recommended. |
| Auto-fetch | On | Automatically fetch citation data when items are displayed |
| Cache lifetime | 7 days | How long to cache citation data before refreshing |
| Results per page | 25 | Number of results loaded per page in the network browser |

## How it works

Citegeist uses the [OpenAlex API](https://docs.openalex.org/) — a free, open catalog of the world's research. No API key is required. Adding your email in settings opts you into the "polite pool" which has higher rate limits.

Citation data is cached in each item's **Extra** field using namespaced keys (e.g., `Citegeist.citedByCount: 42`). This means cached data persists with your library and syncs across devices. Citegeist never modifies any other content in the Extra field.

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

### Dev installation via proxy file

For development, create a proxy file in your Zotero profile's extensions directory:

```bash
# Find your profile path
ls ~/Library/Application\ Support/Zotero/Profiles/

# Create proxy file (replace PROFILE_ID)
echo "/path/to/citegeist/build/addon" > \
  ~/Library/Application\ Support/Zotero/Profiles/PROFILE_ID/extensions/citegeist@opusvita.org
```

Then rebuild and restart Zotero to see changes.

### Releasing

```bash
npm run release   # bumps version, creates tag, pushes
```

GitHub Actions builds the XPI and creates a release automatically.

## License

[AGPL-3.0-or-later](LICENSE)

## Credits

Built by [Opus Vita](https://opusvita.org). Citation data from [OpenAlex](https://openalex.org).

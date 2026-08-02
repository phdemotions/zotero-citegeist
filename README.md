<p align="center">
  <img src="docs/assets/logo.png" width="200" alt="Citegeist logo" />
</p>

<h1 align="center">Citegeist</h1>

<p align="center">
  A free Zotero plugin that puts citation counts, field-weighted impact, and journal rankings next to the items in your library. Follow citations forward and backward, and open any author's full publication record, without leaving Zotero. Works with DOIs, PubMed IDs, arXiv IDs, and ISBNs.
</p>

<p align="center">
  <a href="https://github.com/phdemotions/zotero-citegeist/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/phdemotions/zotero-citegeist?style=flat-square&color=5a9cff" /></a>
  <a href="https://github.com/phdemotions/zotero-citegeist/releases/latest"><img alt="Downloads" src="https://img.shields.io/github/downloads/phdemotions/zotero-citegeist/total?style=flat-square&color=30d158" /></a>
  <a href="https://github.com/phdemotions/zotero-citegeist/blob/main/LICENSE"><img alt="License: GPL-3.0-or-later" src="https://img.shields.io/badge/license-GPL--3.0-8e8e93?style=flat-square" /></a>
  <a href="https://doi.org/10.5281/zenodo.19433716"><img alt="DOI" src="https://zenodo.org/badge/DOI/10.5281/zenodo.19433716.svg" /></a>
</p>

---

## What Citegeist does

Citegeist is a free plugin for [Zotero 7+](https://www.zotero.org/downloads/) that adds citation metrics, author profiles, and a citation-network browser to your library. All data comes from [OpenAlex](https://openalex.org), a free, open index of roughly 250 million scholarly works.

For any item with a recognized identifier, you get:

- **Citation count, FWCI, and percentile** as sortable columns, so you can rank a folder by field-normalized impact instead of raw counts.
- **Journal metrics and ranking-list membership.** Two-year mean citedness and h-index, plus UTD24, FT50, ABDC 2025, and AJG 2024 flags across 3,177 journals.
- **A year-by-year citation trend**, so a still-cited paper reads differently from a dormant one.
- **Author profiles.** Each author's h-index in the pane, and a click through to everything they've published (see [Author discovery](#author-discovery)).
- **A citation-network browser** for forward and backward snowballing, with one-click "Add to Zotero" on any result.
- **Retraction flags** straight from OpenAlex.

No account or subscription. OpenAlex has metered its API since July 2026, so anonymous use runs on a free daily allowance. That covers ordinary browsing; a library-wide scan can exhaust it, and a free API key lifts the ceiling (see [Settings](#settings)).

---

## Install

> Requires [Zotero 7 or later](https://www.zotero.org/downloads/) (tested through Zotero 9). Zotero 6 is not supported.

1. Download **[citegeist.xpi](https://github.com/phdemotions/zotero-citegeist/releases/latest)** from the latest release. It's the `.xpi` file under "Assets".
2. In Zotero, open **Tools → Add-ons**.
3. Click the gear icon at the top right, then **Install Add-on From File**.
4. Select the file you downloaded.
5. Restart Zotero when prompted.

Citegeist begins fetching data for your library as soon as Zotero restarts. New versions install themselves on the next restart, so there's nothing to keep track of.

---

## Usage

### Sortable columns

Citegeist adds nine columns, all off by default. Right-click any column header to turn the ones you want on; drag headers to reorder, click one to sort.

#### Article metrics

| Column         | What it shows                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Citations**  | Total citation count                                                                                                   |
| **FWCI**       | Field-Weighted Citation Impact: how the paper compares to the world average for its field (1.0 = average, 2.0 = twice) |
| **Percentile** | Where the paper ranks among comparable papers (85.0 = cited more than 85% of papers in the same field and year)        |

#### Journal metrics

| Column         | What it shows                                                                        |
| -------------- | ------------------------------------------------------------------------------------ |
| **Citedness**  | The journal's 2-year mean citedness, an open equivalent of the Journal Impact Factor |
| **J. H-Index** | The journal's h-index                                                                |

#### Journal rankings

| Column       | What it shows                                                     |
| ------------ | ----------------------------------------------------------------- |
| **UTD24**    | Checkmark if the journal is on the UT Dallas 24 list (2024)       |
| **FT50**     | Checkmark if the journal is on the Financial Times 50 list (2024) |
| **ABDC '25** | ABDC 2025 tier: A\*, A, B, or C                                   |
| **AJG '24**  | ABS Academic Journal Guide 2024 tier: 4\*, 4, 3, 2, or 1          |

Metrics fetch in the background, using the best identifier an item has (DOI first, then PMID, arXiv ID, ISBN). A dash means Citegeist looked and OpenAlex has no value for that paper; a blank cell means the item has no identifier to look up.

Sorting by **FWCI** surfaces work that punches above its field, rather than papers that simply sit in high-citation disciplines.

### The item pane

Select an item and open the **Citation Intelligence** section in the right-hand panel.

| Element              | What it means                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Citation count**   | How many published papers reference this one                                                                         |
| **FWCI**             | How this paper compares to the world average for its field and year (1.0 = average, 2.0 = twice the average)         |
| **Percentile**       | Where it ranks against all papers in its field and year. "85th %ile" means cited more than 85% of comparable papers. |
| **Top 1% / Top 10%** | A badge, shown when the paper is among the most-cited in its field                                                   |
| **Trend**            | Whether its citation rate is rising or falling (for example, "↗ +18% 2024")                                          |

Two buttons under the metrics open the citation network for this paper: **Citing works** lists papers that cite it, **References** lists papers it cites. The refresh button in the section header forces a re-fetch; otherwise cached data refreshes every 7 days, which you can change in Settings.

### Author discovery

_Added in v3.0._

Under the network buttons, the pane lists the paper's authors, each matched to their OpenAlex profile and shown with their h-index. Click a name to open that author's full body of work, sortable by citations, field-weighted impact, or year, and add any of it to your library the same way you would from the network browser.

Matching runs on its own whenever citation data loads, so most authors are already resolved by the time you look. Citegeist records each match as a native Zotero `openalex:author` relation on the item, which means other tools in your workflow can read the authorship straight from Zotero without going through Citegeist's database.

To resolve authors on demand, or across a whole collection at once, use the right-click menus below.

### The citation network browser

Snowballing is one of the fastest ways to map a literature: from any item, walk outward to the papers that cite it, or inward to the papers it cites.

Each result shows its title (click to expand the abstract), the authors, journal, and year, a citation count colored by impact, and badges for Open Access, Retracted, In Library, and No DOI.

To pull a result into your library, click **Add to _Collection_** for the full record, or use the dropdown to choose a different collection. Papers you already have show a **File** button instead, for moving them between collections. Set a default collection in the footer and repeated adds land in the right folder.

### Right-click menus

On one or more selected items:

| Menu item                     | What it does                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Fetch Citation Counts**     | Fetches or refreshes citation data for the selection. Works on multiple items at once.                                        |
| **View Citing Works...**      | Opens the network browser. One item at a time; needs an identifier (DOI, PMID, arXiv ID, or ISBN) or a confirmed title match. |
| **View References...**        | Opens the network browser in references mode.                                                                                 |
| **Resolve Author Identities** | Matches the selected items' authors to OpenAlex and fills in the pane's author list. Also happens automatically on fetch.     |

On a collection in the left sidebar:

| Menu item                                     | What it does                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| **Fetch All Citation Counts (Citegeist)**     | Fetches every item in the collection and its subcollections.               |
| **Resolve All Author Identities (Citegeist)** | Matches every author in the collection and its subcollections to OpenAlex. |

After importing a batch of papers, running **Fetch All** on the top-level collection populates everything in one pass.

---

## Settings

Open **Zotero → Settings** (macOS) or **Edit → Preferences** (Windows and Linux) and pick the **Citegeist** tab.

| Setting              | Default   | What it does                                                                                                                                                                                                                                                                                |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenAlex API key** | _(empty)_ | Optional. Without a key you get OpenAlex's free daily allowance, which is fine for everyday use; a large scan can exhaust it (error `CG-API42`). A [free key](https://openalex.org) raises the limit. Stored on this computer only, never synced or logged, and only ever sent to OpenAlex. |
| **Auto-fetch**       | On        | Fetches data as you browse. Turn it off to fetch manually from the right-click menu.                                                                                                                                                                                                        |
| **Cache lifetime**   | 7 days    | How long before cached data is refreshed. Raise it (30 to 90 days) for large libraries.                                                                                                                                                                                                     |
| **Results per page** | 25        | How many results the network browser loads at a time.                                                                                                                                                                                                                                       |

The same tab has a **Troubleshooting** section with a running log of anything Citegeist has hit this session and a **Copy diagnostic report** button (see [Troubleshooting](#troubleshooting)).

---

## Data storage and sync

Since v2.0.0, Citegeist keeps its cache in a private SQLite file at `<profile>/citegeist.sqlite` rather than in your items' Extra fields. Remove the plugin and nothing is left behind.

Cached metrics (counts, FWCI, percentiles, journal data) are per-machine and don't sync. Open your library on a second device and its items refetch from OpenAlex the first time you view them; after that it's instant.

The one thing that does travel between devices is a title match you confirm by hand. For an item with no DOI, confirming a match writes a single line to its Extra field, `Citegeist match ID: W12345678`, which rides Zotero Sync to your other machines. That line is the only thing Citegeist ever writes to an item, and deleting it drops the confirmation.

Upgrading from v1.3.x or earlier runs a one-time migration that moves any old `Citegeist.*` Extra fields into the cache. Back up your Zotero data directory first. The [upgrade runbook](#troubleshooting) below covers what to expect and the automatic backup Citegeist writes before it touches anything.

---

## FAQ

<details>
<summary><strong>What if a paper doesn't have a DOI?</strong></summary>

Citegeist works through four identifiers in order:

1. **DOI**, which covers most journal articles and conference papers.
2. **PubMed ID (PMID)** for biomedical work. Add `PMID: 12345678` to the item's Extra field if it isn't there already.
3. **arXiv ID**, read from the Extra field (`arXiv: 2205.01833`), the Archive ID field, or an arxiv.org URL.
4. **ISBN** for books and book chapters. OpenAlex's book coverage is thin, so counts here are often zero or missing.

With none of these present, the item's cells stay blank. The DOI or PMID is usually on the publisher's page or in PubMed, and you can paste it into the item by hand.

</details>

<details>
<summary><strong>What does FWCI mean?</strong></summary>

Field-Weighted Citation Impact compares a paper's citations to the average for papers of the same field, year, and type.

- **1.0** is exactly the world average.
- **2.5** is 2.5 times more cited than expected.
- **0.5** is half the expected citations.

The normalization is the point: citation norms differ enormously between fields. Fifty citations can be exceptional in marketing and unremarkable in biomedicine, and FWCI puts both on the same scale.

</details>

<details>
<summary><strong>Which journal ranking lists are included?</strong></summary>

Four lists common in business, management, economics, and related fields:

- **UTD24**: UT Dallas 24 (2024), 24 premier research journals.
- **FT50**: Financial Times 50 (2024), used in business-school research rankings.
- **ABDC**: Australian Business Deans Council Quality List (2025), tiered A\*, A, B, C.
- **AJG**: Chartered ABS Academic Journal Guide (2024), tiered 4\*, 4, 3, 2, 1.

That's 3,177 journals in total, matched on either print or electronic ISSN. If one you use is missing, [tell us](https://github.com/phdemotions/zotero-citegeist/issues).

</details>

<details>
<summary><strong>Do I need an API key or an account?</strong></summary>

No sign-up, no paid tier. Citegeist and its data are free.

OpenAlex has metered its API since July 2026, so anonymous use draws on a free daily allowance. That's plenty for everyday browsing; you'd only hit the limit on a large, library-wide scan, and Citegeist shows `CG-API42` when you do. A free OpenAlex API key raises the limit. Get one at [openalex.org](https://openalex.org) and paste it into **Settings → Citegeist**, where it stays on your computer, unsynced and unlogged.

</details>

<details>
<summary><strong>Does my data sync across devices?</strong></summary>

Mostly no, by design. Cached metrics live in a per-device SQLite file and refetch from OpenAlex the first time you open your library on a new machine. The exception is a title match you confirm by hand, which syncs through a single line in the item's Extra field. [Data storage and sync](#data-storage-and-sync) has the full picture.

</details>

<details>
<summary><strong>Will Citegeist slow Zotero down?</strong></summary>

No. Fetches run in the background, and the ranking lists are bundled with the plugin, so looking one up makes no network request at all.

</details>

<details>
<summary><strong>Can I use Citegeist with Zotero 6?</strong></summary>

No, Zotero 7 or later is required. Zotero is a [free upgrade](https://www.zotero.org/downloads/).

</details>

<details>
<summary><strong>New to Zotero? A few terms this guide uses</strong></summary>

[Zotero](https://www.zotero.org) is a free, open-source reference manager for collecting, organizing, and citing research. If it's new to you, [install Zotero 7](https://www.zotero.org/downloads/) and add a few papers before adding Citegeist.

- **Library**: everything you've saved, across papers, articles, and books.
- **Item**: one entry in the library.
- **Collection**: a folder you make to group items by topic or project.
- **DOI**: a Digital Object Identifier, the unique code on most published papers (for example `10.1038/nature12373`). Citegeist prefers it when present.
- **PMID**: a PubMed ID for biomedical literature. Add `PMID: 12345678` to an item's Extra field if needed.
- **arXiv ID**: the identifier for an arxiv.org preprint (for example `2205.01833`), read automatically from the Extra field or URL.
- **ISBN**: the standard book number, used for books and book chapters.

</details>

---

## Troubleshooting

<details>
<summary><strong>Something went wrong, and how to report it well</strong></summary>

Every failure carries a short code, like `CG-NET01`, `CG-DB01`, or `CG-API42`. When a fetch fails, the code sits under **Details** in the pane and in the network browser. For anything else, a blank column or a menu that did nothing, open **Settings → Citegeist → Troubleshooting** and click **Copy diagnostic report**.

That report holds your Citegeist build, your Zotero version, and every problem since Zotero started. It carries no titles, DOIs, or other library content, no API key, and no personal details such as your username. Pasting it into a [GitHub issue](https://github.com/phdemotions/zotero-citegeist/issues) is usually enough to pin down the cause on the first reply.

Every code and what it means is listed in [`docs/ERROR-CODES.md`](docs/ERROR-CODES.md).

</details>

<details>
<summary><strong>Upgrading from v1.3.x</strong></summary>

v2.0.0 moved cached data out of Zotero's `Extra` field into a private SQLite database (`<profile>/citegeist.sqlite`). On first launch it runs a one-time migration that strips the old `Citegeist.*` lines from your items and rewrites them into the cache. Afterward:

- Removing Citegeist leaves your library clean.
- One line stays in Extra on purpose: `Citegeist match ID: W12345678`, on items where you confirmed a title match. It's the only user-curated state that has to survive a downgrade and sync across devices.
- Counts and journal metrics become per-device. On a new machine, items refetch from OpenAlex the first time you view them.

Before you upgrade:

1. **Back up your Zotero data directory.** Right-click in the library and choose **Show Data Directory**, quit Zotero, and copy that folder somewhere safe (Time Machine, Dropbox history, or a plain copy alongside it). Restart and upgrade.
2. **Be on Zotero 7.0.10 or newer.** The migration uses an API that older builds ignore, and the v2.0.0 manifest won't load on them. Install from [zotero.org/downloads](https://www.zotero.org/downloads/) if in doubt.
3. **Expect a progress window** if you have more than about 500 items with Citegeist data. Smaller libraries migrate instantly.

Citegeist also writes its own safety net. Before touching a single item, it saves a JSON snapshot of every Extra field it's about to change to a `citegeist-backups/` folder in your data directory, named `citegeist-migration-backup-<timestamp>.json` and keyed by `library_id` and `item_key`. A one-time alert tells you where it landed. If anything looks off afterward, open that file, find the item by its key, and paste the original `extra` value back through Zotero's UI. Citegeist keeps the five most recent backups; delete them once you're satisfied.

If something still looks wrong:

- _Columns are all empty._ Open `Help → Debug Output Logging → View Output` and look for `[Citegeist] cache initialized: N rows`. If `N` is 0 but you had data before, the migration was blocked. Nearby lines will say `migration deferred` (Zotero too old) or `cache not initialized` (the database couldn't open, usually antivirus quarantining `citegeist.sqlite`). Clear the block, restart, and the migration retries on its own.
- _Confirmed matches are missing._ Check the item's Extra field for a `Citegeist match ID: W…` line. If it's there, the next fetch rediscovers the work; if it's gone, restart and Citegeist will refetch and ask you to re-confirm.
- _Old `Citegeist.openAlexId:` lines are still in Extra._ Restart. If `migrationV1Complete` is `false` in `about:config` (search `extensions.zotero.citegeist`), the migration retries. If it's `true` and the lines remain, file an issue with your debug log.
- _You want to roll back to v1.3.x._ Reinstall the older XPI from [GitHub Releases](https://github.com/phdemotions/zotero-citegeist/releases). It ignores the `Citegeist match ID:` lines harmlessly, and your `citegeist.sqlite` waits unused until you upgrade again.

</details>

<details>
<summary><strong>A column is empty or stuck on "…"</strong></summary>

Every item needs one identifier Citegeist can resolve: a DOI, PMID, arXiv ID, or ISBN.

1. Check the item has a **DOI**, a `PMID:` or `arXiv:` line in **Extra**, or an **ISBN** for books.
2. Make sure **Settings → Citegeist → Auto-fetch** is on, or right-click and choose **Fetch Citation Counts**.
3. Give it a moment. Requests are capped at 8 per second to stay inside OpenAlex's limits.
4. A row of dashes usually means OpenAlex has no value for that work.
5. Books show blank citation cells when OpenAlex reports zero, since its book coverage is incomplete.

</details>

<details>
<summary><strong>"Couldn't reach OpenAlex" (CG-NET01)</strong></summary>

This is a connection problem, not a "not found". Check your internet, then try loading [status.openalex.org](https://status.openalex.org) or `https://api.openalex.org/works/doi:10.1038/nature12373` in a browser. Data already in your cache keeps working offline.

If you see `CG-API42` instead, that's the daily allowance running out, not a connection problem. Add a free API key in Settings (see the FAQ).

</details>

<details>
<summary><strong>Counts differ from Google Scholar, Scopus, or Web of Science</strong></summary>

OpenAlex indexes a broader, more open set of sources than Scopus or Web of Science, so its counts can run higher, sometimes much higher. That's a difference in source, not a bug. FWCI and percentile are normalized inside OpenAlex's corpus, so compare them on that basis.

</details>

<details>
<summary><strong>Reading Citegeist's debug output</strong></summary>

For most problems, **Settings → Citegeist → Troubleshooting → Copy diagnostic report** captures everything needed in one click (see the first entry above).

For deeper digging, open **Help → Debug Output Logging → Enable**, reproduce the problem, then **Help → Debug Output Logging → View Output**. Lines are prefixed with `[Citegeist]`, and the startup line names the exact build (`[Citegeist] Starting v3.0.0 (build …)`), which is worth including when you file a bug.

</details>

---

## Community & support

- **Bugs and feature requests:** [GitHub Issues](https://github.com/phdemotions/zotero-citegeist/issues)
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md)
- **Code of Conduct:** [CODE_OF_CONDUCT.md](.github/CODE_OF_CONDUCT.md)
- **Roadmap:** [BACKLOG.md](docs/BACKLOG.md)

Citegeist is free and stays free. If it helps your work, you can [sponsor it on GitHub](https://github.com/sponsors/phdemotions).

## Citing Citegeist

If Citegeist plays a part in your research, please cite it. The metadata is in [`CITATION.cff`](CITATION.cff), and the paper is at [`docs/paper/paper.md`](docs/paper/paper.md).

---

<details>
<summary><strong>For developers</strong></summary>

### Building from source

```bash
npm install          # Install dependencies
npm run build:dev    # Development build (no minification)
npm run build        # Production build (creates .xpi)
npm test             # Run tests
npm run typecheck    # Type-check
```

### Dev installation

Create a proxy file in your Zotero profile's `extensions/` folder named `citegeist@opusvita.org`, containing the absolute path to this repo's `build/addon`.

| OS      | Profile path                                                     |
| ------- | ---------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Zotero/Profiles/<ID>/extensions/` |
| Windows | `%APPDATA%\Zotero\Zotero\Profiles\<ID>\extensions\`              |
| Linux   | `~/.zotero/zotero/<ID>/extensions/`                              |

### Releasing

```bash
npm run release   # Bumps version, tags, pushes
```

GitHub Actions builds the XPI and publishes the release.

</details>

## License

[GPL-3.0-or-later](LICENSE)

## Credits

Built by [Josh Gonzales](https://github.com/phdemotions). Citation data from [OpenAlex](https://openalex.org).

/**
 * Item pane section showing citation intelligence.
 *
 * Layout priority (everything must fit above the fold):
 *   1. Headline stat line — "20 citations · FWCI 1.61 · 85th percentile"
 *   2. Action buttons — "View 20 citing works" / "View references"
 *   3. Sparkline — compact trend bar
 *
 * Uses onRender (sync) for cached data and onAsyncRender for network fetch.
 *
 * IMPORTANT: Interactive elements (buttons) are created via DOM API, not
 * innerHTML, because Zotero's XUL/XHTML pane context can silently swallow
 * <button> elements set via innerHTML.
 */

import { getCachedData, clearCache, isCacheStale, type CachedData } from "./cache";
import { fetchAndCacheItem } from "./citationService";
import { invalidateColumnCache } from "./citationColumn";
import type { OpenAlexWork } from "./openalex";
import { showCitationNetwork } from "./citationNetwork";
import { escapeHTML } from "./utils";

let refreshing = false;

const PANE_ID = "citegeist-citation-details";

export function registerCitationPane(pluginID: string): void {
  Zotero.ItemPaneManager.registerSection({
    paneID: PANE_ID,
    pluginID,
    header: {
      l10nID: "citegeist-pane-header",
      icon: "chrome://citegeist/content/icons/icon-16.svg",
    },
    sidenav: {
      l10nID: "citegeist-pane-sidenav",
      icon: "chrome://citegeist/content/icons/icon-20.svg",
    },
    bodyXHTML: `
      <div id="citegeist-pane-root" xmlns="http://www.w3.org/1999/xhtml">
        <style>
          #citegeist-pane-root {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            padding: 8px 12px 10px;
            font-size: 12px;
            line-height: 1.5;
            color: var(--fill-primary);
          }
          .cg-loading {
            color: var(--fill-secondary);
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 0;
          }
          .cg-loading::before {
            content: "";
            width: 12px; height: 12px;
            border: 2px solid var(--fill-quinary, #ddd);
            border-top-color: var(--accent-blue40, #4a90d9);
            border-radius: 50%;
            animation: cg-spin 0.8s linear infinite;
            flex-shrink: 0;
          }
          @keyframes cg-spin { to { transform: rotate(360deg); } }
          .cg-no-doi { color: var(--fill-secondary); padding: 4px 0; }

          .cg-retracted {
            background: var(--accent-red5, #fee);
            border: 1px solid var(--accent-red20, #fcc);
            border-radius: 4px;
            padding: 5px 8px;
            color: var(--accent-red, #c00);
            font-weight: 600;
            font-size: 11px;
            margin-bottom: 8px;
          }

          .cg-headline {
            display: flex;
            align-items: baseline;
            gap: 4px;
            flex-wrap: wrap;
            margin-bottom: 10px;
          }
          .cg-headline-count {
            font-size: 24px;
            font-weight: 800;
            letter-spacing: -0.8px;
            color: var(--fill-primary);
            font-variant-numeric: tabular-nums;
          }
          .cg-headline-label {
            font-size: 12px;
            color: var(--fill-secondary);
            margin-right: 6px;
          }
          .cg-headline-sep {
            color: var(--fill-quinary, #ccc);
            margin: 0 2px;
            font-size: 10px;
          }
          .cg-headline-detail {
            font-size: 11px;
            color: var(--fill-secondary);
          }
          .cg-headline-detail strong {
            color: var(--fill-primary);
            font-weight: 600;
          }

          .cg-badge {
            font-size: 9px;
            padding: 2px 6px;
            border-radius: 4px;
            font-weight: 700;
            margin-left: 4px;
            vertical-align: middle;
          }
          .cg-badge-top1 {
            background: var(--accent-yellow5, rgba(255,214,10,0.12));
            color: var(--accent-yellow, #ffd60a);
          }
          .cg-badge-top10 {
            background: var(--accent-blue5, rgba(90,156,255,0.12));
            color: var(--accent-blue, #5a9cff);
          }

          .cg-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-bottom: 10px;
          }
          .cg-action-btn {
            display: inline-block;
            padding: 6px 14px;
            border: 1px solid var(--fill-quinary, rgba(255,255,255,0.1));
            border-radius: 7px;
            background: var(--material-background, rgba(255,255,255,0.05));
            color: var(--fill-primary, #e8e8ed);
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            text-align: center;
            text-decoration: none;
            -moz-user-select: none;
            user-select: none;
          }
          .cg-action-btn:hover {
            background: var(--fill-quinary, rgba(255,255,255,0.1));
          }
          .cg-action-btn-primary {
            background: var(--accent-blue40, #5a9cff);
            color: #fff;
            border-color: transparent;
            font-weight: 600;
          }
          .cg-action-btn-primary:hover {
            background: var(--accent-blue50, #4a8cf0);
          }

          .cg-trend {
            border-top: 1px solid var(--fill-quinary, rgba(255,255,255,0.06));
            padding-top: 7px;
            font-size: 11px;
            color: var(--fill-secondary, #8e8e93);
            line-height: 1.4;
          }
        </style>
        <div id="citegeist-content"></div>
      </div>
    `,
    onItemChange: ({ item, setEnabled }) => {
      setEnabled(item.isRegularItem());
    },
    onRender: ({ body, item, setSectionSummary }) => {
      const container = body.querySelector("#citegeist-content") as HTMLElement;
      if (!container) return;

      const doi = item.getField("DOI");
      if (!doi || !doi.trim()) {
        container.innerHTML = `<div class="cg-no-doi">No DOI available for this item.</div>`;
        setSectionSummary("No DOI");
        return;
      }

      const cached = getCachedData(item);
      if (cached) {
        renderPane(container, cached, item);
        setSectionSummary(`${cached.citedByCount.toLocaleString()} citations`);
      } else {
        container.innerHTML = `<div class="cg-loading">Fetching citation data…</div>`;
        setSectionSummary("Loading…");
      }
    },
    onAsyncRender: async ({ body, item, setSectionSummary }) => {
      const container = body.querySelector("#citegeist-content") as HTMLElement;
      if (!container) return;

      const doi = item.getField("DOI");
      if (!doi || !doi.trim()) return;

      // If we already rendered cached data in onRender, skip the network call
      // unless the cache is stale. This avoids redundant re-renders.
      const alreadyCached = getCachedData(item);
      if (alreadyCached && !isCacheStale(item)) return;

      const result = await fetchAndCacheItem(item);
      if (result.success && result.work) {
        const freshData = getCachedData(item);
        if (freshData) {
          renderPane(container, freshData, item, result.work);
          setSectionSummary(`${freshData.citedByCount.toLocaleString()} citations`);
          // Notify columns to refresh so citation data appears immediately
          invalidateColumnCache(item.id);
        }
      } else if (!alreadyCached && !result.success) {
        container.innerHTML = `<div class="cg-no-doi">Could not find this work on OpenAlex.</div>`;
        setSectionSummary("Not found");
      }
    },
    sectionButtons: [
      {
        type: "refresh",
        icon: "chrome://zotero/skin/16/universal/sync.svg",
        l10nID: "citegeist-pane-refresh",
        onClick: async ({ body, item, setSectionSummary }) => {
          if (refreshing) return;
          refreshing = true;
          try {
            const container = body.querySelector("#citegeist-content") as HTMLElement;
            if (container) {
              container.innerHTML = `<div class="cg-loading">Refreshing\u2026</div>`;
            }
            await clearCache(item);
            const result = await fetchAndCacheItem(item);
            const cached = getCachedData(item);
            if (container) {
              if (cached) {
                renderPane(container, cached, item, result.work ?? undefined);
                setSectionSummary(`${cached.citedByCount.toLocaleString()} citations`);
                invalidateColumnCache(item.id);
              } else {
                container.innerHTML = `<div class="cg-no-doi">Could not refresh \u2014 OpenAlex may be unavailable.</div>`;
                setSectionSummary("Error");
              }
            }
          } finally {
            refreshing = false;
          }
        },
      },
    ],
  });

  Zotero.debug("[Citegeist] Citation pane section registered");
}

/**
 * Build the pane content using DOM API (not innerHTML for interactive elements).
 *
 * Zotero's item pane renders in a mixed XUL/XHTML context where <button>
 * elements set via innerHTML can fail silently. We build the static parts
 * with innerHTML (fast), then create interactive elements via createElement
 * and attach listeners directly.
 */
function renderPane(
  container: HTMLElement,
  data: CachedData,
  item: _ZoteroTypes.Item,
  work?: OpenAlexWork,
): void {
  const doc = container.ownerDocument;

  // Clear previous content
  container.textContent = "";

  // ── Retraction banner ──
  if (data.isRetracted) {
    const banner = doc.createElement("div");
    banner.className = "cg-retracted";
    banner.textContent = "\u26A0 This work has been retracted";
    container.appendChild(banner);
  }

  // ── Headline stat line ──
  const headline = doc.createElement("div");
  headline.className = "cg-headline";

  let headlineHTML = "";
  headlineHTML += `<span class="cg-headline-count">${escapeHTML(data.citedByCount.toLocaleString())}</span>`;
  headlineHTML += `<span class="cg-headline-label">citations</span>`;

  if (data.fwci !== null) {
    headlineHTML += `<span class="cg-headline-sep">\u00B7</span>`;
    headlineHTML += `<span class="cg-headline-detail">FWCI <strong>${escapeHTML(data.fwci.toFixed(2))}</strong></span>`;
  }
  if (data.percentile !== null) {
    headlineHTML += `<span class="cg-headline-sep">\u00B7</span>`;
    headlineHTML += `<span class="cg-headline-detail"><strong>${escapeHTML(data.percentile.toFixed(0))}th</strong> %ile</span>`;
  }
  if (data.isTop1Percent) {
    headlineHTML += `<span class="cg-badge cg-badge-top1">Top 1%</span>`;
  } else if (data.isTop10Percent) {
    headlineHTML += `<span class="cg-badge cg-badge-top10">Top 10%</span>`;
  }

  headline.innerHTML = headlineHTML;
  container.appendChild(headline);

  // ── Action buttons — created via DOM API for reliable rendering ──
  const actions = doc.createElement("div");
  actions.className = "cg-actions";

  const citingBtn = doc.createElement("div");
  citingBtn.className = "cg-action-btn cg-action-btn-primary";
  citingBtn.setAttribute("role", "button");
  citingBtn.setAttribute("tabindex", "0");
  citingBtn.textContent = `View ${data.citedByCount.toLocaleString()} citing works \u2192`;
  citingBtn.addEventListener("click", () => {
    Zotero.debug("[Citegeist] Citing button clicked for item " + item.id);
    showCitationNetwork(item, "citing").catch((e: unknown) => {
      Zotero.debug("[Citegeist] ERROR in showCitationNetwork (citing): " + e);
    });
  });
  citingBtn.addEventListener("keydown", (e: Event) => {
    if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") {
      e.preventDefault();
      showCitationNetwork(item, "citing").catch((e2: unknown) => {
        Zotero.debug("[Citegeist] ERROR in showCitationNetwork (citing, key): " + e2);
      });
    }
  });
  actions.appendChild(citingBtn);

  const refsBtn = doc.createElement("div");
  refsBtn.className = "cg-action-btn";
  refsBtn.setAttribute("role", "button");
  refsBtn.setAttribute("tabindex", "0");
  refsBtn.textContent = "View references \u2192";
  refsBtn.addEventListener("click", () => {
    Zotero.debug("[Citegeist] References button clicked for item " + item.id);
    showCitationNetwork(item, "references").catch((e: unknown) => {
      Zotero.debug("[Citegeist] ERROR in showCitationNetwork (refs): " + e);
    });
  });
  refsBtn.addEventListener("keydown", (e: Event) => {
    if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") {
      e.preventDefault();
      showCitationNetwork(item, "references").catch((e2: unknown) => {
        Zotero.debug("[Citegeist] ERROR in showCitationNetwork (refs, key): " + e2);
      });
    }
  });
  actions.appendChild(refsBtn);

  container.appendChild(actions);

  Zotero.debug(`[Citegeist] Pane rendered: ${data.citedByCount} citations, 2 action buttons appended`);

  // ── Trend insight — actionable text, not a tiny chart ──
  if (work?.counts_by_year && work.counts_by_year.length >= 2) {
    const sorted = [...work.counts_by_year].sort((a, b) => b.year - a.year);
    const currentYear = new Date().getFullYear();

    // Most recent complete year and the one before it
    const recent = sorted.find((y) => y.year === currentYear - 1) || sorted[0];
    const prior = sorted.find((y) => y.year === recent.year - 1);

    const trend = doc.createElement("div");
    trend.className = "cg-trend";

    let trendText = "";
    const recentCount = recent.cited_by_count;

    if (prior && prior.cited_by_count > 0) {
      const change = recentCount - prior.cited_by_count;
      const pctChange = Math.round((change / prior.cited_by_count) * 100);

      if (change > 0) {
        trendText = `\u2197 ${recentCount} citations in ${recent.year} (+${pctChange}%)`;
      } else if (change < 0) {
        trendText = `\u2198 ${recentCount} citations in ${recent.year} (${pctChange}%)`;
      } else {
        trendText = `\u2192 ${recentCount} citations in ${recent.year} (steady)`;
      }
    } else if (recentCount > 0) {
      trendText = `${recentCount} citations in ${recent.year}`;
    } else {
      trendText = `No citations in ${recent.year}`;
    }

    // Peak year insight (if different from most recent)
    const peak = sorted.reduce((a, b) =>
      b.cited_by_count > a.cited_by_count ? b : a,
    );
    if (peak.year !== recent.year && peak.cited_by_count > recentCount) {
      trendText += ` \u00B7 peak: ${peak.cited_by_count} in ${peak.year}`;
    }

    trend.textContent = trendText;
    container.appendChild(trend);
  }
}

export function unregisterCitationPane(): void {
  Zotero.ItemPaneManager.unregisterSection(PANE_ID);
}

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

import {
  getCachedData,
  clearCache,
  isCacheStale,
  getPendingSuggestion,
  dismissAsNoMatch,
  confirmTitleMatch,
  type CachedData,
  type PendingSuggestion,
} from "./cache";
import { fetchAndCacheItem, extractIdentifier } from "./citationService";
import { invalidateColumnCache } from "./citationColumn";
import { normalizeDOI } from "./openalex";
import type { OpenAlexWork } from "./openalex";
import { showCitationNetwork } from "./citationNetwork";
import { escapeHTML, logError, isBookType, toOrdinal } from "./utils";

/**
 * Per-item refresh in-flight set. Keyed by Zotero item ID so a refresh
 * spam-click on item A doesn't silently swallow a legitimate refresh on
 * item B (the old module-global `refreshing` flag rejected EVERY second
 * click regardless of which pane fired it).
 */
const refreshing = new Set<number>();

/**
 * Generation counter incremented on every item change AND every refresh.
 * Pane async paths snapshot the current value before awaiting and re-check
 * after — a stale resolution (user selected a different item OR clicked
 * refresh mid-confirm) is dropped instead of stomping the now-current
 * pane state. Zotero reuses the section's `body` element across
 * selections, so without this guard a slow fetch on item A would
 * overwrite item B's pane. Refresh increments the same counter so
 * `onConfirm` (and other in-flight handlers) bail when their state was
 * invalidated by an intentional user wipe.
 */
let paneGeneration = 0;

const PANE_ID = "citegeist-citation-details";

/**
 * Build the text shown in the section's collapse header.
 * Books with 0 citations show "Found on OpenAlex" rather than "0 citations"
 * because zero almost always reflects incomplete coverage, not genuine uncitedness.
 */
function citationSummary(count: number, item: _ZoteroTypes.Item): string {
  if (count === 0 && isBookType(item)) {
    return "Found on OpenAlex";
  }
  return `${count.toLocaleString()} citations`;
}

/**
 * Canonical empty-state copy. Centralizes the body text + section summary
 * for every "nothing to render" path so the two text shards never drift
 * between `onRender`, `onAsyncRender`, and the refresh button.
 */
const EMPTY_STATES = {
  noIdentifier: {
    html: "No recognized identifier found. Add a DOI, PMID, arXiv ID, or ISBN to enable citation data.",
    summary: "No identifier",
    cls: "cg-no-identifier",
  },
  loading: { html: "Fetching citation data…", summary: "Loading…", cls: "cg-loading" },
  refreshing: { html: "Refreshing…", summary: "Refreshing…", cls: "cg-loading" },
  unavailable: {
    html: "OpenAlex is currently unavailable. Try again in a few minutes.",
    summary: "Unavailable",
    cls: "cg-no-identifier",
  },
  notFoundTitle: {
    html: "Not found on OpenAlex. We also searched by title and found no confident match.",
    summary: "Not found",
    cls: "cg-no-identifier",
  },
  notFound: {
    html: "This work was not found on OpenAlex.",
    summary: "Not found",
    cls: "cg-no-identifier",
  },
  dismissed: {
    html: "Match dismissed. Add a DOI to get citation data, or we’ll search again in 30 days.",
    summary: "Not found",
    cls: "cg-no-identifier",
  },
  confirmLoading: { html: "Loading…", summary: "Loading…", cls: "cg-loading" },
} as const;

function renderEmptyState(
  container: HTMLElement,
  setSummary: (s: string) => void,
  key: keyof typeof EMPTY_STATES,
): void {
  // Always clear suggestion-only ARIA attributes when transitioning out
  // of `renderSuggestion`. Without this, the entire pane stays wrapped
  // in a `role=status aria-live=polite` region and every subsequent
  // mutation (refresh, confirm-loading, full renderPane) re-announces
  // the whole tree. (ADV-U2)
  clearSuggestionAria(container);
  const s = EMPTY_STATES[key];
  container.innerHTML = `<div class="${s.cls}">${s.html}</div>`;
  setSummary(s.summary);
}

function clearSuggestionAria(container: HTMLElement): void {
  if (container.getAttribute("role") === "status") container.removeAttribute("role");
  if (container.hasAttribute("aria-live")) container.removeAttribute("aria-live");
}

let paneRegistered = false;
let paneRegisteredPluginID: string | null = null;

/**
 * Same as the column module's `namespacedColumnKey` — Zotero stores
 * `ItemPaneManager` sections under `CSS.escape(${pluginID}-${paneID})`.
 * Unregister with the un-prefixed paneID silently fails, the stale
 * section stays, and the next register throws "paneID must be unique".
 */
function namespacedPaneKey(pluginID: string, paneID: string): string {
  const raw = `${pluginID}-${paneID}`;
  type CSSWithEscape = { escape: (s: string) => string };
  const cssGlobal = (globalThis as unknown as { CSS?: CSSWithEscape }).CSS;
  if (cssGlobal && typeof cssGlobal.escape === "function") {
    return cssGlobal.escape(raw);
  }
  return raw.replace(/[@.]/g, "\\$&");
}

export function registerCitationPane(pluginID: string): void {
  if (paneRegistered) return;
  paneRegistered = true;
  paneRegisteredPluginID = pluginID;
  // Defensive unregister with namespaced key (see namespacedPaneKey).
  // Without the prefix, Zotero can't find the entry and the next
  // register throws "paneID must be unique" — exactly the error the
  // user reported.
  try {
    Zotero.ItemPaneManager.unregisterSection(namespacedPaneKey(pluginID, PANE_ID));
  } catch {
    // Expected when the section isn't already registered.
  }
  try {
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
          /*
           * Design tokens. All pane text colors flow from Zotero's CSS
           * variables so dark/light theme switching works automatically.
           * Accent colors define both light + dark values via the
           * light-dark() CSS function (Firefox 128+, Zotero 9 ships on
           * Firefox 128+); the function gracefully degrades to the first
           * argument on older builds.
           *
           * Contrast targets: WCAG AA -- 4.5:1 for body text, 3:1 for
           * large text (18px+ regular / 14px+ bold).
           */
          #citegeist-pane-root {
            /* Primary + secondary text — inherit Zotero theme */
            --cg-text-primary: var(--fill-primary);
            --cg-text-secondary: var(--fill-secondary);
            /* Sage / green family — used for badges, links, secondary buttons */
            --cg-sage-fg: light-dark(#2F6B5A, #8FAD9F);
            --cg-sage-bg: light-dark(rgba(60, 110, 95, 0.08), rgba(143, 173, 159, 0.10));
            --cg-sage-border: light-dark(rgba(60, 110, 95, 0.35), rgba(143, 173, 159, 0.35));
            /* Primary action button — dark green works against both themes */
            --cg-primary-bg: #2F6B5A;
            --cg-primary-bg-hover: #245546;
            --cg-primary-fg: #ffffff;
            /* Top-1% percentile + suggestion banner accent (warm amber) */
            --cg-amber-fg: light-dark(#8B5A1A, #D4A84B);
            --cg-amber-fg-strong: light-dark(#6F4715, #E0B458);
            --cg-amber-bg: light-dark(rgba(168, 101, 26, 0.10), rgba(180, 130, 40, 0.15));
            --cg-amber-border: light-dark(rgba(168, 101, 26, 0.30), rgba(180, 130, 40, 0.35));

            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-feature-settings: 'kern' 1, 'liga' 1;
            padding: 8px 12px 10px;
            font-size: 12px;
            line-height: 1.5;
            color: var(--cg-text-primary);
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
            border-top-color: var(--accent-blue40, #8FAD9F);
            border-radius: 50%;
            animation: cg-spin 0.8s linear infinite;
            flex-shrink: 0;
          }
          @keyframes cg-spin { to { transform: rotate(360deg); } }
          /* Respect Reduce Motion at the OS level — the spinner is the
             only animation in the pane but the same rule applies. */
          @media (prefers-reduced-motion: reduce) {
            .cg-loading::before { animation-duration: 0.001ms !important; }
          }
          .cg-no-identifier { color: var(--fill-secondary); padding: 4px 0; }

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
            background: var(--cg-amber-bg);
            color: var(--cg-amber-fg);
          }
          .cg-badge-top10 {
            background: var(--cg-sage-bg);
            color: var(--cg-sage-fg);
          }

          .cg-metric-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            align-items: stretch;
            gap: 6px;
            margin-bottom: 10px;
          }
          .cg-metric-tile {
            display: flex;
            flex-direction: column;
            justify-content: flex-start;
            background: var(--cg-sage-bg);
            border: 1px solid var(--cg-sage-border);
            border-radius: 6px;
            padding: 10px;
            overflow: hidden;
          }
          .cg-metric-label {
            display: block;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--cg-text-secondary);
            margin-bottom: 4px;
          }
          .cg-metric-value {
            display: block;
            font-size: 20px;
            font-weight: 600;
            color: var(--cg-text-primary);
            font-variant-numeric: tabular-nums;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
          }
          .cg-metric-badge {
            display: block;
            margin-top: 4px;
            margin-left: 0;
          }

          #citegeist-pane-root .cg-actions {
            display: flex;
            gap: 8px;
            margin-bottom: 12px;
          }
          #citegeist-pane-root .cg-action-btn {
            flex: 1;
            padding: 14px 12px;
            border: 1px solid var(--cg-sage-border);
            border-radius: 8px;
            background: var(--cg-sage-bg);
            color: var(--cg-sage-fg);
            font-size: 13px;
            font-weight: 600;
            font-family: inherit;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            text-decoration: none;
            -moz-user-select: none;
            user-select: none;
            line-height: 1.4;
            transition: background 0.12s, border-color 0.12s, color 0.12s;
          }
          #citegeist-pane-root .cg-action-btn:focus-visible {
            outline: 2px solid var(--cg-sage-fg);
            outline-offset: 2px;
          }
          #citegeist-pane-root .cg-action-btn:hover {
            background: light-dark(rgba(60, 110, 95, 0.16), rgba(143, 173, 159, 0.18));
            border-color: var(--cg-sage-fg);
            color: var(--cg-text-primary);
          }
          #citegeist-pane-root .cg-action-btn-primary {
            background: var(--cg-primary-bg);
            border-color: transparent;
            color: var(--cg-primary-fg);
            font-weight: 600;
            font-size: 13px;
          }
          #citegeist-pane-root .cg-action-btn-primary:hover {
            background: var(--cg-primary-bg-hover);
            border-color: transparent;
            color: var(--cg-primary-fg);
          }

          .cg-trend {
            border-top: 1px solid var(--fill-quinary, rgba(255,255,255,0.06));
            padding-top: 7px;
            font-size: 11px;
            color: var(--fill-secondary, #8e8e93);
            line-height: 1.4;
          }

          /* ── Title-match suggestion UI ── */
          .cg-match-banner {
            background: var(--cg-amber-bg);
            border: 1px solid var(--cg-amber-border);
            border-radius: 6px;
            padding: 8px 10px;
            margin-bottom: 10px;
            font-size: 11px;
            color: var(--cg-amber-fg);
            line-height: 1.45;
          }
          .cg-match-banner strong {
            display: block;
            font-size: 11px;
            font-weight: 700;
            margin-bottom: 3px;
            color: var(--cg-amber-fg-strong);
          }
          .cg-match-card {
            border: 1px solid rgba(143,173,159,0.25);
            border-radius: 8px;
            padding: 10px 12px;
            margin-bottom: 10px;
            font-size: 11px;
            line-height: 1.5;
          }
          .cg-match-card-title {
            font-weight: 600;
            font-size: 12px;
            color: var(--fill-primary);
            margin-bottom: 3px;
          }
          .cg-match-card-meta {
            color: var(--fill-secondary, #8e8e93);
            font-size: 11px;
            margin-bottom: 8px;
          }
          .cg-match-actions {
            display: flex;
            gap: 6px;
          }
          #citegeist-pane-root .cg-match-confirm {
            flex: 1;
            padding: 7px 10px;
            background: var(--cg-primary-bg);
            border: none;
            border-radius: 6px;
            color: var(--cg-primary-fg);
            font-size: 12px;
            font-weight: 600;
            font-family: inherit;
            cursor: pointer;
          }
          #citegeist-pane-root .cg-match-confirm:focus-visible {
            outline: 2px solid var(--cg-sage-fg);
            outline-offset: 2px;
          }
          #citegeist-pane-root .cg-match-confirm:hover {
            background: var(--cg-primary-bg-hover);
          }
          #citegeist-pane-root .cg-match-dismiss {
            flex: 1;
            padding: 7px 10px;
            background: transparent;
            border: 1px solid var(--cg-sage-border);
            border-radius: 6px;
            color: var(--cg-text-secondary);
            font-size: 12px;
            font-family: inherit;
            cursor: pointer;
          }
          #citegeist-pane-root .cg-match-dismiss:focus-visible {
            outline: 2px solid var(--cg-sage-fg);
            outline-offset: 2px;
          }
          #citegeist-pane-root .cg-match-dismiss:hover {
            background: var(--cg-sage-bg);
            color: var(--cg-text-primary);
          }
          .cg-doi-prompt {
            border: 1px solid rgba(143,173,159,0.25);
            border-radius: 6px;
            padding: 8px 10px;
            margin-top: 10px;
            font-size: 11px;
            color: var(--fill-secondary, #8e8e93);
            line-height: 1.45;
          }
          .cg-doi-prompt strong {
            display: block;
            color: var(--fill-primary);
            font-size: 11px;
            margin-bottom: 4px;
          }
          .cg-doi-prompt-actions {
            display: flex;
            gap: 6px;
            margin-top: 6px;
          }
          #citegeist-pane-root .cg-doi-yes {
            padding: 5px 10px;
            background: var(--cg-sage-bg);
            border: 1px solid var(--cg-sage-border);
            border-radius: 5px;
            color: var(--cg-sage-fg);
            font-size: 11px;
            font-weight: 600;
            font-family: inherit;
            cursor: pointer;
          }
          #citegeist-pane-root .cg-doi-yes:focus-visible {
            outline: 2px solid var(--cg-sage-fg);
            outline-offset: 2px;
          }
          #citegeist-pane-root .cg-doi-yes:hover {
            background: light-dark(rgba(60, 110, 95, 0.16), rgba(143, 173, 159, 0.25));
          }
          #citegeist-pane-root .cg-doi-no {
            padding: 5px 10px;
            background: transparent;
            border: none;
            color: var(--fill-secondary, #8e8e93);
            font-size: 11px;
            font-family: inherit;
            cursor: pointer;
          }
        </style>
        <div id="citegeist-content"></div>
      </div>
    `,
      onItemChange: ({ item, setEnabled }) => {
        // Bump the generation token so any in-flight onAsyncRender / onConfirm
        // from the previous item's fetch detects the mismatch on resume and
        // drops its DOM write instead of clobbering the new item's pane.
        paneGeneration++;
        // Also disable for trashed items — without this the pane stays
        // interactive on items in the trash, letting users confirm matches
        // or fetch citations against records that will be hard-deleted.
        setEnabled(item.isRegularItem() && !item.deleted);
      },
      onRender: ({ body, item, setSectionSummary }) => {
        const container = body.querySelector("#citegeist-content") as HTMLElement;
        if (!container) return;

        const cached = getCachedData(item);
        if (cached) {
          renderPane(container, cached, item);
          setSectionSummary(citationSummary(cached.citedByCount, item));
          return;
        }

        // Check for a pending unconfirmed suggestion from a previous fetch
        const suggestion = getPendingSuggestion(item);
        if (suggestion) {
          renderSuggestion(container, suggestion, item, setSectionSummary);
          return;
        }

        if (!extractIdentifier(item)) {
          renderEmptyState(container, setSectionSummary, "noIdentifier");
          return;
        }

        renderEmptyState(container, setSectionSummary, "loading");
      },
      onAsyncRender: async ({ body, item, setSectionSummary }) => {
        const container = body.querySelector("#citegeist-content") as HTMLElement;
        if (!container) return;

        // If we already rendered cached data in onRender and it's fresh, skip
        const alreadyCached = getCachedData(item);
        if (alreadyCached && !isCacheStale(item)) return;

        // If a suggestion is already rendered (from a prior fetch stored in Extra), skip
        if (!alreadyCached && getPendingSuggestion(item)) return;

        // Snapshot the generation BEFORE the await so a mid-fetch item
        // change is detected on resume. Without this, Zotero's body-element
        // reuse would have us writing item A's data into item B's pane.
        const gen = paneGeneration;
        const result = await fetchAndCacheItem(item);
        if (gen !== paneGeneration) return;

        if (result.status === "ok") {
          const freshData = getCachedData(item);
          if (freshData) {
            renderPane(container, freshData, item, result.work);
            setSectionSummary(citationSummary(freshData.citedByCount, item));
            invalidateColumnCache(item.id);
          }
        } else if (result.status === "suggestion") {
          const suggestion = getPendingSuggestion(item);
          if (suggestion) {
            renderSuggestion(container, suggestion, item, setSectionSummary);
            invalidateColumnCache(item.id);
          }
        } else if (result.status === "error" && !alreadyCached) {
          const key =
            result.error === "network"
              ? "unavailable"
              : result.error === "no-match"
                ? "notFoundTitle"
                : "notFound";
          renderEmptyState(container, setSectionSummary, key);
        }
      },
      sectionButtons: [
        {
          type: "refresh",
          icon: "chrome://zotero/skin/16/universal/sync.svg",
          l10nID: "citegeist-pane-refresh",
          onClick: async ({ body, item, setSectionSummary }) => {
            // Per-item gate: spam-click on item A must not silently swallow a
            // refresh on item B.
            if (refreshing.has(item.id)) return;
            refreshing.add(item.id);
            // Bump the generation token so any in-flight onConfirm / async
            // render handler resuming after this `clearCache` call bails
            // instead of writing stale post-confirm state over the now-empty
            // pane.
            paneGeneration++;
            const gen = paneGeneration;
            try {
              const container = body.querySelector("#citegeist-content") as HTMLElement;
              if (container) renderEmptyState(container, setSectionSummary, "refreshing");
              await clearCache(item); // wide-clear: also nukes pending suggestion
              const result = await fetchAndCacheItem(item);
              if (gen !== paneGeneration) return;
              const cached = getCachedData(item);
              if (container) {
                if (cached) {
                  renderPane(
                    container,
                    cached,
                    item,
                    result.status === "ok" ? result.work : undefined,
                  );
                  setSectionSummary(citationSummary(cached.citedByCount, item));
                  invalidateColumnCache(item.id);
                } else if (result.status === "suggestion") {
                  const suggestion = getPendingSuggestion(item);
                  if (suggestion) {
                    renderSuggestion(container, suggestion, item, setSectionSummary);
                    invalidateColumnCache(item.id);
                  }
                } else {
                  renderEmptyState(
                    container,
                    setSectionSummary,
                    result.status === "error" && result.error === "network"
                      ? "unavailable"
                      : "notFound",
                  );
                }
              }
            } finally {
              refreshing.delete(item.id);
            }
          },
        },
      ],
    });
  } catch (e) {
    paneRegistered = false;
    Zotero.debug(`[Citegeist] registerCitationPane failed: ${String(e)}`);
  }

  Zotero.debug("[Citegeist] Citation pane section registered");
}

/**
 * Append a DOI population prompt below the rendered pane after a confirmed title match.
 * If the researcher accepts, the DOI is written to the item field, graduating it out of
 * the title-search pipeline permanently.
 */
function renderDoiPrompt(container: HTMLElement, item: _ZoteroTypes.Item, doi: string): void {
  const doc = container.ownerDocument;

  const prompt = doc.createElement("div");
  prompt.className = "cg-doi-prompt";

  const label = doc.createElement("strong");
  label.textContent = "Also add DOI to this item?";
  prompt.appendChild(label);

  const detail = doc.createElement("span");
  detail.textContent = `The matched paper has DOI ${doi}. Adding it means future refreshes go direct \u2014 no title search needed.`;
  prompt.appendChild(detail);

  const promptActions = doc.createElement("div");
  promptActions.className = "cg-doi-prompt-actions";

  const yesBtn = doc.createElement("button");
  yesBtn.type = "button";
  yesBtn.className = "cg-doi-yes";
  yesBtn.textContent = "Add DOI";
  yesBtn.addEventListener("click", async () => {
    try {
      item.setField("DOI", normalizeDOI(doi) ?? doi);
      await item.saveTx();
      prompt.remove();
    } catch (e) {
      logError("renderDoiPrompt add DOI", e);
    }
  });

  const noBtn = doc.createElement("button");
  noBtn.type = "button";
  noBtn.className = "cg-doi-no";
  noBtn.textContent = "No thanks";
  noBtn.addEventListener("click", () => prompt.remove());

  promptActions.appendChild(yesBtn);
  promptActions.appendChild(noBtn);
  prompt.appendChild(promptActions);
  container.appendChild(prompt);
}

/**
 * Render the suggestion confirmation UI for an unconfirmed title match.
 * High-confidence: shows metrics with a banner above them.
 * Medium-confidence: shows a card with match details only, no metrics.
 */
function renderSuggestion(
  container: HTMLElement,
  suggestion: PendingSuggestion,
  item: _ZoteroTypes.Item,
  setSectionSummary: (s: string) => void,
): void {
  const doc = container.ownerDocument;
  container.textContent = "";

  /**
   * Construct a button whose async action is double-click-safe.
   *
   * Disables the button (and its siblings) synchronously on click so a
   * spam-click can't fire two concurrent confirm/dismiss writes before
   * SQLite mutateRow even has a chance to serialize them. Re-enables in
   * `finally` so failure modes (network blip, read-only library) leave a
   * usable retry path — on success the pane has re-rendered and the
   * buttons are detached anyway, so the re-enable is a no-op.
   */
  const makeGuardedButton = (
    label: string,
    className: string,
    action: () => Promise<void>,
  ): HTMLButtonElement => {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.textContent = label;
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const siblings = btn.parentElement?.querySelectorAll("button");
      siblings?.forEach((s) => ((s as HTMLButtonElement).disabled = true));
      try {
        await action();
      } finally {
        btn.disabled = false;
        siblings?.forEach((s) => ((s as HTMLButtonElement).disabled = false));
      }
    });
    return btn;
  };

  const onConfirm = async (): Promise<void> => {
    // Generation snapshot: a mid-confirm item change must not leave the
    // newly-selected item's pane displaying the previous item's freshly-
    // fetched work data.
    const gen = paneGeneration;
    try {
      // confirmTitleMatch atomically promotes pending→confirmed and clears
      // the pending block in a single upsert (see cache/write.ts), so no
      // separate clearPendingSuggestion call is needed.
      await confirmTitleMatch(item, suggestion.tier);
      if (gen !== paneGeneration) return;

      // Fetch the full work using the now-confirmed ID
      renderEmptyState(container, setSectionSummary, "confirmLoading");
      const result = await fetchAndCacheItem(item);
      if (gen !== paneGeneration) return;
      const fresh = getCachedData(item);
      if (fresh) {
        renderPane(container, fresh, item, result.status === "ok" ? result.work : undefined);
        setSectionSummary(citationSummary(fresh.citedByCount, item));
      } else if (result.status === "error") {
        // Confirmation persisted in SQLite (confirmed_open_alex_id is set),
        // but the follow-up fetch failed (network blip, transient 5xx).
        // Without this branch the pane stays on `confirmLoading` forever,
        // hiding the fact that the user's curation actually succeeded.
        renderEmptyState(
          container,
          setSectionSummary,
          result.error === "network" ? "unavailable" : "notFound",
        );
      }
      invalidateColumnCache(item.id);

      // DOI population bonus: if matched work has a DOI and item doesn't, offer to add it
      const itemDoi = (item.getField("DOI") as string) || "";
      if (suggestion.doi && !itemDoi.trim() && fresh) {
        renderDoiPrompt(container, item, suggestion.doi);
      }
    } catch (e) {
      logError("renderSuggestion confirm", e);
    }
  };

  const onDismiss = async (): Promise<void> => {
    try {
      // Atomic clear+no-match: prevents a concurrent fetch from landing
      // work data between the two writes and producing a row with both
      // real metrics AND no_match=1 (contradictory state).
      await dismissAsNoMatch(item);
      renderEmptyState(container, setSectionSummary, "dismissed");
      invalidateColumnCache(item.id);
    } catch (e) {
      logError("renderSuggestion dismiss", e);
    }
  };

  // Both tiers represent a possible-but-unconfirmed match; surface the
  // status in the section header so it doesn't read "Loading…" or
  // "Not found" while a confirmable match is visible in the body.
  setSectionSummary("Possible match");

  // role=status announces dismiss/confirm transitions to screen readers
  // (a-n 7).
  container.setAttribute("role", "status");
  container.setAttribute("aria-live", "polite");

  if (suggestion.tier === "high") {
    // High-confidence: show a banner above the metrics
    const banner = doc.createElement("div");
    banner.className = "cg-match-banner";
    banner.innerHTML = `<strong>Matched by title</strong>We couldn\u2019t find a direct identifier, so we matched this item by title, year, and authors. Please confirm this is the right paper.`;
    container.appendChild(banner);

    // Show the metrics speculatively. aria-label spells out the tilde so
    // screen readers say "approximately" rather than ignoring the glyph
    // entirely; visible glyphs are aria-hidden to avoid double-reading. (P3.5)
    const headline = doc.createElement("div");
    headline.className = "cg-headline";
    headline.setAttribute(
      "aria-label",
      `Approximately ${suggestion.citedByCount} citations${suggestion.fwci !== null ? `, FWCI approximately ${suggestion.fwci.toFixed(2)}` : ""}, pending confirmation`,
    );
    let html = `<span class="cg-headline-count" aria-hidden="true">~${escapeHTML(String(suggestion.citedByCount))}</span>`;
    html += `<span class="cg-headline-label" aria-hidden="true">citations</span>`;
    if (suggestion.fwci !== null) {
      html += `<span class="cg-headline-sep" aria-hidden="true">\u00B7</span>`;
      html += `<span class="cg-headline-detail" aria-hidden="true">FWCI <strong>~${escapeHTML(suggestion.fwci.toFixed(2))}</strong></span>`;
    }
    headline.innerHTML = html;
    container.appendChild(headline);

    const actions = doc.createElement("div");
    actions.className = "cg-match-actions";
    const confirmBtn = makeGuardedButton("Confirm match", "cg-match-confirm", () =>
      onConfirm().catch((e) => logError("onConfirm", e)),
    );
    actions.appendChild(confirmBtn);
    const dismissBtn = makeGuardedButton("Not this paper", "cg-match-dismiss", () =>
      onDismiss().catch((e) => logError("onDismiss", e)),
    );
    actions.appendChild(dismissBtn);
    container.appendChild(actions);
  } else {
    // Medium-confidence: show the candidate card, no metrics
    const card = doc.createElement("div");
    card.className = "cg-match-card";

    const titleDiv = doc.createElement("div");
    titleDiv.className = "cg-match-card-title";
    titleDiv.textContent = suggestion.title;
    card.appendChild(titleDiv);

    const meta = doc.createElement("div");
    meta.className = "cg-match-card-meta";
    const parts: string[] = suggestion.year !== null ? [String(suggestion.year)] : [];
    if (suggestion.citedByCount > 0) parts.push(`${suggestion.citedByCount} citations`);
    if (suggestion.fwci !== null) parts.push(`FWCI ${suggestion.fwci.toFixed(2)}`);
    meta.textContent = parts.join(" \u00B7 ");
    card.appendChild(meta);

    const actions = doc.createElement("div");
    actions.className = "cg-match-actions";
    const confirmBtn = makeGuardedButton("Confirm match", "cg-match-confirm", () =>
      onConfirm().catch((e) => logError("onConfirm", e)),
    );
    actions.appendChild(confirmBtn);
    const dismissBtn = makeGuardedButton("Not this paper", "cg-match-dismiss", () =>
      onDismiss().catch((e) => logError("onDismiss", e)),
    );
    actions.appendChild(dismissBtn);
    card.appendChild(actions);

    container.appendChild(card);
  }
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

  // Clear previous content + any suggestion-era ARIA wrapping. Without
  // the latter, a confirmed-from-suggestion render leaves the entire
  // pane inside a `role=status aria-live=polite` region and every
  // metric mutation re-announces the whole tree. (ADV-U2)
  clearSuggestionAria(container);
  container.textContent = "";

  // ── Retraction banner ──
  if (data.isRetracted) {
    const banner = doc.createElement("div");
    banner.className = "cg-retracted";
    banner.textContent = "\u26A0 This work has been retracted";
    container.appendChild(banner);
  }

  // ── Metric grid ──
  const isBook = isBookType(item);
  const suppressCount = isBook && data.citedByCount === 0;

  if (!suppressCount) {
    const grid = doc.createElement("div");
    grid.className = "cg-metric-grid";

    // All values are escapeHTML'd or static; safe to set via innerHTML.
    const makeTile = (label: string, value: string, extraHTML = ""): HTMLElement => {
      const tile = doc.createElement("div");
      tile.className = "cg-metric-tile";
      tile.innerHTML =
        `<span class="cg-metric-label">${label}</span>` +
        `<span class="cg-metric-value" title="${value}">${value}</span>` +
        extraHTML;
      return tile;
    };

    const citCount = escapeHTML(data.citedByCount.toLocaleString());
    grid.appendChild(makeTile("CITATIONS", citCount));

    const fwciVal = data.fwci !== null ? escapeHTML(data.fwci.toFixed(2)) : "—";
    grid.appendChild(makeTile("FWCI", fwciVal));

    const pctVal =
      data.percentile !== null ? escapeHTML(toOrdinal(Math.round(data.percentile))) : "—";
    const pctBadge = data.isTop1Percent
      ? `<span class="cg-metric-badge"><span class="cg-badge cg-badge-top1">Top 1%</span></span>`
      : data.isTop10Percent
        ? `<span class="cg-metric-badge"><span class="cg-badge cg-badge-top10">Top 10%</span></span>`
        : "";
    grid.appendChild(makeTile("PERCENTILE", pctVal, pctBadge));

    container.appendChild(grid);
  } else {
    const note = doc.createElement("div");
    note.className = "cg-no-identifier";
    note.textContent = "Citation tracking for books is limited in OpenAlex.";
    container.appendChild(note);
  }

  // ── Action buttons — real <button> elements for keyboard + screen reader support ──
  const actions = doc.createElement("div");
  actions.className = "cg-actions";

  const makeActionButton = (
    label: string,
    ariaLabel: string,
    variant: "primary" | "secondary",
    mode: "citing" | "references",
  ): HTMLButtonElement => {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "cg-action-btn" + (variant === "primary" ? " cg-action-btn-primary" : "");
    btn.textContent = label;
    btn.setAttribute("aria-label", ariaLabel);
    btn.addEventListener("click", () => {
      Zotero.debug(`[Citegeist] ${mode} button clicked for item ${item.id}`);
      showCitationNetwork(item, mode).catch((e: unknown) => {
        logError(`showCitationNetwork(${mode})`, e);
      });
    });
    return btn;
  };

  const citingBtn = makeActionButton(
    `View ${data.citedByCount.toLocaleString()} citing works \u2192`,
    `View ${data.citedByCount.toLocaleString()} works that cite this paper`,
    "primary",
    "citing",
  );
  actions.appendChild(citingBtn);

  const refsBtn = makeActionButton(
    "View references \u2192",
    "View works cited by this paper",
    "secondary",
    "references",
  );
  actions.appendChild(refsBtn);

  container.appendChild(actions);

  Zotero.debug(
    `[Citegeist] Pane rendered: ${data.citedByCount} citations, 2 action buttons appended`,
  );

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
    const peak = sorted.reduce((a, b) => (b.cited_by_count > a.cited_by_count ? b : a));
    if (peak.year !== recent.year && peak.cited_by_count > recentCount) {
      trendText += ` \u00B7 peak: ${peak.cited_by_count} in ${peak.year}`;
    }

    trend.textContent = trendText;
    container.appendChild(trend);
  }
}

export function unregisterCitationPane(): void {
  if (paneRegisteredPluginID) {
    try {
      Zotero.ItemPaneManager.unregisterSection(namespacedPaneKey(paneRegisteredPluginID, PANE_ID));
    } catch (e) {
      Zotero.debug(`[Citegeist] unregisterCitationPane: ${String(e)}`);
    }
    paneRegisteredPluginID = null;
  }
  paneRegistered = false;
}

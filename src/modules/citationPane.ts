/**
 * The unified Citegeist item-pane section: citation impact + author discovery.
 *
 * Composition: two titled cards. An "Impact" card holds the one hero (the
 * citation count), a single supporting-metric line (FWCI, percentile, trend) and
 * the two peer "explore" actions; an "Authors" card holds the author link rows
 * (name, h-index, chevron; each opens that author's works). Cards fill the pane
 * width and the author list reflows into columns when the pane is dragged wide,
 * so extra width is used rather than left as dead space. Metrics render
 * synchronously from the cache in onRender; author rows load async in
 * renderAuthorRows under a paneGeneration guard.
 *
 * IMPORTANT: interactive elements + all interpolated data are built via the DOM
 * API (createElement + textContent), never innerHTML — Zotero's XUL/XHTML pane
 * context can silently swallow `<button>` set via innerHTML, and textContent
 * keeps hostile author names / titles inert.
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
import { showCitationNetwork, showAuthorWorks } from "./citationNetwork";
import { getItemAuthors, getAuthor, type AuthorRow } from "./cache/authors";
import {
  buildAuthorRowViewModels,
  compactTrend,
  getAuthorCreators,
  type AuthorRowViewModel,
} from "./authorProfile";
import { logError, isBookType, toOrdinal } from "./utils";
import { cgDesignTokens } from "./ui/tokens";
import { cgComponents } from "./ui/components";
import { resolveHostScheme } from "./ui/theme";
import { SETTINGS_PANE_ID } from "../constants";

/**
 * Force `color-scheme` on the pane root to Zotero's actual theme — the same
 * resolver the network dialog uses — so the pane's `light-dark()` tokens never
 * diverge from the host when the OS appearance disagrees with Zotero's theme.
 * Text already tracks Zotero via `--fill-*`; this keeps surfaces/tints/accents
 * in lockstep too. Cheap and idempotent; safe to call on every render. See
 * `ui/theme.ts`.
 */
function applyHostScheme(body: HTMLElement): void {
  const root = body.querySelector<HTMLElement>("#citegeist-pane-root");
  const win = root?.ownerDocument?.defaultView;
  if (root && win) root.style.colorScheme = resolveHostScheme(win as Window);
}

/**
 * Open Zotero's Settings dialog directly to the Citegeist pane. Zotero hosts
 * plugin preferences in the Settings dialog (not the Add-ons window), so this
 * gives the item pane a one-click shortcut to where the email/cache settings
 * actually live. `Zotero.Utilities.Internal.openPreferences` isn't in the
 * typings, hence the cast.
 */
function openCitegeistSettings(): void {
  try {
    (
      Zotero as unknown as {
        Utilities: { Internal: { openPreferences(paneID: string): void } };
      }
    ).Utilities.Internal.openPreferences(SETTINGS_PANE_ID);
  } catch (e) {
    logError("openCitegeistSettings", e);
  }
}

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
  matchSaved: {
    html: "Match confirmed — the metrics didn’t load just yet. Use the refresh button to try again.",
    summary: "Confirmed",
    cls: "cg-loading",
  },
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
  // Wrapped in a card so loading/empty states sit on the same surface as real
  // content: no bare text line, and no layout jump when the cards replace them.
  container.innerHTML = `<div class="cg-card cg-state-card"><div class="${s.cls}">${s.html}</div></div>`;
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

export function registerCitationPane(pluginID: string, rootURI: string): void {
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
        // Zotero 9 REQUIRES l10nID here — a plain `label` is rejected with
        // "Option must have .header[\"l10nID\"]" / "Option [\"header\"] is invalid"
        // and the section never registers (the pane vanishes entirely). The text
        // comes from the injected FTL (citegeist-pane-header). hooks.ts loads
        // citegeist.ftl into the window at startup AND on window load so the ID
        // resolves even when the main window is already open before onStartup.
        l10nID: "citegeist-pane-header",
        // The COLOR icon (explicit #8FAD9F fills), NOT icon-16/20.svg — those use
        // `fill/stroke="context-fill"`, which only resolves inside a XUL chrome
        // context that sets -moz-context-properties. Zotero paints the section /
        // sidenav icon as a plain url() image, where context-fill falls back to
        // transparent → a blank icon. rootURI (jar:) so the URL itself resolves.
        icon: `${rootURI}content/icons/icon-20-color.svg`,
        // darkIcon required too — Zotero does NOT default it to `icon` (see the
        // sidenav note below); omitting it blanks the icon in dark mode.
        darkIcon: `${rootURI}content/icons/icon-20-color.svg`,
      },
      sidenav: {
        // l10nID required, same as header (citegeist-pane-sidenav in the FTL).
        l10nID: "citegeist-pane-sidenav",
        // Color icon (explicit fills): Zotero renders the sidenav icon as a
        // background-image, so the SVG's own colours show (a context-fill icon
        // would be blank here). rootURI so the URL resolves.
        icon: `${rootURI}content/icons/icon-20-color.svg`,
        // darkIcon is REQUIRED, not optional. Zotero does NOT default it to
        // `icon` (despite the JSDoc): itemPaneSidenav.js emits
        // `--custom-sidenav-icon-dark: url('<darkIcon>')` verbatim, and the
        // sidenav SCSS applies `background-image: var(--custom-sidenav-icon-dark)`
        // under `@media (prefers-color-scheme: dark)` with NO fallback. Omit it
        // and dark-mode users get `url('undefined')` → a BLANK sidenav icon —
        // the persistent blank-icon bug. The sage art reads on both themes.
        darkIcon: `${rootURI}content/icons/icon-20-color.svg`,
      },
      bodyXHTML: `
      <div id="citegeist-pane-root" xmlns="http://www.w3.org/1999/xhtml">
        <style>/*<![CDATA[*/
          ${cgDesignTokens("#citegeist-pane-root", { embedded: true })}
          ${cgComponents("#citegeist-pane-root")}
          /*
           * Pane-local layer. Design tokens come from the canonical module
           * (src/modules/ui/tokens.ts, which mirrors
           * docs/design-system/citegeist-primitives.html). Embedded text colors
           * flow from Zotero's --fill-* vars so dark/light theme switching is
           * automatic. Below: thin compat aliases mapping the pane's legacy
           * token names onto the canonical layer, plus the pane-local
           * filled-button tokens.
           */
          #citegeist-pane-root {
            font-family: var(--cg-font);
            font-feature-settings: 'kern' 1, 'liga' 1;
            /* Even 12px gutter; each card owns its inner padding and the content
               column owns the gap BETWEEN cards, so spacing is systematic rather
               than a pile of per-element margins. */
            padding: var(--cg-space-3);
            /* Deliberately no max-width: the cards are meant to FILL a dragged-wide
               pane (the old 26rem cap left dead space on the right). Nothing
               stretches badly now — the hero is left-grouped and the author list
               reflows into columns. */
            font-size: var(--cg-size-footnote);
            line-height: 1.5;
            color: var(--cg-text-primary);
          }

          /* Card stack — one systematic gap; layout does the spacing. */
          #citegeist-content {
            display: flex;
            flex-direction: column;
            gap: var(--cg-space-3);
          }

          /* Each card's uppercase title sits above its content. */
          .cg-card-title { display: block; margin-bottom: var(--cg-space-2); }

          /* Pane-local card fill. The shared .cg-card primitive uses
             --cg-surface-elevated, which is #FFFFFF in light mode — identical to
             Zotero's own item-pane background, so the card would read as nothing
             but a 1px hairline. The sunken tint reads as a real grouped box
             against the host background in BOTH themes, which is the entire point
             of grouping. Border stays for definition. */
          #citegeist-pane-root .cg-card { background: var(--cg-surface-sunken); }
          .cg-loading {
            color: var(--cg-text-secondary);
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 0;
          }
          .cg-loading::before {
            content: "";
            width: 12px; height: 12px;
            border: 2px solid var(--cg-sage-tint-15);
            border-top-color: var(--cg-sage-accent);
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
          .cg-no-identifier { color: var(--cg-text-secondary); padding: 4px 0; }

          .cg-retracted {
            background: var(--cg-danger-tint);
            border: 1px solid var(--cg-danger-tint-strong);
            border-radius: 4px;
            padding: 5px 8px;
            color: var(--cg-danger);
            font-weight: 600;
            font-size: 11px;
          }

          /* ── Hero: the citation count is the single largest element on the
             surface. Number, label and the top-percentile chip are LEFT-grouped as
             one unit; a right-aligned chip drifts absurdly far from the number it
             qualifies once the pane is dragged wide (the old "stretched" look). ── */
          .cg-hero {
            display: flex;
            align-items: baseline;
            flex-wrap: wrap;
            gap: var(--cg-space-2);
          }
          .cg-hero-main {
            display: flex;
            align-items: baseline;
            gap: var(--cg-space-2);
            min-width: 0;
          }
          .cg-hero-stat {
            font-size: var(--cg-size-display);
            font-weight: var(--cg-weight-bold);
            letter-spacing: -0.025em;
            color: var(--cg-text-primary);
            font-variant-numeric: tabular-nums;
            line-height: 1.05;
          }
          .cg-hero-label {
            font-size: var(--cg-size-subhead);
            color: var(--cg-text-secondary);
          }
          .cg-hero-chip { flex-shrink: 0; align-self: center; }

          /* ── Supporting-metric line: FWCI · percentile · trend on one row, 8px
             under the hero, tabular, ' · ' separators with equal space. ── */
          .cg-metricline {
            margin-top: var(--cg-space-2);
            font-size: var(--cg-size-subhead);
            color: var(--cg-text-secondary);
            font-variant-numeric: tabular-nums;
            line-height: 1.4;
          }
          .cg-metricline-sep { color: var(--cg-text-tertiary); margin: 0 var(--cg-space-2); }
          .cg-metricline strong { color: var(--cg-text-primary); font-weight: var(--cg-weight-semibold); }

          /* Book-with-no-citations note replaces the hero (OpenAlex book coverage
             is sparse; a bare "0" would misread as genuinely uncited). */
          .cg-booknote { color: var(--cg-text-secondary); padding: 2px 0; }

          /* ── Action row: two peer explore buttons (tinted, equal width). The
             hero number is the one hero, so neither action is a filled primary.
             .cg-actions / .cg-btn come from cgComponents(); inside the Impact card
             the card padding owns the bottom space, so only the 12px top margin is
             local. Vertical padding is tightened from the primitive's 14px: a 44px
             control is right for the dialog, too heavy for two side-by-side
             actions in a 320px sidebar card. ── */
          #citegeist-pane-root .cg-actions { margin: var(--cg-space-3) 0 0; }
          #citegeist-pane-root .cg-actions > .cg-btn { padding: var(--cg-space-2) var(--cg-space-3); }

          /* ── Authors: link rows (name · h-index · chevron) inside their own card.
             The card boundary replaces the old full-bleed hairline. Each row is a
             clickable unit → the author-works dialog, so a hover tint is earned; a
             border is not. ── */
          .cg-authorlist {
            display: flex;
            flex-direction: column;
            /* ONE author per line, always — never a multi-column grid. Authorship
               order is semantic in academia (first author, senior author), and
               columns turn an ordered byline into a grid of equals; names also
               ellipsis badly in a narrow column. Rows run full width, so the extra
               width of a dragged-wide pane goes to the NAME (fewer truncations)
               with the h-index column aligned right. The cap engages only on an
               unusually wide pane, where an unbounded name-to-h-index gap would
               otherwise read as broken. */
            max-width: 34rem;
          }
          .cg-authorrow {
            display: flex;
            align-items: center;
            gap: var(--cg-space-2);
            width: 100%;
            padding: var(--cg-space-1);
            background: transparent;
            border: none;
            border-radius: var(--cg-radius-md);
            cursor: pointer;
            font-family: inherit;
            text-align: left;
          }
          .cg-authorrow:hover { background: var(--cg-sage-tint-06); }
          .cg-authorrow:focus-visible { outline: 2px solid var(--cg-sage-accent); outline-offset: -2px; }
          .cg-authorrow-name {
            flex: 1;
            min-width: 0;
            font-size: var(--cg-size-subhead);
            color: var(--cg-text-primary);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .cg-authorrow:hover .cg-authorrow-name { color: var(--cg-sage-accent); }
          .cg-authorrow-h {
            font-size: var(--cg-size-caption);
            color: var(--cg-text-tertiary);
            font-variant-numeric: tabular-nums;
            white-space: nowrap;
          }
          .cg-authorrow-chev {
            font-size: var(--cg-size-subhead);
            color: var(--cg-text-tertiary);
            line-height: 1;
          }

          /* ── Title-match suggestion UI ── */
          /* Suggestion-card chrome (border / radius / surface / padding) comes
             from the shared .cg-card primitive; this keeps only the card's own
             outer spacing + base type. (.cg-match-banner was dead — removed.) */
          .cg-match-card {
            font-size: 11px;
            line-height: 1.5;
          }
          .cg-match-card-title {
            font-weight: 600;
            font-size: 12px;
            color: var(--cg-text-primary);
            margin-bottom: var(--cg-space-1);
          }
          .cg-match-card-meta {
            color: var(--cg-text-secondary);
            font-size: 11px;
            margin-bottom: var(--cg-space-1);
          }
          .cg-match-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: var(--cg-space-2);
            margin-bottom: var(--cg-space-3);
          }
          /* Eyebrow → shared .cg-eyebrow; confidence chip → shared .cg-chip
             (--amber when strong, --quiet otherwise). See ui/components.ts. */
          .cg-match-prompt {
            font-size: 11px;
            line-height: 1.45;
            color: var(--cg-text-secondary);
            margin-bottom: var(--cg-space-3);
          }
          .cg-match-legend {
            font-size: 10px;
            color: var(--cg-text-secondary);
            opacity: 0.85;
            margin-bottom: var(--cg-space-3);
          }
          #citegeist-pane-root .cg-match-confirm:disabled,
          #citegeist-pane-root .cg-match-dismiss:disabled {
            opacity: 0.55;
            cursor: default;
          }
          #citegeist-pane-root .cg-match-verify {
            display: inline-block;
            margin-top: 8px;
            font-size: 11px;
            color: var(--cg-sage-accent);
            text-decoration: none;
          }
          #citegeist-pane-root .cg-match-verify:hover {
            text-decoration: underline;
          }
          /* Keep the focus treatment identical to every other interactive element
             in the pane (.cg-btn, .cg-authorrow) instead of falling through to
             Zotero's default outline. */
          #citegeist-pane-root .cg-match-verify:focus-visible {
            outline: 2px solid var(--cg-sage-accent);
            outline-offset: 2px;
          }
          /* Confirm / "Not this paper" reuse the shared .cg-btn / .cg-btn--filled /
             .cg-btn--tinted primitives (assigned in renderSuggestion) so they
             match the data view's buttons exactly. Only the :disabled hook above
             is local to the suggestion card. */
          /* DOI-prompt chrome comes from the shared .cg-banner primitive (incl.
             its strong block heading); this keeps only the outer spacing. No
             angle brackets in pane-style comments — see the CDATA note above. */
          /* No margin here: the prompt is a flex child of #citegeist-content,
             which already owns the gap. Actions sit on the 4pt grid. */
          .cg-doi-prompt-actions {
            display: flex;
            gap: var(--cg-space-2);
            margin-top: var(--cg-space-2);
          }
          /* DOI-prompt buttons use the shared .cg-btn--sm primitive
             (assigned in renderDoiPrompt) — see ui/components.ts. */
        /*]]>*/</style>
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
        applyHostScheme(body);
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
        applyHostScheme(body);
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
          // l10nID, not label: the section-button schema has no `label` field, so
          // a plain string is dropped and the button gets no tooltip. Text comes
          // from the FTL's `.tooltiptext` (see citegeist-pane-refresh).
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
        {
          type: "citegeist-settings",
          icon: "chrome://zotero/skin/16/universal/options.svg",
          l10nID: "citegeist-pane-settings",
          onClick: () => openCitegeistSettings(),
        },
      ],
    });
  } catch (e) {
    paneRegistered = false;
    logError("registerCitationPane", e);
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
  prompt.className = "cg-banner cg-doi-prompt";

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
  yesBtn.className = "cg-btn cg-btn--sm cg-btn--filled cg-doi-yes";
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
  noBtn.className = "cg-btn cg-btn--sm cg-btn--plain cg-doi-no";
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
        // Confirmation persisted in SQLite (confirmed_open_alex_id is set), but
        // the follow-up fetch failed (network blip, transient 5xx). Show a
        // POSITIVE "match saved" state — NOT "Not found", which made a
        // successful confirmation read as a failure (W2). Metrics retry on the
        // next refresh / auto-fetch.
        renderEmptyState(container, setSectionSummary, "matchSaved");
      }
      invalidateColumnCache(item.id);

      // DOI graduation: if the matched work has a DOI the item lacks, offer to
      // add it — regardless of whether metrics loaded. The DOI is the durable
      // win (it permanently graduates the item out of title search), so don't
      // gate it on `fresh` (W3).
      const itemDoi = (item.getField("DOI") as string) || "";
      if (suggestion.doi && !itemDoi.trim()) {
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

  // One unified card for both tiers \u2014 the only difference is the confidence
  // chip. The high tier previously showed speculative metrics with NO title,
  // authors, or year, so the user was asked to confirm an invisible paper.
  const isStrong = suggestion.tier === "high";
  const confidencePct = Math.max(0, Math.min(100, Math.round((suggestion.confidence ?? 0) * 100)));

  const card = doc.createElement("div");
  card.className = "cg-card cg-match-card";

  // Header: "POSSIBLE MATCH" eyebrow + a confidence chip.
  const headerRow = doc.createElement("div");
  headerRow.className = "cg-match-header";
  const eyebrow = doc.createElement("span");
  eyebrow.className = "cg-eyebrow";
  eyebrow.textContent = "Possible match";
  headerRow.appendChild(eyebrow);
  const chip = doc.createElement("span");
  chip.className = isStrong ? "cg-chip cg-chip--amber" : "cg-chip cg-chip--quiet";
  chip.textContent = `${isStrong ? "Strong" : "Possible"} \u00B7 ${confidencePct}%`;
  headerRow.appendChild(chip);
  card.appendChild(headerRow);

  // What this is + the ask.
  const prompt = doc.createElement("div");
  prompt.className = "cg-match-prompt";
  prompt.textContent =
    "No exact identifier \u2014 we matched this item to OpenAlex by title and year. Is this the right paper?";
  card.appendChild(prompt);

  // Candidate identity so the decision is informed.
  const titleDiv = doc.createElement("div");
  titleDiv.className = "cg-match-card-title";
  titleDiv.textContent = suggestion.title;
  card.appendChild(titleDiv);

  const meta = doc.createElement("div");
  meta.className = "cg-match-card-meta";
  const parts: string[] = [];
  if (suggestion.year !== null) parts.push(String(suggestion.year));
  parts.push(`~${suggestion.citedByCount} citation${suggestion.citedByCount === 1 ? "" : "s"}`);
  if (suggestion.fwci !== null) parts.push(`FWCI ~${suggestion.fwci.toFixed(2)}`);
  meta.textContent = parts.join(" \u00B7 ");
  // Spell out the tilde for screen readers ("approximately") so the speculative
  // metrics aren't read as exact.
  meta.setAttribute(
    "aria-label",
    `Candidate ${suggestion.title}${suggestion.year !== null ? `, ${suggestion.year}` : ""}, approximately ${suggestion.citedByCount} citations${suggestion.fwci !== null ? `, FWCI approximately ${suggestion.fwci.toFixed(2)}` : ""}`,
  );
  card.appendChild(meta);

  const legend = doc.createElement("div");
  legend.className = "cg-match-legend";
  legend.textContent = "~ estimated until you confirm";
  card.appendChild(legend);

  // Primary / secondary actions — reuse the shared button primitives so the
  // suggestion card matches the data view exactly (the cg-match-* classes are
  // kept only as JS/`:disabled` hooks).
  const actions = doc.createElement("div");
  actions.className = "cg-actions";
  actions.appendChild(
    makeGuardedButton("Confirm match", "cg-btn cg-btn--filled cg-match-confirm", () =>
      onConfirm().catch((e) => logError("onConfirm", e)),
    ),
  );
  actions.appendChild(
    makeGuardedButton("Not this paper", "cg-btn cg-btn--tinted cg-match-dismiss", () =>
      onDismiss().catch((e) => logError("onDismiss", e)),
    ),
  );
  card.appendChild(actions);

  // Non-destructive escape: open the candidate on OpenAlex to verify before
  // deciding. Only link a well-formed work id.
  const oaMatch = (suggestion.openAlexId || "").match(/W\d+/);
  if (oaMatch) {
    const verify = doc.createElement("a");
    verify.className = "cg-match-verify";
    verify.textContent = "View candidate on OpenAlex \u2197";
    const url = `https://openalex.org/${oaMatch[0]}`;
    verify.setAttribute("href", url);
    verify.addEventListener("click", (e) => {
      e.preventDefault();
      try {
        Zotero.launchURL(url);
      } catch (err) {
        logError("match verify launchURL", err);
      }
    });
    card.appendChild(verify);
  }

  container.appendChild(card);
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

  const isBook = isBookType(item);
  const suppressCount = isBook && data.citedByCount === 0;

  // ── Impact card: hero count + supporting metrics + the two explore actions,
  // in one titled box. ──
  const impact = doc.createElement("div");
  impact.className = "cg-card cg-impact-card";
  const impactTitle = doc.createElement("span");
  impactTitle.className = "cg-eyebrow cg-card-title";
  impactTitle.textContent = "Impact";
  impact.appendChild(impactTitle);

  if (!suppressCount) {
    // ── Hero: the citation count is the single largest element ──
    const hero = doc.createElement("div");
    hero.className = "cg-hero";

    const main = doc.createElement("div");
    main.className = "cg-hero-main";
    const stat = doc.createElement("span");
    stat.className = "cg-hero-stat";
    stat.textContent = data.citedByCount.toLocaleString();
    main.appendChild(stat);
    const label = doc.createElement("span");
    label.className = "cg-hero-label";
    label.textContent = data.citedByCount === 1 ? "citation" : "citations";
    main.appendChild(label);
    hero.appendChild(main);

    // Top-percentile chip — the one evidence accent (amber at Top 1%). The exact
    // percentile lives in the metric line below; the chip is the at-a-glance flag.
    if (data.isTop1Percent || data.isTop10Percent) {
      const chipWrap = doc.createElement("span");
      chipWrap.className = "cg-hero-chip";
      const chip = doc.createElement("span");
      chip.className = data.isTop1Percent ? "cg-chip cg-chip--amber" : "cg-chip";
      chip.textContent = data.isTop1Percent ? "Top 1%" : "Top 10%";
      chipWrap.appendChild(chip);
      hero.appendChild(chipWrap);
    }
    impact.appendChild(hero);

    // ── Supporting-metric line: FWCI · percentile · trend ──
    const line = doc.createElement("div");
    line.className = "cg-metricline";
    let first = true;
    const addSep = (): void => {
      if (first) {
        first = false;
        return;
      }
      const sep = doc.createElement("span");
      sep.className = "cg-metricline-sep";
      sep.textContent = "·";
      line.appendChild(sep);
    };
    if (data.fwci !== null) {
      addSep();
      const strong = doc.createElement("strong");
      strong.textContent = "FWCI ";
      line.appendChild(strong);
      line.appendChild(doc.createTextNode(data.fwci.toFixed(2)));
    }
    if (data.percentile !== null) {
      addSep();
      line.appendChild(doc.createTextNode(`${toOrdinal(Math.round(data.percentile))} percentile`));
    }
    const trend = compactTrend(work);
    if (trend) {
      addSep();
      line.appendChild(doc.createTextNode(trend));
    }
    if (!first) impact.appendChild(line);
  } else {
    const note = doc.createElement("div");
    note.className = "cg-booknote";
    note.textContent = "Citation tracking for books is limited in OpenAlex.";
    impact.appendChild(note);
  }

  // ── Action row: two peer explore buttons (tinted, equal width) ──
  const actions = doc.createElement("div");
  actions.className = "cg-actions";

  const makeActionButton = (
    label: string,
    ariaLabel: string,
    mode: "citing" | "references",
  ): HTMLButtonElement => {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "cg-btn cg-btn--tinted";
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

  actions.appendChild(
    makeActionButton(
      "Citing works \u2192",
      `View ${data.citedByCount.toLocaleString()} works that cite this paper`,
      "citing",
    ),
  );
  actions.appendChild(
    makeActionButton("References \u2192", "View works cited by this paper", "references"),
  );
  impact.appendChild(actions);
  container.appendChild(impact);

  // \u2500\u2500 Authors: async link rows (name, h-index, chevron; tap opens author works) \u2500\u2500
  const authorsRegion = doc.createElement("div");
  authorsRegion.className = "cg-authors";
  container.appendChild(authorsRegion);
  const gen = paneGeneration;
  renderAuthorRows(authorsRegion, item, gen).catch((e) => logError("renderAuthorRows", e));

  Zotero.debug(`[Citegeist] Pane rendered: ${data.citedByCount} citations`);
}

/**
 * Load and render the author link rows into `region`. Author reads are async
 * (no sync mirror, pane-only), so this runs after the synchronous metric render
 * and appends when ready. The whole card is built INSIDE the populated region so
 * an item with no resolved authors shows no empty card. Guarded by
 * `paneGeneration`: an item switch mid-load drops the write.
 */
async function renderAuthorRows(
  region: HTMLElement,
  item: _ZoteroTypes.Item,
  gen: number,
): Promise<void> {
  const doc = region.ownerDocument;
  try {
    const creators = getAuthorCreators(item);
    const itemAuthors = await getItemAuthors(item.libraryID, item.key);
    if (gen !== paneGeneration) return;

    const resolvedIds = [...new Set(itemAuthors.map((r) => r.author_id))];
    const authorRowsData = await Promise.all(resolvedIds.map((id) => getAuthor(id)));
    if (gen !== paneGeneration) return;
    const byId = new Map<string, AuthorRow | null>();
    resolvedIds.forEach((id, i) => byId.set(id, authorRowsData[i]));

    // Link rows only — resolved authors are the ones with a profile to open.
    // Unresolved creators stay in Zotero's own creator list; no dead rows here.
    const vms = buildAuthorRowViewModels(creators, itemAuthors, byId).filter((vm) => vm.authorId);
    if (vms.length === 0) return;

    region.textContent = "";
    const card = doc.createElement("div");
    card.className = "cg-card cg-authors-card";
    const title = doc.createElement("span");
    title.className = "cg-eyebrow cg-card-title";
    title.textContent = "Authors";
    card.appendChild(title);
    const list = doc.createElement("div");
    list.className = "cg-authorlist";
    for (const vm of vms) list.appendChild(authorRow(doc, vm));
    card.appendChild(list);
    region.appendChild(card);
  } catch (e) {
    if (gen !== paneGeneration) return;
    logError("renderAuthorRows", e);
    region.textContent = "";
  }
}

/** One author link row: name (flex), h-index, chevron; tap opens the author-works dialog. */
function authorRow(doc: Document, vm: AuthorRowViewModel): HTMLElement {
  const btn = doc.createElement("button");
  btn.type = "button";
  btn.className = "cg-authorrow";
  btn.setAttribute("aria-label", `View ${vm.name}’s works`);

  const name = doc.createElement("span");
  name.className = "cg-authorrow-name";
  name.textContent = vm.name;
  // Long names ellipsis at the grid's 190px column minimum; the tooltip is the
  // sighted-mouse equivalent of the button's aria-label.
  name.title = vm.name;
  btn.appendChild(name);

  if (vm.hIndexLabel) {
    const h = doc.createElement("span");
    h.className = "cg-authorrow-h";
    h.textContent = vm.hIndexLabel;
    btn.appendChild(h);
  }

  const chev = doc.createElement("span");
  chev.className = "cg-authorrow-chev";
  chev.textContent = "›";
  chev.setAttribute("aria-hidden", "true");
  btn.appendChild(chev);

  const authorId = vm.authorId as string;
  btn.addEventListener("click", () =>
    showAuthorWorks(authorId).catch((e) => logError("showAuthorWorks", e)),
  );
  return btn;
}

export function unregisterCitationPane(): void {
  if (paneRegisteredPluginID) {
    try {
      Zotero.ItemPaneManager.unregisterSection(namespacedPaneKey(paneRegisteredPluginID, PANE_ID));
    } catch (e) {
      logError("unregisterCitationPane", e);
    }
    paneRegisteredPluginID = null;
  }
  paneRegistered = false;
}

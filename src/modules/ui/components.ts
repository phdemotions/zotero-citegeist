/**
 * Canonical Citegeist component primitives — the component-level companion to
 * `tokens.ts`. Mirrors the button/row primitives in
 * `docs/design-system/citegeist-primitives.html` so BOTH UI surfaces (the item
 * pane and the network dialog) compose the SAME components instead of each
 * re-declaring them. Emitted scope-prefixed right after `cgDesignTokens(scope)`,
 * so primitives inherit that surface's `--cg-*` tokens and keep the ID-level
 * specificity the pane needs to beat Zotero's defaults.
 *
 * Layout-free by design: `.cg-btn` styles only the button's own chrome; the
 * full-width-row behavior comes from the container (`.cg-actions > .cg-btn`),
 * so one primitive serves both full-width action rows and compact inline
 * prompts (via `.cg-btn--sm`). Values match the shipped pane buttons so
 * migrating onto the primitive is visually neutral.
 */
export function cgComponents(scope: string): string {
  return `
    /* ── Button primitive (filled / tinted / plain · default / sm) ── */
    ${scope} .cg-btn {
      font-family: inherit;
      font-size: var(--cg-size-subhead);
      font-weight: var(--cg-weight-semibold);
      /* Desktop control height (Zotero-native), not an iOS 44pt tap target. */
      padding: 10px var(--cg-space-3);
      border: 1px solid transparent;
      border-radius: var(--cg-radius-lg);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      -moz-user-select: none;
      user-select: none;
      line-height: 1.4;
      transition: background var(--cg-dur-fast) var(--cg-ease),
        border-color var(--cg-dur-fast) var(--cg-ease),
        color var(--cg-dur-fast) var(--cg-ease),
        transform var(--cg-dur-fast) var(--cg-ease);
    }
    ${scope} .cg-btn:active { transform: scale(var(--cg-press)); }
    ${scope} .cg-btn:focus-visible { outline: 2px solid var(--cg-sage-accent); outline-offset: 2px; }
    ${scope} .cg-btn:disabled { opacity: 0.55; cursor: default; transform: none; }

    /* Filled (primary): fixed deep green + white text — see --cg-primary-bg. */
    ${scope} .cg-btn--filled { background: var(--cg-primary-bg); color: var(--cg-primary-fg); border-color: transparent; }
    ${scope} .cg-btn--filled:hover { background: var(--cg-primary-bg-hover); color: var(--cg-primary-fg); }

    /* Tinted (secondary): sage wash + hairline-sage border. */
    ${scope} .cg-btn--tinted { background: var(--cg-sage-tint-08); color: var(--cg-sage-accent); border-color: var(--cg-sage-tint-35); }
    ${scope} .cg-btn--tinted:hover { background: var(--cg-sage-tint-20); border-color: var(--cg-sage-accent); color: var(--cg-text-primary); }

    /* Plain (tertiary): text button, hairline only. */
    ${scope} .cg-btn--plain { background: transparent; color: var(--cg-text-secondary); border-color: var(--cg-hairline); }
    ${scope} .cg-btn--plain:hover { color: var(--cg-text-primary); background: var(--cg-sage-tint-06); }

    /* Compact size — inline prompts (e.g. the DOI prompt). */
    ${scope} .cg-btn--sm { padding: var(--cg-space-1) var(--cg-space-3); font-size: var(--cg-size-caption); border-radius: var(--cg-radius-md); }

    /* ── Action row: equal-width buttons. ── */
    ${scope} .cg-actions { display: flex; gap: var(--cg-space-2); margin-bottom: var(--cg-space-3); }
    ${scope} .cg-actions > .cg-btn { flex: 1; }

    /* ── Chip / badge primitive (canonical uppercase pill — mirrors the
       gallery). One pill for percentile, Open Access, retracted, in-library,
       etc.; semantic colour comes from the modifier. Layout-free: the row
       container (.cg-result-badges / .cg-metric-badge) owns placement. ── */
    ${scope} .cg-chip {
      display: inline-flex;
      align-items: center;
      gap: var(--cg-space-1);
      font-size: var(--cg-size-caption);
      font-weight: var(--cg-weight-bold);
      letter-spacing: var(--cg-track-caps);
      text-transform: uppercase;
      padding: 2px var(--cg-space-2);
      border-radius: var(--cg-radius-pill);
      background: var(--cg-sage-tint-12);
      color: var(--cg-sage-accent);
      white-space: nowrap;
    }
    ${scope} .cg-chip--amber { background: var(--cg-amber-tint); color: var(--cg-amber-strong); }
    ${scope} .cg-chip--quiet { background: var(--cg-sage-tint-12); color: var(--cg-text-secondary); }
    ${scope} .cg-chip--danger { background: var(--cg-danger-tint); color: var(--cg-danger); }

    /* ── Card surface (bordered, elevated) — mirrors the gallery. Container
       only; the card's inner content keeps its surface-specific layout. ── */
    ${scope} .cg-card {
      border: 1px solid var(--cg-hairline);
      border-radius: var(--cg-radius-lg);
      background: var(--cg-surface-elevated);
      padding: var(--cg-space-3);
    }

    /* ── Banner (inline note / prompt) — sage by default, amber variant. A
       strong child element becomes the banner's block heading. ── */
    ${scope} .cg-banner {
      border: 1px solid var(--cg-hairline);
      border-radius: var(--cg-radius-md);
      background: var(--cg-sage-tint-06);
      color: var(--cg-text-secondary);
      padding: 8px 10px;
      font-size: var(--cg-size-caption);
      line-height: 1.45;
    }
    ${scope} .cg-banner--amber { background: var(--cg-amber-tint); color: var(--cg-amber-strong); border-color: transparent; }
    ${scope} .cg-banner strong { display: block; color: var(--cg-text-primary); font-weight: var(--cg-weight-semibold); margin-bottom: 2px; }

    /* ── Eyebrow (small uppercase section label). ── */
    ${scope} .cg-eyebrow {
      font-size: var(--cg-size-caption2);
      font-weight: var(--cg-weight-bold);
      letter-spacing: var(--cg-track-caps);
      text-transform: uppercase;
      color: var(--cg-text-tertiary);
    }

    @media (prefers-reduced-motion: reduce) {
      ${scope} .cg-btn { transition: none; }
      ${scope} .cg-btn:active { transform: none; }
    }`;
}

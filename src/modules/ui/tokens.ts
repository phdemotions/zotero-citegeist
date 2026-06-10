/**
 * Canonical Citegeist design tokens — the single source of truth for both UI
 * surfaces:
 *   • the embedded item pane  (#citegeist-pane-root)      — inherits Zotero's theme
 *   • the modal network dialog (#citegeist-network-dialog) — owns a slate surface
 *
 * Values mirror the design reference at
 * `docs/design-system/citegeist-primitives.html` verbatim: Apple-HIG metrics
 * (SF type ramp, 4pt spacing, 6/8px control radii, iOS motion) and Zotero
 * standards (theme-driven where embedded, `light-dark()` with hardcoded values,
 * WCAG AA, reduce-motion). Both surfaces emit `cgDesignTokens(scope)` once and
 * then reference `var(--cg-*)` throughout, so a token change here updates the
 * whole plugin.
 *
 * `light-dark()` needs Firefox 128+ (Zotero 9 ships on it) and a `color-scheme`
 * on the surface; both surface roots set one. On older builds the function
 * degrades to its first (light) argument.
 */

export interface CgTokenOptions {
  /**
   * Embedded surfaces (the item pane) inherit Zotero's theme text colors via
   * `--fill-*` so they track the host light/dark theme exactly. Modal surfaces
   * (the network dialog) own the slate text ramp regardless of host theme.
   */
  embedded?: boolean;
}

/**
 * Emit the canonical token block scoped to `scope` (e.g. `"#citegeist-pane-root"`
 * or `"#citegeist-network-dialog"`). Returns a CSS string — concatenate it into
 * the surface's `<style>` / stylesheet before any rule that uses `var(--cg-*)`.
 */
export function cgDesignTokens(scope: string, opts: CgTokenOptions = {}): string {
  // Text + surface ramp. Embedded inherits Zotero's theme; modal owns slate.
  const textAndSurface = opts.embedded
    ? `
      /* Text inherits Zotero's theme so the pane tracks the host light/dark
         theme automatically. Tertiary falls back to a slate value on the rare
         build without --fill-tertiary. */
      --cg-text-primary: var(--fill-primary);
      --cg-text-secondary: var(--fill-secondary);
      --cg-text-tertiary: var(--fill-tertiary, light-dark(#63726A, #8A9A92));
      --cg-surface: transparent;
      --cg-surface-elevated: light-dark(#FFFFFF, #222E28);
      --cg-surface-sunken: light-dark(#F1F5F3, #1B2520);`
    : `
      /* Modal owns the slate palette regardless of host theme. */
      --cg-text-primary: light-dark(#1A2820, #E7EEE9);
      --cg-text-secondary: light-dark(#46554C, #9CAAA3);
      --cg-text-tertiary: light-dark(#63726A, #8A9A92);
      --cg-surface: light-dark(#F8FAF9, #141D18);
      --cg-surface-elevated: light-dark(#FFFFFF, #1E2A24);
      --cg-surface-sunken: light-dark(#EFF3F1, #1A2520);`;

  return `
    ${scope} {
      /* ── Spacing (4pt rhythm, HIG) ── */
      --cg-space-1: 4px;
      --cg-space-2: 8px;
      --cg-space-3: 12px;
      --cg-space-4: 16px;
      --cg-space-5: 20px;
      --cg-space-6: 24px;

      /* ── Radius (HIG: control 6, card 8, pill) ── */
      --cg-radius-sm: 4px;
      --cg-radius-md: 6px;
      --cg-radius-lg: 8px;
      --cg-radius-xl: 12px;
      --cg-radius-pill: 999px;

      /* ── Type ramp (SF / HIG sizes; tabular for metrics) ── */
      --cg-font: 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;
      --cg-size-caption2: 10px;
      --cg-size-caption: 11px;
      --cg-size-footnote: 12px;
      --cg-size-subhead: 13px;
      --cg-size-body: 14px;
      --cg-size-title3: 18px;
      --cg-size-stat: 22px;
      --cg-size-display: 28px;
      --cg-weight-regular: 400;
      --cg-weight-medium: 510;
      --cg-weight-semibold: 590;
      --cg-weight-bold: 680;
      --cg-track-tight: -0.01em;
      --cg-track-caps: 0.06em;

      /* ── Motion (HIG standard ease; instant focus) ── */
      --cg-ease: cubic-bezier(0.32, 0.72, 0, 1);
      --cg-dur-fast: 120ms;
      --cg-dur: 200ms;
      --cg-press: 0.97;

      /* ── Elevation ── */
      --cg-shadow-modal: 0 16px 40px rgba(20, 29, 24, 0.28), 0 0 1px rgba(20, 29, 24, 0.2);
      /* Raised pill (segmented selection). Scheme-agnostic: light-dark() is not
         valid inside box-shadow, so one neutral value — a soft dark drop (depth
         on light, invisible on dark) plus a faint top highlight (edge on dark,
         invisible on light). */
      --cg-lift: 0 1px 2px rgba(15, 28, 22, 0.16), inset 0 0.5px 0 rgba(255, 255, 255, 0.07);

      /* ── Accent: sage (one accent; amber = evidence weight only) ── */
      --cg-sage-accent: light-dark(#2F6B5A, #8FAD9F);
      --cg-sage-accent-strong: light-dark(#214A3F, #B6C9BD);
      /* Foreground on a filled sage surface: white on the dark-green light
         accent, dark slate on the pale dark-mode accent (WCAG AA both ways). */
      --cg-on-accent: light-dark(#FFFFFF, #11201A);

      /* Sage tint scale — used for tinted fills, hovers, borders. Defined for
         BOTH schemes (light: deep sage at low alpha; dark: pale sage at low
         alpha, per the gallery). NOTE: a prior dialog build set the dark arm to
         a self-referential var(), which is invalid-at-computed-value-time and
         silently collapsed every dark-mode tint to transparent — this scale is
         the fix. */
      --cg-sage-tint-04: light-dark(rgba(47, 107, 90, 0.04), rgba(143, 173, 159, 0.06));
      --cg-sage-tint-06: light-dark(rgba(47, 107, 90, 0.06), rgba(143, 173, 159, 0.08));
      --cg-sage-tint-08: light-dark(rgba(47, 107, 90, 0.08), rgba(143, 173, 159, 0.10));
      --cg-sage-tint-10: light-dark(rgba(47, 107, 90, 0.10), rgba(143, 173, 159, 0.12));
      --cg-sage-tint-12: light-dark(rgba(47, 107, 90, 0.12), rgba(143, 173, 159, 0.14));
      --cg-sage-tint-15: light-dark(rgba(47, 107, 90, 0.15), rgba(143, 173, 159, 0.17));
      --cg-sage-tint-16: light-dark(rgba(47, 107, 90, 0.16), rgba(143, 173, 159, 0.18));
      --cg-sage-tint-20: light-dark(rgba(47, 107, 90, 0.20), rgba(143, 173, 159, 0.22));
      --cg-sage-tint-22: light-dark(rgba(47, 107, 90, 0.22), rgba(143, 173, 159, 0.24));
      --cg-sage-tint-25: light-dark(rgba(47, 107, 90, 0.25), rgba(143, 173, 159, 0.27));
      --cg-sage-tint-35: light-dark(rgba(47, 107, 90, 0.35), rgba(143, 173, 159, 0.35));

      /* Hairline border (cards, rows, plain buttons) — mirrors the gallery. */
      --cg-hairline: light-dark(rgba(60, 110, 95, 0.12), rgba(143, 173, 159, 0.12));

      /* Fixed-green primary button — theme-AGNOSTIC on purpose: a pale-sage
         accent on white would be illegible in dark mode, so the filled button
         uses this deep green (white text) in BOTH schemes. Shared by the pane
         and dialog primary buttons so the one green lives in one place. */
      --cg-primary-bg: #2F6B5A;
      --cg-primary-bg-hover: #245546;
      --cg-primary-fg: #FFFFFF;

      /* ── Amber: evidence weight only (top-percentile, suggestion banner) ── */
      --cg-amber: light-dark(#8B5A1A, #D4A84B);
      --cg-amber-strong: light-dark(#6F4715, #E0B458);
      --cg-amber-tint: light-dark(rgba(168, 101, 26, 0.10), rgba(180, 130, 40, 0.15));
      --cg-amber-border: light-dark(rgba(168, 101, 26, 0.30), rgba(180, 130, 40, 0.35));

      /* ── Danger: destructive / retracted ── */
      --cg-danger: light-dark(#C44030, #FF453A);
      --cg-danger-strong: light-dark(#A43020, #FF6961);
      --cg-danger-tint: light-dark(rgba(196, 64, 48, 0.10), rgba(255, 69, 58, 0.12));
      --cg-danger-tint-strong: light-dark(rgba(196, 64, 48, 0.18), rgba(255, 69, 58, 0.22));

      /* ── Success: "added to library" / undo affordance. Dark arms preserve
         the prior frozen #4A7D6B / rgba(74,125,107,…); light arms add the
         proper deep-sage so light mode no longer shows the dark-arm green. ── */
      --cg-success: light-dark(#2F6B5A, #4A7D6B);
      --cg-success-tint: light-dark(rgba(47, 107, 90, 0.12), rgba(74, 125, 107, 0.12));
      --cg-success-tint-strong: light-dark(rgba(47, 107, 90, 0.20), rgba(74, 125, 107, 0.20));
      --cg-success-border: light-dark(rgba(47, 107, 90, 0.30), rgba(74, 125, 107, 0.30));

      /* ── Focus ring (instant, never animated) ── */
      --cg-focus-ring: var(--cg-sage-accent);
      --cg-focus: 0 0 0 2px var(--cg-surface), 0 0 0 4px var(--cg-sage-accent);
${textAndSurface}
    }`;
}

/**
 * CSS styles for the Citation Network dialog.
 *
 * Design language: Opus Vita family — Citegeist · Sententia · Marginalia.
 * Slate (dark) palette variant:
 *   Ink ramp  — green-undertoned near-black neutrals
 *   Sage ramp — primary accent (#8FAD9F on dark, #2F6B5A on light, replaces blue throughout)
 *   Amber     — evidence weight only (not used in this dialog)
 * Typography: Inter for UI labels; system serif fallback for editorial elements.
 *
 * Design tokens come from the canonical layer in `src/modules/ui/tokens.ts`
 * (mirrors `docs/design-system/citegeist-primitives.html`). This file emits
 * those tokens scoped to the dialog, then keeps a thin compat-alias block so
 * the existing component CSS (which references the dialog's legacy token names)
 * needs no churn.
 */

import { cgDesignTokens } from "../ui/tokens";
import { cgComponents } from "../ui/components";

export function getDialogCSS(): string {
  return `
    ${cgDesignTokens("#citegeist-network-dialog")}
    ${cgComponents("#citegeist-network-dialog")}

    /* ── Dialog root: Slate palette — green-undertoned ── */
    /* Legacy dialog token names mapped onto the canonical layer. Quaternary
       text + hover text are dialog-only extra ramp steps, kept local. The
       sage-tint scale, accent, red/danger, focus ring, and base surfaces all
       now resolve from cgDesignTokens() above — which also fixes the prior
       dark-mode bug where every --cg-sage-tint-* dark arm was a self-reference
       (invalid at computed value time → tints silently went transparent). */
    #citegeist-network-dialog {
      --cg-bg-primary: var(--cg-surface);
      --cg-bg-secondary: var(--cg-surface-sunken);
      --cg-bg-elevated: var(--cg-surface-elevated);
      --cg-text-quaternary: light-dark(#8A998F, #586860);
      --cg-text-hover: light-dark(#28362E, #BFCBC5);
      --cg-sage-accent-tint-12: var(--cg-sage-tint-12);
      --cg-sage-accent-tint-25: var(--cg-sage-tint-25);
      --cg-red-fg: var(--cg-danger);
      --cg-red-fg-hover: var(--cg-danger-strong);
      --cg-red-bg: var(--cg-danger-tint);
      --cg-red-bg-hover: var(--cg-danger-tint-strong);

      background-color: var(--cg-bg-primary);
      color: var(--cg-text-primary);
      font-family: var(--cg-font);
      font-feature-settings: 'kern' 1, 'liga' 1;
    }
    #citegeist-network-dialog * { box-sizing: border-box; }

    /* ── Chrome (close bar) ── */
    .cg-dialog-chrome {
      display: flex; align-items: center;
      padding: 5px 14px;
      background: var(--cg-sage-tint-04);
      border-bottom: 1px solid var(--cg-sage-tint-08);
      flex-shrink: 0;
    }
    .cg-close-btn {
      width: 22px; height: 22px; border-radius: 6px;
      border: none; background: var(--cg-red-bg); color: var(--cg-red-fg);
      font-size: 14px; line-height: 1; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; padding: 0;
      transition: background 0.12s, color 0.12s;
    }
    .cg-close-btn:hover { background: var(--cg-red-bg-hover); color: var(--cg-red-fg-hover); }
    .cg-close-btn:focus-visible { outline: 2px solid var(--cg-sage-accent); outline-offset: 1px; }

    /* ── Top band: source title, metadata, cited-by stat ── */
    .cg-dialog-top {
      display: grid; grid-template-columns: minmax(0, 1fr) auto;
      align-items: center; gap: 14px;
      padding: 13px 14px 11px;
      border-bottom: 1px solid var(--cg-sage-tint-12);
      flex-shrink: 0;
    }
    .cg-header-text { min-width: 0; }
    .cg-dialog-eyebrow {
      font-size: 11px; font-weight: 600; color: var(--cg-text-tertiary);
      text-transform: uppercase; letter-spacing: 0.06em;
      font-family: var(--cg-font);
    }
    .cg-dialog-title {
      font-size: 13px; font-weight: 650; color: var(--cg-text-primary);
      margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      font-family: var(--cg-font);
    }
    .cg-source-authors {
      font-size: 11px; color: var(--cg-text-tertiary); margin-top: 3px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      font-family: var(--cg-font);
    }
    .cg-count-stack { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
    .cg-stat {
      min-width: 72px; text-align: right;
      border: 1px solid var(--cg-sage-tint-15);
      border-radius: 7px; padding: 6px 9px;
      background: var(--cg-sage-tint-06);
    }
    .cg-stat-value {
      display: block; font-size: 14px; line-height: 1; color: var(--cg-text-primary);
      font-variant-numeric: tabular-nums;
    }
    .cg-stat-label { font-size: 10px; color: var(--cg-text-tertiary); }

    /* ── Command bar: mode + search + filter + sort ── */
    .cg-command-bar {
      display: grid; grid-template-columns: auto minmax(160px, 1fr) auto;
      align-items: center; gap: 8px;
      padding: 9px 14px;
      background: var(--cg-sage-tint-04);
      border-bottom: 1px solid var(--cg-sage-tint-10);
      flex-shrink: 0;
    }
    .cg-tabs-inner {
      display: flex; gap: 1px;
      background: var(--cg-sage-tint-08);
      border-radius: 7px; padding: 2px;
    }
    .cg-tab {
      padding: 7px 14px; font-size: 11px; font-weight: 600; min-height: 28px;
      cursor: pointer; border: none; background: transparent;
      color: var(--cg-text-secondary); border-radius: 5px;
      transition: background 0.15s, color 0.15s;
      font-family: var(--cg-font);
    }
    .cg-tab.active { background: var(--cg-sage-tint-16); color: var(--cg-text-primary); }
    .cg-tab:hover:not(.active) { color: var(--cg-text-hover); }
    .cg-tab:focus-visible { outline: 2px solid var(--cg-sage-accent); outline-offset: 1px; }
    .cg-search-wrap { position: relative; min-width: 0; }
    .cg-search-icon {
      position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
      color: var(--cg-text-quaternary); font-size: 12px; pointer-events: none;
    }
    .cg-search-input {
      width: 100%; padding: 7px 10px 7px 30px;
      border: 1px solid var(--cg-sage-tint-15);
      border-radius: 7px; font-size: 12px;
      background: var(--cg-sage-tint-06); color: var(--cg-text-primary); outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
      font-family: var(--cg-font);
    }
    .cg-search-input:focus {
      border-color: var(--cg-sage-tint-35);
      box-shadow: 0 0 0 3px var(--cg-sage-accent-tint-12);
      background: var(--cg-sage-tint-08);
    }
    .cg-search-input::placeholder { color: var(--cg-text-quaternary); }
    .cg-control-cluster { display: flex; align-items: center; gap: 6px; }
    .cg-hide-in-library {
      display: inline-flex; align-items: center; gap: 7px;
      min-height: 32px; padding: 7px 9px;
      border: 1px solid var(--cg-sage-tint-15); border-radius: 7px;
      background: var(--cg-sage-tint-06); color: var(--cg-text-secondary);
      font-size: 11px; font-weight: 600; cursor: pointer; white-space: nowrap;
      transition: background 0.12s, color 0.12s, border-color 0.12s;
      font-family: var(--cg-font);
    }
    .cg-hide-in-library:hover { color: var(--cg-text-hover); }
    .cg-hide-in-library:focus-visible { outline: 2px solid var(--cg-sage-accent); outline-offset: 1px; }
    .cg-hide-in-library.cg-switch-on {
      color: var(--cg-text-primary); border-color: var(--cg-sage-tint-35);
      background: var(--cg-sage-tint-16);
    }
    .cg-switch {
      position: relative; width: 25px; height: 14px; border-radius: 999px;
      background: var(--cg-sage-tint-22); flex-shrink: 0;
      transition: background 0.12s;
    }
    .cg-switch::after {
      content: ""; position: absolute; top: 2px; left: 2px;
      width: 10px; height: 10px; border-radius: 50%;
      background: var(--cg-text-quaternary); transition: transform 0.12s, background 0.12s;
    }
    .cg-hide-in-library.cg-switch-on .cg-switch { background: var(--cg-sage-accent-tint-25); }
    .cg-hide-in-library.cg-switch-on .cg-switch::after {
      transform: translateX(11px); background: var(--cg-sage-accent);
    }
    .cg-sort-label {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 11px; color: var(--cg-text-tertiary); white-space: nowrap;
      font-family: var(--cg-font);
    }
    .cg-sort-select {
      padding: 6px 8px; border: 1px solid var(--cg-sage-tint-15);
      border-radius: 7px; font-size: 11px;
      background: var(--cg-sage-tint-06); color: var(--cg-text-hover); cursor: pointer;
      font-family: var(--cg-font);
    }
    .cg-sort-select:focus-visible { outline: 2px solid var(--cg-sage-accent); outline-offset: 1px; }
    @media (max-width: 600px) {
      .cg-dialog-top, .cg-command-bar { grid-template-columns: 1fr; }
      .cg-count-stack, .cg-control-cluster, .cg-tabs-inner { width: 100%; }
    }

    /* ── Results body ── */
    .cg-dialog-body { flex: 1; overflow-y: auto; padding: 0; min-height: 300px; }
    .cg-results-list { list-style: none; margin: 0; padding: 0; }

    /* ── Result items ── */
    .cg-result-item {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 13px 14px;
      border-bottom: 1px solid var(--cg-sage-tint-12);
      cursor: pointer;
      transition: background 0.1s;
    }
    .cg-result-item:hover { background: var(--cg-sage-tint-08); }
    .cg-result-content { flex: 1; min-width: 0; }
    .cg-result-title {
      font-size: 13px; font-weight: 500; line-height: 1.4;
      margin-bottom: 3px; color: var(--cg-text-primary);
      font-family: var(--cg-font);
    }
    .cg-result-title a {
      color: var(--cg-text-primary); text-decoration: none;
      transition: color 0.1s;
    }
    .cg-result-title a:hover { color: var(--cg-sage-accent-strong); text-decoration: underline; }
    .cg-result-title a:focus-visible {
      outline: 2px solid var(--cg-sage-accent); outline-offset: 1px; border-radius: 2px;
    }
    .cg-result-title .cg-no-link {
      color: var(--cg-text-secondary); cursor: default;
    }
    .cg-result-meta {
      font-size: 11px; color: var(--cg-text-secondary); line-height: 1.4;
      font-family: var(--cg-font);
    }
    .cg-result-meta-authors {
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .cg-result-meta-venue { color: var(--cg-text-tertiary); margin-top: 1px; }
    .cg-result-year { color: var(--cg-text-secondary); font-weight: 500; }
    .cg-result-badges {
      display: flex; gap: 5px; margin-top: 5px; flex-wrap: wrap; align-items: center;
    }
    .cg-result-badge {
      font-size: 10px; padding: 1px 7px; border-radius: 4px;
      font-weight: 600; letter-spacing: 0.1px;
      font-family: var(--cg-font);
    }
    .cg-badge-oa { background: var(--cg-sage-accent-tint-12); color: var(--cg-sage-accent); }
    .cg-badge-retracted { background: var(--cg-red-bg); color: var(--cg-red-fg); }
    .cg-badge-in-library { background: var(--cg-sage-accent-tint-12); color: var(--cg-sage-accent); }
    .cg-badge-no-doi { background: var(--cg-sage-tint-06); color: var(--cg-text-tertiary); }

    /* ── Right column: count + action ── */
    .cg-result-right {
      flex-shrink: 0; display: flex; flex-direction: column;
      align-items: flex-end; gap: 6px; min-width: 130px;
    }
    .cg-result-count {
      font-size: 15px; font-weight: 700;
      font-variant-numeric: tabular-nums; letter-spacing: -0.3px;
      font-feature-settings: 'kern' 1, 'tnum' 1;
      font-family: var(--cg-font);
    }
    .cg-count-high { color: var(--cg-sage-accent); font-weight: 800; }
    .cg-count-medium { color: var(--cg-text-primary); }
    .cg-count-low { color: var(--cg-text-secondary); }

    /* ── Split button ── */
    .cg-split-btn {
      display: inline-flex; align-items: stretch;
      border-radius: 7px;
      border: 1px solid var(--cg-sage-accent-tint-25);
      font-size: 11px; font-weight: 500;
      transition: border-color 0.12s;
      font-family: var(--cg-font);
    }
    .cg-split-btn > .cg-split-main:first-child { border-radius: 6px 0 0 6px; }
    .cg-split-btn > .cg-split-arrow:last-of-type { border-radius: 0 6px 6px 0; }
    .cg-split-btn:hover { border-color: var(--cg-sage-tint-35); }
    .cg-split-main {
      padding: 5px 11px; background: var(--cg-sage-tint-12); color: var(--cg-sage-accent);
      border: none; cursor: pointer; min-height: 26px;
      white-space: nowrap; max-width: 180px;
      overflow: hidden; text-overflow: ellipsis;
      transition: background 0.12s;
    }
    .cg-split-main:hover { background: var(--cg-sage-tint-20); }
    .cg-split-main:focus-visible { outline: 2px solid var(--cg-sage-accent); outline-offset: -2px; }
    .cg-split-arrow {
      padding: 5px 7px; background: var(--cg-sage-tint-10); color: var(--cg-sage-accent);
      border: none; border-left: 1px solid var(--cg-sage-tint-22);
      cursor: pointer; font-size: 9px; min-height: 26px;
      display: flex; align-items: center;
      transition: background 0.12s;
    }
    .cg-split-arrow:hover { background: var(--cg-sage-tint-20); }
    .cg-split-arrow:focus-visible { outline: 2px solid var(--cg-sage-accent); outline-offset: -2px; }

    /* Added state */
    .cg-split-btn.cg-state-added { border-color: var(--cg-success-border); }
    .cg-split-btn.cg-state-added .cg-split-main {
      background: var(--cg-success-tint); color: var(--cg-success);
    }
    .cg-split-btn.cg-state-added .cg-split-main:hover {
      background: var(--cg-success-tint-strong);
    }

    /* File state (in library) */
    .cg-split-btn.cg-state-file { border-color: var(--cg-sage-tint-15); }
    .cg-split-btn.cg-state-file .cg-split-main {
      background: var(--cg-sage-tint-06); color: var(--cg-text-secondary);
    }
    .cg-split-btn.cg-state-file .cg-split-main:hover {
      background: var(--cg-sage-tint-10); color: var(--cg-text-hover);
    }
    .cg-split-btn.cg-state-file .cg-split-arrow {
      background: var(--cg-sage-tint-04); color: var(--cg-text-tertiary);
      border-left-color: var(--cg-sage-tint-10);
    }
    .cg-split-btn.cg-state-file .cg-split-arrow:hover {
      background: var(--cg-sage-tint-10); color: var(--cg-text-secondary);
    }

    /* Adding spinner */
    .cg-spinner {
      display: inline-block; width: 12px; height: 12px;
      border: 2px solid var(--cg-sage-tint-20);
      border-top-color: var(--cg-sage-accent); border-radius: 50%;
      animation: cg-spin 0.6s linear infinite;
      vertical-align: middle;
    }
    @keyframes cg-spin { to { transform: rotate(360deg); } }

    /* ── Expanded detail area ── */
    .cg-result-expanded {
      padding: 8px 14px 12px 14px;
      border-bottom: 1px solid var(--cg-sage-tint-08);
      background: rgba(56,104,87,0.03);
      animation: cg-expand-in 0.15s ease-out;
    }
    @keyframes cg-expand-in {
      from { opacity: 0; } to { opacity: 1; }
    }
    .cg-abstract-text {
      font-size: 12px; line-height: 1.55; color: var(--cg-text-secondary);
      display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical;
      overflow: hidden;
      font-family: var(--cg-font);
    }
    .cg-abstract-loading {
      font-size: 12px; color: var(--cg-text-tertiary); font-style: italic;
      font-family: var(--cg-font);
    }
    .cg-abstract-none {
      font-size: 12px; color: var(--cg-text-quaternary); font-style: italic;
      font-family: var(--cg-font);
    }

    /* ── Expand affordance ── */
    .cg-expand-hint {
      font-size: 10px; color: var(--cg-text-quaternary);
      margin-top: 4px; cursor: pointer;
      transition: color 0.12s;
      font-family: var(--cg-font);
    }
    .cg-result-item:hover .cg-expand-hint { color: var(--cg-text-secondary); }
    .cg-expand-chevron {
      display: inline-block; transition: transform 0.15s ease;
      font-size: 9px; margin-right: 3px;
    }
    .cg-result-item[aria-expanded="true"] .cg-expand-chevron {
      transform: rotate(90deg);
    }

    /* ── Undo countdown bar ── */
    .cg-undo-bar {
      position: absolute; bottom: 0; left: 0; height: 2px;
      background: var(--cg-success); border-radius: 0 0 6px 6px;
      animation: cg-undo-shrink 8s linear forwards;
    }
    @keyframes cg-undo-shrink { from { width: 100%; } to { width: 0; } }

    /* ── Result item focus (keyboard nav) ── */
    .cg-result-item:focus-visible {
      outline: 2px solid var(--cg-sage-accent); outline-offset: -2px;
      background: rgba(143,173,159,0.06);
    }
    .cg-result-item:focus { outline: none; }

    /* While a load is in flight, dim inactive tabs so the user can see
       their click was ignored. Active tab stays full opacity so the user
       knows where focus is. (F11) */
    #citegeist-network-dialog.cg-is-loading .cg-tab:not(.active) {
      opacity: 0.45;
      cursor: progress;
    }

    /* Inline error banner shown under a row when Add fails (read-only
       library, network drop, validation throw). Auto-dismisses in 5s. */
    .cg-row-error {
      margin-top: 6px; padding: 6px 10px; border-radius: var(--cg-radius-md);
      background: var(--cg-danger-tint);
      color: var(--cg-danger); font-size: 12px; line-height: 1.4;
      border: 1px solid var(--cg-danger-tint-strong);
      role: alert;
    }

    /* ── Skeleton loading ── */
    .cg-skeleton-row {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 12px 14px; border-bottom: 1px solid var(--cg-sage-tint-08);
    }
    .cg-skeleton-bar {
      height: 12px; border-radius: 4px;
      background: var(--cg-sage-tint-10);
      animation: cg-pulse 1.5s ease-in-out infinite;
    }
    @keyframes cg-pulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 0.8; }
    }
    .cg-skeleton-content { flex: 1; }
    .cg-skeleton-title { width: 70%; height: 14px; margin-bottom: 8px; }
    .cg-skeleton-meta { width: 50%; height: 10px; margin-bottom: 4px; }
    .cg-skeleton-meta2 { width: 35%; height: 10px; }
    .cg-skeleton-right { width: 40px; height: 20px; flex-shrink: 0; }

    /* ── Per-item collection picker (dropdown) ── */
    .cg-item-picker {
      position: absolute; right: 0; top: calc(100% + 4px);
      width: 270px; max-height: 300px;
      display: flex; flex-direction: column;
      background: var(--cg-surface-elevated); border: 1px solid var(--cg-sage-tint-20);
      border-radius: 10px;
      box-shadow: 0 12px 40px rgba(14,22,18,0.6);
      z-index: 20;
      animation: cg-picker-in 0.12s ease-out;
    }
    @keyframes cg-picker-in {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .cg-item-picker[hidden] { display: none; }
    .cg-picker-list {
      flex: 1; overflow-y: auto; padding: 4px 0;
      min-height: 0;
    }
    .cg-picker-option {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 12px; font-size: 12px; color: var(--cg-text-hover);
      cursor: pointer; border: none; background: transparent;
      width: 100%; text-align: left;
      transition: background 0.1s;
      font-family: var(--cg-font);
    }
    .cg-picker-option:hover { background: var(--cg-sage-tint-08); }
    .cg-picker-option:focus-visible { outline: 2px solid var(--cg-sage-accent); outline-offset: -2px; }
    .cg-picker-option[hidden] { display: none; }
    .cg-picker-check {
      width: 14px; height: 14px; flex-shrink: 0;
      border: 1.5px solid var(--cg-sage-tint-25); border-radius: 3px;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; color: transparent;
    }
    .cg-picker-option.checked .cg-picker-check {
      background: var(--cg-sage-accent); border-color: var(--cg-sage-accent); color: #1A241E;
    }
    .cg-picker-chevron {
      width: 14px; height: 14px; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 9px; color: var(--cg-text-tertiary);
      transition: transform 0.15s ease;
      cursor: pointer;
      margin-left: -4px;
    }
    .cg-picker-chevron.expanded { transform: rotate(90deg); }
    .cg-picker-label {
      flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .cg-picker-separator {
      height: 1px; background: var(--cg-sage-tint-10); margin: 4px 12px;
    }
    .cg-picker-actions {
      display: flex; justify-content: flex-end; padding: 6px 12px;
      border-top: 1px solid var(--cg-sage-tint-10);
      flex-shrink: 0;
      background: var(--cg-surface-elevated);
      border-radius: 0 0 10px 10px;
    }
    .cg-picker-done {
      padding: 5px 16px; border-radius: 6px; font-size: 11px; font-weight: 600;
      background: #2F6B5A; color: #FFFFFF; border: none; cursor: pointer;
      transition: background 0.12s;
      font-family: var(--cg-font);
    }
    .cg-picker-done:hover { background: #245546; }
    .cg-picker-done:focus-visible { outline: 2px solid var(--cg-sage-accent); outline-offset: 2px; }

    /* ── Footer ── */
    .cg-dialog-footer {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px;
      border-top: 1px solid var(--cg-sage-tint-12);
      flex-shrink: 0;
      background: rgba(56,104,87,0.03);
    }
    .cg-footer-info {
      font-size: 11px; color: var(--cg-text-tertiary);
      font-family: var(--cg-font);
    }
    .cg-footer-right {
      display: flex; align-items: center; gap: 8px;
    }
    .cg-footer-label {
      font-size: 11px; color: var(--cg-text-tertiary);
      font-family: var(--cg-font);
    }
    .cg-default-chip {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 5px 10px; border-radius: 7px; font-size: 11px; font-weight: 500;
      background: var(--cg-sage-tint-08); color: var(--cg-text-hover);
      border: 1px solid var(--cg-sage-tint-15);
      cursor: pointer; white-space: nowrap; max-width: 200px;
      transition: background 0.12s;
      font-family: var(--cg-font);
    }
    .cg-default-chip:hover { background: var(--cg-sage-tint-12); }
    .cg-default-chip:focus-visible { outline: 2px solid var(--cg-sage-accent); outline-offset: 1px; }
    .cg-default-chip-label {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .cg-default-chip-extra { color: var(--cg-sage-accent); font-weight: 600; flex-shrink: 0; }
    .cg-default-dropdown {
      position: absolute; bottom: calc(100% + 6px); right: 0;
      width: 270px; max-height: 300px;
      display: flex; flex-direction: column;
      background: var(--cg-surface-elevated); border: 1px solid var(--cg-sage-tint-20);
      border-radius: 10px;
      box-shadow: 0 12px 40px rgba(14,22,18,0.6);
      z-index: 20;
      animation: cg-picker-in 0.12s ease-out;
    }
    .cg-default-dropdown[hidden] { display: none; }

    /* ── States ── */
    .cg-loading-more {
      text-align: center; padding: 20px; font-size: 12px; color: var(--cg-text-quaternary);
      font-family: var(--cg-font);
    }
    .cg-empty {
      text-align: center; padding: 48px 24px;
      color: var(--cg-text-tertiary); font-size: 13px; line-height: 1.5;
      font-family: var(--cg-font);
    }
    .cg-empty-title {
      font-size: 14px; font-weight: 600; color: var(--cg-text-secondary); margin-bottom: 4px;
    }
    .cg-cap-notice {
      text-align: center; padding: 8px 14px; font-size: 11px;
      color: var(--cg-text-quaternary); background: rgba(56,104,87,0.03);
      border-top: 1px solid var(--cg-sage-tint-06);
      font-family: var(--cg-font);
    }

    /* Respect the user's OS-level Reduce Motion preference. Collapses
       infinite spinners + entrance animations to near-zero. NOTE we
       intentionally do NOT include .cg-undo-bar — its 8s linear
       horizontal width shrink is the ONLY visual indicator of how much
       time remains before the Undo affordance expires, and a smooth
       horizontal-width transition is generally considered vestibular-
       safe (no rotation, scaling, parallax, or perspective). Removing
       it would leave reduced-motion users with no time cue, which
       violates the same accessibility goal the override is supposed
       to honor. (ADV-U4, Iter W refinement) */
    @media (prefers-reduced-motion: reduce) {
      .cg-spinner,
      .cg-result-expanded,
      .cg-skeleton-bar,
      .cg-item-picker,
      .cg-default-dropdown {
        animation-duration: 0.001ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.001ms !important;
      }
    }
  `;
}

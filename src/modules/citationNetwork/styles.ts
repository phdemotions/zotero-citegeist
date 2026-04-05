/**
 * CSS styles for the Citation Network dialog.
 */

export function getDialogCSS(): string {
  return `
    #citegeist-network-dialog * { box-sizing: border-box; }

    /* ── Header ── */
    .cg-dialog-header {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid rgba(128,128,128,0.08);
      flex-shrink: 0;
    }
    .cg-close-btn {
      width: 24px; height: 24px; border-radius: 6px;
      border: none; background: rgba(255,69,58,0.12); color: #ff453a;
      font-size: 15px; line-height: 1; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; padding: 0;
      transition: background 0.12s, color 0.12s;
    }
    .cg-close-btn:hover { background: rgba(255,69,58,0.22); color: #ff6961; }
    .cg-close-btn:focus-visible { outline: 2px solid #5a9cff; outline-offset: 1px; }
    .cg-header-text { flex: 1; min-width: 0; }
    .cg-dialog-title {
      font-size: 11px; font-weight: 500; color: var(--fill-secondary, #8e8e93);
      letter-spacing: 0.2px; text-transform: uppercase;
    }
    .cg-dialog-subtitle {
      font-size: 13px; font-weight: 600; color: var(--fill-primary, #e8e8ed);
      margin-top: 1px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    /* ── Tabs ── */
    .cg-dialog-tabs {
      display: flex; gap: 1px; padding: 8px 14px;
      flex-shrink: 0;
      background: rgba(128,128,128,0.02);
      border-bottom: 1px solid rgba(128,128,128,0.06);
    }
    .cg-tabs-inner {
      display: flex; gap: 1px;
      background: rgba(128,128,128,0.06);
      border-radius: 7px; padding: 2px;
    }
    .cg-tab {
      padding: 5px 16px; font-size: 11px; font-weight: 500;
      cursor: pointer; border: none; background: transparent;
      color: var(--fill-secondary, #8e8e93); border-radius: 5px;
      transition: background 0.15s, color 0.15s;
    }
    .cg-tab.active { background: rgba(128,128,128,0.1); color: var(--fill-primary, #e8e8ed); font-weight: 600; }
    .cg-tab:hover:not(.active) { color: var(--fill-secondary, #c8c8cd); }
    .cg-tab:focus-visible { outline: 2px solid #5a9cff; outline-offset: 1px; }

    /* ── Toolbar ── */
    .cg-dialog-toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 14px;
      border-bottom: 1px solid rgba(128,128,128,0.06);
      flex-shrink: 0;
    }
    .cg-search-wrap { flex: 1; position: relative; }
    .cg-search-icon {
      position: absolute; left: 8px; top: 50%; transform: translateY(-50%);
      color: var(--fill-quaternary, #48484a); font-size: 12px; pointer-events: none;
    }
    .cg-search-input {
      width: 100%; padding: 6px 10px 6px 28px;
      border: 1px solid rgba(128,128,128,0.1);
      border-radius: 7px; font-size: 12px;
      background: rgba(128,128,128,0.04); color: var(--fill-primary, #e8e8ed); outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .cg-search-input:focus {
      border-color: rgba(90,156,255,0.5);
      box-shadow: 0 0 0 3px rgba(90,156,255,0.12);
      background: rgba(128,128,128,0.06);
    }
    .cg-search-input::placeholder { color: var(--fill-quaternary, #48484a); }
    .cg-sort-select {
      padding: 6px 8px; border: 1px solid rgba(128,128,128,0.1);
      border-radius: 7px; font-size: 11px;
      background: rgba(128,128,128,0.04); color: var(--fill-secondary, #c8c8cd); cursor: pointer;
    }
    .cg-sort-select:focus-visible { outline: 2px solid #5a9cff; outline-offset: 1px; }

    /* ── Results body ── */
    .cg-dialog-body { flex: 1; overflow-y: auto; padding: 0; min-height: 300px; }
    .cg-results-list { list-style: none; margin: 0; padding: 0; }

    /* ── Result items ── */
    .cg-result-item {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid rgba(128,128,128,0.04);
      cursor: pointer;
      transition: background 0.1s;
    }
    .cg-result-item:hover { background: rgba(128,128,128,0.025); }
    .cg-result-content { flex: 1; min-width: 0; }
    .cg-result-title {
      font-size: 13px; font-weight: 500; line-height: 1.4;
      margin-bottom: 3px; color: var(--fill-primary, #e8e8ed);
    }
    .cg-result-title a {
      color: var(--fill-primary, #e8e8ed); text-decoration: none;
      transition: color 0.1s;
    }
    .cg-result-title a:hover { color: #6ab0ff; text-decoration: underline; }
    .cg-result-title a:focus-visible {
      outline: 2px solid #5a9cff; outline-offset: 1px; border-radius: 2px;
    }
    .cg-result-title .cg-no-link {
      color: var(--fill-secondary, #8e8e93); cursor: default;
    }
    .cg-result-meta { font-size: 11px; color: var(--fill-secondary, #8e8e93); line-height: 1.4; }
    .cg-result-meta-authors {
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .cg-result-meta-venue { color: var(--fill-tertiary, #636366); margin-top: 1px; }
    .cg-result-year { color: var(--fill-secondary, #a8a8ad); font-weight: 500; }
    .cg-result-badges {
      display: flex; gap: 5px; margin-top: 5px; flex-wrap: wrap; align-items: center;
    }
    .cg-result-badge {
      font-size: 10px; padding: 1px 7px; border-radius: 4px;
      font-weight: 600; letter-spacing: 0.1px;
    }
    .cg-badge-oa { background: rgba(48,209,88,0.1); color: #32d74b; }
    .cg-badge-retracted { background: rgba(255,69,58,0.1); color: #ff453a; }
    .cg-badge-in-library { background: rgba(90,156,255,0.1); color: #5a9cff; }
    .cg-badge-no-doi { background: rgba(128,128,128,0.04); color: var(--fill-tertiary, #636366); }

    /* ── Right column: count + action ── */
    .cg-result-right {
      flex-shrink: 0; display: flex; flex-direction: column;
      align-items: flex-end; gap: 6px; min-width: 130px;
    }
    .cg-result-count {
      font-size: 15px; font-weight: 700;
      font-variant-numeric: tabular-nums; letter-spacing: -0.3px;
    }
    .cg-count-high { color: var(--accent-blue, #5a9cff); font-weight: 800; }
    .cg-count-medium { color: var(--fill-primary, #e8e8ed); }
    .cg-count-low { color: var(--fill-secondary, #8e8e93); }

    /* ── Split button ── */
    .cg-split-btn {
      display: inline-flex; align-items: stretch;
      border-radius: 7px;
      border: 1px solid rgba(90,156,255,0.25);
      font-size: 11px; font-weight: 500;
      transition: border-color 0.12s;
    }
    .cg-split-btn > .cg-split-main:first-child { border-radius: 6px 0 0 6px; }
    .cg-split-btn > .cg-split-arrow:last-of-type { border-radius: 0 6px 6px 0; }
    .cg-split-btn:hover { border-color: rgba(90,156,255,0.4); }
    .cg-split-main {
      padding: 4px 10px; background: rgba(90,156,255,0.08); color: #5a9cff;
      border: none; cursor: pointer;
      white-space: nowrap; max-width: 180px;
      overflow: hidden; text-overflow: ellipsis;
      transition: background 0.12s;
    }
    .cg-split-main:hover { background: rgba(90,156,255,0.15); }
    .cg-split-main:focus-visible { outline: 2px solid #5a9cff; outline-offset: -2px; }
    .cg-split-arrow {
      padding: 4px 6px; background: rgba(90,156,255,0.06); color: #5a9cff;
      border: none; border-left: 1px solid rgba(90,156,255,0.2);
      cursor: pointer; font-size: 9px;
      display: flex; align-items: center;
      transition: background 0.12s;
    }
    .cg-split-arrow:hover { background: rgba(90,156,255,0.15); }
    .cg-split-arrow:focus-visible { outline: 2px solid #5a9cff; outline-offset: -2px; }

    /* Added state */
    .cg-split-btn.cg-state-added { border-color: rgba(48,209,88,0.25); }
    .cg-split-btn.cg-state-added .cg-split-main {
      background: rgba(48,209,88,0.08); color: #30d158;
    }
    .cg-split-btn.cg-state-added .cg-split-main:hover {
      background: rgba(48,209,88,0.15);
    }

    /* File state (in library) */
    .cg-split-btn.cg-state-file { border-color: rgba(128,128,128,0.12); }
    .cg-split-btn.cg-state-file .cg-split-main {
      background: rgba(128,128,128,0.04); color: var(--fill-secondary, #a8a8ad);
    }
    .cg-split-btn.cg-state-file .cg-split-main:hover {
      background: rgba(128,128,128,0.08); color: var(--fill-secondary, #c8c8cd);
    }
    .cg-split-btn.cg-state-file .cg-split-arrow {
      background: rgba(128,128,128,0.02); color: var(--fill-tertiary, #636366);
      border-left-color: rgba(128,128,128,0.08);
    }
    .cg-split-btn.cg-state-file .cg-split-arrow:hover {
      background: rgba(128,128,128,0.08); color: var(--fill-secondary, #a8a8ad);
    }

    /* Adding spinner */
    .cg-spinner {
      display: inline-block; width: 12px; height: 12px;
      border: 2px solid rgba(90,156,255,0.2);
      border-top-color: #5a9cff; border-radius: 50%;
      animation: cg-spin 0.6s linear infinite;
      vertical-align: middle;
    }
    @keyframes cg-spin { to { transform: rotate(360deg); } }

    /* ── Expanded detail area ── */
    .cg-result-expanded {
      padding: 8px 14px 12px 14px;
      border-bottom: 1px solid rgba(128,128,128,0.04);
      background: rgba(128,128,128,0.015);
      animation: cg-expand-in 0.15s ease-out;
    }
    @keyframes cg-expand-in {
      from { opacity: 0; } to { opacity: 1; }
    }
    .cg-abstract-text {
      font-size: 12px; line-height: 1.55; color: var(--fill-secondary, #a8a8ad);
      display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .cg-abstract-loading {
      font-size: 12px; color: var(--fill-tertiary, #636366); font-style: italic;
    }
    .cg-abstract-none {
      font-size: 12px; color: var(--fill-quaternary, #48484a); font-style: italic;
    }

    /* ── Expand affordance ── */
    .cg-expand-hint {
      font-size: 10px; color: var(--fill-quaternary, #48484a);
      margin-top: 4px; cursor: pointer;
      transition: color 0.12s;
    }
    .cg-result-item:hover .cg-expand-hint { color: var(--fill-secondary, #8e8e93); }
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
      background: #30d158; border-radius: 0 0 6px 6px;
      animation: cg-undo-shrink 8s linear forwards;
    }
    @keyframes cg-undo-shrink { from { width: 100%; } to { width: 0; } }

    /* ── Result item focus (keyboard nav) ── */
    .cg-result-item:focus-visible {
      outline: 2px solid #5a9cff; outline-offset: -2px;
      background: rgba(90,156,255,0.04);
    }
    .cg-result-item:focus { outline: none; }

    /* ── Skeleton loading ── */
    .cg-skeleton-row {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 12px 14px; border-bottom: 1px solid rgba(128,128,128,0.04);
    }
    .cg-skeleton-bar {
      height: 12px; border-radius: 4px;
      background: rgba(128,128,128,0.08);
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
      background: var(--material-background, #1c1c1e); border: 1px solid rgba(128,128,128,0.12);
      border-radius: 10px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5);
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
      padding: 6px 12px; font-size: 12px; color: var(--fill-secondary, #c8c8cd);
      cursor: pointer; border: none; background: transparent;
      width: 100%; text-align: left;
      transition: background 0.1s;
    }
    .cg-picker-option:hover { background: rgba(128,128,128,0.06); }
    .cg-picker-option:focus-visible { outline: 2px solid #5a9cff; outline-offset: -2px; }
    .cg-picker-option[hidden] { display: none; }
    .cg-picker-check {
      width: 14px; height: 14px; flex-shrink: 0;
      border: 1.5px solid rgba(128,128,128,0.2); border-radius: 3px;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; color: transparent;
    }
    .cg-picker-option.checked .cg-picker-check {
      background: #5a9cff; border-color: #5a9cff; color: #fff;
    }
    .cg-picker-chevron {
      width: 14px; height: 14px; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 9px; color: var(--fill-tertiary, #8e8e93);
      transition: transform 0.15s ease;
      cursor: pointer;
      margin-left: -4px;
    }
    .cg-picker-chevron.expanded { transform: rotate(90deg); }
    .cg-picker-label {
      flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .cg-picker-separator {
      height: 1px; background: rgba(128,128,128,0.06); margin: 4px 12px;
    }
    .cg-picker-actions {
      display: flex; justify-content: flex-end; padding: 6px 12px;
      border-top: 1px solid rgba(128,128,128,0.06);
      flex-shrink: 0;
      background: var(--material-background, #1c1c1e);
      border-radius: 0 0 10px 10px;
    }
    .cg-picker-done {
      padding: 5px 16px; border-radius: 6px; font-size: 11px; font-weight: 600;
      background: #5a9cff; color: #fff; border: none; cursor: pointer;
      transition: background 0.12s;
    }
    .cg-picker-done:hover { background: #4a8cf0; }
    .cg-picker-done:focus-visible { outline: 2px solid #5a9cff; outline-offset: 2px; }

    /* ── Footer ── */
    .cg-dialog-footer {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px;
      border-top: 1px solid rgba(128,128,128,0.08);
      flex-shrink: 0;
      background: rgba(128,128,128,0.02);
    }
    .cg-footer-info { font-size: 11px; color: var(--fill-tertiary, #636366); }
    .cg-footer-right {
      display: flex; align-items: center; gap: 8px;
    }
    .cg-footer-label { font-size: 11px; color: var(--fill-tertiary, #636366); }
    .cg-default-chip {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 5px 10px; border-radius: 7px; font-size: 11px; font-weight: 500;
      background: rgba(128,128,128,0.06); color: var(--fill-secondary, #c8c8cd);
      border: 1px solid rgba(128,128,128,0.1);
      cursor: pointer; white-space: nowrap; max-width: 200px;
      transition: background 0.12s;
    }
    .cg-default-chip:hover { background: rgba(128,128,128,0.1); }
    .cg-default-chip:focus-visible { outline: 2px solid #5a9cff; outline-offset: 1px; }
    .cg-default-chip-label {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .cg-default-chip-extra { color: #5a9cff; font-weight: 600; flex-shrink: 0; }
    .cg-default-dropdown {
      position: absolute; bottom: calc(100% + 6px); right: 0;
      width: 270px; max-height: 300px;
      display: flex; flex-direction: column;
      background: var(--material-background, #1c1c1e); border: 1px solid rgba(128,128,128,0.12);
      border-radius: 10px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5);
      z-index: 20;
      animation: cg-picker-in 0.12s ease-out;
    }
    .cg-default-dropdown[hidden] { display: none; }

    /* ── States ── */
    .cg-loading-more {
      text-align: center; padding: 20px; font-size: 12px; color: var(--fill-quaternary, #48484a);
    }
    .cg-empty {
      text-align: center; padding: 48px 24px;
      color: var(--fill-tertiary, #636366); font-size: 13px; line-height: 1.5;
    }
    .cg-empty-title {
      font-size: 14px; font-weight: 600; color: var(--fill-secondary, #8e8e93); margin-bottom: 4px;
    }
    .cg-cap-notice {
      text-align: center; padding: 8px 14px; font-size: 11px;
      color: var(--fill-quaternary, #48484a); background: rgba(128,128,128,0.02);
      border-top: 1px solid rgba(128,128,128,0.04);
    }
  `;
}

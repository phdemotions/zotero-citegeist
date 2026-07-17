/**
 * Item-pane "Authors" section (U7a section + U8 curation).
 *
 * A second Citegeist item-pane section — separate from "Citation details" so
 * author identity is one concern with its own collapse header + sidenav icon
 * (Zotero's native IA). It lists the item's author creators matched to their
 * OpenAlex identities, each with a trust-state pill (concept B):
 *   • Verified   — user-confirmed identity (wins over background refresh)
 *   • Unverified — resolved by OpenAlex, not yet confirmed
 *   • No match   — a creator OpenAlex couldn't resolve
 * Tapping the pill reveals confirm / override / add-ID. Confirm and override
 * write the curated `item_authors` row (`setCuratedItemAuthor`) and drive the
 * synced relation (`syncItemAuthorRelations`); override / add-ID resolve a
 * pasted OpenAlex URL/ID or ORCID (`resolveAuthorInput`). Clicking a resolved
 * name opens that author's works (the dialog's author mode, U7b).
 *
 * Reads are async (no sync mirror, KTD5), so rows load in `onAsyncRender` under
 * a generation guard mirroring the citation pane's. Interactive elements are
 * built via the DOM API (never innerHTML) — Zotero's XUL pane context can
 * swallow `<button>`s set through innerHTML.
 *
 * Position-matching (creator index ↔ `item_authors.author_position`) is exact
 * for Citegeist-added items and best-effort for hand-entered ones; the user can
 * always override, so a mismatch is correctable, never lost.
 */

import {
  getItemAuthors,
  getAuthor,
  setCuratedItemAuthor,
  syncItemAuthorRelations,
  type AuthorRow,
} from "./cache/authors";
import {
  buildCurationRowViewModels,
  type CurationRowViewModel,
  type AuthorCreator,
} from "./authorProfile";
import { showAuthorWorks } from "./citationNetwork";
import { resolveAuthorInput } from "./openalexAuthors";
import { logError } from "./utils";
import { cgDesignTokens } from "./ui/tokens";
import { cgComponents } from "./ui/components";
import { resolveHostScheme } from "./ui/theme";

const PANE_ID = "citegeist-authors";

/** Bumped on every item change (and after a curation write) so an in-flight
 *  async render whose item was switched out drops its DOM write. */
let authorsGeneration = 0;

let sectionRegistered = false;
let sectionRegisteredPluginID: string | null = null;

function applyHostScheme(body: HTMLElement): void {
  const root = body.querySelector<HTMLElement>("#citegeist-authors-root");
  const win = root?.ownerDocument?.defaultView;
  if (root && win) root.style.colorScheme = resolveHostScheme(win as Window);
}

function namespacedPaneKey(pluginID: string, paneID: string): string {
  const raw = `${pluginID}-${paneID}`;
  type CSSWithEscape = { escape: (s: string) => string };
  const cssGlobal = (globalThis as unknown as { CSS?: CSSWithEscape }).CSS;
  if (cssGlobal && typeof cssGlobal.escape === "function") return cssGlobal.escape(raw);
  return raw.replace(/[@.]/g, "\\$&");
}

// ── DOM helpers ──

function el(doc: Document, tag: string, className?: string, text?: string): HTMLElement {
  const e = doc.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function isLibraryEditable(item: _ZoteroTypes.Item): boolean {
  try {
    const lib = (item as unknown as { library?: { editable?: boolean } }).library;
    return lib?.editable !== false;
  } catch {
    return true;
  }
}

/** The item's author-type creators, indexed among authors (the write position). */
function getAuthorCreators(item: _ZoteroTypes.Item): AuthorCreator[] {
  let authorTypeID: number | undefined;
  try {
    authorTypeID = (
      Zotero as { CreatorTypes?: { getID?: (n: string) => number } }
    ).CreatorTypes?.getID?.("author");
  } catch {
    authorTypeID = undefined;
  }
  const creators = (item.getCreators?.() ?? []) as Array<{
    creatorTypeID?: number;
    lastName?: string;
    firstName?: string;
    name?: string;
  }>;
  const out: AuthorCreator[] = [];
  let authorIdx = 0;
  for (const c of creators) {
    const isAuthor =
      authorTypeID == null || c.creatorTypeID == null || c.creatorTypeID === authorTypeID;
    if (!isAuthor) continue;
    out.push({ name: creatorName(c) || `Author ${authorIdx + 1}`, position: authorIdx });
    authorIdx++;
  }
  return out;
}

function creatorName(c: { lastName?: string; firstName?: string; name?: string }): string {
  const last = (c.lastName || "").trim();
  const first = (c.firstName || "").trim();
  if (last && first) return `${last}, ${first}`;
  return last || (c.name || "").trim() || first;
}

function pillLabel(state: CurationRowViewModel["state"]): string {
  if (state === "verified") return "✓ Verified";
  if (state === "unverified") return "Unverified";
  return "No match";
}

// ── Curation writes ──

async function curateAuthor(
  item: _ZoteroTypes.Item,
  authorId: string,
  position: number,
): Promise<void> {
  await setCuratedItemAuthor({ libraryID: item.libraryID, key: item.key }, authorId, position);
  await syncItemAuthorRelations(item);
}

// ── Row + panel rendering ──

function actionButton(
  doc: Document,
  label: string,
  extraClass: string,
  onClick: () => void,
): HTMLButtonElement {
  const b = el(doc, "button", `cg-curate-btn ${extraClass}`) as HTMLButtonElement;
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

/** Replace the panel with the paste-an-ID form (override / add-ID). */
function showPasteForm(
  doc: Document,
  item: _ZoteroTypes.Item,
  vm: CurationRowViewModel,
  panel: HTMLElement,
  onChange: () => void,
): void {
  panel.textContent = "";
  panel.appendChild(
    el(
      doc,
      "div",
      "cg-curate-label",
      vm.state === "no-match"
        ? "Paste this author’s OpenAlex URL, ID, or ORCID:"
        : "Wrong author? Paste the correct OpenAlex URL, ID, or ORCID:",
    ),
  );
  const input = el(doc, "input", "cg-curate-input") as HTMLInputElement;
  input.type = "text";
  input.setAttribute("placeholder", "https://openalex.org/A…  ·  0000-0000-0000-0000");
  panel.appendChild(input);

  const err = el(doc, "div", "cg-curate-error");
  err.hidden = true;
  panel.appendChild(err);

  const actions = el(doc, "div", "cg-curate-actions");
  const setBtn = actionButton(doc, "Set author", "cg-curate-primary", async () => {
    const value = input.value.trim();
    if (!value) return;
    err.hidden = true;
    setBtn.disabled = true;
    setBtn.textContent = "Resolving…";
    try {
      const id = await resolveAuthorInput(value);
      if (!id) {
        err.textContent = "Couldn’t resolve that to an OpenAlex author.";
        err.hidden = false;
        setBtn.disabled = false;
        setBtn.textContent = "Set author";
        return;
      }
      await curateAuthor(item, id, vm.position);
      onChange();
    } catch (e) {
      logError("curation override", e);
      err.textContent = "Couldn’t reach OpenAlex. Try again in a moment.";
      err.hidden = false;
      setBtn.disabled = false;
      setBtn.textContent = "Set author";
    }
  });
  actions.appendChild(setBtn);
  actions.appendChild(actionButton(doc, "Cancel", "cg-curate-cancel", () => onChange()));
  panel.appendChild(actions);
  input.focus();
}

/** Populate a row's curation panel with the confirm / override / add-ID actions. */
function buildPanel(
  doc: Document,
  item: _ZoteroTypes.Item,
  vm: CurationRowViewModel,
  panel: HTMLElement,
  onChange: () => void,
  editable: boolean,
): void {
  panel.textContent = "";
  if (!editable) {
    panel.appendChild(
      el(doc, "div", "cg-curate-note", "Read-only library — authorship can’t be changed here."),
    );
    return;
  }
  const actions = el(doc, "div", "cg-curate-actions");
  if (vm.state === "unverified" && vm.authorId) {
    const authorId = vm.authorId;
    actions.appendChild(
      actionButton(doc, "Confirm", "cg-curate-primary", async () => {
        try {
          await curateAuthor(item, authorId, vm.position);
          onChange();
        } catch (e) {
          logError("curation confirm", e);
        }
      }),
    );
  }
  actions.appendChild(
    actionButton(doc, vm.state === "no-match" ? "Add ID" : "Override", "cg-curate-plain", () =>
      showPasteForm(doc, item, vm, panel, onChange),
    ),
  );
  panel.appendChild(actions);
}

function buildRow(
  doc: Document,
  item: _ZoteroTypes.Item,
  vm: CurationRowViewModel,
  onChange: () => void,
  editable: boolean,
): HTMLElement {
  const wrap = el(doc, "div", "cg-author-rowwrap");
  const row = el(doc, "div", "cg-author-row");

  if (vm.authorId) {
    const nameBtn = el(doc, "button", "cg-author-name cg-author-name--link") as HTMLButtonElement;
    nameBtn.type = "button";
    nameBtn.textContent = vm.name;
    nameBtn.setAttribute("aria-label", `View ${vm.name}’s works`);
    const authorId = vm.authorId;
    nameBtn.addEventListener("click", () =>
      showAuthorWorks(authorId).catch((e) => logError("showAuthorWorks", e)),
    );
    row.appendChild(nameBtn);
  } else {
    row.appendChild(el(doc, "span", "cg-author-name", vm.name));
  }

  if (vm.hIndexLabel) row.appendChild(el(doc, "span", "cg-author-hint", vm.hIndexLabel));

  const pill = el(doc, "button", `cg-pill cg-pill--${vm.state}`) as HTMLButtonElement;
  pill.type = "button";
  pill.textContent = pillLabel(vm.state);
  pill.setAttribute("aria-expanded", "false");

  const panel = el(doc, "div", "cg-curate-panel");
  panel.hidden = true;

  pill.addEventListener("click", () => {
    const opening = panel.hidden;
    panel.hidden = !opening;
    pill.setAttribute("aria-expanded", opening ? "true" : "false");
    if (opening) buildPanel(doc, item, vm, panel, onChange, editable);
  });
  row.appendChild(pill);

  wrap.appendChild(row);
  wrap.appendChild(panel);
  return wrap;
}

function emptyNote(doc: Document): HTMLElement {
  const note = el(doc, "div", "cg-banner cg-authors-empty");
  note.appendChild(el(doc, "strong", undefined, "Authors not linked yet"));
  note.appendChild(
    doc.createTextNode(
      " Right-click this item → Resolve Author Identities to link its authors to OpenAlex.",
    ),
  );
  return note;
}

function readOnlyNote(doc: Document): HTMLElement {
  const note = el(doc, "div", "cg-banner cg-authors-readonly");
  note.appendChild(el(doc, "strong", undefined, "Saved locally"));
  note.appendChild(doc.createTextNode(" Confirmations aren’t synced — this library is read-only."));
  return note;
}

// ── Render + re-render ──

async function renderAuthors(
  container: HTMLElement,
  item: _ZoteroTypes.Item,
  setSectionSummary: (s: string) => void,
): Promise<void> {
  const doc = container.ownerDocument;
  const gen = authorsGeneration;
  try {
    const creators = getAuthorCreators(item);
    const itemAuthors = await getItemAuthors(item.libraryID, item.key);
    if (gen !== authorsGeneration) return;

    if (creators.length === 0 && itemAuthors.length === 0) {
      container.textContent = "";
      container.appendChild(emptyNote(doc));
      setSectionSummary("");
      return;
    }

    const resolvedIds = [...new Set(itemAuthors.map((r) => r.author_id))];
    const authorRows = await Promise.all(resolvedIds.map((id) => getAuthor(id)));
    if (gen !== authorsGeneration) return;
    const byId = new Map<string, AuthorRow | null>();
    resolvedIds.forEach((id, i) => byId.set(id, authorRows[i]));

    const vms = buildCurationRowViewModels(creators, itemAuthors, byId);
    const editable = isLibraryEditable(item);
    const onChange = () => reRender(container, item, setSectionSummary);

    container.textContent = "";
    for (const vm of vms) container.appendChild(buildRow(doc, item, vm, onChange, editable));
    if (!editable) container.appendChild(readOnlyNote(doc));

    const verified = vms.filter((v) => v.state === "verified").length;
    setSectionSummary(`${verified}/${vms.length} verified`);
  } catch (e) {
    if (gen !== authorsGeneration) return;
    logError("renderAuthors", e);
    container.textContent = "";
    setSectionSummary("");
  }
}

/** Re-render after a curation write. Bumps the generation so it supersedes any
 *  in-flight render and is itself superseded by a later item change. */
function reRender(
  container: HTMLElement,
  item: _ZoteroTypes.Item,
  setSectionSummary: (s: string) => void,
): void {
  authorsGeneration++;
  renderAuthors(container, item, setSectionSummary).catch((e) => logError("renderAuthors", e));
}

/** Pane-local CSS: author rows + status pills + the curation panel. Tokens only
 *  (theme-following); no `<`/`&` so it stays XML-safe in the bodyXHTML `<style>`. */
function authorsSectionCss(scope: string): string {
  return `
    ${scope} .cg-authors-empty, ${scope} .cg-authors-readonly { color: var(--cg-text-secondary); }
    ${scope} .cg-authors-readonly { margin-top: var(--cg-space-2); }
    ${scope} .cg-author-row {
      display: flex; align-items: center; gap: var(--cg-space-2);
      padding: var(--cg-space-2) var(--cg-space-1); border-radius: var(--cg-radius-md);
    }
    ${scope} .cg-author-name {
      flex: 1; min-width: 0; font-size: var(--cg-size-subhead);
      font-weight: var(--cg-weight-medium); color: var(--cg-text-primary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    ${scope} .cg-author-name--link {
      background: transparent; border: none; padding: 0; text-align: left;
      cursor: pointer; font-family: inherit;
    }
    ${scope} .cg-author-name--link:hover { color: var(--cg-sage-accent); text-decoration: underline; }
    ${scope} .cg-author-name--link:focus-visible { outline: 2px solid var(--cg-sage-accent); outline-offset: 2px; }
    ${scope} .cg-author-hint {
      font-size: var(--cg-size-caption); font-weight: var(--cg-weight-semibold);
      color: var(--cg-sage-accent); font-variant-numeric: tabular-nums; white-space: nowrap;
    }
    ${scope} .cg-pill {
      font-size: var(--cg-size-caption2); font-weight: var(--cg-weight-bold);
      letter-spacing: var(--cg-track-caps); text-transform: uppercase;
      padding: 3px var(--cg-space-2); border-radius: var(--cg-radius-pill);
      border: 1px solid transparent; cursor: pointer; font-family: inherit; white-space: nowrap;
    }
    ${scope} .cg-pill:focus-visible { outline: 2px solid var(--cg-sage-accent); outline-offset: 2px; }
    ${scope} .cg-pill--verified { background: var(--cg-sage-tint-12); color: var(--cg-sage-accent-strong); }
    ${scope} .cg-pill--unverified { background: transparent; color: var(--cg-text-tertiary); border-color: var(--cg-hairline); }
    ${scope} .cg-pill--no-match { background: var(--cg-amber-tint); color: var(--cg-amber-strong); border-color: var(--cg-amber-border); }
    ${scope} .cg-curate-panel { padding: var(--cg-space-2) var(--cg-space-1) var(--cg-space-1); }
    ${scope} .cg-curate-actions { display: flex; gap: var(--cg-space-2); flex-wrap: wrap; }
    ${scope} .cg-curate-btn {
      font-size: var(--cg-size-caption); font-weight: var(--cg-weight-semibold);
      padding: var(--cg-space-1) var(--cg-space-3); border-radius: var(--cg-radius-md);
      cursor: pointer; font-family: inherit;
      border: 1px solid var(--cg-hairline); background: transparent; color: var(--cg-text-secondary);
    }
    ${scope} .cg-curate-btn:hover { background: var(--cg-sage-tint-06); color: var(--cg-text-primary); }
    ${scope} .cg-curate-btn:disabled { opacity: 0.6; cursor: default; }
    ${scope} .cg-curate-primary {
      background: var(--cg-primary-bg); color: var(--cg-primary-fg); border-color: transparent;
    }
    ${scope} .cg-curate-primary:hover { background: var(--cg-primary-bg-hover); color: var(--cg-primary-fg); }
    ${scope} .cg-curate-label { font-size: var(--cg-size-caption); color: var(--cg-text-secondary); margin-bottom: var(--cg-space-2); }
    ${scope} .cg-curate-input {
      width: 100%; box-sizing: border-box; font-size: var(--cg-size-footnote);
      padding: var(--cg-space-1) var(--cg-space-2); border: 1px solid var(--cg-sage-tint-35);
      border-radius: var(--cg-radius-md); background: var(--cg-surface-elevated);
      color: var(--cg-text-primary); margin-bottom: var(--cg-space-2); font-family: inherit;
    }
    ${scope} .cg-curate-error { font-size: var(--cg-size-caption); color: var(--cg-danger); margin-bottom: var(--cg-space-2); }
    ${scope} .cg-curate-note { font-size: var(--cg-size-caption); color: var(--cg-text-tertiary); }
  `;
}

// ── Registration ──

export function registerAuthorsSection(pluginID: string): void {
  if (sectionRegistered) return;
  sectionRegistered = true;
  sectionRegisteredPluginID = pluginID;
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
        l10nID: "citegeist-authors-header",
        icon: "chrome://citegeist/content/icons/icon-20-color.svg",
      },
      sidenav: {
        l10nID: "citegeist-authors-sidenav",
        icon: "chrome://citegeist/content/icons/icon-20-color.svg",
      },
      bodyXHTML: `
      <div id="citegeist-authors-root" xmlns="http://www.w3.org/1999/xhtml">
        <style>
          ${cgDesignTokens("#citegeist-authors-root", { embedded: true })}
          ${cgComponents("#citegeist-authors-root")}
          ${authorsSectionCss("#citegeist-authors-root")}
        </style>
        <div id="citegeist-authors-content"></div>
      </div>
    `,
      onItemChange: ({ item, setEnabled }) => {
        authorsGeneration++;
        setEnabled(item.isRegularItem() && !item.deleted);
      },
      onRender: ({ body }) => {
        applyHostScheme(body);
        const container = body.querySelector("#citegeist-authors-content") as HTMLElement;
        if (container) container.textContent = "";
      },
      onAsyncRender: async ({ body, item, setSectionSummary }) => {
        applyHostScheme(body);
        const container = body.querySelector("#citegeist-authors-content") as HTMLElement;
        if (!container) return;
        await renderAuthors(container, item, setSectionSummary);
      },
    });
  } catch (e) {
    sectionRegistered = false;
    logError("registerAuthorsSection", e);
  }

  Zotero.debug("[Citegeist] Authors pane section registered");
}

export function unregisterAuthorsSection(): void {
  if (sectionRegisteredPluginID) {
    try {
      Zotero.ItemPaneManager.unregisterSection(
        namespacedPaneKey(sectionRegisteredPluginID, PANE_ID),
      );
    } catch (e) {
      logError("unregisterAuthorsSection", e);
    }
    sectionRegisteredPluginID = null;
  }
  sectionRegistered = false;
}

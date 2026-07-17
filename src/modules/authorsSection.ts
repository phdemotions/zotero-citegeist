/**
 * Item-pane "Authors" section (U7a of the author-identity layer).
 *
 * A second Citegeist item-pane section — separate from "Citation details" so
 * author identity is one concern with its own collapse header + sidenav icon
 * (Zotero's native IA). Lists the item's OpenAlex-resolved authors as rows
 * (name · h-index hint · chevron, concept E2); clicking a row opens that
 * author's Scholar profile as the citation-network dialog's "author works" mode
 * (U7b). Curation (confirm / override) lands in this same section in U8.
 *
 * Reads are async (the author cache has no sync mirror, KTD5), so rows load in
 * `onAsyncRender` under a generation guard mirroring the citation pane's.
 * Interactive rows are built via the DOM API (never innerHTML) — Zotero's XUL
 * pane context can swallow `<button>`s set through innerHTML.
 */

import { getItemAuthors, getAuthor, type AuthorRow } from "./cache/authors";
import { buildAuthorRowViewModels, type AuthorRowViewModel } from "./authorProfile";
import { showAuthorWorks } from "./citationNetwork";
import { logError } from "./utils";
import { cgDesignTokens } from "./ui/tokens";
import { cgComponents } from "./ui/components";
import { resolveHostScheme } from "./ui/theme";

const PANE_ID = "citegeist-authors";

/**
 * Bumped on every item change so an in-flight async render whose item was
 * switched out drops its DOM write instead of stomping the now-current item
 * (Zotero reuses the section `body` across selections). Mirrors the citation
 * pane's `paneGeneration`.
 */
let authorsGeneration = 0;

let sectionRegistered = false;
let sectionRegisteredPluginID: string | null = null;

/** Force the pane root's `color-scheme` to Zotero's real theme (see ui/theme.ts). */
function applyHostScheme(body: HTMLElement): void {
  const root = body.querySelector<HTMLElement>("#citegeist-authors-root");
  const win = root?.ownerDocument?.defaultView;
  if (root && win) root.style.colorScheme = resolveHostScheme(win as Window);
}

/**
 * Same namespacing Zotero applies internally (`CSS.escape(pluginID-paneID)`).
 * Unregistering with the un-prefixed id silently fails and the next register
 * throws "paneID must be unique" — see the citation pane's note.
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

/** Pane-local CSS for the author rows (E2). Tokens only, so it follows the
 *  theme; no `<`/`&` so it stays XML-safe inside the bodyXHTML `<style>`. */
function authorsSectionCss(scope: string): string {
  return `
    ${scope} .cg-authors-empty { color: var(--cg-text-secondary); }
    ${scope} .cg-author-row {
      display: flex; align-items: center; gap: var(--cg-space-2);
      width: 100%; text-align: left; background: transparent; border: none;
      border-radius: var(--cg-radius-md); padding: var(--cg-space-2) var(--cg-space-1);
      cursor: pointer; font-family: inherit; color: var(--cg-text-primary);
      transition: background var(--cg-dur-fast) var(--cg-ease);
    }
    ${scope} .cg-author-row:hover { background: var(--cg-sage-tint-06); }
    ${scope} .cg-author-row:focus-visible { outline: 2px solid var(--cg-sage-accent); outline-offset: 2px; }
    ${scope} .cg-author-name {
      flex: 1; min-width: 0; font-size: var(--cg-size-subhead);
      font-weight: var(--cg-weight-medium); white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis;
    }
    ${scope} .cg-author-hint {
      font-size: var(--cg-size-caption); font-weight: var(--cg-weight-semibold);
      color: var(--cg-sage-accent); font-variant-numeric: tabular-nums; white-space: nowrap;
    }
    ${scope} .cg-author-chev { color: var(--cg-text-tertiary); font-size: var(--cg-size-body); }
  `;
}

function buildAuthorRow(doc: Document, vm: AuthorRowViewModel): HTMLElement {
  const row = doc.createElement("button");
  row.type = "button";
  row.className = "cg-author-row";
  row.setAttribute("aria-label", `View ${vm.name}’s works`);

  const name = doc.createElement("span");
  name.className = "cg-author-name";
  name.textContent = vm.name;
  row.appendChild(name);

  if (vm.hIndexLabel) {
    const hint = doc.createElement("span");
    hint.className = "cg-author-hint";
    hint.textContent = vm.hIndexLabel;
    row.appendChild(hint);
  }

  const chev = doc.createElement("span");
  chev.className = "cg-author-chev";
  chev.textContent = "›"; // ›
  row.appendChild(chev);

  row.addEventListener("click", () => {
    showAuthorWorks(vm.authorId).catch((e) => logError("showAuthorWorks", e));
  });
  return row;
}

/** Load the item's resolved authors and render the rows (or an empty note). */
async function renderAuthors(
  container: HTMLElement,
  item: _ZoteroTypes.Item,
  setSectionSummary: (s: string) => void,
): Promise<void> {
  const doc = container.ownerDocument;
  const gen = authorsGeneration;
  try {
    const itemAuthors = await getItemAuthors(item.libraryID, item.key);
    if (gen !== authorsGeneration) return;

    if (itemAuthors.length === 0) {
      container.textContent = "";
      const note = doc.createElement("div");
      note.className = "cg-banner cg-authors-empty";
      const strong = doc.createElement("strong");
      strong.textContent = "Authors not linked yet";
      note.appendChild(strong);
      note.appendChild(
        doc.createTextNode(
          " Right-click this item → Resolve Author Identities to link its authors to OpenAlex.",
        ),
      );
      container.appendChild(note);
      setSectionSummary("Not linked");
      return;
    }

    const authorRows = await Promise.all(itemAuthors.map((ia) => getAuthor(ia.author_id)));
    if (gen !== authorsGeneration) return;

    const byId = new Map<string, AuthorRow | null>();
    itemAuthors.forEach((ia, i) => byId.set(ia.author_id, authorRows[i]));
    const vms = buildAuthorRowViewModels(itemAuthors, byId);

    container.textContent = "";
    for (const vm of vms) container.appendChild(buildAuthorRow(doc, vm));
    setSectionSummary(`${vms.length} author${vms.length === 1 ? "" : "s"}`);
  } catch (e) {
    if (gen !== authorsGeneration) return;
    logError("renderAuthors", e);
    container.textContent = "";
    setSectionSummary("");
  }
}

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
        // Bump so any in-flight async render for the previous item bails.
        authorsGeneration++;
        setEnabled(item.isRegularItem() && !item.deleted);
      },
      onRender: ({ body }) => {
        applyHostScheme(body);
        const container = body.querySelector("#citegeist-authors-content") as HTMLElement;
        // Reads are async; clear synchronously and let onAsyncRender fill in.
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

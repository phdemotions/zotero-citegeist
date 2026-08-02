/**
 * The one renderer for a coded failure state.
 *
 * Both surfaces — the item pane and the citation-network dialog — build this
 * from here rather than each hand-writing its own error copy. That is the
 * point: before this existed the dialog said "An unexpected error occurred"
 * while the pane said something else entirely, and neither gave the user
 * anything to quote.
 *
 * Shape (design direction B): a plain sentence the user can act on, with the
 * machine-facing detail — code, call site, build, host — behind a disclosure.
 * Most users never open it; the ones filing an issue get everything a
 * maintainer would otherwise have to ask for, in one paste.
 *
 * Nothing here is coloured. In this design system sage means ACTION and amber
 * means EVIDENCE, so a failure may spend neither — it composes the neutral
 * `.cg-diag*` primitives from `ui/components.ts`.
 */

import { describeCode } from "./codes";
import { buildDiagnosticReport } from "./report";
import type { DiagnosticCode } from "./codes";
import { logError } from "../utils";
import { COPY_FEEDBACK_REVERT_MS } from "../../constants";

/**
 * Copy text to the system clipboard. `Zotero.Utilities.Internal` isn't in the
 * typings, hence the cast. Returns false rather than throwing — a failed copy
 * must not take out the error panel it lives in.
 */
export function copyToClipboard(text: string): boolean {
  try {
    (
      Zotero as unknown as {
        Utilities: { Internal: { copyTextToClipboard(s: string): void } };
      }
    ).Utilities.Internal.copyTextToClipboard(text);
    return true;
  } catch (e) {
    logError("copyToClipboard", e);
    return false;
  }
}

/**
 * Build the coded failure block.
 *
 * `context` is the call-site label that lands in the report — make it the
 * thing you'd want to read in a bug report ("network dialog load"), not the
 * function's identifier.
 */
export function buildDiagnosticElement(
  doc: Document,
  code: DiagnosticCode,
  context: string,
): HTMLElement {
  const entry = describeCode(code);

  const wrap = doc.createElement("div");
  wrap.className = "cg-diag";

  const msg = doc.createElement("p");
  msg.className = "cg-diag-msg";
  msg.textContent = entry.message;
  wrap.appendChild(msg);

  const disclosure = doc.createElement("div");
  disclosure.className = "cg-diag-disclosure";

  const toggle = doc.createElement("button");
  toggle.className = "cg-btn cg-btn--plain cg-btn--sm";
  toggle.textContent = "Details";
  toggle.setAttribute("aria-expanded", "false");

  const detail = doc.createElement("p");
  detail.className = "cg-diag-detail";
  detail.style.display = "none";
  detail.textContent = buildDiagnosticReport({ code, context });

  const copy = doc.createElement("button");
  // --plain (neutral, hairline) matches the adjacent Details button. A bare
  // .cg-btn has no background of its own — every other button in the app carries
  // a variant — so without one this rendered with the browser's default chrome.
  // Neutral, not the sage --filled/--tinted: the colour-role invariant reserves
  // sage for ACTION, and an error surface may spend neither sage nor amber.
  copy.className = "cg-btn cg-btn--plain cg-btn--sm";
  copy.textContent = "Copy report";
  copy.style.display = "none";

  // Visually-hidden live region so the copy result is announced to screen
  // readers: a change to a focused button's own label (below) isn't reliably
  // spoken. Mirrors the settings pane's role=status pattern; clipped so it adds
  // nothing visual to the error block.
  const liveStatus = doc.createElement("span");
  liveStatus.setAttribute("role", "status");
  liveStatus.setAttribute("aria-live", "polite");
  liveStatus.style.cssText =
    "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;";

  toggle.addEventListener("click", () => {
    const open = detail.style.display === "none";
    detail.style.display = open ? "" : "none";
    copy.style.display = open ? "" : "none";
    toggle.setAttribute("aria-expanded", String(open));
  });
  copy.addEventListener("click", () => {
    // Rebuilt on copy rather than reusing the disclosure's text: anything that
    // failed while the panel sat open belongs in what the user pastes.
    const ok = copyToClipboard(buildDiagnosticReport({ code, context }));
    copy.textContent = ok ? "Copied" : "Couldn't copy";
    liveStatus.textContent = ok ? "Report copied to clipboard" : "Couldn't copy the report";
    // Revert so a second copy re-signals (otherwise the label sticks on
    // "Copied" and a repeat click gives no feedback).
    const win = copy.ownerDocument?.defaultView;
    win?.setTimeout(() => {
      copy.textContent = "Copy report";
    }, COPY_FEEDBACK_REVERT_MS);
  });

  disclosure.appendChild(toggle);
  disclosure.appendChild(detail);
  disclosure.appendChild(copy);
  disclosure.appendChild(liveStatus);
  wrap.appendChild(disclosure);
  return wrap;
}

/**
 * The Citegeist diagnostic code registry.
 *
 * Every failure a user can see carries a short, stable code. A user pastes
 * `CG-DB01` into a GitHub issue and the failure is identified before anyone
 * asks a follow-up question — which is the whole point: Citegeist ships to
 * researchers who will not enable Zotero's debug logging before hitting a bug,
 * so a report that carries no code carries nothing.
 *
 * ## The rules that make a code worth citing
 *
 * 1. **Append-only.** A code is a permanent public identifier. Never renumber,
 *    never reuse, never repurpose a retired one — a code in a 2027 issue must
 *    still resolve to the same meaning. Retire by leaving the entry in place
 *    with a `retired` note.
 * 2. **One code per distinguishable user situation**, not per throw site. Two
 *    call sites that leave the user in the same position with the same next
 *    step share a code.
 * 3. **The message is the user's whole explanation.** Say what happened, then
 *    what to do. No exception text, no "Error:" prefix, no first person.
 * 4. **`retryable` is a promise to the UI**: true means "the same action may
 *    work shortly", which is what gates whether we offer a retry affordance.
 *
 * This module deliberately imports nothing. It sits at the bottom of the
 * dependency graph so any layer — fetch, cache, UI — can name a code without
 * creating a cycle.
 */

/** Subsystem a code belongs to. Also the code's prefix. */
export type DiagnosticArea = "NET" | "API" | "DB" | "MATCH" | "ID" | "UI" | "BUG";

export interface DiagnosticCodeEntry {
  /** Stable public identifier, e.g. "CG-DB01". Never changes. */
  readonly code: string;
  readonly area: DiagnosticArea;
  /**
   * What the user is told. One or two sentences: what happened, then what to
   * do about it. This is the entire explanation most users will ever read.
   */
  readonly message: string;
  /** True when repeating the same action might succeed shortly. */
  readonly retryable: boolean;
}

/**
 * The registry. Keys are the codes themselves so a lookup reads like the thing
 * the user reported.
 *
 * APPEND ONLY — see the module docblock.
 */
export const DIAGNOSTIC_CODES = {
  "CG-NET01": {
    code: "CG-NET01",
    area: "NET",
    message:
      "Couldn't reach OpenAlex. Check your internet connection and try again in a few minutes.",
    retryable: true,
  },
  "CG-API01": {
    code: "CG-API01",
    area: "API",
    message:
      "OpenAlex rejected your API key. Check the key in Citegeist settings, or clear it to use the free anonymous quota.",
    retryable: false,
  },
  "CG-API42": {
    code: "CG-API42",
    area: "API",
    message:
      "You've used up today's OpenAlex request budget. It resets within 24 hours. A free OpenAlex API key raises the limit — add one in Citegeist settings.",
    retryable: false,
  },
  "CG-API50": {
    code: "CG-API50",
    area: "API",
    message: "OpenAlex returned an unexpected response. Try again in a few minutes.",
    retryable: true,
  },
  "CG-DB01": {
    code: "CG-DB01",
    area: "DB",
    message:
      "Couldn't save to Citegeist's local database. If your Zotero data folder is inside Dropbox, iCloud Drive, OneDrive or Box, the sync client can lock the file — pausing sync usually clears it.",
    retryable: true,
  },
  "CG-DB02": {
    code: "CG-DB02",
    area: "DB",
    message:
      "Citegeist's local database couldn't be opened. Restart Zotero; if it persists, quit Zotero and check that citegeist.sqlite in your data folder isn't quarantined by antivirus.",
    retryable: false,
  },
  "CG-MATCH01": {
    code: "CG-MATCH01",
    area: "MATCH",
    message: "This work isn't in OpenAlex, so there are no citation metrics to show.",
    retryable: false,
  },
  "CG-MATCH02": {
    code: "CG-MATCH02",
    area: "MATCH",
    message:
      "Not found by identifier, and a title search found no confident match. Adding a DOI is the most reliable fix.",
    retryable: false,
  },
  "CG-ID01": {
    code: "CG-ID01",
    area: "ID",
    message:
      "No recognized identifier on this item. Add a DOI, PMID, arXiv ID, or ISBN to enable citation data.",
    retryable: false,
  },
  "CG-UI01": {
    code: "CG-UI01",
    area: "UI",
    message: "Something went wrong drawing this panel. Switch items and back, or restart Zotero.",
    retryable: true,
  },
  "CG-BUG01": {
    code: "CG-BUG01",
    area: "BUG",
    message:
      "Citegeist hit an unexpected problem. Copying the report below into a GitHub issue is the fastest way to get it fixed.",
    retryable: true,
  },
} as const satisfies Record<string, DiagnosticCodeEntry>;

/** Every code in the registry, as a union of string literals. */
export type DiagnosticCode = keyof typeof DIAGNOSTIC_CODES;

/** All registered codes. Order is registry order. */
export const ALL_DIAGNOSTIC_CODES = Object.keys(DIAGNOSTIC_CODES) as DiagnosticCode[];

/**
 * Look up a code's entry. Returns the CG-BUG01 entry for an unknown code
 * rather than throwing — a diagnostics layer that can crash while reporting a
 * crash is worse than useless.
 */
export function describeCode(code: string): DiagnosticCodeEntry {
  return (
    (DIAGNOSTIC_CODES as Record<string, DiagnosticCodeEntry>)[code] ?? DIAGNOSTIC_CODES["CG-BUG01"]
  );
}

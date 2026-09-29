/**
 * Pure comparisons over Debug Output lines and console messages, used by the
 * root hooks inside Zotero and unit-tested in test/realZoteroHarness.test.ts.
 */

/**
 * Lines in `after` that `before` did not hold, counting duplicates.
 *
 * Compares content, not length: once stored Debug Output passes
 * `extensions.zotero.debug.store.limit`, Zotero drops lines from the front, so
 * the buffer can gain a line and keep its length.
 */
export function linesAdded(before: readonly string[], after: readonly string[]): string[] {
  const unmatched = new Map<string, number>();
  for (const line of before) unmatched.set(line, (unmatched.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of after) {
    const left = unmatched.get(line) ?? 0;
    if (left > 0) unmatched.set(line, left - 1);
    else added.push(line);
  }
  return added;
}

/** Lines added since `before` that no pattern in `allowed` matches. Patterns must not be global. */
export function unexpectedLines(
  before: readonly string[],
  after: readonly string[],
  allowed: readonly RegExp[],
): string[] {
  return linesAdded(before, after).filter((line) => !allowed.some((pattern) => pattern.test(line)));
}

/** One message from Gecko's console service, reduced to what the run-wide check reads. */
export interface ConsoleRecord {
  readonly message: string;
  /** Script URL for an nsIScriptError; empty for a plain console message. */
  readonly sourceName: string;
  /** An nsIScriptError that is neither a warning nor an info message. */
  readonly isError: boolean;
}

/** What Gecko logs when a chrome:// URL's package has been unregistered. */
export const UNREGISTERED_CHROME_MESSAGE = "No chrome package registered for chrome://citegeist";

/**
 * True for a console message that points at Citegeist: its chrome package gone,
 * or an error whose message or source contains one of `markers` (its chrome
 * URL, its add-on id, its load directory). Warnings and info messages never
 * count, and neither does a bare mention of "citegeist": on CI the checkout
 * path itself contains it.
 */
export function isCitegeistConsoleProblem(
  record: ConsoleRecord,
  markers: readonly string[],
): boolean {
  if (record.message.includes(UNREGISTERED_CHROME_MESSAGE)) return true;
  if (!record.isError) return false;
  return markers.some(
    (marker) => record.message.includes(marker) || record.sourceName.includes(marker),
  );
}

export function formatConsoleRecord(record: ConsoleRecord): string {
  return record.sourceName ? `${record.message} (${record.sourceName})` : record.message;
}

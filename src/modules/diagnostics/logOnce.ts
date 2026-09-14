/**
 * Recording a failure that a surface can hit every time it opens.
 *
 * A context menu or a pane checks the host each time it shows, so one broken
 * host contract repeats for as long as the user keeps clicking. Recorded every
 * time, those repeats push older, more useful entries out of the ring buffer.
 */

import { codeForError, logError, normalizeError, redactSensitive } from "../utils";
import { recentDiagnostics } from "./record";

/**
 * `logError(context, error)`, unless the buffer still holds the entry that call
 * would record.
 *
 * Entries match on code, context and detail, computed exactly as `logError`
 * stores them (the context redacted, the detail normalized), so a different
 * failure, or the same failure on another surface, records its own entry. Once
 * the earlier entry has aged out of the buffer, or the user cleared it, the
 * failure records again, so a report never hides a failure that is still
 * happening.
 *
 * The detail includes the first stack frame, so this collapses repeats of an
 * error built at one call site. Build the error with a fixed message, never
 * host error text, which could carry a library name into the shareable report.
 */
export function logErrorUnlessBuffered(context: string, error: unknown): void {
  const code = codeForError(error);
  const recordedContext = redactSensitive(context);
  const detail = normalizeError(error);
  const buffered = recentDiagnostics().some(
    (entry) => entry.code === code && entry.context === recordedContext && entry.detail === detail,
  );
  if (!buffered) logError(context, error);
}

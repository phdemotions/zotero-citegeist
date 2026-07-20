/**
 * The in-memory diagnostic ring buffer.
 *
 * Zotero's debug logging is off by default and nobody turns it on *before*
 * hitting a bug, so without this a user report arrives with no history at all.
 * Keeping the last N failures in memory means the diagnostic report can always
 * answer "what else went wrong just before this?" — which is usually the
 * question that identifies the real cause.
 *
 * Deliberately memory-only. Writing a log file would mean another file in the
 * user's data directory to keep, rotate, and eventually corrupt, and the window
 * that matters for a bug report is the current session.
 *
 * This module imports nothing from the app: `logError` in `utils.ts` feeds it
 * already-normalized (and already API-key-redacted) strings, so there is no
 * cycle and no path by which a raw error string reaches the buffer unredacted.
 */

import { DIAGNOSTIC_RING_BUFFER_SIZE } from "../../constants";

export interface DiagnosticEntry {
  /** Epoch milliseconds. Rendered as local wall-clock time in the report. */
  readonly at: number;
  /** Registry code, e.g. "CG-DB01". */
  readonly code: string;
  /** Call-site label passed to logError, e.g. "cacheWorkData". */
  readonly context: string;
  /** Normalized, API-key-redacted error text. */
  readonly detail: string;
}

let buffer: DiagnosticEntry[] = [];

/**
 * Append one failure. Oldest entries fall off the front once the buffer is
 * full — recent failures are what diagnose a live problem.
 */
export function recordDiagnostic(code: string, context: string, detail: string): void {
  buffer.push({ at: Date.now(), code, context, detail });
  if (buffer.length > DIAGNOSTIC_RING_BUFFER_SIZE) {
    buffer = buffer.slice(-DIAGNOSTIC_RING_BUFFER_SIZE);
  }
}

/** Oldest-first snapshot. Returns a copy — callers can't mutate the buffer. */
export function recentDiagnostics(): DiagnosticEntry[] {
  return [...buffer];
}

/** The most recent entry, or null when nothing has failed this session. */
export function lastDiagnostic(): DiagnosticEntry | null {
  return buffer.length ? buffer[buffer.length - 1] : null;
}

/** Drop everything. Exported for the settings pane and for test isolation. */
export function clearDiagnostics(): void {
  buffer = [];
}

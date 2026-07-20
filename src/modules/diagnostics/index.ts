/**
 * Citegeist diagnostics — stable error codes, an in-memory failure history,
 * host-callback error boundaries, and the copy-paste report that ties them
 * together.
 *
 * The problem it solves: a user hits a bug, sees a spinner or a blank panel,
 * and files an issue that says "it doesn't work". Every failure now carries a
 * code the user can quote, and the report answers the follow-up questions
 * before they're asked.
 *
 * Layering (no cycles): `codes` imports nothing · `record` imports constants ·
 * `utils` imports both and is the single funnel that records · `guard` and
 * `report` sit on top.
 */

export {
  DIAGNOSTIC_CODES,
  ALL_DIAGNOSTIC_CODES,
  describeCode,
  type DiagnosticCode,
  type DiagnosticArea,
  type DiagnosticCodeEntry,
} from "./codes";
export {
  recordDiagnostic,
  recentDiagnostics,
  lastDiagnostic,
  clearDiagnostics,
  type DiagnosticEntry,
} from "./record";
export { guard, guardAsync, type GuardFallback } from "./guard";
export { buildDiagnosticReport, setPluginVersion, type ReportContext } from "./report";

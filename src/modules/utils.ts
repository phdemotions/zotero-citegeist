/**
 * Shared utilities for Citegeist.
 */

import { DIAGNOSTIC_CODES, type DiagnosticCode } from "./diagnostics/codes";
import { recordDiagnostic } from "./diagnostics/record";

/**
 * Safely set innerHTML in Zotero's XUL document context.
 *
 * Zotero 7's main window is a XUL document. Setting innerHTML on elements
 * in XUL documents parses content as XML, which rejects normal HTML.
 * This function parses HTML with DOMParser (text/html), then imports
 * the resulting nodes into the target element's document.
 */
export function safeInnerHTML(element: Element, html: string): void {
  // Clear existing content
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }

  // Parse as HTML (not XML) using DOMParser
  const parser = new DOMParser();
  const htmlDoc = parser.parseFromString(`<body>${html}</body>`, "text/html");

  // Import each child node from the parsed body into the target document
  const ownerDoc = element.ownerDocument;
  for (const child of Array.from(htmlDoc.body.childNodes)) {
    element.appendChild(ownerDoc.importNode(child, true));
  }
}

/**
 * Escape a string for safe insertion into HTML.
 * Handles all five HTML-significant characters.
 */
export function escapeHTML(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Parse an integer with NaN safety. Returns fallback on failure.
 */
export function safeParseInt(val: string | undefined, fallback: number = 0): number {
  if (val === undefined) return fallback;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Strict integer parse for migration trust boundaries. Returns null on any
 * non-numeric input rather than silently coercing to a fallback — callers
 * persisting values from hand-edited Extra fields must distinguish "user
 * typed garbage" from "user typed 0".
 */
export function safeParseIntOrNull(val: string | undefined): number | null {
  if (val === undefined) return null;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Parse a float with NaN safety. Returns null on failure.
 * Also rejects ±Infinity — those would persist to SQLite and poison every
 * downstream numeric comparison (sort, threshold filter, derived metric).
 */
export function safeParseFloat(val: string | undefined): number | null {
  if (val === undefined) return null;
  const parsed = parseFloat(val);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Redact an OpenAlex `api_key` query-param value from any string.
 *
 * OpenAlex is metered (July 2026); the optional key rides the request URL as
 * `?api_key=…`. Zotero.HTTP errors can carry the full URL in their message, so
 * every string bound for a log MUST pass through here. This is centralized
 * inside {@link normalizeError} — the single funnel every `logError` and raw
 * `Zotero.debug(normalizeError(e))` call already uses — rather than at
 * individual call sites, so no logging path can bypass it.
 */
export function redactApiKey(s: string): string {
  return s.replace(/(\bapi_key=)[^&\s"')]+/gi, "$1REDACTED");
}

/**
 * Strip absolute filesystem paths, which carry the OS username.
 *
 * The diagnostic report is copy-pasted into public GitHub issues and promises
 * "no personal details", so a `/Users/<name>/…` or `C:\Users\<name>\…` path
 * (from, e.g., a backup-prune error carrying the file it touched) must not
 * survive into the ring buffer. Anchored on the home root so it never mangles a
 * URL (those start with a scheme, not `/Users`). The local Zotero debug log is
 * left untouched — only what reaches the shareable buffer is scrubbed.
 */
export function redactPaths(s: string): string {
  return (
    s
      // Consume the user segment up to the NEXT SEPARATOR, not the next space:
      // a profile folder is often "John Smith", and stopping at the space left
      // the surname behind ("~ Smith\\Zotero\\…").
      .replace(/\/(?:Users|home)\/[^/\r\n]*/g, "~")
      .replace(/[A-Za-z]:\\Users\\[^\\\r\n]*/gi, "~")
  );
}

/**
 * The full scrub applied to anything bound for the diagnostic ring buffer: the
 * opt-in API key, any username-bearing path, and any resolvable OpenAlex id.
 * The single place all three compose, so a new sink can't pick up one and miss
 * the others.
 */
export function redactSensitive(s: string): string {
  return redactDois(redactOpenAlexIds(redactPaths(redactApiKey(s))));
}

/**
 * Replace a DOI with `<doi>`.
 *
 * A DOI is the most direct pointer to library content there is, and it is named
 * first in the report's on-screen promise, so it gets the same defense-in-depth
 * net as an OpenAlex id. Matches the bare form, which also covers a doi.org URL
 * (the DOI is a substring of it).
 */
export function redactDois(s: string): string {
  return s.replace(/\b10\.\d{4,9}\/[^\s"')<>]+/gi, "<doi>");
}

/**
 * Replace a resolvable OpenAlex entity id with `<id>`.
 *
 * Any OpenAlex id (a work `W…`, author `A…`, or source/journal `S…`, plus the
 * other entity prefixes) resolves 1:1 via one unauthenticated GET to a paper's
 * title, a person, or a journal — a pointer to library content. Call sites are
 * supposed to keep ids out of a recorded context, but this is the net that
 * keeps the "no library content" promise true if a future one forgets.
 */
export function redactOpenAlexIds(s: string): string {
  return s.replace(/\b[WASIPFCTL]\d{4,}\b/g, "<id>");
}

/**
 * Normalize an unknown caught value into a string suitable for logging.
 *
 * Zotero.debug(msg + e) coerces objects to "[object Object]" and drops
 * stack traces. Use this helper in every catch() so log lines are useful
 * in production. The result is always run through {@link redactApiKey} so a
 * URL-bearing error can never leak the user's OpenAlex key into the debug log.
 */
export function normalizeError(e: unknown): string {
  return redactSensitive(rawNormalizeError(e));
}

function rawNormalizeError(e: unknown): string {
  if (e instanceof Error) {
    const first = e.stack?.split("\n")[1]?.trim();
    return first ? `${e.message} (${first})` : e.message;
  }
  if (typeof e === "string") return e;
  if (e === undefined) return "undefined";
  if (e === null) return "null";
  try {
    const json = JSON.stringify(e);
    return json ?? String(e);
  } catch {
    return String(e);
  }
}

/**
 * Prefixed debug logger, and the single funnel into the diagnostic ring buffer.
 *
 * Every caught error in the codebase already flows through here, so recording
 * at this one point means the diagnostic report has history even though Zotero
 * debug logging is off — which it always is until after the bug has happened.
 * The recorded detail is `normalizeError`'s output, so it is API-key-redacted
 * before it is ever stored.
 */
export function logError(context: string, e: unknown): void {
  const detail = normalizeError(e);
  Zotero.debug(`[Citegeist] ERROR ${context}: ${detail}`);
  // `context` is a call-site label, but a few carry a path (a backup filename,
  // for one), so it goes through the same scrub as `detail` before it can reach
  // the shareable buffer. `detail` is already scrubbed by normalizeError.
  recordDiagnostic(codeForError(e), redactSensitive(context), detail);
}

/**
 * The diagnostic code for a caught value.
 *
 * A {@link CitegeistError} names its own code; anything else is by definition
 * unclassified, which is exactly what CG-BUG01 means. Resist the temptation to
 * sniff message text here — a code inferred from a substring silently
 * mis-classifies the moment an upstream message is reworded, and a wrong code
 * in a bug report is worse than an honest "unexpected".
 */
export function codeForError(e: unknown): DiagnosticCode {
  return e instanceof CitegeistError ? e.code : "CG-BUG01";
}

/**
 * True for Zotero item types where zero citation counts likely reflect
 * incomplete OpenAlex coverage rather than genuine uncitedness.
 * Centralised here so citationColumn and citationPane stay in sync.
 */
export function isBookType(item: _ZoteroTypes.Item): boolean {
  return item.itemType === "book" || item.itemType === "bookSection";
}

/**
 * Base class for every failure Citegeist can explain to a user.
 *
 * Carrying the diagnostic code on the error itself is what lets a throw travel
 * from the fetch layer to the pane without anyone re-deriving what went wrong
 * from a message string. A subclass picks its code once; every UI layer just
 * reads `.code`.
 */
export class CitegeistError extends Error {
  constructor(
    message: string,
    public readonly code: DiagnosticCode,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CitegeistError";
  }

  /** The user-facing explanation for this error's code. */
  get userMessage(): string {
    return DIAGNOSTIC_CODES[this.code].message;
  }

  /** True when repeating the same action might succeed shortly. */
  get retryable(): boolean {
    return DIAGNOSTIC_CODES[this.code].retryable;
  }
}

/**
 * Distinguishes "OpenAlex unreachable" from "work not found" so UI layers
 * can render a helpful message instead of a flat "not found" dead end.
 */
export class OpenAlexNetworkError extends CitegeistError {
  constructor(message: string, cause?: unknown) {
    super(message, "CG-NET01", cause);
    this.name = "OpenAlexNetworkError";
  }
}

/**
 * OpenAlex answered, but with something we can't use — an unexpected status
 * (400/422/…) or a body that isn't valid JSON. Distinct from
 * {@link OpenAlexNetworkError}: telling a user to "check your internet
 * connection" when the service replied is misleading, and it sends them
 * debugging the wrong thing.
 */
export class OpenAlexResponseError extends CitegeistError {
  constructor(message: string, cause?: unknown) {
    super(message, "CG-API50", cause);
    this.name = "OpenAlexResponseError";
  }
}

/**
 * A local cache read or write failed. Its own class (rather than a bare throw)
 * because the most common cause is environmental, not a bug: a Zotero data
 * directory inside Dropbox/iCloud/OneDrive/Box lets the sync client lock the
 * SQLite file, and CG-DB01 tells the user that in one sentence.
 */
export class CacheError extends CitegeistError {
  constructor(message: string, cause?: unknown) {
    super(message, "CG-DB01", cause);
    this.name = "CacheError";
  }
}

/**
 * The caller's OpenAlex daily budget is exhausted (July-2026 metered API).
 * Distinct from {@link OpenAlexNetworkError} so the UI can prompt the user to
 * add an API key rather than showing an "unreachable" dead end, and so a
 * bulk pass can stop cleanly instead of caching a spurious "no data".
 */
export class OpenAlexBudgetError extends CitegeistError {
  constructor(message = "OpenAlex daily budget exhausted") {
    super(message, "CG-API42");
    this.name = "OpenAlexBudgetError";
  }
}

/**
 * OpenAlex rejected the request's API key (HTTP 401/403). Distinct from a
 * network failure so the UI can prompt the user to re-check their key.
 */
export class OpenAlexAuthError extends CitegeistError {
  constructor(message = "OpenAlex rejected the API key") {
    super(message, "CG-API01");
    this.name = "OpenAlexAuthError";
  }
}

/** Return the English ordinal string for a non-negative integer (e.g. 1 → "1st", 92 → "92nd"). */
export function toOrdinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const mod10 = n % 10;
  if (mod10 === 1) return `${n}st`;
  if (mod10 === 2) return `${n}nd`;
  if (mod10 === 3) return `${n}rd`;
  return `${n}th`;
}

/**
 * Marker for values that are already HTML-escaped, consumed by {@link safeHTML}.
 */
export interface SafeHTMLValue {
  readonly __safeHTML: true;
  readonly html: string;
}

/** Wrap a string that is already HTML-safe so {@link safeHTML} won't re-escape it. */
export function rawHTML(html: string): SafeHTMLValue {
  return { __safeHTML: true, html };
}

/**
 * Tagged template literal that HTML-escapes every interpolated value by default.
 * Wrap pre-sanitized fragments in {@link rawHTML} to skip escaping.
 *
 *     safeHTML`<a href="${url}">${label}</a>`
 */
export function safeHTML(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v && typeof v === "object" && (v as SafeHTMLValue).__safeHTML === true) {
      out += (v as SafeHTMLValue).html;
    } else if (v === null || v === undefined) {
      out += "";
    } else {
      out += escapeHTML(String(v));
    }
    out += strings[i + 1];
  }
  return out;
}

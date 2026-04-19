/**
 * Shared utilities for Citegeist.
 */

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
 * Parse a float with NaN safety. Returns null on failure.
 */
export function safeParseFloat(val: string | undefined): number | null {
  if (val === undefined) return null;
  const parsed = parseFloat(val);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Normalize an unknown caught value into a string suitable for logging.
 *
 * Zotero.debug(msg + e) coerces objects to "[object Object]" and drops
 * stack traces. Use this helper in every catch() so log lines are useful
 * in production.
 */
export function normalizeError(e: unknown): string {
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

/** Prefixed debug logger with consistent formatting. */
export function logError(context: string, e: unknown): void {
  Zotero.debug(`[Citegeist] ERROR ${context}: ${normalizeError(e)}`);
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
 * Distinguishes "OpenAlex unreachable" from "work not found" so UI layers
 * can render a helpful message instead of a flat "not found" dead end.
 */
export class OpenAlexNetworkError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "OpenAlexNetworkError";
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

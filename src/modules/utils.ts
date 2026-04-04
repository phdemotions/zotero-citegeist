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
  const htmlDoc = parser.parseFromString(
    `<body>${html}</body>`,
    "text/html",
  );

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

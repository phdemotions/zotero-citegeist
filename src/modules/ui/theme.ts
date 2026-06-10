/**
 * Host-theme resolution for Citegeist's `light-dark()` surfaces.
 *
 * Both UI surfaces colour themselves with CSS `light-dark()`, which resolves
 * against the element's used `color-scheme`. That value is *inherited* from the
 * mount point — and a Zotero window's `color-scheme` can follow the OS
 * appearance even when Zotero itself is themed the opposite way (Settings →
 * General → Appearance = Light while macOS is Dark, or vice-versa). When they
 * disagree, every `light-dark()` token resolves to the wrong arm: the network
 * dialog rendered fully dark in Zotero's light theme.
 *
 * The fix is to stop inheriting and instead force `color-scheme` to Zotero's
 * *actual* theme, sampled from what Zotero actually paints. Both surfaces call
 * `resolveHostScheme(win)` and set the result on their root element, so a single
 * resolver keeps the pane and dialog in lockstep with the host.
 */

/** Perceived luminance (0–255) of a CSS `rgb()/rgba()` string, or null. */
function cssLuminance(color: string): number | null {
  const n = color?.match(/[\d.]+/g);
  if (!n || n.length < 3) return null;
  if (n.length >= 4 && Number(n[3]) === 0) return null; // fully transparent → no signal
  return 0.299 * Number(n[0]) + 0.587 * Number(n[1]) + 0.114 * Number(n[2]);
}

/**
 * Resolve the host (Zotero) theme as `"light"` or `"dark"`. Layered signal,
 * most-authoritative first:
 *   1. `--fill-primary` — Zotero's main text colour. Light text ⇒ dark theme.
 *      A sentinel default (`rgb(1,2,3)`) distinguishes "var undefined here" from
 *      a genuine reading, so we don't mistake a missing var for black text.
 *   2. the window background — dark background ⇒ dark theme.
 *   3. the OS preference (`prefers-color-scheme`) as a last resort.
 */
export function resolveHostScheme(win: Window): "light" | "dark" {
  const doc = win.document;
  try {
    const probe = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
    probe.style.cssText =
      "position:absolute;width:0;height:0;color:var(--fill-primary, rgb(1,2,3));";
    (doc.body || doc.documentElement).appendChild(probe);
    const textColor = win.getComputedStyle(probe).color;
    probe.remove();
    if (!/rgba?\(\s*1,\s*2,\s*3/.test(textColor)) {
      const textLum = cssLuminance(textColor);
      if (textLum !== null) return textLum > 140 ? "dark" : "light";
    }
    for (const el of [doc.documentElement, doc.body]) {
      if (!el) continue;
      const bgLum = cssLuminance(win.getComputedStyle(el).backgroundColor);
      if (bgLum !== null) return bgLum < 128 ? "dark" : "light";
    }
  } catch {
    /* fall through to OS preference */
  }
  try {
    return win.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

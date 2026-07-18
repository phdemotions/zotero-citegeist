import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cgComponents } from "../src/modules/ui/components";
import { cgDesignTokens } from "../src/modules/ui/tokens";

/**
 * Guards for the shared UI primitive layer. The component emitters are pure
 * string functions, so these assertions are deterministic and DOM-free.
 *
 * The "no raw hex" rule is the backbone: primitives must compose from
 * `var(--cg-*)` tokens, never hardcoded colours. A hardcoded colour can't
 * follow the forced `color-scheme`, which is exactly the class of bug that made
 * the network dialog render dark in light mode. Colours live in `tokens.ts`
 * (which IS allowed hex — it defines them); every other layer references them.
 */

// A hex-free scope so the no-raw-hex assertion can never false-positive on the
// scope text itself (e.g. "#z" contains no 3+ hex run).
const SCOPE = "#z";

describe("cgComponents", () => {
  const css = cgComponents(SCOPE);

  it("emits the button primitive family scoped to the surface", () => {
    for (const selector of [
      `${SCOPE} .cg-btn`,
      `${SCOPE} .cg-btn--filled`,
      `${SCOPE} .cg-btn--tinted`,
      `${SCOPE} .cg-btn--plain`,
      `${SCOPE} .cg-btn--sm`,
      `${SCOPE} .cg-actions`,
    ]) {
      expect(css).toContain(selector);
    }
  });

  it("references design tokens only — no raw hex colours", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("emits no raw < or & — the pane bodyXHTML parses as XML, where a stray one aborts the whole parse and the pane silently vanishes (regression guard for the itemPaneSection XML break)", () => {
    expect(css).not.toMatch(/[<&]/);
  });

  it("carries the reduced-motion + focus-visible a11y affordances", () => {
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain(":focus-visible");
  });
});

describe("cgDesignTokens", () => {
  it("emits the token block scoped to the surface", () => {
    expect(cgDesignTokens(SCOPE)).toContain(`${SCOPE} {`);
  });

  it("emits no raw < or & (XML-safe for the pane style block)", () => {
    expect(cgDesignTokens(SCOPE, { embedded: true })).not.toMatch(/[<&]/);
    expect(cgDesignTokens(SCOPE)).not.toMatch(/[<&]/);
  });

  it("embedded mode sources text from Zotero's --fill-* theme vars", () => {
    expect(cgDesignTokens(SCOPE, { embedded: true })).toContain("var(--fill-primary)");
  });

  it("modal mode owns its slate text ramp (does not read --fill-primary)", () => {
    const modal = cgDesignTokens(SCOPE);
    // The modal surface defines --cg-text-primary from its own value, not the
    // host theme, so it stays a consistent slate regardless of host.
    expect(modal).toContain("--cg-text-primary");
    expect(modal).not.toContain("var(--fill-primary)");
  });
});

/**
 * Gallery ↔ code parity. `src/modules/ui/components.ts` is the CANONICAL source
 * for the component primitives; `docs/design-system/citegeist-primitives.html`
 * is the illustrative reference. This guards against the reference silently
 * falling behind the code — every primitive class the app actually ships must
 * be documented in the gallery, so a new primitive can't be added without also
 * showing it in the spec.
 */
describe("gallery documents every shipped primitive", () => {
  it("every .cg-* class emitted by cgComponents appears in the gallery", () => {
    // Strip CSS comments first so class names mentioned in prose (e.g. a
    // comment referencing a surface's layout class) aren't mistaken for
    // emitted selectors.
    const selectorsOnly = cgComponents(SCOPE).replace(/\/\*[\s\S]*?\*\//g, "");
    const emitted = new Set([...selectorsOnly.matchAll(/\.(cg-[a-z0-9-]+)/g)].map((m) => m[1]));
    const galleryPath = fileURLToPath(
      new URL("../docs/design-system/citegeist-primitives.html", import.meta.url),
    );
    const gallery = readFileSync(galleryPath, "utf8");
    const missing = [...emitted].filter((cls) => !gallery.includes(cls)).sort();
    expect(missing).toEqual([]);
  });
});

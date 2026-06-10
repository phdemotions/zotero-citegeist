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

  it("carries the reduced-motion + focus-visible a11y affordances", () => {
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain(":focus-visible");
  });
});

describe("cgDesignTokens", () => {
  it("emits the token block scoped to the surface", () => {
    expect(cgDesignTokens(SCOPE)).toContain(`${SCOPE} {`);
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

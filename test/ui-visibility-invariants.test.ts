/**
 * UI VISIBILITY INVARIANTS (Zotero 9) — the guard rail for "things showing up".
 *
 * Every assertion here corresponds to a bug that has ALREADY shipped and blanked
 * a surface on Zotero 9 during development:
 *   • header/sidenav registered with a plain `label` → registerSection throws →
 *     the whole item-pane section vanishes.
 *   • header/sidenav given only `icon` (no `darkIcon`) → dark-mode users get a
 *     `url('undefined')` background → blank sidenav icon.
 *   • a `context-fill` SVG used where Zotero paints a background-image → blank.
 *   • bootstrap dropping the registerChrome handle → GC unregisters
 *     chrome://citegeist/ → blank icons + unresolved FTL.
 *   • FTL loaded via a chrome:// link and only in onMainWindowLoad → labels blank
 *     when the window was already open at startup.
 *
 * If you are redesigning the pane and a test here fails, DO NOT delete it — read
 * docs/solutions/integration-issues/zotero-9-plugin-blank-ui-and-sync-break.md
 * first. These are the contracts that keep the icon, menu, and pane visible.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

// ── The heavy data/UI-action deps aren't exercised at registration time; mock
// them so importing the real citationPane stays light and we can capture the
// exact options object passed to Zotero.ItemPaneManager.registerSection. ──
vi.mock("../src/modules/cache", () => ({
  getCachedData: vi.fn(),
  clearCache: vi.fn(),
  isCacheStale: vi.fn(),
  getPendingSuggestion: vi.fn(),
  dismissAsNoMatch: vi.fn(),
  confirmTitleMatch: vi.fn(),
}));
vi.mock("../src/modules/citationService", () => ({
  fetchAndCacheItem: vi.fn(),
  extractIdentifier: vi.fn(),
}));
vi.mock("../src/modules/citationColumn", () => ({ invalidateColumnCache: vi.fn() }));
vi.mock("../src/modules/openalex", () => ({ normalizeDOI: vi.fn() }));
vi.mock("../src/modules/citationNetwork", () => ({
  showCitationNetwork: vi.fn(),
  showAuthorWorks: vi.fn(),
}));
vi.mock("../src/modules/cache/authors", () => ({ getItemAuthors: vi.fn(), getAuthor: vi.fn() }));
vi.mock("../src/modules/authorProfile", () => ({
  buildAuthorRowViewModels: vi.fn(() => []),
  compactTrend: vi.fn(),
  getAuthorCreators: vi.fn(() => []),
}));

interface SectionOpts {
  header: { l10nID?: string; label?: string; icon?: string; darkIcon?: string };
  sidenav: { l10nID?: string; label?: string; icon?: string; darkIcon?: string };
  sectionButtons?: Array<{ type: string; l10nID?: string; label?: string; icon?: string }>;
}

const ROOT = "jar:file:///plugin.xpi!/";

async function captureRegisterSection(): Promise<SectionOpts> {
  let captured: SectionOpts | undefined;
  vi.stubGlobal("Zotero", {
    debug: vi.fn(),
    ItemPaneManager: {
      registerSection: vi.fn((opts: SectionOpts) => {
        captured = opts;
      }),
      unregisterSection: vi.fn(),
    },
  });
  vi.stubGlobal("CSS", { escape: (s: string) => s });
  const { registerCitationPane } = await import("../src/modules/citationPane");
  registerCitationPane("citegeist@opusvita.org", ROOT);
  if (!captured) throw new Error("registerSection was never called");
  return captured;
}

describe("UI visibility invariants (Zotero 9) — DO NOT let these regress", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("item-pane section registration", () => {
    it("header uses l10nID and NEVER a plain label (Z9 throws on label → pane vanishes)", async () => {
      const opts = await captureRegisterSection();
      expect(opts.header.l10nID).toBe("citegeist-pane-header");
      expect(opts.header.label, "header.label must be unset — Z9 rejects it").toBeUndefined();
    });

    it("sidenav uses l10nID and NEVER a plain label", async () => {
      const opts = await captureRegisterSection();
      expect(opts.sidenav.l10nID).toBe("citegeist-pane-sidenav");
      expect(opts.sidenav.label, "sidenav.label must be unset — Z9 rejects it").toBeUndefined();
    });

    it("header AND sidenav each set icon AND darkIcon (no darkIcon = blank in dark mode)", async () => {
      const opts = await captureRegisterSection();
      for (const surface of ["header", "sidenav"] as const) {
        expect(opts[surface].icon, `${surface}.icon must be set`).toBeTruthy();
        expect(
          opts[surface].darkIcon,
          `${surface}.darkIcon must be set — Zotero does NOT default it, so a dark-mode OS gets url('undefined')`,
        ).toBeTruthy();
      }
    });

    it("header/sidenav icons are explicit-fill color SVGs via rootURI, never context-fill", async () => {
      const opts = await captureRegisterSection();
      for (const surface of ["header", "sidenav"] as const) {
        for (const key of ["icon", "darkIcon"] as const) {
          const url = opts[surface][key]!;
          expect(
            url.startsWith(ROOT),
            `${surface}.${key} must load via rootURI (not chrome://)`,
          ).toBe(true);
          expect(
            url,
            `${surface}.${key} must be a *-color.svg (background-image needs real fills)`,
          ).toMatch(/icon-\d+-color\.svg$/);
        }
      }
    });

    it("every section button uses l10nID, never a plain label (MenuManager-style drop)", async () => {
      const opts = await captureRegisterSection();
      expect(opts.sectionButtons?.length, "section buttons must exist").toBeGreaterThan(0);
      for (const btn of opts.sectionButtons ?? []) {
        expect(btn.l10nID, `button "${btn.type}" must set l10nID`).toBeTruthy();
        expect(btn.label, `button "${btn.type}" must not set a plain label`).toBeUndefined();
      }
    });
  });

  describe("icon assets", () => {
    it("the referenced color icon exists and uses explicit fills (no context-fill)", () => {
      const svg = read("../addon/content/icons/icon-20-color.svg");
      expect(svg).toMatch(/<svg/);
      expect(
        svg,
        "a color icon must NOT use context-fill (paints transparent as a url() image)",
      ).not.toMatch(/context-fill/);
    });
  });

  describe("chrome registration (addon/bootstrap.js)", () => {
    const bootstrap = read("../addon/bootstrap.js");
    it("retains the registerChrome handle (drop it → GC unregisters chrome://citegeist/)", () => {
      expect(bootstrap).toMatch(/chromeHandle\s*=\s*aomStartup\.registerChrome/);
    });
    it("destructs the chrome handle on shutdown", () => {
      expect(bootstrap).toMatch(/chromeHandle\.destruct\(\)/);
    });
  });

  describe("FTL loading (src/hooks.ts)", () => {
    const hooks = read("../src/hooks.ts");
    it("injects the FTL by bare filename via insertFTLIfNeeded, never a chrome:// locale link", () => {
      expect(hooks).toMatch(/insertFTLIfNeeded\(/);
      expect(hooks).toMatch(/citegeist\.ftl/);
      // The regressed form assigned `link.href = "chrome://citegeist/locale/…"`.
      // Guard the actual assignment, not comments that mention the anti-pattern.
      expect(hooks, "FTL must not be loaded via a chrome://citegeist href").not.toMatch(
        /href\s*=\s*["'`]chrome:\/\/citegeist/,
      );
    });
    it("wires the FTL in BOTH the already-open-window (onStartup) and onMainWindowLoad paths", () => {
      // onStartup injects for a window already open before startup (uses mainWin);
      // onMainWindowLoad injects for windows opened later (uses win). Both required —
      // onMainWindowLoad does not fire for an already-open window.
      expect(hooks, "onStartup must inject FTL for an already-open window").toMatch(
        /ensureCitegeistFTL\(mainWin\)/,
      );
      expect(hooks, "onMainWindowLoad must inject FTL for new windows").toMatch(
        /ensureCitegeistFTL\(win\)/,
      );
    });
  });
});

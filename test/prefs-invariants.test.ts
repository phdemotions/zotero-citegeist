/**
 * U18 guard: every Citegeist preference read and write goes through
 * `src/modules/prefs.ts`.
 *
 * `Zotero.Prefs` resolves a name under `extensions.zotero.` unless told the name
 * is global, and Citegeist's pref constants are already full names. A direct call
 * without that argument reads a pref nothing writes and returns `undefined`
 * without complaint, which is how every earlier build ignored its own settings
 * pane. Static source assertions, like `diagnostics-guard-invariants.test.ts`:
 * the failure is a call that looks right, so nothing surfaces at runtime.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as constants from "../src/constants";
import { LEGACY_DOUBLED_PREFS, type CitegeistPref } from "../src/modules/prefs";

const PREFS_MODULE = "src/modules/prefs.ts";
/** A direct reference to either pref API. */
const DIRECT_PREF_ACCESS = /\bZotero\s*\.\s*Prefs\b|\bServices\s*\.\s*prefs\b/;

function repoFile(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
}

/** Block comments and whole-line `//` comments removed, so prose that names the API is not a call. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every `.ts` under `src/`, repo-relative, so the guard covers new files automatically. */
function allSrcFiles(dir = "src"): string[] {
  const abs = fileURLToPath(new URL(`../${dir}`, import.meta.url));
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...allSrcFiles(rel));
    else if (entry.name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

/** Files other than prefs.ts whose code reaches a pref API directly. */
function prefAccessOffenders(sources: Record<string, string>): string[] {
  return Object.entries(sources)
    .filter(([file, code]) => file !== PREFS_MODULE && DIRECT_PREF_ACCESS.test(stripComments(code)))
    .map(([file]) => file)
    .sort();
}

describe("preference access goes through prefs.ts (U18)", () => {
  it("no src module but prefs.ts touches Zotero.Prefs or Services.prefs", () => {
    const sources = Object.fromEntries(allSrcFiles().map((f) => [f, repoFile(f)]));
    expect(Object.keys(sources), "positive control: the scan reads prefs.ts").toContain(
      PREFS_MODULE,
    );
    expect(prefAccessOffenders(sources), "these modules bypass src/modules/prefs.ts").toEqual([]);
  });

  it("the scan catches a stray call and ignores one named only in a comment", () => {
    expect(
      prefAccessOffenders({
        "src/modules/stray.ts": "const on = Zotero.Prefs.get(PREF_AUTO_FETCH) as boolean;",
        "src/modules/writer.ts": "Services.prefs.setIntPref(PREF_NETWORK_PAGE_SIZE, 50);",
        "src/modules/prose.ts":
          "/** Read with `Zotero.Prefs.get(name, true)`. */\n// Zotero.Prefs.get returns undefined\nexport const x = 1;",
        [PREFS_MODULE]: "Zotero.Prefs.get(name, true);",
      }),
    ).toEqual(["src/modules/stray.ts", "src/modules/writer.ts"]);
  });

  it("prefs.ts passes `global` on every Zotero.Prefs read and write", () => {
    const calls = [
      ...stripComments(repoFile(PREFS_MODULE)).matchAll(/Zotero\.Prefs\.(?:get|set)\(([^()]*)\)/g),
    ];
    expect(calls.length, "positive control: prefs.ts calls Zotero.Prefs").toBeGreaterThanOrEqual(3);
    for (const [call, args] of calls) {
      expect(args, call).toMatch(/,\s*true\s*,?\s*$/);
    }
  });

  it("the settings pane and addon/prefs.js name only Citegeist pref constants, none read from a legacy name", () => {
    const known = new Set(
      Object.entries(constants)
        .filter(([key]) => key.startsWith("PREF_"))
        .map(([, value]) => value),
    );
    const bound = [
      ...repoFile("addon/content/preferences.xhtml").matchAll(/preference="([^"]+)"/g),
    ].map((m) => m[1]);
    const defaulted = [...repoFile("addon/prefs.js").matchAll(/^pref\("([^"]+)"/gm)].map(
      (m) => m[1],
    );

    expect(bound.length, "positive control: the settings pane binds prefs").toBeGreaterThan(0);
    expect(new Set(bound), "every bound setting ships a default, and nothing else does").toEqual(
      new Set(defaulted),
    );
    for (const name of bound) {
      expect(known.has(name), `${name} has no PREF_* constant`).toBe(true);
      expect(
        LEGACY_DOUBLED_PREFS.has(name as CitegeistPref),
        `${name} is a setting the pane writes, so it has no legacy value`,
      ).toBe(false);
    }
  });
});

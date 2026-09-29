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
 *
 * The scan runs on the TypeScript AST (test/_helpers/sourceGuard.ts), as
 * selection-guard-invariants.test.ts does, and test/sourceGuard.test.ts covers
 * each way the scanner finds an access. The text scan this replaces missed
 * `const { Prefs } = Zotero`, `Zotero["Prefs"]`, an alias and `Zotero?.Prefs`,
 * lost a call that sat between a `/*` and a `*\/` held in strings, and skipped
 * the `global` check on any call with parentheses inside it.
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as constants from "../src/constants";
import { LEGACY_DOUBLED_PREFS, type CitegeistPref } from "../src/modules/prefs";
import {
  allowanceMismatches,
  describeHit,
  readRepoFile,
  repoSources,
  scanSources,
  unallowedHits,
  type Allowance,
  type GuardSpec,
  type SourceHit,
} from "./_helpers/sourceGuard";

const PREFS_MODULE = "src/modules/prefs.ts";

/**
 * Both pref APIs and the XPCOM service behind them. The scanner also resolves a
 * receiver reached through `globalThis`, `window` or a local alias.
 */
const PREF_API: GuardSpec = {
  members: [
    { member: "Prefs", receivers: ["Zotero"] },
    { member: "prefs", receivers: ["Services"] },
  ],
  contractIds: ["@mozilla.org/preferences-service;1"],
};

/** The only sites that may reach a pref API: the functions in prefs.ts that call Zotero.Prefs. */
const PREF_SITES: readonly Allowance[] = [
  {
    file: PREFS_MODULE,
    fn: "getPref",
    member: "Prefs",
    count: 3,
    why: "reads the real name, falls back to the doubled legacy name, and copies that value forward",
  },
  {
    file: PREFS_MODULE,
    fn: "setPref",
    member: "Prefs",
    count: 2,
    why: "writes the real name, and the doubled name for a flag a downgraded copy reads",
  },
  {
    file: PREFS_MODULE,
    fn: "setTimestampPref",
    member: "Prefs",
    count: 1,
    why: "writes a timestamp as a decimal string",
  },
];

/**
 * The 0-based argument each Zotero.Prefs method takes `global` in:
 * `get(pref, global)`, `set(pref, value, global)`, `clear(pref, global)`.
 */
const GLOBAL_ARGUMENT: ReadonlyMap<string, number> = new Map([
  ["get", 1],
  ["set", 2],
  ["clear", 1],
]);

/** Every direct reach for a pref API in `sources` that {@link PREF_SITES} does not allow. */
function accessViolations(sources: Readonly<Record<string, string>>): SourceHit[] {
  return unallowedHits(scanSources(sources, PREF_API), PREF_SITES);
}

/**
 * One message per Zotero.Prefs hit in prefs.ts that does not pass a literal
 * `true` as `global`. An argument counts only when its whole source text is
 * `true`, which only the `true` keyword can be, so a constant, an expression or
 * a missing argument fails. A hit that is not a direct call to a method in
 * {@link GLOBAL_ARGUMENT} cannot be checked, and fails too.
 */
function globalArgumentProblems(hits: readonly SourceHit[]): string[] {
  return hits
    .filter((hit) => hit.file === PREFS_MODULE && hit.member === "Prefs")
    .flatMap((hit) => {
      const index = hit.call ? GLOBAL_ARGUMENT.get(hit.call.method) : undefined;
      if (!hit.call || index === undefined) {
        return [`${describeHit(hit)}: not a get, set or clear call, so global cannot be checked`];
      }
      const arg = hit.call.args[index];
      if (arg === "true") return [];
      return [
        `${describeHit(hit)}: passes ${arg === undefined ? "no global" : `${arg} as global`}`,
      ];
    });
}

describe("preference access goes through prefs.ts (U18)", () => {
  const sources = repoSources();
  let hits: SourceHit[] = [];

  // The whole-tree scan runs once, under a hook budget sized for the parallel
  // suite, so the assertions below only compare results.
  beforeAll(() => {
    hits = scanSources(sources, PREF_API);
  }, 60_000);

  it("scans the whole src tree, and finds prefs.ts reading and writing Zotero.Prefs (positive control)", () => {
    expect(Object.keys(sources).length, "expected to scan the whole src tree").toBeGreaterThan(20);
    const methods = hits.filter((hit) => hit.file === PREFS_MODULE).map((hit) => hit.call?.method);
    expect(methods).toContain("get");
    expect(methods).toContain("set");
  });

  it("no src module but prefs.ts reaches Zotero.Prefs, Services.prefs or the preferences service", () => {
    expect(
      unallowedHits(hits, PREF_SITES).map(describeHit),
      `route these through ${PREFS_MODULE}`,
    ).toEqual([]);
  });

  it("every allowance still matches its site exactly, so none outlives its reason or covers a new call", () => {
    expect(allowanceMismatches(hits, PREF_SITES)).toEqual([]);
  });

  it("prefs.ts passes a literal `true` as `global` on every Zotero.Prefs call", () => {
    expect(globalArgumentProblems(hits)).toEqual([]);
  });

  it("the settings pane and addon/prefs.js name only Citegeist pref constants, none read from a legacy name", () => {
    const known = new Set(
      Object.entries(constants)
        .filter(([key]) => key.startsWith("PREF_"))
        .map(([, value]) => value),
    );
    const bound = [
      ...readRepoFile("addon/content/preferences.xhtml").matchAll(/preference="([^"]+)"/g),
    ].map((m) => m[1]);
    const defaulted = [...readRepoFile("addon/prefs.js").matchAll(/^pref\("([^"]+)"/gm)].map(
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

describe("the preference guard is wired to its spec", () => {
  const FIXTURE_FILE = "src/modules/fixture.ts";

  const OUTSIDE: ReadonlyArray<readonly [string, string, Pick<SourceHit, "member" | "form">]> = [
    [
      "Prefs destructured from Zotero",
      "const { Prefs } = Zotero;\nexport const on = Prefs.get(PREF_AUTO_FETCH);",
      { member: "Prefs", form: "destructuring" },
    ],
    [
      "Zotero.Prefs by bracket",
      'export const on = Zotero["Prefs"].get(PREF_AUTO_FETCH);',
      { member: "Prefs", form: "element" },
    ],
    [
      "Services.prefs",
      "export const on = Services.prefs.getBoolPref(PREF_AUTO_FETCH);",
      { member: "prefs", form: "property" },
    ],
    [
      "the preferences service by contract id",
      'export const branch = Components.classes["@mozilla.org/preferences-service;1"].getService();',
      { member: "@mozilla.org/preferences-service;1", form: "string" },
    ],
  ];

  it.each(OUTSIDE)("flags %s outside prefs.ts", (_name, source, expected) => {
    const flagged = accessViolations({ [FIXTURE_FILE]: source });
    expect(flagged.map(({ member, form }) => ({ member, form }))).toEqual([expected]);
  });

  it("flags a Zotero.Prefs call in prefs.ts outside the functions allowed, so the file is not exempt", () => {
    const source =
      "export function readStray(name: string) {\n  return Zotero.Prefs.get(name, true);\n}";
    expect(accessViolations({ [PREFS_MODULE]: source }).map((hit) => hit.fn)).toEqual([
      "readStray",
    ]);
  });

  it("flags nothing that only names a pref API: comments, strings, types, other members and receivers", () => {
    const NEGATIVE = [
      "/** Read with `Zotero.Prefs.get(name, true)`, never `Services.prefs`. */",
      '// Zotero["Prefs"] and const { Prefs } = Zotero /* not a block opener',
      '/* Components.classes["@mozilla.org/preferences-service;1"] */',
      'import { getPref } from "./prefs";',
      "type PrefsApi = typeof Zotero.Prefs;",
      'type Contract = "@mozilla.org/preferences-service;1";',
      "export const on = getPref(PREF_AUTO_FETCH);",
      "export const items = Zotero.Items;",
      "export const prompt = Services.prompt;",
      "export const other = Other.Prefs;",
      'export const hint = "set it with Zotero.Prefs.set(name, value, true)";',
      'export const cid = "the @mozilla.org/preferences-service;1 contract";',
      "export const local = { Prefs: 1, prefs: 2 };",
      "export function take({ Prefs }: { Prefs: unknown }) {",
      "  return Prefs;",
      "}",
    ].join("\n");

    expect(accessViolations({ [FIXTURE_FILE]: NEGATIVE }).map(describeHit)).toEqual([]);
    // Positive control: the fixture parses as code.
    const items = scanSources(
      { [FIXTURE_FILE]: NEGATIVE },
      { members: [{ member: "Items", receivers: ["Zotero"] }] },
    );
    expect(items.map((hit) => hit.line)).toEqual([8]);
  });

  const GLOBAL_EVASIONS: ReadonlyArray<readonly [string, string]> = [
    [
      "a read whose name is a nested call, with no global",
      "export function getPref(name: string) {\n  return Zotero.Prefs.get(String(name));\n}",
    ],
    [
      "a write with no global",
      "export function setPref(name: string, value: string) {\n  Zotero.Prefs.set(name, value);\n}",
    ],
    [
      "a global that is a constant, not the literal",
      "const GLOBAL = true;\nexport function setPref(name: string, value: string) {\n  Zotero.Prefs.set(name, value, GLOBAL);\n}",
    ],
    [
      "true passed as a write's value, not its global",
      "export function setPref(name: string) {\n  Zotero.Prefs.set(name, true);\n}",
    ],
    [
      "a clear with no global",
      "export function clearPref(name: string) {\n  Zotero.Prefs.clear(name);\n}",
    ],
    [
      "a call to a method the check does not know",
      "export function watch(name: string, fn: () => void) {\n  Zotero.Prefs.registerObserver(name, fn, true);\n}",
    ],
    ["a reference that is not a call", "export const prefsApi = Zotero.Prefs;"],
  ];

  it.each(GLOBAL_EVASIONS)("the global check flags %s", (_name, source) => {
    const problems = globalArgumentProblems(scanSources({ [PREFS_MODULE]: source }, PREF_API));
    expect(problems).toHaveLength(1);
  });

  it("the global check passes get, set and clear with a literal true, however the call is spelled", () => {
    const source = [
      "export function readIt(name: string) {",
      "  return Zotero.Prefs.get(String(name), true);",
      "}",
      "export function writeIt(name: string, value: string) {",
      "  Zotero.Prefs.set(ZOTERO_PREF_BRANCH + name, (value), /* global */ true);",
      "  Zotero?.Prefs?.clear(name, true);",
      "}",
    ].join("\n");
    const hits = scanSources({ [PREFS_MODULE]: source }, PREF_API);

    expect(hits, "positive control: the fixture calls Zotero.Prefs three times").toHaveLength(3);
    expect(globalArgumentProblems(hits)).toEqual([]);
  });
});

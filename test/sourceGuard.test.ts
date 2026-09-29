/**
 * Tests for test/_helpers/sourceGuard.ts, the AST scanner the source-invariant
 * guards run on.
 *
 * Every access form has fixtures the scanner must report, each fixture is shown
 * to depend on the detector for its form (it goes unreported without it), and a
 * negative fixture holds everything that names an API without reaching it:
 * comments, strings, types, other receivers and definitions.
 */

import { describe, expect, it } from "vitest";
import {
  ACCESS_FORMS,
  allowanceMismatches,
  repoSources,
  scanSource,
  scanSources,
  unallowedHits,
  type Allowance,
  type GuardSpec,
  type SourceHit,
} from "./_helpers/sourceGuard";

/** Shaped like the preference guard: members on named globals, and a contract id. */
const PREFS: GuardSpec = {
  members: [
    { member: "Prefs", receivers: ["Zotero"] },
    { member: "prefs", receivers: ["Services"] },
  ],
  contractIds: ["@mozilla.org/preferences-service;1"],
};

/** Shaped like the selection guard: a member whose name alone identifies the API. */
const SELECTION: GuardSpec = { members: [{ member: "getSelectedCollection" }] };

const FILE = "src/modules/fixture.ts";

type Expected = Pick<SourceHit, "member" | "form" | "line"> &
  Partial<Pick<SourceHit, "fn" | "receiver">>;

interface Fixture {
  readonly name: string;
  readonly spec: GuardSpec;
  readonly source: string;
  readonly hits: readonly Expected[];
}

const prefsHit = (form: Expected["form"], line = 1): Expected => ({
  member: "Prefs",
  form,
  line,
  receiver: "Zotero",
});

const FIXTURES: readonly Fixture[] = [
  {
    name: "dotted access",
    spec: PREFS,
    source: 'export const on = Zotero.Prefs.get("autoFetch", true);',
    hits: [{ ...prefsHit("property"), fn: "<module>" }],
  },
  {
    name: "optional chaining",
    spec: PREFS,
    source: 'export const on = Zotero?.Prefs?.get("autoFetch", true);',
    hits: [prefsHit("property")],
  },
  {
    name: "a second named receiver",
    spec: PREFS,
    source: 'Services.prefs.setIntPref("pageSize", 50);',
    hits: [{ member: "prefs", form: "property", line: 1, receiver: "Services" }],
  },
  {
    name: "an alias made with bind",
    spec: PREFS,
    source: "export const get = Zotero.Prefs.get.bind(Zotero.Prefs);",
    hits: [prefsHit("property"), prefsHit("property")],
  },
  {
    name: "bracket access",
    spec: PREFS,
    source: 'export const on = Zotero["Prefs"].get("autoFetch", true);',
    hits: [prefsHit("element")],
  },
  {
    name: "optional bracket access with a template key",
    spec: PREFS,
    source: 'export const on = Zotero?.[`Prefs`]?.get("autoFetch", true);',
    hits: [prefsHit("element")],
  },
  {
    name: "bracket access with a concatenated key",
    spec: PREFS,
    source: 'export const on = Zotero["Pre" + "fs"].get("autoFetch", true);',
    hits: [prefsHit("element")],
  },
  {
    name: "bracket access with a key held in a const",
    spec: PREFS,
    source: 'const key = "Prefs";\nexport const on = Zotero[key].get("autoFetch", true);',
    hits: [prefsHit("element", 2)],
  },
  {
    name: "Reflect.get",
    spec: PREFS,
    source: 'export const prefs = Reflect.get(Zotero, "Prefs");',
    hits: [prefsHit("element")],
  },
  {
    name: "Reflect.has",
    spec: PREFS,
    source: 'export const has = Reflect.has(Zotero, "Prefs");',
    hits: [prefsHit("element")],
  },
  {
    name: "Object.getOwnPropertyDescriptor",
    spec: PREFS,
    source: 'export const prefs = Object.getOwnPropertyDescriptor(Zotero, "Prefs");',
    hits: [prefsHit("element")],
  },
  {
    name: "an in check",
    spec: PREFS,
    source: 'export const has = "Prefs" in Zotero;',
    hits: [prefsHit("element")],
  },
  {
    name: "destructuring",
    spec: PREFS,
    source: 'const { Prefs } = Zotero;\nexport const on = Prefs.get("autoFetch", true);',
    hits: [prefsHit("destructuring")],
  },
  {
    name: "renamed destructuring",
    spec: PREFS,
    source: "const { Prefs: p } = Zotero;",
    hits: [prefsHit("destructuring")],
  },
  {
    name: "destructuring with a computed key",
    spec: PREFS,
    source: 'const { ["Pre" + "fs"]: p } = Zotero;',
    hits: [prefsHit("destructuring")],
  },
  {
    name: "nested destructuring from globalThis",
    spec: PREFS,
    source: "const { Zotero: { Prefs } } = globalThis;",
    hits: [prefsHit("destructuring")],
  },
  {
    name: "a parameter pattern that defaults to the receiver",
    spec: PREFS,
    source: "export function read({ Prefs } = Zotero) {\n  return Prefs;\n}",
    hits: [{ ...prefsHit("destructuring"), fn: "read" }],
  },
  {
    name: "destructuring an alias",
    spec: PREFS,
    source: "const z = Zotero;\nconst { Prefs } = z;",
    hits: [prefsHit("destructuring", 2)],
  },
  {
    name: "destructuring assignment",
    spec: PREFS,
    source: "let p: unknown;\n({ Prefs: p } = Zotero);",
    hits: [prefsHit("destructuring-assignment", 2)],
  },
  {
    name: "a receiver alias",
    spec: PREFS,
    source: 'const z = Zotero;\nexport const on = z.Prefs.get("autoFetch", true);',
    hits: [prefsHit("property", 2)],
  },
  {
    name: "an alias of an alias",
    spec: PREFS,
    source: 'const a = Zotero;\nconst b = a;\nexport const on = b["Prefs"].get("autoFetch", true);',
    hits: [prefsHit("element", 3)],
  },
  {
    name: "an alias assigned after its declaration",
    spec: PREFS,
    source: "let z: unknown;\nz = Zotero;\nexport const p = (z as typeof Zotero).Prefs;",
    hits: [prefsHit("property", 3)],
  },
  {
    name: "an alias destructured from globalThis",
    spec: PREFS,
    source: "const { Zotero: z } = globalThis;\nexport const p = z.Prefs;",
    hits: [prefsHit("property", 2)],
  },
  {
    name: "a cast receiver",
    spec: PREFS,
    source: "export const p = (Zotero as unknown as { Prefs: unknown }).Prefs;",
    hits: [prefsHit("property")],
  },
  {
    name: "a non-null receiver",
    spec: PREFS,
    source: "export const p = Zotero!.Prefs;",
    hits: [prefsHit("property")],
  },
  {
    name: "a receiver reached through globalThis",
    spec: PREFS,
    source: "export const p = globalThis.Zotero.Prefs;",
    hits: [prefsHit("property")],
  },
  {
    name: "a receiver reached through self",
    spec: PREFS,
    source: "export const p = self.Zotero.Prefs;",
    hits: [prefsHit("property")],
  },
  {
    name: "a receiver reached through a window bracket",
    spec: PREFS,
    source: 'export const p = window["Zotero"].Prefs;',
    hits: [prefsHit("property")],
  },
  {
    name: "a contract id used as a key",
    spec: PREFS,
    source:
      'export const service = Components.classes["@mozilla.org/preferences-service;1"].getService();',
    hits: [{ member: "@mozilla.org/preferences-service;1", form: "string", line: 1 }],
  },
  {
    name: "a contract id built in a const",
    spec: PREFS,
    source: 'const CID = "@mozilla.org/preferences-service;" + "1";',
    hits: [{ member: "@mozilla.org/preferences-service;1", form: "string", line: 1 }],
  },
  {
    name: "code after a line comment holding /*",
    spec: PREFS,
    source:
      '// a stray /* in a line comment\nexport const on = Zotero.Prefs.get("autoFetch", true);\n// closes */ here',
    hits: [prefsHit("property", 2)],
  },
  {
    name: "code between strings holding /* and */",
    spec: PREFS,
    source:
      'const open = "/*";\nexport const on = Zotero.Prefs.get("autoFetch", true);\nconst close = "*/";',
    hits: [prefsHit("property", 2)],
  },
  {
    name: "code on a line that a template string starts with //",
    spec: PREFS,
    source: 'const note = `\n// `; export const on = Zotero.Prefs.get("autoFetch", true);',
    hits: [prefsHit("property", 2)],
  },
  {
    name: "a member watched on any receiver",
    spec: SELECTION,
    source: "export const col = win.ZoteroPane?.getSelectedCollection?.();",
    hits: [{ member: "getSelectedCollection", form: "property", line: 1 }],
  },
  {
    name: "a member watched on any receiver, read through a key held as a string",
    spec: SELECTION,
    source: 'const key = "getSelectedCollection";\nexport const col = pane[key]();',
    hits: [
      { member: "getSelectedCollection", form: "string", line: 1 },
      { member: "getSelectedCollection", form: "element", line: 2 },
    ],
  },
  {
    name: "a member watched on any receiver, as a context field",
    spec: SELECTION,
    source: "export const col = ctx.getSelectedCollection;",
    hits: [{ member: "getSelectedCollection", form: "property", line: 1 }],
  },
  {
    name: "a member watched on any receiver, through an alias made with bind",
    spec: SELECTION,
    source: "export const read = pane.getSelectedCollection.bind(pane);",
    hits: [{ member: "getSelectedCollection", form: "property", line: 1 }],
  },
  {
    name: "a member watched on any receiver, through bracket access",
    spec: SELECTION,
    source: 'export const col = pane["getSelectedCollection"]();',
    hits: [{ member: "getSelectedCollection", form: "element", line: 1 }],
  },
  {
    name: "a member watched on any receiver, through optional bracket access with a template key",
    spec: SELECTION,
    source: "export const col = pane?.[`getSelectedCollection`]?.();",
    hits: [{ member: "getSelectedCollection", form: "element", line: 1 }],
  },
  {
    name: "a member watched on any receiver, through a concatenated key",
    spec: SELECTION,
    source: 'export const col = pane["getSelected" + "Collection"]();',
    hits: [{ member: "getSelectedCollection", form: "element", line: 1 }],
  },
  {
    name: "a member watched on any receiver, through Reflect.get",
    spec: SELECTION,
    source: 'export const read = Reflect.get(pane, "getSelectedCollection");',
    hits: [{ member: "getSelectedCollection", form: "element", line: 1 }],
  },
  {
    name: "a member watched on any receiver, in an in check",
    spec: SELECTION,
    source: 'export const has = "getSelectedCollection" in ctx;',
    hits: [{ member: "getSelectedCollection", form: "element", line: 1 }],
  },
  {
    name: "a member watched on any receiver, through renamed destructuring",
    spec: SELECTION,
    source: "const { getSelectedCollection: read } = pane;",
    hits: [{ member: "getSelectedCollection", form: "destructuring", line: 1 }],
  },
  {
    name: "a member watched on any receiver, destructured from a parameter",
    spec: SELECTION,
    source:
      "export function first({ getSelectedCollection }: Pane) {\n  return getSelectedCollection();\n}",
    hits: [{ member: "getSelectedCollection", form: "destructuring", line: 1, fn: "first" }],
  },
  {
    name: "a member watched on any receiver, in a destructuring assignment",
    spec: SELECTION,
    source: "let read: unknown;\n({ getSelectedCollection: read } = pane);",
    hits: [{ member: "getSelectedCollection", form: "destructuring-assignment", line: 2 }],
  },
];

const cases = FIXTURES.map((fixture) => [fixture.name, fixture] as const);

describe("scanSource reports every way of reaching a watched member", () => {
  it.each(cases)("%s", (_name, fixture) => {
    expect(scanSource(FILE, fixture.source, fixture.spec)).toEqual(
      fixture.hits.map((hit) => expect.objectContaining(hit)),
    );
  });

  it.each(cases)("%s goes unreported without the detector for its form", (_name, fixture) => {
    const expected = new Set(fixture.hits.map((hit) => hit.form));
    const others = new Set(ACCESS_FORMS.filter((form) => !expected.has(form)));
    expect(scanSource(FILE, fixture.source, fixture.spec, { forms: others })).toEqual([]);
  });

  it("has a fixture for every form", () => {
    expect(new Set(FIXTURES.flatMap((f) => f.hits.map((hit) => hit.form)))).toEqual(
      new Set(ACCESS_FORMS),
    );
  });
});

describe("scanSource reports nothing that only names an API", () => {
  const NEGATIVE = [
    "/** Read with `Zotero.Prefs.get(name, true)`, never `Services.prefs`. */",
    '// Zotero.Prefs.get returns undefined /* not a block */ Zotero["Prefs"]',
    "/* const { Prefs } = Zotero; pane.getSelectedCollection(); */",
    'import type { Prefs } from "./types";',
    "interface Host {",
    "  Prefs: unknown;",
    "  getSelectedCollection(): void;",
    "}",
    'type Key = "Prefs" | "getSelectedCollection" | "@mozilla.org/preferences-service;1";',
    "type Api = typeof Zotero.Prefs;",
    'export const message = "use Zotero.Prefs.get(name, true), not getSelectedCollection()";',
    'export const cid = "the @mozilla.org/preferences-service;1 contract";',
    "export const note = `Zotero.Prefs and getSelectedCollection() are named here only`;",
    "export const items = Zotero.Items;",
    "export const prompt = Services.prompt;",
    "export const other = Other.Prefs;",
    "const notZotero = Other;",
    "export const viaOther = notZotero.Prefs;",
    "export const plural = pane.getSelectedCollections();",
    "export const local = { Prefs: 1, getSelectedCollection: () => undefined };",
    'export const quoted = { "getSelectedCollection": 1 };',
    "export const flags = { prefs: true }.prefs;",
    "export function take({ Prefs }: { Prefs: unknown }) {",
    "  return Prefs;",
    "}",
  ].join("\n");

  it("for comments, strings, types, other receivers, other members and definitions", () => {
    expect(scanSource(FILE, NEGATIVE, PREFS)).toEqual([]);
    expect(scanSource(FILE, NEGATIVE, SELECTION)).toEqual([]);
  });

  it("while still parsing that fixture as code (positive control)", () => {
    const items = scanSource(FILE, NEGATIVE, {
      members: [{ member: "Items", receivers: ["Zotero"] }],
    });
    expect(items).toEqual([expect.objectContaining({ member: "Items", line: 14 })]);
  });
});

describe("what a hit records", () => {
  it("names the function each hit is in", () => {
    const source = [
      "function declared() { return Zotero.Prefs; }",
      "const arrow = () => Zotero.Prefs;",
      "class Holder {",
      "  method() { return Zotero.Prefs; }",
      "  field = () => Zotero.Prefs;",
      "  get value() { return Zotero.Prefs; }",
      "}",
      "function outer() {",
      "  [1].forEach(() => Zotero.Prefs);",
      "  return { handler: () => Zotero.Prefs };",
      "}",
      "export const top = Zotero.Prefs;",
    ].join("\n");
    expect(scanSource(FILE, source, PREFS).map((hit) => [hit.line, hit.fn])).toEqual([
      [1, "declared"],
      [2, "arrow"],
      [4, "method"],
      [5, "field"],
      [6, "value"],
      [9, "outer"],
      [10, "outer"],
      [12, "<module>"],
    ]);
  });

  it("records the method call a hit is the object of, with its argument texts", () => {
    const source = [
      "Zotero.Prefs.get(name, true);",
      "Zotero.Prefs?.set(name, value, true);",
      "export const bare = Zotero.Prefs;",
    ].join("\n");
    const [get, set, bare] = scanSource(FILE, source, PREFS);
    expect(get.call).toEqual({ method: "get", args: ["name", "true"] });
    expect(set.call).toEqual({ method: "set", args: ["name", "value", "true"] });
    expect(bare.call).toBeUndefined();
    expect(bare.text).toBe("export const bare = Zotero.Prefs;");
  });

  it("scanSources keeps each hit's file", () => {
    const hits = scanSources(
      { "src/a.ts": "Zotero.Prefs.get(name, true);", "src/b.ts": "export const x = 1;" },
      PREFS,
    );
    expect(hits.map((hit) => hit.file)).toEqual(["src/a.ts"]);
  });

  it("scans the repo's own source, and finds prefs.ts reaching Zotero.Prefs (positive control)", () => {
    const sources = repoSources();
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    const prefs = scanSources({ "src/modules/prefs.ts": sources["src/modules/prefs.ts"] }, PREFS);
    expect(prefs.length).toBeGreaterThanOrEqual(3);
    for (const hit of prefs) expect(hit).toMatchObject({ member: "Prefs", receiver: "Zotero" });
  });
});

describe("allowances are keyed by file, function and member, and counted", () => {
  const source = [
    "function reader() {",
    '  const a = Zotero.Prefs.get("a", true); const b = pane.getSelectedCollection();',
    '  return Zotero.Prefs.get("b", true);',
    "}",
    "function other() { return Zotero.Prefs; }",
  ].join("\n");
  const spec: GuardSpec = { members: [...(PREFS.members ?? []), ...(SELECTION.members ?? [])] };
  const hits = scanSource("src/modules/reader.ts", source, spec);
  const reader: Allowance = {
    file: "src/modules/reader.ts",
    fn: "reader",
    member: "Prefs",
    count: 2,
    why: "the one reader",
  };
  const where = (list: readonly SourceHit[]) => list.map((h) => [h.line, h.fn, h.member]);

  it("excuse a site's hits up to its count, and no other member on the same line or other function", () => {
    expect(where(unallowedHits(hits, [reader]))).toEqual([
      [2, "reader", "getSelectedCollection"],
      [5, "other", "Prefs"],
    ]);
  });

  it("leave every hit past the count unexcused", () => {
    expect(where(unallowedHits(hits, [{ ...reader, count: 1 }]))).toEqual([
      [2, "reader", "getSelectedCollection"],
      [3, "reader", "Prefs"],
      [5, "other", "Prefs"],
    ]);
  });

  it("report a site that no longer has exactly its count, whether it grew or is gone", () => {
    expect(allowanceMismatches(hits, [reader])).toEqual([]);
    expect(allowanceMismatches(hits, [{ ...reader, count: 1 }])).toEqual([
      expect.stringContaining("reader reaches Prefs 2 time(s), allowed 1"),
    ]);
    expect(allowanceMismatches(hits, [{ ...reader, fn: "gone" }])).toEqual([
      expect.stringContaining("gone reaches Prefs 0 time(s), allowed 2"),
    ]);
  });
});

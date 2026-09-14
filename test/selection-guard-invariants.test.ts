/**
 * Guard for reading the Zotero selection.
 *
 * Two host facts make a stray selection read a bug that shows only on a real
 * Zotero. On Zotero 10 the singular collection-tree getters throw on a multi-row
 * selection and otherwise log a removed-API warning, on release and beta builds
 * alike. And `Zotero.getActiveZoteroPane()` is the most recent window's pane,
 * while Zotero's own context menus act on the right-clicked window's.
 * `src/modules/host/selection.ts` handles both, so no other module may read the
 * selection, and that module reads a singular getter only as the fallback for a
 * host without the plural one.
 *
 * Static source assertions, like diagnostics-guard-invariants.test.ts: the
 * failure mode is a call that exists, which no mocked runtime test observes. The
 * scan runs on the TypeScript AST (test/_helpers/sourceGuard.ts), so a comment or
 * a string can neither hide a read nor fake one, and an exemption names the
 * function and member it covers rather than a line.
 */
import { describe, expect, it } from "vitest";
import {
  ACCESS_FORMS,
  allowanceMismatches,
  describeHit,
  readRepoFile,
  repoSources,
  scanSources,
  unallowedHits,
  type AccessForm,
  type Allowance,
  type GuardSpec,
  type ScanOptions,
  type SourceHit,
} from "./_helpers/sourceGuard";

const SELECTION_MODULE = "src/modules/host/selection.ts";

/** Zotero 10's singular getters and context field: each throws on a multi-row selection. */
const SINGULAR_READS = [
  "getSelectedCollection",
  "getSelectedLibraryID",
  "getCollectionTreeRow",
  "collectionTreeRow",
];

/** The rest of the selection surface: safe on Zotero 10, but which pane and window they read is decided in one place. */
const OTHER_READS = [
  "getSelectedCollections",
  "getSelectedLibraryIDs",
  "getCollectionTreeRows",
  "collectionTreeRows",
  "getSelectedItems",
  "getActiveZoteroPane",
];

const onAnyReceiver = (names: readonly string[]): GuardSpec => ({
  members: names.map((member) => ({ member })),
});
const SINGULAR = onAnyReceiver(SINGULAR_READS);
const ANY_SELECTION_READ = onAnyReceiver([...SINGULAR_READS, ...OTHER_READS]);

/** In the selection module, each singular read sits where the plural form was checked first. */
const SINGULAR_FALLBACKS: readonly Allowance[] = [
  {
    file: SELECTION_MODULE,
    fn: "collectionTargetsFromMenuContext",
    member: "collectionTreeRow",
    count: 2,
    why: "Zotero 8 and 9 contexts: an `in` check, then the read, only when collectionTreeRows is absent",
  },
  {
    file: SELECTION_MODULE,
    fn: "collectionTargetsFromPane",
    member: "getCollectionTreeRow",
    count: 2,
    why: "Zotero 7 to 9 panes: a typeof check, then the call, only when getCollectionTreeRows is absent",
  },
  {
    file: SELECTION_MODULE,
    fn: "selectedCollectionsFromPane",
    member: "getSelectedCollection",
    count: 2,
    why: "Zotero 7 to 9 panes: a typeof check, then the call, only when getSelectedCollections is absent",
  },
];

/** Outside the selection module: sites that use a guarded name but read no selection. */
const OUTSIDE_ALLOWED: readonly Allowance[] = [
  {
    file: "src/modules/citationColumn.ts",
    fn: "scheduleColumnRepaint",
    member: "getActiveZoteroPane",
    why: "repaints the most recent window's item tree and reads no selection",
  },
];

function split(sources: Readonly<Record<string, string>>): {
  inModule: Record<string, string>;
  outside: Record<string, string>;
} {
  const inModule: Record<string, string> = {};
  const outside: Record<string, string> = {};
  for (const [file, text] of Object.entries(sources)) {
    (file === SELECTION_MODULE ? inModule : outside)[file] = text;
  }
  return { inModule, outside };
}

/** Every selection read in `sources` that the rules above do not allow. */
function selectionViolations(
  sources: Readonly<Record<string, string>>,
  options?: ScanOptions,
): SourceHit[] {
  const { inModule, outside } = split(sources);
  return [
    ...unallowedHits(scanSources(inModule, SINGULAR, options), SINGULAR_FALLBACKS),
    ...unallowedHits(scanSources(outside, ANY_SELECTION_READ, options), OUTSIDE_ALLOWED),
  ];
}

describe("the Zotero selection is read only in src/modules/host/selection.ts", () => {
  const sources = repoSources();

  it("scans the whole src tree, and finds the reads the selection module makes (positive control)", () => {
    expect(Object.keys(sources).length, "expected to scan the whole src tree").toBeGreaterThan(20);
    const members = scanSources(
      { [SELECTION_MODULE]: sources[SELECTION_MODULE] },
      ANY_SELECTION_READ,
    ).map((hit) => hit.member);
    for (const read of [
      "getCollectionTreeRows",
      "collectionTreeRows",
      "getSelectedCollections",
      "getSelectedItems",
      "getActiveZoteroPane",
      "getCollectionTreeRow",
      "collectionTreeRow",
      "getSelectedCollection",
    ]) {
      expect(members, `${SELECTION_MODULE} no longer reads ${read}`).toContain(read);
    }
  });

  it("no other src module reads the selection, and the selection module reads a singular getter only as a fallback", () => {
    expect(
      selectionViolations(sources).map(describeHit),
      `route these reads through ${SELECTION_MODULE}`,
    ).toEqual([]);
  });

  it("every allowance still matches its site exactly, so none outlives its reason or covers a new read", () => {
    const { inModule, outside } = split(sources);
    expect([
      ...allowanceMismatches(scanSources(inModule, SINGULAR), SINGULAR_FALLBACKS),
      ...allowanceMismatches(scanSources(outside, ANY_SELECTION_READ), OUTSIDE_ALLOWED),
    ]).toEqual([]);
  });

  it("the typings declare no getSelectedLibraryID getter, so a stray call fails tsc", () => {
    expect(readRepoFile("typings/zotero.d.ts")).not.toMatch(/\bgetSelectedLibraryIDs?\s*[?(]/);
  });
});

describe("the selection guard catches every way around it", () => {
  const FIXTURE_FILE = "src/modules/fixture.ts";

  interface Evasion {
    readonly name: string;
    /** Scanned as this file; an ordinary module by default. */
    readonly file?: string;
    readonly source: string;
    readonly member: string;
    /** The forms that must flag it, and without which it goes unflagged. */
    readonly forms: readonly AccessForm[];
  }

  const EVASIONS: readonly Evasion[] = [
    {
      name: "a direct call",
      source: "export const col = pane.getSelectedCollection();",
      member: "getSelectedCollection",
      forms: ["property"],
    },
    {
      name: "an optional call",
      source: "export const row = pane?.getCollectionTreeRow?.();",
      member: "getCollectionTreeRow",
      forms: ["property"],
    },
    {
      name: "a context field",
      source: "export const row = ctx.collectionTreeRow;",
      member: "collectionTreeRow",
      forms: ["property"],
    },
    {
      name: "an alias made with bind",
      source: "export const read = pane.getSelectedLibraryID.bind(pane);",
      member: "getSelectedLibraryID",
      forms: ["property"],
    },
    {
      name: "an alias made by assignment",
      source: "let read: unknown;\nread = pane.getCollectionTreeRow;",
      member: "getCollectionTreeRow",
      forms: ["property"],
    },
    {
      name: "bracket access",
      source: 'export const row = pane["getCollectionTreeRow"]();',
      member: "getCollectionTreeRow",
      forms: ["element"],
    },
    {
      name: "optional bracket access with a template key",
      source: "export const col = pane?.[`getSelectedCollection`]?.();",
      member: "getSelectedCollection",
      forms: ["element"],
    },
    {
      name: "bracket access with a concatenated key",
      source: 'export const id = pane["getSelected" + "LibraryID"]();',
      member: "getSelectedLibraryID",
      forms: ["element"],
    },
    {
      name: "a key held in a constant",
      source: 'const key = "getCollectionTreeRow";\nexport const row = pane[key]();',
      member: "getCollectionTreeRow",
      forms: ["string", "element"],
    },
    {
      name: "Reflect.get",
      source: 'export const read = Reflect.get(pane, "getSelectedCollection");',
      member: "getSelectedCollection",
      forms: ["element"],
    },
    {
      name: "an in check on the context",
      source: 'export const has = "collectionTreeRow" in ctx;',
      member: "collectionTreeRow",
      forms: ["element"],
    },
    {
      name: "destructuring",
      source:
        "const { getSelectedCollection } = pane;\nexport const col = getSelectedCollection();",
      member: "getSelectedCollection",
      forms: ["destructuring"],
    },
    {
      name: "renamed destructuring",
      source: "const { getCollectionTreeRow: read } = pane;",
      member: "getCollectionTreeRow",
      forms: ["destructuring"],
    },
    {
      name: "destructuring a parameter",
      source: "export function rowOf({ collectionTreeRow }: Ctx) {\n  return collectionTreeRow;\n}",
      member: "collectionTreeRow",
      forms: ["destructuring"],
    },
    {
      name: "destructuring assignment",
      source: "let read: unknown;\n({ getSelectedLibraryID: read } = pane);",
      member: "getSelectedLibraryID",
      forms: ["destructuring-assignment"],
    },
    {
      name: "code after a line comment holding /*",
      source:
        "// a stray /* in a line comment\nexport const col = pane.getSelectedCollection();\n// closes */",
      member: "getSelectedCollection",
      forms: ["property"],
    },
    {
      name: "code between strings holding /* and */",
      source:
        'const open = "/*";\nexport const row = pane.getCollectionTreeRow();\nconst close = "*/";',
      member: "getCollectionTreeRow",
      forms: ["property"],
    },
    {
      name: "code on a line that a template string starts with //",
      source: "const note = `\n// `; export const col = pane.getSelectedCollection();",
      member: "getSelectedCollection",
      forms: ["property"],
    },
    {
      name: "a read on the same line as an allowed one",
      file: "src/modules/citationColumn.ts",
      source:
        "function scheduleColumnRepaint(): void {\n  const view = Zotero.getActiveZoteroPane()?.itemsView; const col = pane.getSelectedCollection();\n}",
      member: "getSelectedCollection",
      forms: ["property"],
    },
    {
      name: "a second read of the allowed member in the allowed function",
      file: "src/modules/citationColumn.ts",
      source:
        "function scheduleColumnRepaint(): void {\n  const view = Zotero.getActiveZoteroPane()?.itemsView;\n  const pane = Zotero.getActiveZoteroPane();\n}",
      member: "getActiveZoteroPane",
      forms: ["property"],
    },
    {
      name: "a singular read in the selection module outside its fallbacks",
      file: SELECTION_MODULE,
      source:
        "export function defaultCollection(pane: Pane) {\n  return pane.getSelectedCollection();\n}",
      member: "getSelectedCollection",
      forms: ["property"],
    },
    {
      name: "a plural read outside the selection module",
      source: "export const rows = pane.getCollectionTreeRows();",
      member: "getCollectionTreeRows",
      forms: ["property"],
    },
  ];

  const cases = EVASIONS.map((evasion) => [evasion.name, evasion] as const);
  const flaggedForms = (evasion: Evasion, options?: ScanOptions) =>
    selectionViolations({ [evasion.file ?? FIXTURE_FILE]: evasion.source }, options)
      .filter((hit) => hit.member === evasion.member)
      .map((hit) => hit.form)
      .sort();

  it.each(cases)("flags %s", (_name, evasion) => {
    expect(flaggedForms(evasion)).toEqual([...evasion.forms].sort());
  });

  it.each(cases)("%s goes unflagged without the detectors that catch it", (_name, evasion) => {
    const without = new Set(ACCESS_FORMS.filter((form) => !evasion.forms.includes(form)));
    expect(flaggedForms(evasion, { forms: without })).toEqual([]);
  });

  it("flags nothing that only names a getter: plural reads in the selection module, comments, strings and types", () => {
    const NEGATIVE = [
      "// pane.getSelectedCollection() is gone on Zotero 10 /* not a block opener",
      "/* A block comment naming getCollectionTreeRow() and ctx.collectionTreeRow */",
      "/** JSDoc: `getSelectedLibraryID()` was removed. */",
      'type Row = Pick<Pane, "getCollectionTreeRow" | "getSelectedCollection">;',
      "export function readRows(pane: Pane, ctx: Ctx) {",
      "  const rows = pane.getCollectionTreeRows?.();",
      "  const collections = pane.getSelectedCollections?.();",
      "  const contextRows = ctx.collectionTreeRows;",
      '  const detail = "pane getCollectionTreeRow threw";',
      "  const hint = `use getSelectedCollections() instead of getSelectedCollection()`;",
      '  const url = "https://example.org//getSelectedCollection/*";',
      "  return { rows, collections, contextRows, detail, hint, url };",
      "}",
    ].join("\n");

    expect(selectionViolations({ [SELECTION_MODULE]: NEGATIVE }).map(describeHit)).toEqual([]);
    expect(scanSources({ [FIXTURE_FILE]: NEGATIVE }, SINGULAR).map(describeHit)).toEqual([]);
    // Positive control: the fixture parses as code, and outside the selection
    // module its plural reads are still flagged.
    expect(selectionViolations({ [FIXTURE_FILE]: NEGATIVE }).map((hit) => hit.member)).toEqual([
      "getCollectionTreeRows",
      "getSelectedCollections",
      "collectionTreeRows",
    ]);
  });
});

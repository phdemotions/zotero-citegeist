/**
 * Guard for reading the Zotero selection.
 *
 * Two host facts make a stray selection read a bug that shows only on a real
 * Zotero. On Zotero 10 the singular collection-tree getters throw on a multi-row
 * selection and otherwise log a removed-API warning, on release and beta builds
 * alike. And `Zotero.getActiveZoteroPane()` is the most recent window's pane,
 * while Zotero's own context menus act on the right-clicked window's.
 * `src/modules/host/selection.ts` handles both, so no other module may read the
 * selection.
 *
 * Static source assertions, like diagnostics-guard-invariants.test.ts: the
 * failure mode is a call that exists, which no mocked runtime test observes.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SELECTION_MODULE = "src/modules/host/selection.ts";

function src(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
}

/**
 * Blank out comments without moving lines: block comments (JSDoc included)
 * become spaces and whole-line `//` comments become empty. Trailing inline
 * comments stay, so a string literal holding `//` is never truncated.
 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Every `.ts` under `src/`, repo-relative, so a new module is covered automatically. */
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

/** Selection reads only SELECTION_MODULE may make, each with a line it must catch. */
const SELECTION_READS: ReadonlyArray<{ read: string; pattern: RegExp; sample: string }> = [
  {
    read: "getSelectedCollection(s)",
    pattern: /\bgetSelectedCollections?\b/,
    sample: "const col = pane.getSelectedCollection();",
  },
  {
    read: "getSelectedLibraryID(s)",
    pattern: /\bgetSelectedLibraryIDs?\b/,
    sample: "const id = ZoteroPane.getSelectedLibraryID();",
  },
  {
    read: "getCollectionTreeRow(s)",
    pattern: /\bgetCollectionTreeRows?\b/,
    sample: "const row = pane.getCollectionTreeRow?.();",
  },
  {
    read: "a context's collectionTreeRow(s)",
    pattern: /\bcollectionTreeRows?\b/,
    sample: "const { collectionTreeRow } = ctx;",
  },
  {
    read: "getSelectedItems",
    pattern: /\bgetSelectedItems\b/,
    sample: "const items = ZoteroPane.getSelectedItems();",
  },
  {
    read: "getActiveZoteroPane",
    pattern: /\bgetActiveZoteroPane\b/,
    sample: "const pane = Zotero.getActiveZoteroPane();",
  },
];

/**
 * Lines outside SELECTION_MODULE that may use a guarded name because they read
 * no selection. Each entry names the exact line it permits and fails as stale
 * once that line is gone.
 */
const ALLOWED: ReadonlyArray<{ file: string; line: RegExp; why: string }> = [
  {
    file: "src/modules/citationColumn.ts",
    line: /Zotero\.getActiveZoteroPane\(\)\?\.itemsView\b/,
    why: "repaints the most recent window's item tree and reads no selection",
  },
];

describe("the Zotero selection is read only in src/modules/host/selection.ts", () => {
  it("each guarded pattern catches the read it names (positive control)", () => {
    for (const { read, pattern, sample } of SELECTION_READS) {
      expect(pattern.test(sample), `${read} pattern misses "${sample}"`).toBe(true);
    }
    // The scan reads real source: the selection module itself makes these reads.
    const selection = stripComments(src(SELECTION_MODULE));
    for (const read of [
      "getCollectionTreeRows",
      "collectionTreeRows",
      "getSelectedCollections",
      "getSelectedItems",
      "getActiveZoteroPane",
    ]) {
      expect(selection, `${SELECTION_MODULE} no longer reads ${read}`).toContain(read);
    }
  });

  it("no other src module reads the selection", () => {
    const files = allSrcFiles().filter((f) => f !== SELECTION_MODULE);
    expect(files.length, "expected to scan the whole src tree").toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of files) {
      stripComments(src(file))
        .split("\n")
        .forEach((text, index) => {
          for (const { read, pattern } of SELECTION_READS) {
            if (!pattern.test(text)) continue;
            if (ALLOWED.some((a) => a.file === file && a.line.test(text))) continue;
            offenders.push(`${file}:${index + 1} reads ${read}: ${text.trim()}`);
          }
        });
    }
    expect(offenders, `route these reads through ${SELECTION_MODULE}`).toEqual([]);
  });

  it("every allowlist entry still matches a line, so no exemption outlives its reason", () => {
    for (const { file, line, why } of ALLOWED) {
      expect(stripComments(src(file)), `${file}: ${why}`).toMatch(line);
    }
  });

  it("the typings declare no getSelectedLibraryID getter, so a stray call fails tsc", () => {
    expect(src("typings/zotero.d.ts")).not.toMatch(/\bgetSelectedLibraryIDs?\s*[?(]/);
  });
});

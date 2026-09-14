/**
 * Guards for the cache's single writable choke point (plan U16, KTD11).
 *
 * A write that skips `requireWritableDb` reaches SQLite on a database a newer
 * schema wrote, and the only backstop left is `PRAGMA query_only`, which lives
 * on the connection and can fail or be dropped when Zotero reopens it. Deleting
 * the gate from three separate writers once left every test green, so the
 * shape is checked here, statically, across every file under src/, including
 * files added later:
 *
 * 1. `queryAsync` is called in one place, `runQuery` in cache/db.ts.
 * 2. Every function that issues a write statement gets its connection from
 *    `requireWritableDb`, or takes a `WritableDb` parameter. Only
 *    `requireWritableDb` hands those out, so the compiler follows the
 *    connection from there into every helper.
 * 3. No function that writes also calls `requireDb`, the read accessor. A
 *    writer that holds both could hand the unchecked one to a helper, and
 *    the gate in the same function would still satisfy rule 2.
 * 4. A connection becomes a `WritableDb` by cast in two places only:
 *    `requireWritableDb` and init's schema setup.
 *
 * If a guard fails, fix the code. Never weaken the test.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function src(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
}

/** Remove block comments and whole-line `//` comments (as diagnostics-guard-invariants does). */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

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

const WRITE_KEYWORD = "(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\\s";
/** A write statement opening a string or template literal, or a stamp assignment. */
const WRITE_LITERAL = new RegExp(`[\`"']\\s*${WRITE_KEYWORD}|PRAGMA\\s+user_version\\s*=`);

interface TopLevelFunction {
  readonly file: string;
  readonly name: string;
  /** Declaration up to the body's opening brace: where parameter types live. */
  readonly signature: string;
  readonly body: string;
}

/**
 * Top-level `function` declarations as prettier lays them out: the signature
 * ends at the first line-ending `{`, the body at the first `}` in column 0.
 */
function topLevelFunctions(file: string, code: string): TopLevelFunction[] {
  const lines = code.split("\n");
  const found: TopLevelFunction[] = [];
  for (let i = 0; i < lines.length; i++) {
    const declaration = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/.exec(lines[i]);
    if (!declaration) continue;
    let end = i;
    while (end < lines.length && lines[end] !== "}") end++;
    const text = lines.slice(i, end + 1).join("\n");
    const bodyStart = text.search(/\{\n/);
    found.push({
      file,
      name: declaration[1],
      signature: text.slice(0, bodyStart),
      body: text.slice(bodyStart),
    });
    i = end;
  }
  return found;
}

/** Module constants holding a write statement, such as UPSERT_SQL or SCHEMA. */
function writeSqlConstants(code: string): string[] {
  const pattern = new RegExp(
    `^(?:export\\s+)?const\\s+(\\w+)\\s*=\\s*\`\\s*${WRITE_KEYWORD}`,
    "gm",
  );
  return [...code.matchAll(pattern)].map((match) => match[1]);
}

const files = allSrcFiles().map((file) => ({ file, code: stripComments(src(file)) }));
const functions = files.flatMap(({ file, code }) => topLevelFunctions(file, code));
const writers = files.flatMap(({ file, code }) => {
  const constants = writeSqlConstants(code);
  return topLevelFunctions(file, code).filter(
    (fn) =>
      WRITE_LITERAL.test(fn.body) ||
      constants.some((name) => new RegExp(`\\b${name}\\b`).test(fn.body)),
  );
});
const label = (fn: TopLevelFunction): string => `${fn.file}:${fn.name}`;

describe("cache write invariants", () => {
  it("calls queryAsync only inside runQuery", () => {
    const calls = files.flatMap(({ file, code }) =>
      [...code.matchAll(/\.queryAsync\s*[<(]/g)].map(() => file),
    );
    expect(calls, "queryAsync called outside runQuery").toEqual(["src/modules/cache/db.ts"]);
    const runQuery = functions.find(
      (fn) => fn.file === "src/modules/cache/db.ts" && fn.name === "runQuery",
    );
    expect(runQuery?.body).toMatch(/\.queryAsync\s*[<(]/);
  });

  it("detects every writer it guards (positive control)", () => {
    const names = writers.map((fn) => fn.name);
    for (const expected of [
      "openWritable",
      "stampSchema",
      "upsertRow",
      "deleteRow",
      "mutateRow",
      "createAuthorSchema",
      "garbageCollectOrphanAuthors",
      "upsertAuthorIdentity",
      "cacheItemAuthors",
      "setCuratedItemAuthor",
      "updateAuthorMetrics",
      "reconcileAuthorMerge",
      "migrateFromExtraV1",
      "checkpointItem",
      "garbageCollectOrphans",
    ]) {
      expect(names, `${expected} was not detected as a writer`).toContain(expected);
    }
    // And no false positive on a function that only reads.
    expect(names).not.toContain("readSchemaStamp");
    expect(names).not.toContain("getItemAuthors");
  });

  it("every function that issues a write gets its connection from requireWritableDb or takes a WritableDb", () => {
    const unguarded = writers
      .filter(
        (fn) => !/\brequireWritableDb\(/.test(fn.body) && !/:\s*WritableDb\b/.test(fn.signature),
      )
      .map(label);
    expect(unguarded, "these functions write without passing requireWritableDb").toEqual([]);
  });

  it("no function that writes also takes a connection from requireDb", () => {
    const offenders = writers.filter((fn) => /\brequireDb\(/.test(fn.body)).map(label);
    expect(offenders, "these writers hold an unchecked read connection").toEqual([]);
  });

  it("mints a WritableDb by cast only in requireWritableDb and init", () => {
    const casts = functions.filter((fn) => /\bas\s+WritableDb\b/.test(fn.body)).map(label);
    expect(casts.sort()).toEqual([
      "src/modules/cache/db.ts:doInit",
      "src/modules/cache/db.ts:requireWritableDb",
    ]);
    const total = files.reduce(
      (count, { code }) => count + (code.match(/\bas\s+WritableDb\b/g) ?? []).length,
      0,
    );
    expect(total, "a WritableDb cast outside a function").toBe(2);
  });
});

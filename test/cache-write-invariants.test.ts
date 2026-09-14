/**
 * Guards for the cache's write path (plan U16, KTD11).
 *
 * A write that skips the gate reaches a database a newer schema wrote, and a
 * write that commits outside a transaction can be discarded by Zotero 10's idle
 * vacuum (see src/modules/cache/db.ts). The compiler carries most of the proof:
 * `runWrite` takes only a `WriteTransaction`, which only `WritableDb.transaction`
 * makes, and only `requireWritableDb` makes a `WritableDb`. What the types can't
 * see is checked here, on the syntax tree of every file under src/, including
 * files added later:
 *
 * 1. Write SQL, in any case, quote style or constant, in any kind of function, is
 *    only ever the statement argument of `runWrite`, directly or through a
 *    `const` whose every use is.
 * 2. `queryAsync` and `executeTransaction`, by any access form, are reached once
 *    each: in db.ts's private `rawQuery` and `runInTransaction`.
 * 3. No type assertion produces a `WritableDb` or a `WriteTransaction`; each is
 *    constructed in one place and exported as a type only.
 * 4. Every function that passes the write gate commits its writes in a
 *    transaction: one behavioural case per gate caller the syntax tree finds.
 *
 * The evasions a reviewer found are fixtures the guard must fail, and a negative
 * fixture holds legitimate shapes it must pass. If a guard fails, fix the code.
 * Never weaken the test.
 */
import { posix } from "node:path";
import ts from "typescript";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeDb, mockItem, mockZotero, resetCacheHarness } from "./_helpers/cacheHarness";
import {
  allowanceMismatches,
  enclosingFunction,
  parseSource,
  repoSources,
  scanSources,
  unallowedHits,
  unwrap,
  type Allowance,
  type GuardSpec,
  type SourceHit,
} from "./_helpers/sourceGuard";
import {
  _resetForTesting,
  closeCache,
  deleteRow,
  initCache,
  mutateRow,
  requireWritableDb,
  runWrite,
  upsertRow,
  type WriteTransaction,
} from "../src/modules/cache/db";
import {
  cacheItemAuthors,
  reconcileAuthorMerge,
  setCuratedItemAuthor,
  updateAuthorMetrics,
} from "../src/modules/cache/authors/write";
import { garbageCollectOrphans, migrateFromExtraV1 } from "../src/modules/cache/migration";
import { emptyRow } from "../src/modules/cache/types";

// ── The syntax-tree analysis ─────────────────────────────────────────────────

const DB_FILE = "src/modules/cache/db.ts";
const WRITE_HANDLES: ReadonlySet<string> = new Set(["WritableDb", "WriteTransaction"]);
/** Where each handle may be constructed: db.ts, in this function. */
const HANDLE_MINTS: Readonly<Record<string, string>> = {
  WritableDb: "requireWritableDb",
  WriteTransaction: "runInTransaction",
};
/** Stands in for a part of a string that can't be known without running it. */
const SUBSTITUTION = "substituted_value";

const HOST_API: GuardSpec = {
  members: [{ member: "queryAsync" }, { member: "executeTransaction" }],
};
const HOST_API_SITES: readonly Allowance[] = [
  {
    file: DB_FILE,
    fn: "rawQuery",
    member: "queryAsync",
    why: "the one statement helper: it gives every failure a static message",
  },
  {
    file: DB_FILE,
    fn: "runInTransaction",
    member: "executeTransaction",
    why: "the one place a transaction starts",
  },
];

const TABLE = String.raw`[\w"\`\[\].]+`;
/**
 * A statement that changes the file, matched from its start (after comments),
 * in any case. Each shape needs SQL's own grammar after its keyword, so prose
 * such as "Delete from the library" or "Update Citegeist" doesn't match.
 */
const WRITE_SQL = new RegExp(
  "^(?:" +
    [
      String.raw`INSERT\s+(?:OR\s+\w+\s+)?INTO\s+${TABLE}`,
      String.raw`REPLACE\s+INTO\s+${TABLE}`,
      String.raw`UPDATE\s+(?:OR\s+\w+\s+)?${TABLE}\s+SET\s`,
      String.raw`DELETE\s+FROM\s+${TABLE}(?:\s*;?\s*$|\s+WHERE\b|\s+RETURNING\b)`,
      String.raw`CREATE\s+(?:(?:TEMP|TEMPORARY|UNIQUE|VIRTUAL)\s+)*(?:TABLE|INDEX|VIEW|TRIGGER)\s`,
      String.raw`DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)\s`,
      String.raw`ALTER\s+TABLE\s`,
      String.raw`PRAGMA\s+(?:\w+\.)?user_version\s*=`,
      String.raw`(?:VACUUM|REINDEX)(?:\s|;|$)`,
      String.raw`ATTACH\s+(?:DATABASE\s+)?['"?:${SUBSTITUTION[0]}]`,
      String.raw`DETACH\s+(?:DATABASE\s+)?\w+\s*;?\s*$`,
      String.raw`(?:BEGIN|COMMIT|END|ROLLBACK)(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?\s*;?\s*$`,
      String.raw`(?:SAVEPOINT|RELEASE(?:\s+SAVEPOINT)?)\s+\w+\s*;?\s*$`,
      String.raw`WITH\b[\s\S]*\)\s*(?:INSERT|REPLACE|UPDATE|DELETE)\b`,
    ].join("|") +
    ")",
  "i",
);

function isWriteSql(text: string): boolean {
  let sql = text;
  for (;;) {
    const next = sql
      .replace(/^\s+/, "")
      .replace(/^--[^\n]*(?:\n|$)/, "")
      .replace(/^\/\*[\s\S]*?\*\//, "");
    if (next === sql) break;
    sql = next;
  }
  return WRITE_SQL.test(sql);
}

type Rule = "sql" | "host-api" | "handle";

interface Violation {
  readonly rule: Rule;
  readonly file: string;
  readonly line: number;
  readonly fn: string;
  readonly why: string;
  readonly text: string;
}

interface Analysis {
  readonly violations: Violation[];
  /** Every write statement found: the function it sits in, and a const name or `runWrite`. */
  readonly writeSql: Array<{ readonly file: string; readonly fn: string; readonly holder: string }>;
  /** `file:function` for each function that passes the write gate or opens init's transaction. */
  readonly gateCallers: string[];
  /** Every place a walked file reaches `queryAsync` or `executeTransaction`, allowed or not. */
  readonly hostScan: SourceHit[];
}

interface ImportBinding {
  readonly local: string;
  readonly imported: string;
  readonly module: string;
}

interface FileInfo {
  readonly file: string;
  readonly sf: ts.SourceFile;
  readonly constDecls: ts.VariableDeclaration[];
  readonly imports: ImportBinding[];
  /** `export { imported as local } from module`. */
  readonly reexports: ImportBinding[];
  /** `import * as local from module`. */
  readonly namespaces: Map<string, string>;
  /** What each const visible here spells, by local name. */
  texts: Map<string, string>;
  /** Local names bound to a write-SQL const, to the `file#name` that declares it. */
  writeConsts: Map<string, string>;
}

function isWrapper(node: ts.Node): boolean {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  );
}

/** The outermost expression `node` is the value of, through parentheses and assertions. */
function outermost(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent && isWrapper(current.parent)) current = current.parent;
  return current;
}

function isPlus(node: ts.Node | undefined): node is ts.BinaryExpression {
  return (
    node !== undefined &&
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  );
}

/**
 * The text a string-valued expression spells, with each part that can't be known
 * statically as {@link SUBSTITUTION}; undefined when it isn't string-valued.
 */
function spelledText(node: ts.Node, texts: ReadonlyMap<string, string>): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (isWrapper(node)) {
    return spelledText((node as ts.ParenthesizedExpression).expression, texts);
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      out += (spelledText(span.expression, texts) ?? SUBSTITUTION) + span.literal.text;
    }
    return out;
  }
  if (isPlus(node)) {
    const left = spelledText(node.left, texts);
    const right = spelledText(node.right, texts);
    if (left === undefined && right === undefined) return undefined;
    return (left ?? SUBSTITUTION) + (right ?? SUBSTITUTION);
  }
  if (ts.isIdentifier(node)) return texts.get(node.text);
  return undefined;
}

function isConstDeclaration(decl: ts.VariableDeclaration): boolean {
  return (
    ts.isVariableDeclarationList(decl.parent) && (decl.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

function resolveModule(
  from: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  return [`${base}.ts`, `${base}/index.ts`, base].find((candidate) => files.has(candidate));
}

function collectFile(file: string, sf: ts.SourceFile, files: ReadonlySet<string>): FileInfo {
  const info: FileInfo = {
    file,
    sf,
    constDecls: [],
    imports: [],
    reexports: [],
    namespaces: new Map(),
    texts: new Map(),
    writeConsts: new Map(),
  };
  const walk = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isConstDeclaration(node)
    ) {
      info.constDecls.push(node);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = resolveModule(file, node.moduleSpecifier.text, files);
      const bindings = node.importClause?.namedBindings;
      if (module && bindings && ts.isNamespaceImport(bindings)) {
        info.namespaces.set(bindings.name.text, module);
      } else if (module && bindings) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          info.imports.push({ local: element.name.text, imported, module });
        }
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      const module = resolveModule(file, node.moduleSpecifier.text, files);
      if (module) {
        for (const element of node.exportClause.elements) {
          const imported = (element.propertyName ?? element.name).text;
          info.reexports.push({ local: element.name.text, imported, module });
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return info;
}

function sameEntries(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  return a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);
}

/** Const texts and write-SQL consts for every file, followed through imports and re-exports. */
function resolveConstants(infos: ReadonlyMap<string, FileInfo>): void {
  for (let round = 0; round <= infos.size + 1; round++) {
    let changed = false;
    for (const info of infos.values()) {
      const texts = new Map<string, string>();
      for (const binding of info.imports) {
        const text = infos.get(binding.module)?.texts.get(binding.imported);
        if (text !== undefined) texts.set(binding.local, text);
      }
      for (let pass = 0; pass <= info.constDecls.length; pass++) {
        let grew = false;
        for (const decl of info.constDecls) {
          const name = (decl.name as ts.Identifier).text;
          const text = spelledText(decl.initializer!, texts);
          if (text !== undefined && texts.get(name) !== text) {
            texts.set(name, text);
            grew = true;
          }
        }
        if (!grew) break;
      }
      const writeConsts = new Map<string, string>();
      for (const decl of info.constDecls) {
        const name = (decl.name as ts.Identifier).text;
        const text = texts.get(name);
        if (text !== undefined && isWriteSql(text)) writeConsts.set(name, `${info.file}#${name}`);
      }
      for (const binding of [...info.imports, ...info.reexports]) {
        const exporter = infos.get(binding.module);
        const text = exporter?.texts.get(binding.imported);
        const origin = exporter?.writeConsts.get(binding.imported);
        if (text !== undefined) texts.set(binding.local, text);
        if (origin) writeConsts.set(binding.local, origin);
      }
      if (!sameEntries(texts, info.texts) || !sameEntries(writeConsts, info.writeConsts)) {
        info.texts = texts;
        info.writeConsts = writeConsts;
        changed = true;
      }
    }
    if (!changed) return;
  }
}

/** Whether an identifier reads a binding's value, rather than naming a declaration, key or type. */
function isValueReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isClassDeclaration(parent)) &&
    parent.name === id
  ) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false;
  if (
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isQualifiedName(parent) ||
    ts.isTypeReferenceNode(parent)
  ) {
    return false;
  }
  return true;
}

function namesWriteHandle(type: ts.TypeNode): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) {
      const name = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text;
      if (WRITE_HANDLES.has(name)) found = true;
    }
    ts.forEachChild(node, walk);
  };
  walk(type);
  return found;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/** Collected once per file and text, so a fixture run reuses the src tree's. */
const collected = new Map<string, FileInfo>();

/**
 * Check `walked` (every file, by default) against all of `sources`, through
 * which imports and constants resolve.
 */
function analyse(
  sources: Readonly<Record<string, string>>,
  walked: readonly string[] = Object.keys(sources),
): Analysis {
  const files = new Set(Object.keys(sources));
  const infos = new Map<string, FileInfo>();
  for (const [file, text] of Object.entries(sources)) {
    const key = `${file}\0${text}`;
    let info = collected.get(key);
    if (!info) {
      info = collectFile(file, parseSource(file, text), files);
      collected.set(key, info);
    }
    infos.set(file, info);
  }
  resolveConstants(infos);

  const violations: Violation[] = [];
  const writeSql: Analysis["writeSql"] = [];
  const gateCallers = new Set<string>();
  const mints: Array<{ file: string; fn: string; handle: string; node: ts.Node }> = [];

  const report = (info: FileInfo, rule: Rule, node: ts.Node, why: string): void => {
    const line = info.sf.getLineAndCharacterOfPosition(node.getStart(info.sf)).line + 1;
    const text = (info.sf.text.split(/\r?\n/)[line - 1] ?? "").trim();
    violations.push({ rule, file: info.file, line, fn: enclosingFunction(node), why, text });
  };

  for (const file of walked) {
    const info = infos.get(file)!;
    const fromDb = (imported: string): Set<string> => {
      const names = new Set(
        info.imports
          .filter((b) => b.module === DB_FILE && b.imported === imported)
          .map((b) => b.local),
      );
      if (info.file === DB_FILE) names.add(imported);
      return names;
    };
    const runWriteNames = fromDb("runWrite");
    const gateNames = fromDb("requireWritableDb");
    const dbNamespaces = new Set(
      [...info.namespaces].filter(([, module]) => module === DB_FILE).map(([name]) => name),
    );

    /** Whether `callee` is db.ts's `name`, by import, alias or namespace. */
    const calleeIs = (callee: ts.Expression, names: ReadonlySet<string>, name: string): boolean => {
      const target = unwrap(callee);
      if (ts.isIdentifier(target)) return names.has(target.text);
      return (
        ts.isPropertyAccessExpression(target) &&
        ts.isIdentifier(target.expression) &&
        dbNamespaces.has(target.expression.text) &&
        target.name.text === name
      );
    };

    const isRunWriteStatement = (holder: ts.Node): boolean => {
      const call = holder.parent;
      return (
        call !== undefined &&
        ts.isCallExpression(call) &&
        call.arguments[1] === holder &&
        calleeIs(call.expression, runWriteNames, "runWrite")
      );
    };

    const checkReference = (ref: ts.Node, name: string): void => {
      const holder = outermost(ref);
      if (isRunWriteStatement(holder)) return;
      let top: ts.Node = holder;
      while (
        top.parent &&
        (isPlus(top.parent) ||
          ts.isTemplateSpan(top.parent) ||
          ts.isTemplateExpression(top.parent) ||
          isWrapper(top.parent))
      ) {
        top = top.parent;
      }
      const composed = top !== holder ? spelledText(top, info.texts) : undefined;
      if (composed !== undefined && isWriteSql(composed)) return;
      report(
        info,
        "sql",
        ref,
        `write SQL constant ${name} used other than as runWrite's statement`,
      );
    };

    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) ||
        ts.isExportDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isTypeNode(node)
      ) {
        return;
      }

      if (
        (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
        namesWriteHandle(node.type)
      ) {
        report(info, "handle", node, "a type assertion makes a write handle");
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        if (WRITE_HANDLES.has(node.expression.text)) {
          mints.push({
            file: info.file,
            fn: enclosingFunction(node),
            handle: node.expression.text,
            node,
          });
        }
      }

      if (ts.isCallExpression(node)) {
        const fn = enclosingFunction(node);
        if (calleeIs(node.expression, gateNames, "requireWritableDb")) {
          gateCallers.add(`${info.file}:${fn}`);
        }
        const callee = unwrap(node.expression);
        if (
          info.file === DB_FILE &&
          ts.isIdentifier(callee) &&
          callee.text === "runInTransaction"
        ) {
          if (fn !== "transaction") gateCallers.add(`${info.file}:${fn}`);
          if (fn !== "transaction" && fn !== "openWritable") {
            report(
              info,
              "handle",
              node,
              "a transaction opened outside WritableDb.transaction and init",
            );
          }
        }
        if (
          info.file === DB_FILE &&
          ts.isIdentifier(callee) &&
          callee.text === "rawQuery" &&
          !["runRead", "runWrite", "applyQueryOnly"].includes(fn)
        ) {
          report(
            info,
            "host-api",
            node,
            "rawQuery called outside runRead, runWrite and applyQueryOnly",
          );
        }
      }

      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node) ||
        isPlus(node)
      ) {
        const text = spelledText(node, info.texts);
        const holder = outermost(node);
        const parent = holder.parent;
        const partOfLarger =
          parent !== undefined &&
          (ts.isTemplateSpan(parent) ||
            (isPlus(parent) && spelledText(parent, info.texts) !== undefined));
        if (text !== undefined && !partOfLarger && isWriteSql(text)) {
          const fn = enclosingFunction(node);
          if (
            parent &&
            ts.isVariableDeclaration(parent) &&
            parent.initializer === holder &&
            ts.isIdentifier(parent.name) &&
            isConstDeclaration(parent)
          ) {
            writeSql.push({ file: info.file, fn, holder: parent.name.text });
          } else if (isRunWriteStatement(holder)) {
            writeSql.push({ file: info.file, fn, holder: "runWrite" });
          } else {
            report(info, "sql", node, "write SQL that is not runWrite's statement argument");
          }
        }
      }

      if (ts.isIdentifier(node) && info.writeConsts.has(node.text) && isValueReference(node)) {
        checkReference(node, node.text);
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const module = info.namespaces.get(node.expression.text);
        if (module && infos.get(module)?.writeConsts.has(node.name.text)) {
          checkReference(node, `${node.expression.text}.${node.name.text}`);
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(info.sf);
  }

  // Each handle is constructed in its one place, once.
  for (const mint of mints) {
    if (mint.file !== DB_FILE || mint.fn !== HANDLE_MINTS[mint.handle]) {
      report(
        infos.get(mint.file)!,
        "handle",
        mint.node,
        `${mint.handle} constructed outside ${HANDLE_MINTS[mint.handle]}`,
      );
    }
  }
  const db = walked.includes(DB_FILE) ? infos.get(DB_FILE) : undefined;
  for (const [handle, fn] of Object.entries(HANDLE_MINTS)) {
    const allowed = mints.filter((m) => m.handle === handle && m.file === DB_FILE && m.fn === fn);
    if (db && allowed.length !== 1) {
      report(
        db,
        "handle",
        db.sf,
        `${handle} constructed ${allowed.length} time(s) in ${fn}, not once`,
      );
    }
  }
  // The handles are exported as types only, and the two private helpers not at all.
  if (db) {
    const privateHelpers = new Set(["rawQuery", "runInTransaction"]);
    for (const statement of db.sf.statements) {
      if (
        (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) &&
        statement.name &&
        (WRITE_HANDLES.has(statement.name.text) || privateHelpers.has(statement.name.text)) &&
        hasExportModifier(statement)
      ) {
        report(db, "handle", statement, `${statement.name.text} is exported`);
      }
      if (
        ts.isExportDeclaration(statement) &&
        !statement.moduleSpecifier &&
        statement.exportClause
      ) {
        if (!ts.isNamedExports(statement.exportClause)) continue;
        for (const element of statement.exportClause.elements) {
          const name = (element.propertyName ?? element.name).text;
          const typeOnly = statement.isTypeOnly || element.isTypeOnly;
          if ((WRITE_HANDLES.has(name) && !typeOnly) || privateHelpers.has(name)) {
            report(db, "handle", element, `${name} is exported as a value`);
          }
        }
      }
    }
  }

  const walkedSources = Object.fromEntries(walked.map((file) => [file, sources[file]]));
  const hostScan = scanSources(walkedSources, HOST_API);
  for (const hit of unallowedHits(hostScan, HOST_API_SITES)) {
    violations.push({
      rule: "host-api",
      file: hit.file,
      line: hit.line,
      fn: hit.fn,
      text: hit.text,
      why: `${hit.member} reached outside its one db.ts helper`,
    });
  }

  return { violations, writeSql, gateCallers: [...gateCallers].sort(), hostScan };
}

function describeViolation(v: Violation): string {
  return `${v.rule} ${v.file}:${v.line} in ${v.fn}: ${v.why}: ${v.text}`;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FIXTURE = "src/modules/cache/guardFixture.ts";

const EVASIONS: ReadonlyArray<{ name: string; rule: Rule; source: string }> = [
  {
    name: "a writer written as an arrow function (review u16-static-arrow)",
    rule: "sql",
    source: `import { requireDb, runRead } from "./db";
import type { CacheItemKey } from "./types";

export const forgetItem = async (item: CacheItemKey): Promise<void> => {
  const conn = requireDb();
  await runRead(conn, \`DELETE FROM item_cache WHERE library_id = ? AND item_key = ?\`, [item.libraryID, item.key], []);
};
`,
  },
  {
    name: "lower-case SQL",
    rule: "sql",
    source: `import { requireDb, runRead } from "./db";

export async function forgetAll(): Promise<void> {
  await runRead(requireDb(), "delete from item_cache", undefined, []);
}
`,
  },
  {
    name: "queryAsync reached by element access",
    rule: "host-api",
    source: `import { requireDb } from "./db";

export async function countRows(): Promise<unknown> {
  const conn = requireDb();
  return conn["queryAsync"]("SELECT COUNT(*) AS n FROM item_cache");
}
`,
  },
  {
    name: "a WriteTransaction made with an angle-bracket assertion",
    rule: "handle",
    source: `import { requireDb, runWrite, type WriteTransaction } from "./db";

export async function forgetAll(): Promise<void> {
  const tx = <WriteTransaction>(<unknown>requireDb());
  await runWrite(tx, "DELETE FROM item_cache");
}
`,
  },
  {
    name: "SQL held in a double-quoted module constant (review u16-static-dq-const)",
    rule: "sql",
    source: `import { requireDb, runRead } from "./db";
import type { CacheItemKey } from "./types";

const FORGET_SQL = "DELETE FROM item_cache WHERE library_id = ? AND item_key = ?";

export async function forgetItem(item: CacheItemKey): Promise<void> {
  await runRead(requireDb(), FORGET_SQL, [item.libraryID, item.key], []);
}
`,
  },
  {
    name: "a write through the read helper (review control)",
    rule: "sql",
    source: `import { requireDb, runRead } from "./db";

export async function purgeControl(): Promise<void> {
  await runRead(requireDb(), "DELETE FROM item_cache", undefined, []);
}
`,
  },
  {
    name: "a WritableDb made with as",
    rule: "handle",
    source: `import { requireDb, type WritableDb } from "./db";

export function writable(): WritableDb {
  return requireDb() as unknown as WritableDb;
}
`,
  },
  {
    name: "SQL concatenated onto a table name",
    rule: "sql",
    source: `import { requireDb, runRead } from "./db";

export async function clearTable(table: string): Promise<void> {
  await runRead(requireDb(), "DELETE FROM " + table, undefined, []);
}
`,
  },
  {
    name: "a write constant handed to runWrite through another function",
    rule: "sql",
    source: `import { runWrite, type WriteTransaction } from "./db";

const FORGET_SQL = \`DELETE FROM item_cache\`;
const statementFor = (): string => FORGET_SQL;

export async function forgetAll(tx: WriteTransaction): Promise<void> {
  await runWrite(tx, statementFor());
}
`,
  },
  {
    name: "queryAsync taken by destructuring",
    rule: "host-api",
    source: `import { requireDb } from "./db";

export async function rows(): Promise<unknown> {
  const { queryAsync } = requireDb();
  return queryAsync("SELECT 1");
}
`,
  },
  {
    name: "a transaction opened outside db.ts",
    rule: "host-api",
    source: `import { requireDb } from "./db";

export async function inTransaction(): Promise<void> {
  await requireDb().executeTransaction(async () => {});
}
`,
  },
];

/** Shapes the guard must pass: gated writes, reads, and prose, comments and types that mention SQL or the host API. */
const NEGATIVE = `import { requireDb, requireWritableDb, runRead, runWrite, type WriteTransaction } from "./db";

// DELETE FROM item_cache and conn.queryAsync(...) in a comment count for nothing.
const UPSERT_SQL = \`INSERT OR REPLACE INTO item_cache (\${["library_id"].join(", ")}) VALUES (?)\`;
const WHERE_KEY = " WHERE library_id = ?";
const DELETE_SQL = \`DELETE FROM item_cache\${WHERE_KEY}\`;
type Query = _ZoteroTypes.DBConnection["queryAsync"];

export const HELP = "Delete from the library, then update Citegeist from Tools, Plugins.";
export const NOTE = "Select all, then create a collection and replace into it.";

async function write(tx: WriteTransaction): Promise<void> {
  await runWrite(tx, UPSERT_SQL, [1]);
  await runWrite(tx, DELETE_SQL, [1]);
  await runWrite(tx, "delete from migration_progress");
}

export async function legitimate(): Promise<Query | null> {
  await requireWritableDb("legitimate").transaction(write);
  await runRead(requireDb(), "SELECT library_id FROM item_cache", undefined, ["library_id"]);
  return null;
}
`;

// ── Behavioural cases: one per gate caller ───────────────────────────────────

interface WriterCase {
  readonly seed?: () => Promise<unknown>;
  readonly run: () => Promise<unknown>;
}

const row = (key: string) => ({ ...emptyRow(1, key), open_alex_id: "W1", cited_by_count: 1 });

const migration: WriterCase = {
  seed: async () => {
    mockZotero.Items.getAll.mockResolvedValue([
      mockItem("MIG", "Citegeist.openAlexId: W12\nCitegeist.citedByCount: 3"),
    ]);
  },
  run: () => migrateFromExtraV1(),
};

const WRITER_CASES: Readonly<Record<string, WriterCase>> = {
  "src/modules/cache/authors/write.ts:cacheItemAuthors": {
    run: () => cacheItemAuthors({ libraryID: 1, key: "AUTH" }, [{ author: { id: "A1" } }]),
  },
  "src/modules/cache/authors/write.ts:reconcileAuthorMerge": {
    seed: () => cacheItemAuthors({ libraryID: 1, key: "AUTH" }, [{ author: { id: "A1" } }]),
    run: () => reconcileAuthorMerge("A1", "A2"),
  },
  "src/modules/cache/authors/write.ts:setCuratedItemAuthor": {
    run: () => setCuratedItemAuthor({ libraryID: 1, key: "AUTH" }, "A3", 0),
  },
  "src/modules/cache/authors/write.ts:updateAuthorMetrics": {
    run: () =>
      updateAuthorMetrics("A4", {
        worksCount: 1,
        citedByCount: 1,
        hIndex: 1,
        i10Index: 1,
        lastFetched: "2026-09-13T00:00:00.000Z",
      }),
  },
  "src/modules/cache/db.ts:deleteRow": {
    seed: () => upsertRow(row("DEL")),
    run: () => deleteRow(1, "DEL"),
  },
  "src/modules/cache/db.ts:mutateRow": { run: () => mutateRow(1, "MUT", () => row("MUT")) },
  "src/modules/cache/db.ts:openWritable": { seed: () => closeCache(), run: () => initCache() },
  "src/modules/cache/db.ts:upsertRow": { run: () => upsertRow(row("UPS")) },
  "src/modules/cache/migration.ts:garbageCollectOrphans": {
    seed: () => upsertRow(row("ORPHAN")),
    run: () => garbageCollectOrphans({ force: true }),
  },
  "src/modules/cache/migration.ts:migrateFromExtraV1": migration,
  "src/modules/cache/migration.ts:runMigrationLoop": migration,
};

const WRITE_STATEMENT =
  /^(?:CREATE|DELETE|DROP|INSERT|UPDATE|REPLACE|ALTER)\b|^PRAGMA\s+user_version\s*=/i;

// ── Tests ────────────────────────────────────────────────────────────────────

describe("cache write invariants", () => {
  let sources: Record<string, string>;
  let src: Analysis;

  beforeAll(() => {
    sources = repoSources();
    src = analyse(sources);
  }, 60_000);

  it("finds no write outside runWrite, no host API outside its helper, and no made write handle", () => {
    expect(src.violations.map(describeViolation)).toEqual([]);
  });

  it("keeps each host API site exactly as allowed", () => {
    expect(allowanceMismatches(src.hostScan, HOST_API_SITES)).toEqual([]);
  });

  it("detects the write statements it guards, and no read (positive control)", () => {
    const found = src.writeSql.map(
      (s) => `${s.file.replace("src/modules/cache/", "")} ${s.fn} ${s.holder}`,
    );
    for (const expected of [
      "db.ts <module> UPSERT_SQL",
      "db.ts deleteRow runWrite",
      "schema.ts <module> ITEM_CACHE_SCHEMA",
      "schema.ts <module> MIGRATION_PROGRESS_SCHEMA",
      "schema.ts createSchema runWrite",
      "authors/db.ts <module> AUTHORS_SCHEMA",
      "authors/db.ts <module> ITEM_AUTHORS_SCHEMA",
      "authors/db.ts deleteOrphanItemAuthors runWrite",
      "authors/db.ts deleteUnreferencedAuthors runWrite",
      "authors/write.ts upsertAuthorIdentity runWrite",
      "authors/write.ts cacheItemAuthors runWrite",
      "authors/write.ts setCuratedItemAuthor runWrite",
      "authors/write.ts updateAuthorMetrics runWrite",
      "authors/write.ts reconcileAuthorMerge runWrite",
      "migration.ts checkpointItem runWrite",
      "migration.ts migrateFromExtraV1 runWrite",
      "migration.ts garbageCollectOrphans runWrite",
    ]) {
      expect(found, `${expected} was not detected`).toContain(expected);
    }
    const readers = [
      "readSchemaStamp",
      "loadMirrorRows",
      "getItemAuthors",
      "getAuthor",
      "applyQueryOnly",
    ];
    expect(src.writeSql.filter((s) => readers.includes(s.fn) || s.holder === "MIRROR_SQL")).toEqual(
      [],
    );
  });

  it("has one behavioural case below for every function that passes the write gate", () => {
    expect(src.gateCallers).toEqual(Object.keys(WRITER_CASES).sort());
  });

  it.each(EVASIONS)("fails $name", ({ rule, source }) => {
    const found = analyse({ ...sources, [FIXTURE]: source }, [FIXTURE]).violations;
    expect(
      found.map((v) => v.rule),
      found.map(describeViolation).join("\n"),
    ).toContain(rule);
  });

  it("passes legitimate writes, reads, and prose, comments and types that name SQL or the host API", () => {
    const found = analyse({ ...sources, [FIXTURE]: NEGATIVE }, [FIXTURE]).violations;
    expect(found.map(describeViolation)).toEqual([]);
  });
});

describe("cache writes commit in transactions", () => {
  beforeEach(async () => {
    await resetCacheHarness(initCache, _resetForTesting);
  });

  it.each(Object.entries(WRITER_CASES))(
    "%s commits every write it issues inside a transaction",
    async (_name, { seed, run }) => {
      await seed?.();
      const commitsBefore = fakeDb.transactions.commitCount;
      const from = fakeDb.statements.length;

      await run();

      const writes = fakeDb.statements.slice(from).filter((s) => WRITE_STATEMENT.test(s.sql));
      expect(writes.length, "positive control: the case wrote").toBeGreaterThan(0);
      expect(writes.filter((s) => s.transaction === null)).toEqual([]);
      expect(fakeDb.transactions.commitCount).toBeGreaterThan(commitsBefore);
    },
  );

  it("refuses a statement through a transaction that has ended, before it reaches the database", async () => {
    let leaked: WriteTransaction | undefined;
    await requireWritableDb("leak").transaction(async (tx) => {
      leaked = tx;
    });
    const from = fakeDb.statements.length;

    await expect(runWrite(leaked!, "DELETE FROM item_cache")).rejects.toMatchObject({
      code: "CG-BUG01",
    });
    expect(fakeDb.statements.length).toBe(from);
  });

  it("fails a write issued outside a transaction on the fake (positive control for the cases above)", async () => {
    await expect(fakeDb.queryAsync("DELETE FROM item_cache")).rejects.toThrow(
      /outside a transaction/,
    );
  });
});

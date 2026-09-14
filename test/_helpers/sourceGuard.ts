/**
 * AST source guards: find every place a source file reaches a named API.
 *
 * Invariant tests such as selection-guard-invariants.test.ts assert that one
 * module alone touches a host API. A text scan fails them both ways: stripping
 * comments with a regex can blank out real code (a `/*` inside a `//` comment or
 * a string), and prose that names the API can look like a call. This helper
 * parses each file with the TypeScript compiler instead, so comments never
 * count and a string counts only as the exact value a rule names. Each hit
 * carries its file, line, enclosing function and member, and an allowlist is
 * keyed on the same three.
 *
 * What counts as reaching a member, by {@link AccessForm}:
 * - `property`: `recv.member` and `recv?.member`. An alias made with `.bind` or
 *   by assignment starts with this access, so it is caught here.
 * - `element`: `recv["member"]` and `recv?.["member"]`, with the key spelled as a
 *   template, concatenated from literals, or held in a `const`; also
 *   `Reflect.get(recv, "member")` (and `has`, `getOwnPropertyDescriptor`) and
 *   `"member" in recv`.
 * - `destructuring`: `const { member } = recv`, renamed and computed keys, nested
 *   patterns, and parameter patterns whose default is the receiver.
 * - `destructuring-assignment`: `({ member: x } = recv)`.
 * - `string`: a contract id wherever it appears, and the name of a member watched
 *   on any receiver wherever it is not already a key above, such as a constant
 *   holding it for later.
 *
 * A receiver is resolved through parentheses, casts and non-null assertions,
 * through `globalThis`, `window` and `self`, and through local aliases
 * (`const z = Zotero`, `z = Zotero`, `const { Zotero: z } = globalThis`). A
 * receiver passed into a function as an argument is not followed, and neither is
 * a key computed at run time: those are the limits of a static check.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** How a hit reaches its member. See the module docblock. */
export type AccessForm =
  | "property"
  | "element"
  | "destructuring"
  | "destructuring-assignment"
  | "string";

export const ACCESS_FORMS: readonly AccessForm[] = [
  "property",
  "element",
  "destructuring",
  "destructuring-assignment",
  "string",
];

export interface MemberRule {
  /** The member name, e.g. `"Prefs"` or `"getSelectedCollection"`. */
  readonly member: string;
  /**
   * The globals the member counts on, e.g. `["Zotero"]`. Omit for a member whose
   * name alone identifies the API (`getSelectedCollection` on any pane); the bare
   * name then also counts as a `string` hit.
   */
  readonly receivers?: readonly string[];
}

export interface GuardSpec {
  readonly members?: readonly MemberRule[];
  /** Strings that name an API outright, e.g. `"@mozilla.org/preferences-service;1"`. */
  readonly contractIds?: readonly string[];
}

export interface SourceHit {
  /** The path the source was scanned under, repo-relative for repo files. */
  readonly file: string;
  /** 1-based line of the member name, key or string. */
  readonly line: number;
  /**
   * The named function the hit is in: a function declaration, a class member, or
   * a function or arrow bound to a variable. A callback or an object-literal
   * handler belongs to the named function that defines it. Top-level code is
   * `"<module>"`.
   */
  readonly fn: string;
  /** The member name, or the contract id for a contract hit. */
  readonly member: string;
  readonly form: AccessForm;
  /** The global the member was read from, for a rule that names receivers. */
  readonly receiver?: string;
  /** For `recv.member.method(args)`: the method and each argument's source text. */
  readonly call?: { readonly method: string; readonly args: readonly string[] };
  /** The trimmed source line. */
  readonly text: string;
}

export interface ScanOptions {
  /** Report only these forms. Tests use it to show that a fixture depends on its detector. */
  readonly forms?: ReadonlySet<AccessForm>;
}

/** A place a watched API may be touched: one function in one file, `count` times. */
export interface Allowance {
  readonly file: string;
  /** The function name, as {@link SourceHit.fn} reports it. */
  readonly fn: string;
  readonly member: string;
  /** Hits the site may have. Default 1, so a second read in the same function is not excused. */
  readonly count?: number;
  /** Why this site may touch the API. */
  readonly why: string;
}

const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(["globalThis", "window", "self"]);

/** Calls that look a key up on an object, with the object first and the key second. */
const KEYED_LOOKUPS: ReadonlySet<string> = new Set([
  "Reflect.get",
  "Reflect.has",
  "Reflect.getOwnPropertyDescriptor",
  "Object.getOwnPropertyDescriptor",
]);

// ── Scanning ─────────────────────────────────────────────────────────────────

/** Every hit `spec` names in one source file. */
export function scanSource(
  file: string,
  source: string,
  spec: GuardSpec,
  options: ScanOptions = {},
): SourceHit[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = source.split(/\r?\n/);
  const forms = options.forms ?? new Set(ACCESS_FORMS);
  const rules = spec.members ?? [];
  const contractIds = new Set(spec.contractIds ?? []);
  const bareNames = new Set(rules.filter((r) => !r.receivers?.length).map((r) => r.member));
  const aliasTargets = new Set([...rules.flatMap((r) => r.receivers ?? []), ...GLOBAL_OBJECTS]);
  const consts = constStrings(sf);
  const aliases = new Map<string, string>();
  const hits: SourceHit[] = [];

  /** A key or member name as a string: literal, folded, or held in a `const`. */
  const keyOf = (node: ts.Node): string | undefined => foldString(node, consts);

  function propertyName(name: ts.PropertyName): string | undefined {
    if (ts.isComputedPropertyName(name)) return keyOf(name.expression);
    if (ts.isPrivateIdentifier(name)) return undefined;
    return "text" in name ? name.text : undefined;
  }

  /** The global `expr` stands for: an identifier (or its alias), or a global object's property. */
  function receiverOf(expr: ts.Expression): string | undefined {
    const e = unwrap(expr);
    if (ts.isIdentifier(e)) return aliases.get(e.text) ?? e.text;
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const base = receiverOf(e.expression);
      const key = ts.isPropertyAccessExpression(e)
        ? ts.isIdentifier(e.name)
          ? e.name.text
          : undefined
        : keyOf(e.argumentExpression);
      return base !== undefined && GLOBAL_OBJECTS.has(base) ? key : undefined;
    }
    return undefined;
  }

  /** The receiver an object binding pattern destructures. */
  function patternReceiver(pattern: ts.ObjectBindingPattern): string | undefined {
    const holder = pattern.parent;
    if (ts.isVariableDeclaration(holder) || ts.isParameter(holder)) {
      return holder.initializer ? receiverOf(holder.initializer) : undefined;
    }
    if (ts.isBindingElement(holder) && ts.isObjectBindingPattern(holder.parent)) {
      const outer = patternReceiver(holder.parent);
      const key = holder.propertyName ? propertyName(holder.propertyName) : undefined;
      if (outer !== undefined && GLOBAL_OBJECTS.has(outer)) return key;
      return holder.initializer ? receiverOf(holder.initializer) : undefined;
    }
    return undefined;
  }

  /** Whether an object literal is a destructuring-assignment target, and from what. */
  function assignmentTarget(literal: ts.ObjectLiteralExpression): {
    isTarget: boolean;
    receiver?: string;
  } {
    let child: ts.Node = literal;
    let parent = literal.parent;
    while (ts.isParenthesizedExpression(parent)) {
      child = parent;
      parent = parent.parent;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.left === child
    ) {
      return { isTarget: true, receiver: receiverOf(parent.right) };
    }
    if (
      ts.isPropertyAssignment(parent) &&
      parent.initializer === child &&
      ts.isObjectLiteralExpression(parent.parent)
    ) {
      const outer = assignmentTarget(parent.parent);
      if (!outer.isTarget) return { isTarget: false };
      const key = propertyName(parent.name);
      return {
        isTarget: true,
        receiver:
          outer.receiver !== undefined && GLOBAL_OBJECTS.has(outer.receiver) ? key : undefined,
      };
    }
    return { isTarget: false };
  }

  function collectAliases(): void {
    const candidates: Array<{ name: string; resolve: () => string | undefined }> = [];
    const walk = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = node.initializer;
        candidates.push({ name: node.name.text, resolve: () => receiverOf(init) });
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        const right = node.right;
        candidates.push({ name: node.left.text, resolve: () => receiverOf(right) });
      } else if (
        ts.isBindingElement(node) &&
        ts.isIdentifier(node.name) &&
        ts.isObjectBindingPattern(node.parent)
      ) {
        const pattern = node.parent;
        const name = node.name.text;
        const propertyNode = node.propertyName;
        candidates.push({
          name,
          resolve: () => {
            const source = patternReceiver(pattern);
            const key = propertyNode ? propertyName(propertyNode) : name;
            return source !== undefined && GLOBAL_OBJECTS.has(source) ? key : undefined;
          },
        });
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
    // Repeat until nothing changes, so an alias of an alias resolves.
    for (let round = 0; round <= candidates.length; round++) {
      let changed = false;
      for (const { name, resolve } of candidates) {
        const target = resolve();
        if (target === undefined || target === name || !aliasTargets.has(target)) continue;
        if (aliases.get(name) !== target) {
          aliases.set(name, target);
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  /** For `recv.member.method(args)`, the method and its argument texts. */
  function methodCall(access: ts.Node): SourceHit["call"] {
    let outer = access;
    while (ts.isParenthesizedExpression(outer.parent) || ts.isNonNullExpression(outer.parent)) {
      outer = outer.parent;
    }
    const method = outer.parent;
    if (
      !ts.isPropertyAccessExpression(method) ||
      method.expression !== outer ||
      !ts.isIdentifier(method.name)
    ) {
      return undefined;
    }
    const call = method.parent;
    if (!ts.isCallExpression(call) || call.expression !== method) return undefined;
    return { method: method.name.text, args: call.arguments.map((arg) => arg.getText(sf)) };
  }

  function report(
    at: ts.Node,
    form: AccessForm,
    member: string,
    receiver?: string,
    call?: SourceHit["call"],
  ): void {
    if (!forms.has(form)) return;
    const line = sf.getLineAndCharacterOfPosition(at.getStart(sf)).line;
    hits.push({
      file,
      line: line + 1,
      fn: enclosingFunction(at),
      member,
      form,
      ...(receiver !== undefined ? { receiver } : {}),
      ...(call ? { call } : {}),
      text: (lines[line] ?? "").trim(),
    });
  }

  /** Report `name` read from `receiver` when a rule watches it there. */
  function memberHit(
    at: ts.Node,
    form: AccessForm,
    name: string | undefined,
    receiver: string | undefined,
    access?: ts.Node,
  ): void {
    if (name === undefined) return;
    const rule = rules.find(
      (r) =>
        r.member === name &&
        (!r.receivers?.length || (receiver !== undefined && r.receivers.includes(receiver))),
    );
    if (!rule) return;
    const named = rule.receivers?.length ? receiver : undefined;
    report(at, form, name, named, access ? methodCall(access) : undefined);
  }

  /** A string expression that is whole (not part of a longer one) and names a watched API. */
  function checkString(node: ts.Node): void {
    const value = foldString(node);
    if (value === undefined) return;
    if (isStringExpression(node.parent) && foldString(node.parent) !== undefined) return;
    if (contractIds.has(value)) report(node, "string", value);
    else if (bareNames.has(value) && !isKeyOrName(node)) report(node, "string", value);
  }

  function check(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
      memberHit(node.name, "property", node.name.text, receiverOf(node.expression), node);
    } else if (ts.isElementAccessExpression(node)) {
      const key = keyOf(node.argumentExpression);
      memberHit(node.argumentExpression, "element", key, receiverOf(node.expression), node);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) {
      memberHit(node.left, "element", keyOf(node.left), receiverOf(node.right));
    } else if (
      ts.isCallExpression(node) &&
      KEYED_LOOKUPS.has(calleeName(node.expression)) &&
      node.arguments.length >= 2
    ) {
      const [object, key] = node.arguments;
      memberHit(key, "element", keyOf(key), receiverOf(object));
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const name = node.propertyName
        ? propertyName(node.propertyName)
        : ts.isIdentifier(node.name)
          ? node.name.text
          : undefined;
      memberHit(node, "destructuring", name, patternReceiver(node.parent));
    } else if (ts.isObjectLiteralExpression(node)) {
      const target = assignmentTarget(node);
      if (target.isTarget) {
        for (const prop of node.properties) {
          const name = ts.isShorthandPropertyAssignment(prop)
            ? prop.name.text
            : ts.isPropertyAssignment(prop)
              ? propertyName(prop.name)
              : undefined;
          memberHit(prop, "destructuring-assignment", name, target.receiver);
        }
      }
    }
    if (isStringExpression(node)) checkString(node);
  }

  function visit(node: ts.Node): void {
    if (isTypeOnly(node)) return;
    check(node);
    ts.forEachChild(node, visit);
  }

  collectAliases();
  visit(sf);
  return hits;
}

/** Every hit in a file → source map, in file order. */
export function scanSources(
  sources: Readonly<Record<string, string>>,
  spec: GuardSpec,
  options?: ScanOptions,
): SourceHit[] {
  return Object.entries(sources).flatMap(([file, text]) => scanSource(file, text, spec, options));
}

// ── Allowlist ────────────────────────────────────────────────────────────────

/**
 * The hits no allowance covers. An allowance covers hits in its file, function
 * and member, up to its count, in source order; every hit past the count, and
 * every hit for another member on the same line, stays a violation.
 */
export function unallowedHits(
  hits: readonly SourceHit[],
  allowances: readonly Allowance[],
): SourceHit[] {
  const used = new Map<Allowance, number>();
  return hits.filter((hit) => {
    const allowance = allowances.find(
      (a) => a.file === hit.file && a.fn === hit.fn && a.member === hit.member,
    );
    if (!allowance) return true;
    const n = used.get(allowance) ?? 0;
    used.set(allowance, n + 1);
    return n >= (allowance.count ?? 1);
  });
}

/** One message per allowance whose site no longer has exactly `count` hits: stale, or grown. */
export function allowanceMismatches(
  hits: readonly SourceHit[],
  allowances: readonly Allowance[],
): string[] {
  return allowances.flatMap((a) => {
    const found = hits.filter(
      (h) => h.file === a.file && h.fn === a.fn && h.member === a.member,
    ).length;
    const allowed = a.count ?? 1;
    return found === allowed
      ? []
      : [`${a.file} ${a.fn} reaches ${a.member} ${found} time(s), allowed ${allowed}: ${a.why}`];
  });
}

/** A hit as one readable line for an assertion message. */
export function describeHit(hit: SourceHit): string {
  return `${hit.file}:${hit.line} in ${hit.fn}, ${hit.member} (${hit.form}): ${hit.text}`;
}

// ── Repo files ───────────────────────────────────────────────────────────────

const REPO_ROOT = new URL("../../", import.meta.url);

/** A repo file's text, by repo-relative path. */
export function readRepoFile(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, REPO_ROOT)), "utf8");
}

/** Every `.ts` file under `dir`, repo-relative and sorted, so a new module is covered without a list. */
export function repoTsFiles(dir = "src"): string[] {
  const out: string[] = [];
  const abs = fileURLToPath(new URL(`${dir}/`, REPO_ROOT));
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...repoTsFiles(rel));
    else if (entry.name.endsWith(".ts")) out.push(rel);
  }
  return out.sort();
}

/** {@link repoTsFiles} read into the file → source map {@link scanSources} takes. */
export function repoSources(dir = "src"): Record<string, string> {
  return Object.fromEntries(repoTsFiles(dir).map((file) => [file, readRepoFile(file)]));
}

// ── Syntax helpers ───────────────────────────────────────────────────────────

/** Nodes that evaluate nothing: types, interfaces, and import or export declarations. */
function isTypeOnly(node: ts.Node): boolean {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return true;
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return true;
  if (ts.isImportEqualsDeclaration(node)) return true;
  if (ts.isExpressionWithTypeArguments(node)) {
    // A class's `extends Base` evaluates Base; an interface's `extends` does not.
    return !(ts.isHeritageClause(node.parent) && ts.isClassLike(node.parent.parent));
  }
  return ts.isTypeNode(node);
}

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isNonNullExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** An expression that can make up a string value: a literal, a template, `+`, or a wrapper. */
function isStringExpression(node: ts.Node): boolean {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node) ||
    (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  );
}

/**
 * The string `node` evaluates to when that is knowable without running it:
 * literals, templates and `+` of those, through wrappers. With `consts`, an
 * identifier bound to such a string by a `const` folds too.
 */
function foldString(node: ts.Node, consts?: ReadonlyMap<string, string>): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return foldString(node.expression, consts);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldString(node.left, consts);
    if (left === undefined) return undefined;
    const right = foldString(node.right, consts);
    return right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const value = foldString(span.expression, consts);
      if (value === undefined) return undefined;
      out += value + span.literal.text;
    }
    return out;
  }
  if (consts && ts.isIdentifier(node)) return consts.get(node.text);
  return undefined;
}

/** Every `const NAME = <string>` in the file. A name bound to two different strings is dropped. */
function constStrings(sf: ts.SourceFile): Map<string, string> {
  const decls: Array<{ name: string; init: ts.Expression }> = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      decls.push({ name: node.name.text, init: node.initializer });
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  const values = new Map<string, string>();
  const conflicted = new Set<string>();
  for (let round = 0; round <= decls.length; round++) {
    let changed = false;
    for (const { name, init } of decls) {
      if (conflicted.has(name)) continue;
      const value = foldString(init, values);
      if (value === undefined) continue;
      const previous = values.get(name);
      if (previous === undefined) {
        values.set(name, value);
        changed = true;
      } else if (previous !== value) {
        values.delete(name);
        conflicted.add(name);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return values;
}

/** Whether a whole string expression is a key or a declared name rather than a value. */
function isKeyOrName(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isElementAccessExpression(parent)) return parent.argumentExpression === node;
  if (ts.isComputedPropertyName(parent)) return true;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword) {
    return parent.left === node;
  }
  if (ts.isCallExpression(parent) && KEYED_LOOKUPS.has(calleeName(parent.expression))) {
    return parent.arguments[1] === node;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  // A property, method or enum member spelled as a string is a name.
  return (parent as { name?: ts.Node }).name === node;
}

/** `Reflect.get` for `Reflect.get(...)`; empty for anything else. */
function calleeName(expr: ts.Expression): string {
  return ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    ts.isIdentifier(expr.name)
    ? `${expr.expression.text}.${expr.name.text}`
    : "";
}

function enclosingFunction(node: ts.Node): string {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p)) return p.name?.text ?? "default";
    if (ts.isConstructorDeclaration(p)) return "constructor";
    if (
      (ts.isMethodDeclaration(p) ||
        ts.isGetAccessorDeclaration(p) ||
        ts.isSetAccessorDeclaration(p)) &&
      ts.isClassLike(p.parent)
    ) {
      return memberNameText(p.name);
    }
    if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
      if (ts.isFunctionExpression(p) && p.name) return p.name.text;
      let holder: ts.Node = p.parent;
      while (
        ts.isParenthesizedExpression(holder) ||
        ts.isAsExpression(holder) ||
        ts.isSatisfiesExpression(holder)
      ) {
        holder = holder.parent;
      }
      if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) return holder.name.text;
      if (ts.isPropertyDeclaration(holder) && ts.isClassLike(holder.parent)) {
        return memberNameText(holder.name);
      }
    }
  }
  return "<module>";
}

function memberNameText(name: ts.PropertyName): string {
  if (ts.isComputedPropertyName(name)) return foldString(name.expression) ?? "<computed>";
  if (ts.isPrivateIdentifier(name)) return name.text;
  return "text" in name ? name.text : "<computed>";
}

/**
 * Count the Mocha tests a real-Zotero run registers, without Zotero.
 *
 * The scaffold config's `test:bundleTests` hook runs this over the bundles
 * scaffold wrote for Zotero, in the order its generated index.xhtml loads them,
 * and prints the total (harness/runLog.mjs `formatCollectedLine`). CI then
 * requires the run to end with that many passing tests, so a run that collects
 * nothing, or where a spec file fails to load inside Zotero, cannot pass.
 *
 * Each bundle runs in a bare `vm` context whose describe, it and hook functions
 * only record calls. describe bodies execute, so tests generated in a loop
 * count; test and hook bodies never execute. Runs in the scaffold Node process,
 * never inside Zotero.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { SCAFFOLD_TESTER_DIR } from "./scaffold";

export type HookName = "before" | "after" | "beforeEach" | "afterEach";

export interface CollectedFile {
  readonly file: string;
  readonly tests: number;
  /** Hooks registered outside any describe, which Mocha runs for the whole run. */
  readonly rootHooks: Readonly<Record<HookName, number>>;
}

export interface CollectedRun {
  readonly files: readonly CollectedFile[];
  readonly tests: number;
}

/** The spec scripts a scaffold-generated index.xhtml loads, in load order. */
export function specScriptsIn(indexHtml: string): string[] {
  return [...indexHtml.matchAll(/<script src="([^"]+\.(?:spec|test)\.js)"/g)].map((m) => m[1]);
}

/** Count the tests and root hooks one bundled spec file registers. */
export function collectTests(code: string, file: string): CollectedFile {
  let tests = 0;
  let depth = 0;
  const rootHooks: Record<HookName, number> = { before: 0, after: 0, beforeEach: 0, afterEach: 0 };
  const suiteContext = { timeout() {}, slow() {}, retries() {} };
  const hook = (name: HookName) => () => {
    if (depth === 0) rootHooks[name]++;
  };
  const sandbox = {
    describe(_title: string, body: (this: typeof suiteContext) => void) {
      depth++;
      try {
        body.call(suiteContext);
      } finally {
        depth--;
      }
    },
    it() {
      tests++;
    },
    before: hook("before"),
    after: hook("after"),
    beforeEach: hook("beforeEach"),
    afterEach: hook("afterEach"),
  };
  try {
    runInContext(code, createContext(sandbox), { filename: file });
  } catch (e) {
    throw new Error(
      `${file} did not evaluate outside Zotero, so its tests cannot be counted. A spec file ` +
        `may not touch host objects (Zotero, Services, windows) at load time: ` +
        (e instanceof Error ? e.message : String(e)),
    );
  }
  return { file, tests, rootHooks };
}

/** Count every test in the bundles scaffold generated under `testerDir`; throw if there are none. */
export function collectScaffoldBundles(testerDir: string = SCAFFOLD_TESTER_DIR): CollectedRun {
  const contentDir = join(testerDir, "content");
  const indexPath = join(contentDir, "index.xhtml");
  if (!existsSync(indexPath)) {
    throw new Error(`No ${indexPath}: scaffold has not generated its test page, so nothing ran`);
  }
  const scripts = specScriptsIn(readFileSync(indexPath, "utf8"));
  const files = scripts.map((src) =>
    collectTests(readFileSync(join(contentDir, src), "utf8"), src),
  );
  const tests = files.reduce((sum, file) => sum + file.tests, 0);
  if (tests === 0) {
    throw new Error(
      `${indexPath} loads ${scripts.length} spec files holding no tests: the run would pass with nothing tested`,
    );
  }
  return { files, tests };
}

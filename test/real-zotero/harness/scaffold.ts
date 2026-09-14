/**
 * Scaffold-side guarantees for the real-Zotero suite. Runs in the scaffold Node
 * process, never inside Zotero, like everything else in harness/.
 *
 * `zotero-plugin test` always runs scaffold's own build first, and that build
 * empties its `dist` directory, so CI cannot unzip the release XPI straight into
 * the directory scaffold loads. Instead CI unzips it into STAGED_XPI_DIR,
 * scaffold's build copies it into SCAFFOLD_LOAD_DIR with every rewriting option
 * off, and `assertLoadedMatchesStaged` proves the two trees are byte-identical
 * before Zotero starts. If a scaffold upgrade ever begins rewriting files, the
 * run fails instead of quietly testing something other than the shipped XPI.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Where real-zotero.yml unzips the release XPI: the one `npm run build` made on a
 * pull request, or the one release.yml's Verify job built, checked by digest, on a tag.
 */
export const STAGED_XPI_DIR = ".scaffold/xpi";
/** scaffold's `dist`. Its build empties this directory on every run. */
export const SCAFFOLD_DIST_DIR = ".scaffold/build";
/** The directory scaffold installs into Zotero as a temporary add-on: `join(dist, "addon")`. */
export const SCAFFOLD_LOAD_DIR = `${SCAFFOLD_DIST_DIR}/addon`;
/** scaffold's download cache; the tester uses a `chai.js` found here instead of fetching one. */
export const SCAFFOLD_CACHE_DIR = ".scaffold/cache";
/** scaffold's tester plugin. Its generated index.xhtml and spec bundles live under `content/`. */
export const SCAFFOLD_TESTER_DIR = ".scaffold/test/resource";
/** The exact-pinned mocha build scaffold copies into the Mocha window when it exists. */
export const PINNED_MOCHA_PATH = "node_modules/mocha/mocha.js";
/** The exact-pinned chai build `seedPinnedChai` hands scaffold. */
export const PINNED_CHAI_PATH = "node_modules/chai/chai.js";

/**
 * scaffold's `waitForPlugin` condition, always true on purpose. scaffold polls
 * it for a hardcoded 10 s, reports a timeout through a request it does not
 * await, then quits Zotero with status 0, so a slow cold start would end the run
 * with no failure and no logs. The suite's root before hook
 * (00-root-hooks.spec.ts) waits for Citegeist's ready flag instead, as a Mocha
 * failure with a deadline from shared/timeouts.ts.
 */
export const SCAFFOLD_WAIT_FOR_PLUGIN = "() => true";

/** Throw unless STAGED_XPI_DIR holds a built (placeholder-free) Citegeist XPI. */
export function assertStagedXpi(addonID: string, dir: string = STAGED_XPI_DIR): void {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `No unzipped XPI at ${dir}. Run \`npm run build\`, then unzip ` +
        `build/citegeist-*.xpi into ${dir} (.github/workflows/real-zotero.yml does this).`,
    );
  }
  const raw = readFileSync(manifestPath, "utf8");
  const placeholder = raw.match(/__[A-Za-z]+__/);
  if (placeholder) {
    throw new Error(
      `${manifestPath} still contains ${placeholder[0]}: ${dir} holds an unbuilt addon/ tree, not a release XPI`,
    );
  }
  const id = (JSON.parse(raw) as { applications?: { zotero?: { id?: string } } }).applications
    ?.zotero?.id;
  if (id !== addonID) {
    throw new Error(`${manifestPath} is for add-on ${String(id)}, expected ${addonID}`);
  }
}

function digestTree(root: string): Map<string, string> {
  const digests = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        digests.set(
          relative(root, full),
          createHash("sha256").update(readFileSync(full)).digest("hex"),
        );
      }
    }
  };
  if (existsSync(root)) walk(root);
  return digests;
}

/** Every difference between two directory trees: missing, changed, or unexpected files. */
export function diffTrees(expectedRoot: string, actualRoot: string): string[] {
  const expected = digestTree(expectedRoot);
  const actual = digestTree(actualRoot);
  const problems: string[] = [];
  for (const [path, digest] of expected) {
    const got = actual.get(path);
    if (got === undefined) problems.push(`missing: ${path}`);
    else if (got !== digest) problems.push(`changed: ${path}`);
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) problems.push(`unexpected: ${path}`);
  }
  return problems.sort();
}

/** Throw unless the directory scaffold will load is byte-identical to the staged XPI. */
export function assertLoadedMatchesStaged(
  stagedDir: string = STAGED_XPI_DIR,
  loadedDir: string = SCAFFOLD_LOAD_DIR,
): void {
  const problems = diffTrees(stagedDir, loadedDir);
  if (problems.length > 0) {
    throw new Error(
      `${loadedDir} differs from the staged release XPI in ${stagedDir}, so the suite ` +
        `would not be testing the shipped files:\n  ${problems.join("\n  ")}`,
    );
  }
}

/**
 * Throw unless ZOTERO_PLUGIN_ZOTERO_BIN_PATH names an existing file, before
 * scaffold starts anything. real-zotero.yml sets ZOTERO_SETUP_COMPLETE=1, which
 * skips scaffold's own headless setup, so scaffold downloads nothing there and,
 * without the variable, fails with a bare "No Zotero Found.". Only when
 * ZOTERO_SETUP_COMPLETE is unset does that setup download Zotero's beta build
 * in place of a pinned release. Every run needs the variable either way, so
 * requiring it everywhere costs a local run nothing.
 */
export function assertPinnedZoteroBinary(env: Record<string, string | undefined>): void {
  const bin = env.ZOTERO_PLUGIN_ZOTERO_BIN_PATH;
  if (!bin) {
    throw new Error(
      "ZOTERO_PLUGIN_ZOTERO_BIN_PATH is not set. Without it scaffold downloads Zotero's beta " +
        "channel on CI instead of a pinned release; point it at the zotero binary under test.",
    );
  }
  if (!existsSync(bin)) {
    throw new Error(`ZOTERO_PLUGIN_ZOTERO_BIN_PATH=${bin} does not exist`);
  }
}

/**
 * Throw unless the exact-pinned mocha devDependency is installed. Without it
 * scaffold loads the latest mocha from cdn.jsdelivr.net into a chrome-privileged
 * Zotero window.
 */
export function assertPinnedMocha(path: string = PINNED_MOCHA_PATH): void {
  if (!existsSync(path)) {
    throw new Error(
      `${path} is missing, so scaffold would fetch an unpinned mocha from a CDN. Run \`npm install\`.`,
    );
  }
}

/**
 * Hand scaffold the exact-pinned chai devDependency. scaffold's tester copies
 * mocha from node_modules, but takes chai from its cache or else downloads the
 * latest build from chaijs.com into a chrome-privileged Zotero window.
 */
export function seedPinnedChai(
  cacheDir: string = SCAFFOLD_CACHE_DIR,
  source: string = PINNED_CHAI_PATH,
): void {
  if (!existsSync(source)) {
    throw new Error(
      `${source} is missing, so scaffold would fetch an unpinned chai from chaijs.com. Run \`npm install\`.`,
    );
  }
  mkdirSync(cacheDir, { recursive: true });
  copyFileSync(source, join(cacheDir, "chai.js"));
}

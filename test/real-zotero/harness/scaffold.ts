/**
 * Scaffold-side guarantees for the real-Zotero suite. Runs in the scaffold Node
 * process, never inside Zotero.
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

/** Where CI unzips `build/citegeist-<version>.xpi`. */
export const STAGED_XPI_DIR = ".scaffold/xpi";
/** scaffold's `dist`. Its build empties this directory on every run. */
export const SCAFFOLD_DIST_DIR = ".scaffold/build";
/** The directory scaffold installs into Zotero as a temporary add-on. */
export const SCAFFOLD_LOAD_DIR = `${SCAFFOLD_DIST_DIR}/addon`;
/** scaffold's download cache; the tester uses a `chai.js` found here instead of fetching one. */
export const SCAFFOLD_CACHE_DIR = ".scaffold/cache";

/**
 * Condition the scaffold tester polls before opening the Mocha window. scaffold
 * pastes it inside a double-quoted JS string literal in its generated
 * bootstrap.js, so it must contain no double quote, backslash or newline.
 */
export const WAIT_FOR_CITEGEIST = "() => !!(Zotero.Citegeist && Zotero.Citegeist.ready)";
/**
 * Delay before the tester starts polling WAIT_FOR_CITEGEIST. scaffold then polls
 * for a fixed 10 s (hardcoded in its bootstrap template), so Citegeist has this
 * plus 10 s after the tester loads to finish startup on a cold CI profile.
 */
export const STARTUP_DELAY_MS = 5_000;
/** Mocha's per-test timeout. Specs use shorter deadlines of their own so a hang names what it waited for. */
export const SPEC_TIMEOUT_MS = 60_000;

/** Throw unless STAGED_XPI_DIR holds a built (placeholder-free) Citegeist XPI. */
export function assertStagedXpi(addonID: string, dir: string = STAGED_XPI_DIR): void {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `No unzipped XPI at ${dir}. Run \`npm run build\`, then unzip ` +
        `build/citegeist-*.xpi into ${dir} (the real-zotero job in .github/workflows/ci.yml does this).`,
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
 * Hand scaffold the exact-pinned chai devDependency. scaffold's tester copies
 * mocha from node_modules, but takes chai from its cache or else downloads the
 * latest build from chaijs.com into a chrome-privileged Zotero window.
 */
export function seedPinnedChai(cacheDir: string = SCAFFOLD_CACHE_DIR): void {
  mkdirSync(cacheDir, { recursive: true });
  copyFileSync(join("node_modules", "chai", "chai.js"), join(cacheDir, "chai.js"));
}

/**
 * Runs scripts/build.mjs for real, on copies of the project in temporary directories.
 *
 * buildMetadata.test.ts and buildPromotion.test.ts cover what each check rejects and how a swap
 * moves directories. Whether the build runs those checks on the copy it ships, before anything
 * becomes current, and what a failure leaves in build/, shows only when the script runs: with
 * verification swallowed, run on a shadowed directory, the XPI zipped from addon/, or promotion
 * moved into the catch block, every unit test still passed. Faults inside the build, such as a
 * rename that fails or an XPI that differs from the copy it was zipped from, come from modules
 * preloaded with `node --import` that wrap fs or child_process, so scripts/build.mjs carries no
 * test hook.
 *
 * A production build runs zip, and these tests run unzip. Without either on PATH the production
 * tests skip, except in CI (process.env.CI set), where they run and fail.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TestContext } from "vitest";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("..", import.meta.url));
// Everything scripts/build.mjs reads: the addon, the TypeScript it bundles, tsconfig.json for
// the "@/" alias esbuild resolves, the scripts themselves, and package.json.
const PROJECT_FILES = ["addon", "src", "scripts", "package.json", "tsconfig.json"];
const MODES = ["production", "dev"] as const;
type Mode = (typeof MODES)[number];
const BUILD_TIMEOUT = { timeout: 60_000 };
const PREVIOUS_BUILD_MARKER = "build/addon/previous-build.marker";
const MOVED_ASIDE_MARKER = "build/.addon-previous/previous-build.marker";

const IN_CI = Boolean(process.env.CI);
const MISSING_ZIP_TOOLS = ["zip", "unzip"].filter(
  (tool) => spawnSync(tool, ["-v"], { stdio: "ignore" }).error !== undefined,
);

interface Declared {
  version: string;
  min: string;
  max: string;
}

interface BuildResult {
  status: number | null;
  output: string;
}

const templates = new Map<Mode, { dir: string } & BuildResult>();
const copies: string[] = [];

/** Links `path` to the directory `target`: a junction on Windows, which needs no privilege. */
function linkDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

/** A project copy in a temporary directory, sharing this checkout's node_modules by a link. */
function projectDir(prefix: string, source: string, entries: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const entry of entries) {
    cpSync(join(source, entry), join(dir, entry), { recursive: true });
  }
  linkDirectory(join(REPO, "node_modules"), join(dir, "node_modules"));
  return dir;
}

function runBuild(dir: string, mode: Mode, nodeArgs: string[] = []): BuildResult {
  const args = [
    ...nodeArgs,
    join(dir, "scripts", "build.mjs"),
    ...(mode === "dev" ? ["--dev"] : []),
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: dir,
    encoding: "utf8",
    timeout: BUILD_TIMEOUT.timeout,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function buildOrFail(dir: string, mode: Mode, nodeArgs: string[] = []): void {
  const { status, output } = runBuild(dir, mode, nodeArgs);
  expect(status, output).toBe(0);
}

afterAll(() => {
  for (const { dir } of templates.values()) rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A copy of the project and the build/ a clean `mode` build left, so each test starts from a
 * real previous build. The clean build runs once per mode, in the first test that needs it, so a
 * break in production-only code fails the production tests and leaves the dev tests passing.
 * Outside CI, a production test skips here when zip or unzip is missing.
 */
function copyTemplate(mode: Mode, { skip }: TestContext): string {
  skip(
    mode === "production" && MISSING_ZIP_TOOLS.length > 0 && !IN_CI,
    `a production build needs ${MISSING_ZIP_TOOLS.join(" and ")} on PATH`,
  );
  let template = templates.get(mode);
  if (!template) {
    const dir = projectDir(`citegeist-build-${mode}-`, REPO, PROJECT_FILES);
    templates.set(mode, { dir, status: null, output: "the clean build did not finish" });
    template = { dir, ...runBuild(dir, mode) };
    templates.set(mode, template);
  }
  expect(template.status, `the clean ${mode} build failed:\n${template.output}`).toBe(0);

  const dir = projectDir("citegeist-build-", template.dir, [...PROJECT_FILES, "build"]);
  copies.push(dir);
  return dir;
}

/**
 * Writes a module for `node --import` into `dir`, with `LOG` bound to a log file beside it, and
 * returns the Node arguments that load it and a reader for the lines it logged. Each module logs
 * what it injected, so a test can tell the injection ran.
 */
function preload(dir: string, name: string, body: string[]) {
  const file = join(dir, `${name}.mjs`);
  const log = join(dir, `${name}.log`);
  writeFileSync(file, [`const LOG = ${JSON.stringify(log)};`, ...body].join("\n"));
  return {
    nodeArgs: ["--import", pathToFileURL(file).href],
    logged: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
  };
}

/**
 * Wraps fs.renameSync inside the build. Each rename of a directory in build/ is logged as
 * "from -> to" by base name. The first `count` renames from each base name in `failures` throw
 * `code` instead, and are logged with " threw <code>".
 */
function injectRenames(
  dir: string,
  name: string,
  failures: Record<string, { code: string; count: number }> = {},
) {
  return preload(dir, name, [
    `import fs from "node:fs";`,
    `import { basename, dirname } from "node:path";`,
    `import { syncBuiltinESMExports } from "node:module";`,
    `const failures = ${JSON.stringify(failures)};`,
    `const realRename = fs.renameSync;`,
    `fs.renameSync = (from, to) => {`,
    `  if (basename(dirname(String(from))) !== "build") return realRename(from, to);`,
    `  const move = basename(String(from)) + " -> " + basename(String(to));`,
    `  const failure = failures[basename(String(from))];`,
    `  if (failure && failure.count > 0) {`,
    `    failure.count--;`,
    `    fs.appendFileSync(LOG, move + " threw " + failure.code + "\\n");`,
    `    throw Object.assign(new Error("injected " + failure.code + " renaming " + from), { code: failure.code });`,
    `  }`,
    `  realRename(from, to);`,
    `  fs.appendFileSync(LOG, move + "\\n");`,
    `};`,
    `syncBuiltinESMExports();`,
  ]);
}

/** Wraps fs.rmSync inside the build so deleting build/.addon-previous throws EBUSY, as on Windows. */
function injectMovedAsideRemovalFailure(dir: string) {
  return preload(dir, "inject-moved-aside-removal-failure", [
    `import fs from "node:fs";`,
    `import { basename } from "node:path";`,
    `import { syncBuiltinESMExports } from "node:module";`,
    `const realRm = fs.rmSync;`,
    `fs.rmSync = (path, options) => {`,
    `  if (basename(String(path)) !== ".addon-previous") return realRm(path, options);`,
    `  fs.appendFileSync(LOG, "EBUSY\\n");`,
    `  throw Object.assign(new Error("injected EBUSY deleting " + path), { code: "EBUSY" });`,
    `};`,
    `syncBuiltinESMExports();`,
  ]);
}

/**
 * Wraps child_process.execFileSync inside the build so that, once zip has written the XPI,
 * manifest.json inside the XPI is rewritten to cap Zotero at 9.*. The staging copy the XPI was
 * zipped from still passes, so only a check of the XPI itself can fail the build.
 */
function injectPackagedCapRewrite(dir: string) {
  return preload(dir, "inject-packaged-cap-rewrite", [
    `import childProcess from "node:child_process";`,
    `import fs from "node:fs";`,
    `import { tmpdir } from "node:os";`,
    `import { basename, join } from "node:path";`,
    `import { syncBuiltinESMExports } from "node:module";`,
    `const realExecFileSync = childProcess.execFileSync;`,
    `childProcess.execFileSync = (file, args, options) => {`,
    `  const result = realExecFileSync(file, args, options);`,
    `  const xpi = file === "zip" && Array.isArray(args) ? args.find((arg) => arg.endsWith(".xpi")) : undefined;`,
    `  if (xpi) {`,
    `    const manifest = JSON.parse(realExecFileSync("unzip", ["-p", xpi, "manifest.json"], { encoding: "utf8" }));`,
    `    manifest.applications.zotero.strict_max_version = "9.*";`,
    `    const work = fs.mkdtempSync(join(tmpdir(), "citegeist-rewrite-"));`,
    `    fs.writeFileSync(join(work, "manifest.json"), JSON.stringify(manifest, null, 2));`,
    `    realExecFileSync("zip", ["-q", xpi, "manifest.json"], { cwd: work });`,
    `    fs.rmSync(work, { recursive: true, force: true });`,
    `    fs.appendFileSync(LOG, "capped " + basename(xpi) + " at 9.*\\n");`,
    `  }`,
    `  return result;`,
    `};`,
    `syncBuiltinESMExports();`,
  ]);
}

function readJson(file: string) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function editJson(file: string, change: (json: Record<string, never>) => void): void {
  const json = readJson(file);
  change(json);
  writeFileSync(file, JSON.stringify(json, null, 2));
}

function setPackageCap(dir: string, cap: string): void {
  editJson(join(dir, "package.json"), (json) => {
    (json.config as Record<string, string>).zoteroMaxVersion = cap;
  });
}

function declaredByPackage(dir: string): Declared {
  const { version, config } = readJson(join(dir, "package.json"));
  return { version, min: config.zoteroMinVersion, max: config.zoteroMaxVersion };
}

function declaredByManifest(file: string): Declared {
  const { version, applications } = readJson(file);
  return {
    version,
    min: applications.zotero.strict_min_version,
    max: applications.zotero.strict_max_version,
  };
}

/** Each file under `dir` by relative path, with its SHA-256, so two trees compare in one assertion. */
function fileHashes(dir: string, root = dir): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir).flatMap((entry) => {
      const file = join(dir, entry);
      if (statSync(file).isDirectory()) return Object.entries(fileHashes(file, root));
      const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
      return [[relative(root, file).split(sep).join("/"), hash]];
    }),
  );
}

/**
 * Asserts every output of a passing build declares `expected`, and build/ holds nothing else
 * beyond `leftovers`.
 */
function expectBuildDeclares(
  dir: string,
  mode: Mode,
  expected: Declared,
  leftovers: string[] = [],
): void {
  const buildDir = join(dir, "build");
  const addonDir = join(buildDir, "addon");
  const xpiName = `citegeist-${expected.version}.xpi`;
  const outputs = mode === "dev" ? ["addon"] : ["addon", xpiName, "update.json"];

  expect(readdirSync(buildDir).sort()).toEqual([...outputs, ...leftovers].sort());
  expect(declaredByManifest(join(addonDir, "manifest.json"))).toEqual(expected);
  if (mode === "dev") return;

  const xpi = join(buildDir, xpiName);
  const extracted = mkdtempSync(join(tmpdir(), "citegeist-xpi-test-"));
  copies.push(extracted);
  execFileSync("unzip", ["-q", xpi, "-d", extracted]);
  expect(declaredByManifest(join(extracted, "manifest.json"))).toEqual(expected);
  // The XPI holds exactly the copy that became build/addon, not addon/ or an older build.
  expect(fileHashes(extracted)).toEqual(fileHashes(addonDir));

  const { addonID } = readJson(join(dir, "package.json")).config;
  const entries = readJson(join(buildDir, "update.json")).addons[addonID].updates;
  expect(entries).toHaveLength(1);
  const [entry] = entries;
  expect({
    version: entry.version,
    min: entry.applications.zotero.strict_min_version,
    max: entry.applications.zotero.strict_max_version,
  }).toEqual(expected);
  const xpiHash = createHash("sha256").update(readFileSync(xpi)).digest("hex");
  expect(entry.update_hash).toBe(`sha256:${xpiHash}`);
}

/** Asserts build/ holds only build/addon, still the previous build's copy with its marker. */
function expectOnlyPreviousCopy(dir: string, previous: Declared): void {
  expect(readdirSync(join(dir, "build"))).toEqual(["addon"]);
  expect(existsSync(join(dir, PREVIOUS_BUILD_MARKER))).toBe(true);
  expect(declaredByManifest(join(dir, "build/addon/manifest.json"))).toEqual(previous);
}

/** Marks the previous build's copy, so a test can tell whether a later build replaced it. */
function markPreviousBuild(dir: string): Declared {
  writeFileSync(join(dir, PREVIOUS_BUILD_MARKER), "");
  return declaredByManifest(join(dir, "build/addon/manifest.json"));
}

describe("the test environment", () => {
  it("has zip and unzip on PATH, which CI must provide", ({ skip }) => {
    skip(
      MISSING_ZIP_TOOLS.length > 0 && !IN_CI,
      `${MISSING_ZIP_TOOLS.join(" and ")} missing, so production build tests skip`,
    );

    expect(MISSING_ZIP_TOOLS).toEqual([]);
  });
});

describe("a passing build", () => {
  it.for(MODES)(
    "%s: declares package.json's version and range in every output",
    BUILD_TIMEOUT,
    (mode, context) => {
      const dir = copyTemplate(mode, context);

      expectBuildDeclares(dir, mode, declaredByPackage(dir));
    },
  );

  it.for(MODES)(
    "%s: follows a cap changed only in package.json, replacing the previous build's copy",
    BUILD_TIMEOUT,
    (mode, context) => {
      const dir = copyTemplate(mode, context);
      const previous = markPreviousBuild(dir);
      expect(previous.max).not.toBe("11.0.*");
      setPackageCap(dir, "11.0.*");

      buildOrFail(dir, mode);

      const { version, min } = declaredByPackage(dir);
      expectBuildDeclares(dir, mode, { version, min, max: "11.0.*" });
      expect(existsSync(join(dir, PREVIOUS_BUILD_MARKER))).toBe(false);
    },
  );
});

const BROKEN_SOURCES: Array<{
  name: string;
  breakSource: (dir: string) => void;
  reported: string;
}> = [
  {
    name: "addon/manifest.json hardcodes a 9.* cap",
    breakSource: (dir) =>
      editJson(join(dir, "addon/manifest.json"), (manifest) => {
        const applications = manifest.applications as { zotero: Record<string, string> };
        applications.zotero.strict_max_version = "9.*";
      }),
    reported: "to 9.*, package.json config gives",
  },
  {
    name: "an addon file misspells a placeholder",
    breakSource: (dir) => {
      const file = join(dir, "addon/content/preferences.xhtml");
      const content = readFileSync(file, "utf8");
      writeFileSync(file, content.replace("</", "<label>__zoteroMaxVerison__</label></"));
    },
    reported: "content/preferences.xhtml: __zoteroMaxVerison__",
  },
];

// The link points outside addon/, at a file holding a placeholder, as a shared file would.
const LINKS = [
  { kind: "file", path: join("addon", "content", "about.json") },
  { kind: "directory", path: join("addon", "content", "shared") },
] as const;
const SHARED_CONTENT = '{ "version": "__buildVersion__" }\n';

describe("a failing build", () => {
  it.for(
    MODES.flatMap((mode) => BROKEN_SOURCES.map((broken) => [mode, broken.name, broken] as const)),
  )(
    "%s: when %s, exits non-zero and leaves build/addon as the previous build left it",
    BUILD_TIMEOUT,
    ([mode, , broken], context) => {
      const dir = copyTemplate(mode, context);
      const previous = markPreviousBuild(dir);
      broken.breakSource(dir);

      const { status, output } = runBuild(dir, mode);

      expect(status, output).not.toBe(0);
      expect(output).toContain(broken.reported);
      expectOnlyPreviousCopy(dir, previous);
    },
  );

  it.for(MODES.flatMap((mode) => LINKS.map((link) => [mode, link.kind, link] as const)))(
    "%s: when addon/ holds a symbolic link to a %s outside it, exits non-zero naming the link, writes nothing through it, and leaves build/addon as the previous build left it",
    BUILD_TIMEOUT,
    ([mode, kind, link], context) => {
      // A file symlink needs a privilege most Windows accounts lack; a junction does not.
      context.skip(
        process.platform === "win32" && kind === "file",
        "creating a file symlink needs a privilege on Windows",
      );
      const dir = copyTemplate(mode, context);
      const previous = markPreviousBuild(dir);
      const shared = join(dir, "shared");
      const sharedFile = join(shared, "about.json");
      mkdirSync(shared);
      writeFileSync(sharedFile, SHARED_CONTENT);
      if (kind === "file") {
        symlinkSync(join("..", "..", "shared", "about.json"), join(dir, link.path), "file");
      } else {
        linkDirectory(shared, join(dir, link.path));
      }

      const { status, output } = runBuild(dir, mode);

      expect(status, output).not.toBe(0);
      // Named in addon/, where it has to be fixed, rather than in a copy the build made.
      expect(output).toContain(`${sep}${link.path} is a symbolic link`);
      expect(readFileSync(sharedFile, "utf8")).toBe(SHARED_CONTENT);
      expectOnlyPreviousCopy(dir, previous);
    },
  );

  it(
    "fails when the XPI it packaged declares a different cap from the copy it zipped, keeping only the previous build's copy",
    BUILD_TIMEOUT,
    (context) => {
      const dir = copyTemplate("production", context);
      const previous = markPreviousBuild(dir);
      const xpiName = `citegeist-${declaredByPackage(dir).version}.xpi`;
      const injection = injectPackagedCapRewrite(dir);

      const { status, output } = runBuild(dir, "production", injection.nodeArgs);

      expect(injection.logged(), output).toEqual([`capped ${xpiName} at 9.*`]);
      expect(status, output).not.toBe(0);
      expect(output).toContain("The packaged XPI ");
      expect(output).toContain(`${sep}${xpiName} fails verification`);
      expect(output).toContain("to 9.*, package.json config gives");
      expectOnlyPreviousCopy(dir, previous);
    },
  );

  it(
    "removes the previous build's XPI and update.json before a malformed package.json stops it",
    BUILD_TIMEOUT,
    (context) => {
      const dir = copyTemplate("production", context);
      expect(readdirSync(join(dir, "build"))).toContain("update.json");
      const previous = markPreviousBuild(dir);
      setPackageCap(dir, "9.*");

      const { status, output } = runBuild(dir, "production");

      expect(status, output).not.toBe(0);
      expect(output).toContain("Zotero cap in package.json config must be major.minor.*");
      expectOnlyPreviousCopy(dir, previous);
    },
  );
});

describe("promotion", () => {
  it(
    "restores the copy an interrupted promotion moved aside before anything can fail",
    BUILD_TIMEOUT,
    (context) => {
      const dir = copyTemplate("production", context);
      const previous = markPreviousBuild(dir);
      // An earlier build stopped after moving build/addon aside and before moving staging in.
      renameSync(join(dir, "build/addon"), join(dir, "build/.addon-previous"));
      setPackageCap(dir, "9.*");

      const { status, output } = runBuild(dir, "production");

      expect(status, output).not.toBe(0);
      expectOnlyPreviousCopy(dir, previous);
    },
  );

  it(
    "keeps the previous build's copy when staging cannot move into place, and removes the XPI and update.json",
    BUILD_TIMEOUT,
    (context) => {
      const dir = copyTemplate("production", context);
      const previous = markPreviousBuild(dir);
      const injection = injectRenames(dir, "renames", {
        ".addon-staging": { code: "ENOSPC", count: 1 },
      });

      const { status, output } = runBuild(dir, "production", injection.nodeArgs);

      expect(injection.logged()).toEqual([
        "addon -> .addon-previous",
        ".addon-staging -> addon threw ENOSPC",
        ".addon-previous -> addon",
      ]);
      expect(status, output).not.toBe(0);
      expect(output).toContain("injected ENOSPC renaming");
      expectOnlyPreviousCopy(dir, previous);
    },
  );

  it(
    "leaves the last good copy in build/.addon-previous when it cannot move back either, and the next build restores it",
    BUILD_TIMEOUT,
    (context) => {
      const dir = copyTemplate("production", context);
      const previous = markPreviousBuild(dir);
      const failing = injectRenames(dir, "failing-renames", {
        ".addon-staging": { code: "ENOSPC", count: 1 },
        ".addon-previous": { code: "ENOSPC", count: 1 },
      });

      const failed = runBuild(dir, "production", failing.nodeArgs);

      expect(failing.logged()).toEqual([
        "addon -> .addon-previous",
        ".addon-staging -> addon threw ENOSPC",
        ".addon-previous -> addon threw ENOSPC",
      ]);
      expect(failed.status, failed.output).not.toBe(0);
      expect(failed.output).toContain("nor move the last good copy back");
      expect(failed.output).toContain("build/.addon-previous holds the last copy that passed");
      // Cleanup removed the staging copy and nothing else: the only good copy survives.
      expect(readdirSync(join(dir, "build"))).toEqual([".addon-previous"]);
      expect(existsSync(join(dir, MOVED_ASIDE_MARKER))).toBe(true);
      expect(declaredByManifest(join(dir, "build/.addon-previous/manifest.json"))).toEqual(
        previous,
      );

      const next = injectRenames(dir, "next-renames");
      buildOrFail(dir, "production", next.nodeArgs);

      expect(next.logged()).toEqual([
        ".addon-previous -> addon",
        "addon -> .addon-previous",
        ".addon-staging -> addon",
      ]);
      expectBuildDeclares(dir, "production", declaredByPackage(dir));
    },
  );

  it(
    "retries a staging rename locked with EBUSY and completes the build",
    BUILD_TIMEOUT,
    (context) => {
      const dir = copyTemplate("production", context);
      markPreviousBuild(dir);
      const injection = injectRenames(dir, "renames", {
        ".addon-staging": { code: "EBUSY", count: 2 },
      });

      const { status, output } = runBuild(dir, "production", injection.nodeArgs);

      expect(injection.logged()).toEqual([
        "addon -> .addon-previous",
        ".addon-staging -> addon threw EBUSY",
        ".addon-staging -> addon threw EBUSY",
        ".addon-staging -> addon",
      ]);
      expect(status, output).toBe(0);
      expectBuildDeclares(dir, "production", declaredByPackage(dir));
      expect(existsSync(join(dir, PREVIOUS_BUILD_MARKER))).toBe(false);
    },
  );

  it(
    "completes the build with a warning when deleting the moved-aside copy fails, and the next build deletes it",
    BUILD_TIMEOUT,
    (context) => {
      const dir = copyTemplate("production", context);
      markPreviousBuild(dir);
      const injection = injectMovedAsideRemovalFailure(dir);

      const { status, output } = runBuild(dir, "production", injection.nodeArgs);

      expect(injection.logged()).toEqual(["EBUSY"]);
      expect(status, output).toBe(0);
      expect(output).toContain("but deleting the previous copy at");
      expect(output).toContain("The next build deletes it.");
      expectBuildDeclares(dir, "production", declaredByPackage(dir), [".addon-previous"]);
      expect(existsSync(join(dir, PREVIOUS_BUILD_MARKER))).toBe(false);
      expect(existsSync(join(dir, MOVED_ASIDE_MARKER))).toBe(true);

      buildOrFail(dir, "production");

      expectBuildDeclares(dir, "production", declaredByPackage(dir));
    },
  );
});

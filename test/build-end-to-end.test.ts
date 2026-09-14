/**
 * Runs scripts/build.mjs for real, on copies of the project in temporary directories.
 *
 * buildMetadata.test.ts covers what each check rejects. Whether the build runs those checks on
 * the copy it ships, before anything becomes current, and what a failure leaves in build/, shows
 * only when the script runs: with verification swallowed, run on a shadowed directory, the XPI
 * zipped from addon/, or promotion moved into the catch block, every unit test still passed.
 * Promotion is tested by making a rename fail inside the build, through a preload that wraps
 * fs.renameSync, so scripts/build.mjs carries no test hook.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
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
import { afterAll, afterEach, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("..", import.meta.url));
// Everything scripts/build.mjs reads: the addon, the TypeScript it bundles, tsconfig.json for
// the "@/" alias esbuild resolves, the scripts themselves, and package.json.
const PROJECT_FILES = ["addon", "src", "scripts", "package.json", "tsconfig.json"];
const MODES = ["production", "dev"] as const;
type Mode = (typeof MODES)[number];
const BUILD_TIMEOUT_MS = 60_000;
const PREVIOUS_BUILD_MARKER = "build/addon/previous-build.marker";

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

/** A project copy in a temporary directory, sharing this checkout's node_modules by symlink. */
function projectDir(prefix: string, source: string, entries: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const entry of entries) {
    cpSync(join(source, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
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
    timeout: BUILD_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function buildOrFail(dir: string, mode: Mode): void {
  const { status, output } = runBuild(dir, mode);
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
 */
function copyTemplate(mode: Mode): string {
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
 * Makes the build's first `count` renames of build/.addon-staging throw `code`, by preloading a
 * module that wraps fs.renameSync. Returns the Node arguments that load it, and a reader for how
 * many failures it injected, so a test can tell the injection ran.
 */
function injectStagingRenameFailures(dir: string, code: string, count: number) {
  const preload = join(dir, "inject-staging-rename-failures.mjs");
  const log = join(dir, "injected-rename-failures.log");
  writeFileSync(
    preload,
    [
      `import fs from "node:fs";`,
      `import { syncBuiltinESMExports } from "node:module";`,
      `const realRename = fs.renameSync;`,
      `let remaining = ${count};`,
      `fs.renameSync = (from, to) => {`,
      `  if (remaining > 0 && String(from).endsWith(".addon-staging")) {`,
      `    remaining--;`,
      `    fs.appendFileSync(${JSON.stringify(log)}, "${code}\\n");`,
      `    throw Object.assign(new Error("injected ${code} renaming " + from), { code: "${code}" });`,
      `  }`,
      `  return realRename(from, to);`,
      `};`,
      `syncBuiltinESMExports();`,
    ].join("\n"),
  );
  return {
    nodeArgs: ["--import", pathToFileURL(preload).href],
    injected: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0),
  };
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

/** Asserts every output of a passing build declares `expected`, and build/ holds nothing else. */
function expectBuildDeclares(dir: string, mode: Mode, expected: Declared): void {
  const buildDir = join(dir, "build");
  const addonDir = join(buildDir, "addon");
  const xpiName = `citegeist-${expected.version}.xpi`;

  expect(readdirSync(buildDir).sort()).toEqual(
    mode === "dev" ? ["addon"] : ["addon", xpiName, "update.json"],
  );
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

describe("a passing build", () => {
  it.each(MODES)(
    "%s: declares package.json's version and range in every output",
    (mode) => {
      const dir = copyTemplate(mode);

      expectBuildDeclares(dir, mode, declaredByPackage(dir));
    },
    BUILD_TIMEOUT_MS,
  );

  it.each(MODES)(
    "%s: follows a cap changed only in package.json, replacing the previous build's copy",
    (mode) => {
      const dir = copyTemplate(mode);
      const previous = markPreviousBuild(dir);
      expect(previous.max).not.toBe("11.0.*");
      setPackageCap(dir, "11.0.*");

      buildOrFail(dir, mode);

      const { version, min } = declaredByPackage(dir);
      expectBuildDeclares(dir, mode, { version, min, max: "11.0.*" });
      expect(existsSync(join(dir, PREVIOUS_BUILD_MARKER))).toBe(false);
    },
    BUILD_TIMEOUT_MS,
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

describe("a failing build", () => {
  it.each(
    MODES.flatMap((mode) => BROKEN_SOURCES.map((broken) => [mode, broken.name, broken] as const)),
  )(
    "%s: when %s, exits non-zero and leaves build/addon as the previous build left it",
    (mode, _name, broken) => {
      const dir = copyTemplate(mode);
      const previous = markPreviousBuild(dir);
      broken.breakSource(dir);

      const { status, output } = runBuild(dir, mode);

      expect(status, output).not.toBe(0);
      expect(output).toContain(broken.reported);
      expectOnlyPreviousCopy(dir, previous);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "removes the previous build's XPI and update.json before a malformed package.json stops it",
    () => {
      const dir = copyTemplate("production");
      expect(readdirSync(join(dir, "build"))).toContain("update.json");
      const previous = markPreviousBuild(dir);
      setPackageCap(dir, "9.*");

      const { status, output } = runBuild(dir, "production");

      expect(status, output).not.toBe(0);
      expect(output).toContain("Zotero cap in package.json config must be major.minor.*");
      expectOnlyPreviousCopy(dir, previous);
    },
    BUILD_TIMEOUT_MS,
  );
});

describe("promotion", () => {
  it(
    "restores the copy an interrupted promotion moved aside before anything can fail",
    () => {
      const dir = copyTemplate("production");
      const previous = markPreviousBuild(dir);
      // An earlier build stopped after moving build/addon aside and before moving staging in.
      renameSync(join(dir, "build/addon"), join(dir, "build/.addon-previous"));
      setPackageCap(dir, "9.*");

      const { status, output } = runBuild(dir, "production");

      expect(status, output).not.toBe(0);
      expectOnlyPreviousCopy(dir, previous);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "keeps the previous build's copy when staging cannot move into place, and removes the XPI and update.json",
    () => {
      const dir = copyTemplate("production");
      const previous = markPreviousBuild(dir);
      const injection = injectStagingRenameFailures(dir, "ENOSPC", 1);

      const { status, output } = runBuild(dir, "production", injection.nodeArgs);

      expect(injection.injected()).toBe(1);
      expect(status, output).not.toBe(0);
      expect(output).toContain("injected ENOSPC renaming");
      expectOnlyPreviousCopy(dir, previous);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "retries a staging rename locked with EBUSY and completes the build",
    () => {
      const dir = copyTemplate("production");
      markPreviousBuild(dir);
      const injection = injectStagingRenameFailures(dir, "EBUSY", 2);

      const { status, output } = runBuild(dir, "production", injection.nodeArgs);

      expect(injection.injected()).toBe(2);
      expect(status, output).toBe(0);
      expectBuildDeclares(dir, "production", declaredByPackage(dir));
      expect(existsSync(join(dir, PREVIOUS_BUILD_MARKER))).toBe(false);
    },
    BUILD_TIMEOUT_MS,
  );
});

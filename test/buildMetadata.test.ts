import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { parseDocument } from "yaml";
import pkg from "../package.json";
import {
  PLACEHOLDER_FILE_EXTENSIONS,
  assertNoSymbolicLinks,
  assertNoUnreplacedPlaceholders,
  assertRangeShape,
  placeholdersFor,
  readBuildMetadata,
  replacePlaceholders,
  updateManifestFor,
  verifyBuiltAddon,
  verifyPackagedAddon,
  verifyUpdateManifest,
} from "../scripts/build-metadata.mjs";

const ADDON_SOURCE = fileURLToPath(new URL("../addon", import.meta.url));

// A fixed range, independent of what package.json carries today, so these tests
// keep their meaning when a later release moves the floor or the cap.
const FIXTURE_RANGE = { zoteroMinVersion: "7.0.10", zoteroMaxVersion: "10.0.*" };
const meta = readBuildMetadata(withConfig(FIXTURE_RANGE));

function withConfig(overrides: Record<string, string>) {
  return { ...pkg, config: { ...pkg.config, ...overrides } };
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

function thrownMessage(fn: () => unknown): string {
  return (thrown(fn) as Error).message;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Copies addon/ into a temporary directory, placeholders and all. */
function copyAddon(): string {
  const dir = tempDir("citegeist-addon-");
  cpSync(ADDON_SOURCE, dir, { recursive: true });
  return dir;
}

/**
 * Copies addon/ into a temporary directory, applies `edit` to that copy, then replaces
 * placeholders the way scripts/build.mjs does.
 */
function stageAddon(edit: (dir: string) => void = () => {}): string {
  const dir = copyAddon();
  edit(dir);
  replacePlaceholders(dir, placeholdersFor(meta));
  return dir;
}

function editFile(dir: string, path: string, change: (content: string) => string): void {
  const file = join(dir, path);
  writeFileSync(file, change(readFileSync(file, "utf8")));
}

/** Zips `dir`'s contents the way scripts/build.mjs does and returns the archive's path. */
function zipDirectory(dir: string): string {
  const xpi = join(tempDir("citegeist-xpi-test-"), "citegeist.xpi");
  execFileSync("zip", ["-q", "-r", xpi, "."], { cwd: dir });
  return xpi;
}

// verifyPackagedAddon runs unzip, and its tests zip with zip. Without either on PATH those tests
// skip, except in CI, where they run and fail.
const MISSING_ZIP_TOOLS = ["zip", "unzip"].filter(
  (tool) => spawnSync(tool, ["-v"], { stdio: "ignore" }).error !== undefined,
);

describe("build metadata", () => {
  it("uses package Zotero compatibility in placeholders and update manifest", () => {
    const realMeta = readBuildMetadata(pkg);
    const placeholders = placeholdersFor(realMeta);
    const update = updateManifestFor(realMeta, "citegeist-2.0.0.xpi", "abc123");
    const app = update.addons[realMeta.addonID].updates[0].applications.zotero;

    expect(placeholders.__zoteroMinVersion__).toBe(pkg.config.zoteroMinVersion);
    expect(placeholders.__zoteroMaxVersion__).toBe(pkg.config.zoteroMaxVersion);
    expect(app.strict_min_version).toBe(pkg.config.zoteroMinVersion);
    expect(app.strict_max_version).toBe(pkg.config.zoteroMaxVersion);
    expect(JSON.stringify(update)).not.toContain("__zotero");
  });

  const { zoteroMaxVersion: _dropped, ...configWithoutMax } = pkg.config;

  it.each([
    ["missing", configWithoutMax],
    ["empty", { ...pkg.config, zoteroMaxVersion: "" }],
    ["blank", { ...pkg.config, zoteroMaxVersion: "   " }],
  ])("fails fast when zoteroMaxVersion is %s", (_label, config) => {
    expect(() => readBuildMetadata({ ...pkg, config })).toThrow(
      "package.json config.zoteroMaxVersion must be a non-empty string",
    );
  });
});

describe("Zotero range shape", () => {
  it("accepts the range package.json declares", () => {
    expect(() => readBuildMetadata(pkg)).not.toThrow();
  });

  it.each([
    "9.*",
    "10",
    "10.*",
    "*",
    "99.*",
    // A patch in place of the wildcard, or no wildcard at all
    "10.0",
    "10.0.0",
    "10.0.5",
    // Text at either end
    "x10.0.*",
    "10.0.*x",
    // A leading zero, and ten digits, which can pass int32 and then read as 0
    "010.0.*",
    "9999999999.0.*",
  ])("rejects the cap %s", (cap) => {
    const message = thrownMessage(() => readBuildMetadata(withConfig({ zoteroMaxVersion: cap })));

    expect(message).toContain(
      'Zotero cap in package.json config must be major.minor.* such as "10.0.*"',
    );
    expect(message).toContain(`got ${JSON.stringify(cap)}`);
  });

  it.each([
    "8.*",
    "*",
    "v7.0.10",
    "7..0",
    "7.0.",
    "7.0.10x",
    "07.0.10",
    "7.0.9999999999",
    // Firefox's versionString allows at most four parts
    "7.0.10.1.2",
  ])("rejects the floor %s", (floor) => {
    const message = thrownMessage(() => readBuildMetadata(withConfig({ zoteroMinVersion: floor })));

    expect(message).toContain(
      'Zotero floor in package.json config must be up to four dotted numbers such as "7.0.10"',
    );
    expect(message).toContain(`got ${JSON.stringify(floor)}`);
  });

  // A single-minor range such as 10.0 to 10.0.* must stay possible. "10" equals "10.0" because a
  // missing part counts as 0, and the largest part the shape admits still sorts below "*".
  it.each(["7.0.10", "7.0.10.1", "10", "10.0", "10.0.0", "10.0.1", "10.0.999999999"])(
    "accepts the floor %s under the cap 10.0.*",
    (floor) => {
      const config = { zoteroMinVersion: floor, zoteroMaxVersion: "10.0.*" };

      expect(readBuildMetadata(withConfig(config)).zoteroMinVersion).toBe(floor);
    },
  );

  it.each(["10.1", "10.1.0", "11.0"])("rejects the floor %s, above the cap 10.0.*", (floor) => {
    const config = { zoteroMinVersion: floor, zoteroMaxVersion: "10.0.*" };

    expect(() => readBuildMetadata(withConfig(config))).toThrow(
      `Zotero floor ${floor} in package.json config is above the cap 10.0.*`,
    );
  });

  it("names the source it is given, so a range from another file reports that file", () => {
    const label = "release-lines.json line 2.0.6";

    expect(() => assertRangeShape({ min: "7.0.10", max: "10.*" }, label)).toThrow(
      `Zotero cap in ${label} must be major.minor.*`,
    );
    expect(() => assertRangeShape({ min: "8.*", max: "10.0.*" }, label)).toThrow(
      `Zotero floor in ${label} must be up to four dotted numbers`,
    );
    expect(() => assertRangeShape({ min: "7.0.10", max: "10.0.*" }, label)).not.toThrow();
  });
});

describe("package.json version shape", () => {
  it.each([
    "3.0.0",
    "0.1.0",
    "10.20.30",
    "3.0.0-alpha.0",
    "3.0.0-beta.2",
    "3.0.0-rc.1",
    "3.0.0-rc.10",
  ])("accepts the version %s", (version) => {
    expect(readBuildMetadata({ ...pkg, version }).version).toBe(version);
  });

  it.each([
    "3.0",
    "3.0.0.1",
    "v3.0.0",
    " 3.0.0",
    "03.0.0",
    // Firefox compares "rc2" as text, so it would sort above "rc10"
    "3.0.0-rc2",
    "3.0.0-rc",
    "3.0.0-rc.01",
    "3.0.0-RC.1",
    "3.0.0-pre.1",
    "3.0.0-rc.1.2",
    // Firefox reads a "+" as the next number's prerelease: "3.0.0+b" sorts as "3.0.1pre"
    "3.0.0+b",
  ])("rejects the version %s", (version) => {
    const message = thrownMessage(() => readBuildMetadata({ ...pkg, version }));

    expect(message).toContain(
      "package.json version must be major.minor.patch, optionally followed by -alpha.N, -beta.N or -rc.N",
    );
    expect(message).toContain(`got ${JSON.stringify(version)}`);
    // So nobody takes the manifest schema's warning on a valid prerelease for a failure.
    expect(message).toContain(
      'log a warning about its "0-rc" part; that is a warning, not an error',
    );
  });
});

const WORKFLOWS_DIR = ".github/workflows";
const REAL_ZOTERO_WORKFLOW = "real-zotero.yml";
const CALLS_REAL_ZOTERO = /(?:^|\/)\.github\/workflows\/real-zotero\.yml(?:@.*)?$/;
const FROM_JSON_INPUT = /^\$\{\{\s*fromJSON\(\s*inputs\.([A-Za-z_][\w-]*)\s*\)\s*\}\}$/;

type YamlMap = Record<string, unknown>;

interface ZoteroRun {
  source: string;
  versions: string[];
}

function isMap(value: unknown): value is YamlMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a workflow the way GitHub reads it, so a comment, quoting or an alias cannot pass for a
 * version. Any error or warning throws, among them a duplicate key, which could hide a second list.
 */
function parseWorkflow(name: string, source: string): YamlMap {
  const document = parseDocument(source);
  const problems = [...document.errors, ...document.warnings];
  if (problems.length > 0) {
    throw new Error(
      `${name} does not parse cleanly: ${problems.map((problem) => problem.message).join("; ")}`,
    );
  }
  const workflow = document.toJS();
  if (!isMap(workflow)) throw new Error(`${name} is not a YAML mapping`);
  return workflow;
}

function versionList(value: unknown, source: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((version) => typeof version === "string")
  ) {
    throw new Error(
      `${source} must be a non-empty list of Zotero versions, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** A Zotero version list written as JSON in a string, the shape a workflow_call input carries. */
function versionListFromJson(value: unknown, source: string): string[] {
  if (typeof value !== "string") {
    throw new Error(`${source} must be a JSON list in a string, got ${JSON.stringify(value)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${source} is not a JSON list: ${value}`);
  }
  return versionList(parsed, source);
}

/**
 * Every list of Zotero versions a run of the real-Zotero workflow tests. A job's list is its
 * `zotero` matrix, or, when that is `${{ fromJSON(inputs.<name>) }}`, the input's workflow_call
 * default. A caller that passes the input with `with:` runs its own list, so that is a run too.
 * A matrix `include` or `exclude` can add or skip cells, so it throws, as does any shape this
 * cannot read.
 */
function zoteroRuns(workflows: Record<string, string>): ZoteroRun[] {
  const source = workflows[REAL_ZOTERO_WORKFLOW];
  if (source === undefined) throw new Error(`${WORKFLOWS_DIR}/${REAL_ZOTERO_WORKFLOW} is missing`);
  const workflow = parseWorkflow(REAL_ZOTERO_WORKFLOW, source);
  const runs: ZoteroRun[] = [];
  const inputs = new Set<string>();

  for (const [jobName, job] of Object.entries(isMap(workflow.jobs) ? workflow.jobs : {})) {
    const strategy = isMap(job) ? job.strategy : undefined;
    const matrix = isMap(strategy) ? strategy.matrix : undefined;
    const label = `${REAL_ZOTERO_WORKFLOW} job ${jobName}`;
    if (matrix === undefined) continue;
    if (!isMap(matrix)) {
      throw new Error(
        `${label} builds its whole matrix from an expression; update this check to read it`,
      );
    }
    if (!("zotero" in matrix)) continue;
    for (const key of ["include", "exclude"]) {
      if (key in matrix) {
        throw new Error(
          `${label} has a matrix ${key}, which can add or skip Zotero cells this check cannot see; ` +
            `list every version in zotero instead`,
        );
      }
    }

    const input =
      typeof matrix.zotero === "string" ? FROM_JSON_INPUT.exec(matrix.zotero)?.[1] : undefined;
    if (Array.isArray(matrix.zotero)) {
      runs.push({
        source: `${label} matrix`,
        versions: versionList(matrix.zotero, `${label} matrix`),
      });
    } else if (input !== undefined) {
      const on = isMap(workflow.on) ? workflow.on : {};
      const call = isMap(on.workflow_call) ? on.workflow_call : {};
      const declared = isMap(call.inputs) ? call.inputs[input] : undefined;
      const defaultSource = `${REAL_ZOTERO_WORKFLOW} on.workflow_call.inputs.${input}.default`;
      const versions = versionListFromJson(
        isMap(declared) ? declared.default : undefined,
        defaultSource,
      );
      runs.push({ source: defaultSource, versions });
      inputs.add(input);
    } else {
      throw new Error(
        `${label} matrix zotero is ${JSON.stringify(matrix.zotero)}; this check reads a list or ` +
          `\${{ fromJSON(inputs.<name>) }}, so update it to read the new shape`,
      );
    }
  }
  if (runs.length === 0) {
    throw new Error(
      `${REAL_ZOTERO_WORKFLOW} has no job with a zotero matrix; update this check to read it`,
    );
  }

  for (const [name, callerSource] of Object.entries(workflows)) {
    if (name === REAL_ZOTERO_WORKFLOW || !callerSource.includes(REAL_ZOTERO_WORKFLOW)) continue;
    const caller = parseWorkflow(name, callerSource);
    for (const [jobName, job] of Object.entries(isMap(caller.jobs) ? caller.jobs : {})) {
      if (!isMap(job) || typeof job.uses !== "string" || !CALLS_REAL_ZOTERO.test(job.uses))
        continue;
      for (const input of inputs) {
        const passed = isMap(job.with) ? job.with[input] : undefined;
        if (passed === undefined) continue;
        const label = `${name} job ${jobName} with.${input}`;
        runs.push({ source: label, versions: versionListFromJson(passed, label) });
      }
    }
  }
  return runs;
}

/**
 * The cap the highest of `versions` supports, its major.minor.*. Parts compare as numbers, so the
 * order of the list does not matter and 10.10.0 sorts above 10.9.0.
 */
function capForTestedVersions(versions: string[]): string {
  if (versions.length === 0) throw new Error("There are no Zotero versions to take a cap from");
  const parsed = versions.map((version) => {
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(
        `Zotero ${JSON.stringify(version)} is not major.minor.patch; the real-Zotero suite runs ` +
          `release builds only, because beta and dev builds ignore strict_max_version`,
      );
    }
    return version.split(".").map(Number);
  });
  const [major, minor] = parsed.reduce((highest, version) => {
    const order = version[0] - highest[0] || version[1] - highest[1] || version[2] - highest[2];
    return order > 0 ? version : highest;
  });
  return `${major}.${minor}.*`;
}

/** The workflow files in .github/workflows, by file name. */
function readWorkflows(): Record<string, string> {
  const dir = fileURLToPath(new URL(`../${WORKFLOWS_DIR}/`, import.meta.url));
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [name, readFileSync(join(dir, name), "utf8")]),
  );
}

describe("cap against the real-Zotero matrix", () => {
  it("caps at the highest tested Zotero's major.minor: raise the real-Zotero matrix before raising the cap", () => {
    const runs = zoteroRuns(readWorkflows());
    const cap = pkg.config.zoteroMaxVersion;

    for (const { source, versions } of runs) {
      const expectedCap = capForTestedVersions(versions);
      expect(
        cap,
        `package.json config.zoteroMaxVersion is ${cap}, but ${source} runs Zotero ` +
          `${versions.join(", ")}, so the cap must be ${expectedCap}. Raise the real-Zotero ` +
          `matrix before raising the cap (KTD2); raise the cap with the matrix.`,
      ).toBe(expectedCap);
    }
  });

  it.each([
    [["10.0.2", "9.0.6", "11.0.0", "10.1.0"], "11.0.*"],
    [["10.1.0", "11.0.0", "9.0.6", "10.0.2"], "11.0.*"],
    [["10.9.0", "10.10.0"], "10.10.*"],
    [["10.0.9", "10.0.10", "9.99.0"], "10.0.*"],
  ])("takes the cap for %j from the numerically highest version: %s", (versions, cap) => {
    expect(capForTestedVersions(versions)).toBe(cap);
  });

  it("refuses a version that is not major.minor.patch", () => {
    expect(() => capForTestedVersions(["10.0.2", "11.0.0-beta.1"])).toThrow(
      'Zotero "11.0.0-beta.1" is not major.minor.patch',
    );
  });

  const literalMatrix = `
jobs:
  real-zotero:
    strategy:
      matrix:
        zotero: [
          "8.0.4",
          "10.0.2",
          # "11.0.0",
        ]
`;

  const inputMatrix = `
on:
  workflow_call:
    inputs:
      zotero-versions:
        type: string
        default: '["8.0.4", "9.0.6", "10.0.2"]'
jobs:
  real-zotero:
    strategy:
      matrix:
        zotero: \${{ fromJSON(inputs.zotero-versions) }}
`;

  it("reads a literal matrix list, where a commented-out version is not a version", () => {
    expect(zoteroRuns({ [REAL_ZOTERO_WORKFLOW]: literalMatrix })).toEqual([
      { source: "real-zotero.yml job real-zotero matrix", versions: ["8.0.4", "10.0.2"] },
    ]);
  });

  it("reads the workflow_call default for fromJSON(inputs.zotero-versions), and a caller's own list", () => {
    const ci = `
jobs:
  real-zotero:
    uses: ./.github/workflows/real-zotero.yml
  real-zotero-next:
    uses: ./.github/workflows/real-zotero.yml
    with:
      zotero-versions: '["11.0.0"]'
`;

    expect(zoteroRuns({ [REAL_ZOTERO_WORKFLOW]: inputMatrix, "ci.yml": ci })).toEqual([
      {
        source: "real-zotero.yml on.workflow_call.inputs.zotero-versions.default",
        versions: ["8.0.4", "9.0.6", "10.0.2"],
      },
      { source: "ci.yml job real-zotero-next with.zotero-versions", versions: ["11.0.0"] },
    ]);
  });

  it.each([
    [
      "an exclude that skips the cell a raised cap rests on",
      `
jobs:
  real-zotero:
    strategy:
      matrix:
        zotero: ["10.0.2", "11.0.0"]
        exclude:
          - zotero: "11.0.0"
`,
      "real-zotero.yml job real-zotero has a matrix exclude",
    ],
    [
      "an include that adds a cell",
      `
jobs:
  real-zotero:
    strategy:
      matrix:
        zotero: ["10.0.2"]
        include:
          - zotero: "11.0.0"
`,
      "real-zotero.yml job real-zotero has a matrix include",
    ],
    [
      "a duplicate zotero key",
      `
jobs:
  real-zotero:
    strategy:
      matrix:
        zotero: ["11.0.0"]
        zotero: ["10.0.2"]
`,
      "real-zotero.yml does not parse cleanly",
    ],
    [
      "an expression other than fromJSON(inputs.<name>)",
      `
jobs:
  real-zotero:
    strategy:
      matrix:
        zotero: \${{ inputs.zotero-versions }}
`,
      "so update it to read the new shape",
    ],
    [
      "an input with no default",
      inputMatrix.replace(`        default: '["8.0.4", "9.0.6", "10.0.2"]'\n`, ""),
      "real-zotero.yml on.workflow_call.inputs.zotero-versions.default must be a JSON list in a string",
    ],
    [
      "no zotero matrix at all",
      "jobs:\n  real-zotero:\n    runs-on: ubuntu-24.04\n",
      "has no job with a zotero matrix",
    ],
  ])("refuses %s", (_label, workflow, message) => {
    expect(() => zoteroRuns({ [REAL_ZOTERO_WORKFLOW]: workflow })).toThrow(message);
  });

  it("refuses a caller that passes the versions as an expression it cannot read", () => {
    const release = `
jobs:
  real-zotero:
    uses: ./.github/workflows/real-zotero.yml
    with:
      zotero-versions: \${{ inputs.versions }}
`;

    expect(() =>
      zoteroRuns({ [REAL_ZOTERO_WORKFLOW]: inputMatrix, "release.yml": release }),
    ).toThrow("release.yml job real-zotero with.zotero-versions is not a JSON list");
  });
});

describe("update.json verification", () => {
  it("leaves addon/manifest.json with placeholders and no literal version string", () => {
    const raw = readFileSync(join(ADDON_SOURCE, "manifest.json"), "utf8");
    const zotero = JSON.parse(raw).applications.zotero;

    expect(zotero.strict_min_version).toBe("__zoteroMinVersion__");
    expect(zotero.strict_max_version).toBe("__zoteroMaxVersion__");
    // A quoted dotted version such as "7.0.10", "9.*" or "10.0.*" bypasses package.json.
    expect(raw).not.toMatch(/"\d+(?:\.(?:\d+|\*))+"/);
  });

  it("carries a 10.0.* cap into the placeholder map and the built version's update.json entry", () => {
    const update = updateManifestFor(meta, `citegeist-${meta.version}.xpi`, "abc123");

    expect(placeholdersFor(meta).__zoteroMaxVersion__).toBe("10.0.*");
    expect(verifyUpdateManifest(update, meta)).toEqual({ min: "7.0.10", max: "10.0.*" });
  });

  it.each([
    ["cap", { zoteroMaxVersion: "9.*" }, "7.0.10 to 9.*"],
    ["floor", { zoteroMinVersion: "7.0.9" }, "7.0.9 to 10.0.*"],
  ])(
    "fails when the built version's update.json entry has a different %s, showing both ranges",
    (_label, staleRange, publishedRange) => {
      const update = updateManifestFor({ ...meta, ...staleRange }, "citegeist.xpi", "abc123");

      const message = thrownMessage(() => verifyUpdateManifest(update, meta));
      expect(message).toContain(
        `update.json entry for ${meta.version} declares Zotero ${publishedRange}`,
      );
      expect(message).toContain("package.json config gives 7.0.10 to 10.0.*");
    },
  );

  it.each(["first", "last"])(
    "checks the entry for the version being built when a stale line's entry comes %s",
    (position) => {
      const update = updateManifestFor(meta, "citegeist.xpi", "abc123");
      const staleLine = updateManifestFor(
        { ...meta, version: "2.0.6", zoteroMaxVersion: "9.*" },
        "citegeist-2.0.6.xpi",
        "def456",
      ).addons[meta.addonID].updates[0];
      const entries = update.addons[meta.addonID].updates;
      if (position === "first") entries.unshift(staleLine);
      else entries.push(staleLine);

      expect(entries.map((entry: { version: string }) => entry.version)).toEqual(
        position === "first" ? ["2.0.6", meta.version] : [meta.version, "2.0.6"],
      );
      expect(verifyUpdateManifest(update, meta).max).toBe("10.0.*");
    },
  );

  it("fails when update.json has no entry, or more than one, for the version being built", () => {
    const otherVersionOnly = updateManifestFor({ ...meta, version: "2.0.6" }, "old.xpi", "abc123");
    const duplicated = updateManifestFor(meta, "citegeist.xpi", "abc123");
    const entries = duplicated.addons[meta.addonID].updates;
    entries.push({ ...entries[0] });

    expect(() => verifyUpdateManifest(otherVersionOnly, meta)).toThrow(
      `exactly one entry for ${meta.addonID} ${meta.version}, found 0`,
    );
    expect(() => verifyUpdateManifest({}, meta)).toThrow("found 0");
    expect(() => verifyUpdateManifest(duplicated, meta)).toThrow("found 2");
  });
});

describe("verifyBuiltAddon", () => {
  it("returns the manifest's range for a clean build of addon/", () => {
    expect(verifyBuiltAddon(stageAddon(), meta)).toEqual({ min: "7.0.10", max: "10.0.*" });
  });

  it("fails when the built manifest is capped at 9.*, showing both ranges", () => {
    const dir = stageAddon();
    editFile(dir, "manifest.json", (content) => content.replace('"10.0.*"', '"9.*"'));

    const message = thrownMessage(() => verifyBuiltAddon(dir, meta));
    expect(message).toContain("manifest.json does not match package.json");
    expect(message).toContain(
      "Zotero range is 7.0.10 to 9.*, package.json config gives 7.0.10 to 10.0.*",
    );
  });

  it("fails on a misspelt placeholder in an .xhtml file, naming the file", () => {
    const dir = stageAddon((source) =>
      editFile(source, "content/preferences.xhtml", (content) =>
        content.replace("</", "<label>__zoteroMaxVerison__</label></"),
      ),
    );

    expect(() => verifyBuiltAddon(dir, meta)).toThrow(
      "Unreplaced build placeholders in shipped files:\n  content/preferences.xhtml: __zoteroMaxVerison__",
    );
  });

  it("skips a file with an unlisted extension containing a NUL byte, even when its bytes spell a placeholder", () => {
    const placeholderBytes = Buffer.from("__x__");
    const binary = stageAddon((source) =>
      writeFileSync(
        join(source, "content/icons/stray.png"),
        Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), placeholderBytes]),
      ),
    );
    // Positive control: the same bytes without the NUL are text, so the scan reads them.
    const text = stageAddon((source) =>
      writeFileSync(join(source, "content/icons/stray.png"), placeholderBytes),
    );

    expect(verifyBuiltAddon(binary, meta)).toEqual({ min: "7.0.10", max: "10.0.*" });
    expect(() => verifyBuiltAddon(text, meta)).toThrow("content/icons/stray.png: __x__");
  });

  it("fails on a NUL byte in a file with a listed extension, such as UTF-16 text, naming the file", () => {
    const dir = copyAddon();
    writeFileSync(
      join(dir, "locale/en-US/extra.ftl"),
      Buffer.from("extra = __addonName__", "utf16le"),
    );

    expect(() => replacePlaceholders(dir, placeholdersFor(meta))).toThrow(
      "locale/en-US/extra.ftl contains a NUL byte, so it is not UTF-8 text",
    );
    expect(() => verifyBuiltAddon(dir, meta)).toThrow(
      "locale/en-US/extra.ftl contains a NUL byte, so it is not UTF-8 text",
    );
  });

  it("fails on a placeholder in a text file whose extension the build never replaces, naming the list", () => {
    const dir = stageAddon((source) =>
      writeFileSync(join(source, "content/notes.txt"), "Built for __addonRef__"),
    );

    expect(readFileSync(join(dir, "content/notes.txt"), "utf8")).toContain("__addonRef__");
    const message = thrownMessage(() => verifyBuiltAddon(dir, meta));
    expect(message).toContain(
      `not in PLACEHOLDER_FILE_EXTENSIONS (${PLACEHOLDER_FILE_EXTENSIONS.join(", ")})`,
    );
    expect(message).toContain("content/notes.txt: __addonRef__");
    expect(message).not.toContain("Unreplaced build placeholders");
  });

  // Each placeholder addon/manifest.json uses, read from the file, so a new placeholder-backed
  // field fails here until verifyBuiltAddon checks its value.
  const manifestPlaceholders = [
    ...new Set(readFileSync(join(ADDON_SOURCE, "manifest.json"), "utf8").match(/__[A-Za-z]+__/g)),
  ];
  const misspellings: Array<[string, (token: string) => string]> = [
    ["a dropped underscore", (token) => token.slice(0, -1)],
    ["a capital", (token) => `__${token[2].toUpperCase()}${token.slice(3)}`],
    ["snake_case", (token) => token.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)],
  ];

  it("reads every placeholder-backed field from addon/manifest.json", () => {
    expect(manifestPlaceholders.sort()).toEqual(
      [
        "__addonID__",
        "__addonName__",
        "__buildVersion__",
        "__zoteroMaxVersion__",
        "__zoteroMinVersion__",
      ].sort(),
    );
  });

  it.each(
    manifestPlaceholders.flatMap((token) =>
      misspellings.map(([label, misspell]) => [token, label, misspell(token)]),
    ),
  )(
    "fails when manifest.json spells %s with %s (%s), which the scan's shape misses",
    (token, _label, misspelt) => {
      const dir = stageAddon((source) =>
        editFile(source, "manifest.json", (content) => content.replace(token, misspelt)),
      );

      const message = thrownMessage(() => verifyBuiltAddon(dir, meta));
      expect(message).toContain("manifest.json does not match package.json");
      expect(message).toContain(misspelt);
    },
  );
});

describe("symbolic links in the addon", () => {
  const OUTSIDE_CONTENT = '{ "version": "__buildVersion__" }';

  it("accepts addon/ as it is", () => {
    expect(() => assertNoSymbolicLinks(ADDON_SOURCE)).not.toThrow();
  });

  it.for(["file", "directory"] as const)(
    "refuses a link to a %s outside the addon in every walk, naming the link and writing nothing through it",
    (kind, { skip }) => {
      // A file symlink needs a privilege most Windows accounts lack; a junction does not.
      skip(process.platform === "win32" && kind === "file", "file symlinks need a privilege");
      const addon = copyAddon();
      const outside = tempDir("citegeist-outside-");
      const outsideFile = join(outside, "about.json");
      writeFileSync(outsideFile, OUTSIDE_CONTENT);
      const link = join(addon, "content", kind === "file" ? "about.json" : "shared");
      if (kind === "file") symlinkSync(outsideFile, link, "file");
      else symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");

      const refusal = `${link} is a symbolic link`;
      expect(() => assertNoSymbolicLinks(addon)).toThrow(refusal);
      expect(() => replacePlaceholders(addon, placeholdersFor(meta))).toThrow(refusal);
      expect(() => verifyBuiltAddon(addon, meta)).toThrow(refusal);
      expect(readFileSync(outsideFile, "utf8")).toBe(OUTSIDE_CONTENT);
    },
  );

  it("refuses an addon directory that is itself a link", () => {
    const parent = tempDir("citegeist-linked-addon-");
    const real = join(parent, "real");
    mkdirSync(real);
    const link = join(parent, "addon");
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");

    expect(() => assertNoSymbolicLinks(link)).toThrow(`${link} is a symbolic link`);
  });
});

describe.skipIf(MISSING_ZIP_TOOLS.length > 0 && !process.env.CI)("verifyPackagedAddon", () => {
  it("returns the range of an XPI zipped from a verified build", () => {
    expect(verifyPackagedAddon(zipDirectory(stageAddon()), meta)).toEqual({
      min: "7.0.10",
      max: "10.0.*",
    });
  });

  it("fails on an XPI zipped from addon/ itself, whose placeholders were never replaced", () => {
    const xpi = zipDirectory(ADDON_SOURCE);

    const message = thrownMessage(() => verifyPackagedAddon(xpi, meta));
    expect(message).toContain(`The packaged XPI ${xpi} fails verification`);
    expect(message).toContain("Unreplaced build placeholders in shipped files");
    expect(message).toContain("manifest.json: __addonName__");
  });

  it("fails on an XPI whose manifest cap differs from package.json, showing both ranges", () => {
    const dir = stageAddon();
    editFile(dir, "manifest.json", (content) => content.replace('"10.0.*"', '"9.*"'));
    const xpi = zipDirectory(dir);

    const message = thrownMessage(() => verifyPackagedAddon(xpi, meta));
    expect(message).toContain(`The packaged XPI ${xpi} fails verification`);
    expect(message).toContain(
      "Zotero range is 7.0.10 to 9.*, package.json config gives 7.0.10 to 10.0.*",
    );
  });

  it("fails naming the file when it is not a zip archive", () => {
    const xpi = join(tempDir("citegeist-xpi-test-"), "citegeist.xpi");
    writeFileSync(xpi, "not a zip archive");

    expect(() => verifyPackagedAddon(xpi, meta)).toThrow(`Could not extract ${xpi} to verify it`);
  });
});

describe("placeholder scan", () => {
  it("names each file that holds a placeholder, reporting a repeated token once", () => {
    const message = thrownMessage(() =>
      assertNoUnreplacedPlaceholders([
        { path: "bootstrap.js", content: 'registerChrome("citegeist");' },
        { path: "manifest.json", content: '{ "strict_max_version": "__zoteroMaxVersion__" }' },
        {
          path: "content/preferences.xhtml",
          content: "<label>v__buildVersion__ (__buildVersion__)</label>",
        },
      ]),
    );

    expect(message).toContain("manifest.json: __zoteroMaxVersion__");
    expect(message).toContain("content/preferences.xhtml: __buildVersion__");
    expect(message).not.toContain("__buildVersion__, __buildVersion__");
    expect(message).not.toContain("bootstrap.js");
  });

  it("flags a misspelt placeholder but not JavaScript dunder names or bundler annotations", () => {
    expect(() =>
      assertNoUnreplacedPlaceholders([
        {
          path: "content/scripts/citegeist.js",
          content:
            'var a = /* @__PURE__ */ f(); if (k === "__proto__") return; o.__defineGetter__("x", g); ' +
            "o.__iterator__; o.__noSuchMethod__; o.__parent__;",
        },
      ]),
    ).not.toThrow();
    expect(() =>
      assertNoUnreplacedPlaceholders([
        { path: "manifest.json", content: '"__zoteroMaxVerison__"' },
      ]),
    ).toThrow("manifest.json: __zoteroMaxVerison__");
  });

  it("recognises every placeholder the build defines", () => {
    for (const token of Object.keys(placeholdersFor(meta))) {
      expect(() =>
        assertNoUnreplacedPlaceholders([{ path: "manifest.json", content: token }]),
      ).toThrow(`manifest.json: ${token}`);
    }
  });
});

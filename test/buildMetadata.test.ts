import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { parseDocument } from "yaml";
import pkg from "../package.json";
import {
  assertRangeShape,
  compareVersions,
  placeholdersFor,
  readBuildMetadata,
  updateManifestFor,
} from "../scripts/build-metadata.mjs";

function withConfig(overrides: Record<string, string>) {
  return { ...pkg, config: { ...pkg.config, ...overrides } };
}

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the call to throw");
}

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

describe("version order (compareVersions, Firefox's nsVersionComparator)", () => {
  it("sorts main's development version below every prerelease of its version and the version itself", () => {
    // docs/RELEASE-CHECKLIST.md, section 5: main carries X.Y.Z-alpha.0 between releases.
    for (const later of ["3.0.0-alpha.1", "3.0.0-beta.1", "3.0.0-rc.1", "3.0.0"]) {
      expect(compareVersions("3.0.0-alpha.0", later), `3.0.0-alpha.0 < ${later}`).toBe(-1);
      expect(compareVersions(later, "3.0.0-alpha.0"), `${later} > 3.0.0-alpha.0`).toBe(1);
    }
    expect(compareVersions("2.0.6", "3.0.0-alpha.0")).toBe(-1);
    // Firefox compares the text as a string, so a "-dev" suffix would sort above every beta.
    expect(compareVersions("3.0.0-dev.0", "3.0.0-beta.1")).toBe(1);
  });

  it("follows Firefox's rules for numbers, text, missing parts, * and +", () => {
    expect(compareVersions("3.0.0-rc.9", "3.0.0-rc.10")).toBe(-1);
    expect(compareVersions("3.0.0-rc2", "3.0.0-rc10")).toBe(1);
    expect(compareVersions("3.0.0+b", "3.0.1pre")).toBe(0);
    expect(compareVersions("10", "10.0")).toBe(0);
    expect(compareVersions("10.0.1", "10.0.*")).toBe(-1);
    expect(compareVersions("10.1", "10.0.*")).toBe(1);
    expect(compareVersions("1.0a", "1.0")).toBe(-1);
    expect(compareVersions("1.0.0.1", "1.0")).toBe(1);
    expect(compareVersions("10000000000.0", "0.0")).toBe(0);
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
    // A development suffix would sort between beta and rc: Firefox compares the text as a string
    "3.0.0-dev.0",
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
          `matrix first, then raise the cap to match it; never loosen the cap past what it runs.`,
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

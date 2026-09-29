/**
 * Safety properties of every GitHub Actions workflow (plan KTD13). A published release reaches every
 * installed copy on its next update check, so each test here closes one way a wrong commit, a stale
 * run or a compromised dependency could get there. If one fails, fix the workflow; never weaken the
 * test.
 *
 * The release scripts' own behaviour is tested in release-guard.test.ts and release-scripts.test.ts.
 * This file checks that the workflows call them, in the right jobs, in the right order, with the
 * right permissions, and runs the workflow steps that act on their own with the environment their
 * YAML gives them.
 */
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isAlias, isScalar, parseDocument, visit } from "yaml";
import {
  GH_TOKEN,
  GhStub,
  PROCESS_TEST_TIMEOUT_MS,
  REPO_ROOT,
  REPOSITORY,
  TempDirs,
  git,
  isolatedEnv,
  runScript,
} from "./release-fixtures";

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: unknown;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  shell?: string;
  "working-directory"?: string;
  "continue-on-error"?: unknown;
  "timeout-minutes"?: unknown;
}

interface Job {
  name?: string;
  "runs-on"?: unknown;
  uses?: string;
  with?: Record<string, unknown>;
  needs?: string | string[];
  if?: unknown;
  permissions?: unknown;
  concurrency?: unknown;
  outputs?: Record<string, string>;
  strategy?: { matrix?: Record<string, unknown> };
  defaults?: { run?: { shell?: string } };
  env?: Record<string, string>;
  "timeout-minutes"?: unknown;
  "continue-on-error"?: unknown;
  steps?: Step[];
}

interface Workflow {
  on?: unknown;
  permissions?: unknown;
  defaults?: { run?: { shell?: string } };
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}

const WORKFLOW_DIR = join(REPO_ROOT, ".github/workflows");
const WORKFLOW_FILES = readdirSync(WORKFLOW_DIR)
  .filter((file) => /\.ya?ml$/i.test(file))
  .sort();
const sources = Object.fromEntries(
  WORKFLOW_FILES.map((file) => [file, readFileSync(join(WORKFLOW_DIR, file), "utf8")]),
);
const documents = Object.fromEntries(
  WORKFLOW_FILES.map((file) => [file, parseDocument(sources[file])]),
);
const workflows = Object.fromEntries(
  WORKFLOW_FILES.map((file) => [file, (documents[file].toJS() ?? { jobs: {} }) as Workflow]),
);

const RELEASE = "publish-release.yml";

/**
 * Every permission every job holds, exactly. A workflow or job missing from this table fails, so a
 * new write scope is a reviewed change to this file (CODEOWNERS). Every job that holds a write scope
 * here is held to the command allowlist below.
 */
const PERMISSIONS: Record<
  string,
  { workflow: Record<string, string>; jobs: Record<string, Record<string, string>> }
> = {
  "ci.yml": {
    workflow: { contents: "read" },
    jobs: {
      test: { contents: "read" },
      "real-zotero": { contents: "read" },
      zizmor: { contents: "read" },
      gate: {},
    },
  },
  "okf-watch.yml": {
    workflow: { contents: "read" },
    jobs: { drift: { contents: "read", issues: "write" } },
  },
  [RELEASE]: {
    workflow: {},
    jobs: {
      build: { contents: "read", "pull-requests": "read" },
      verify: { contents: "read" },
      "real-zotero": { contents: "read" },
      publish: { contents: "write", "id-token": "write", attestations: "write" },
      badges: { contents: "write" },
    },
  },
  "real-zotero.yml": {
    workflow: { contents: "read" },
    jobs: { "real-zotero": { contents: "read" } },
  },
};

/** "<file> <job>" for every job the table gives a write scope. Each runs only allowlisted commands. */
const WRITE_SCOPED_JOBS = new Set(
  Object.entries(PERMISSIONS).flatMap(([file, { jobs }]) =>
    Object.entries(jobs)
      .filter(([, scopes]) => Object.values(scopes).includes("write"))
      .map(([id]) => `${file} ${id}`),
  ),
);
/** The actions each write-scoped job may use, and nothing else. */
const WRITE_SCOPED_ACTIONS: Record<string, string[]> = {
  [`${RELEASE} publish`]: ["actions/download-artifact", "actions/checkout", "actions/attest"],
  [`${RELEASE} badges`]: ["actions/checkout"],
  "okf-watch.yml drift": ["actions/checkout"],
};
/** The jobs whose checkout keeps its credentials, because they push. They run no dependency. */
const PUSHING_JOBS = new Set([`${RELEASE} publish`, `${RELEASE} badges`]);
/** A step that mentions any of these runs dependencies, test code or Zotero. */
const THIRD_PARTY_CODE = /\b(?:npm|npx|pnpm|yarn|vitest|mocha|zotero-plugin|xvfb-run)\b/;
const INSTALL = "npm install --no-audit --no-fund --ignore-scripts";
const LOCKFILE_CHECK = "git diff --exit-code package-lock.json";
const BUILD = "node scripts/build.mjs";
/** The install and gates, in order, that ci.yml's test job and the release's Verify job run. */
const GATES = [
  INSTALL,
  LOCKFILE_CHECK,
  "npm run typecheck",
  "npm run lint",
  "npm run format:check",
  "npm run okf:check",
  "npm run check:sh",
  "npm test",
];
const API_VERSION_HEADER = "X-GitHub-Api-Version: 2022-11-28";
/** Build's step ids, in order. */
const BUILD_STEPS = [
  "dispatch-ref",
  "checkout",
  "setup-node",
  "release-guard",
  "release-checkout",
  "install",
  "lockfile",
  "build",
  "digest",
  "upload",
];
/** Publish's step ids, in order: reads, then the attestation, then writes. */
const PUBLISH_READS = ["download", "checkout", "digest-check", "tag-state", "channel-version"];
const PUBLISH_WRITES = ["tag", "versioned-release", "channel"];
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function workflow(file: string): Workflow {
  const parsed = workflows[file];
  if (!parsed) throw new Error(`.github/workflows/${file} is missing`);
  return parsed;
}

function jobOf(file: string, id: string): Job {
  const job = workflow(file).jobs?.[id];
  if (!job) throw new Error(`${file} has no job "${id}"`);
  return job;
}

function stepsOf(job: Job): Step[] {
  return job.steps ?? [];
}

function stepById(job: Job, id: string): Step {
  const step = stepsOf(job).find((candidate) => candidate.id === id);
  if (!step) throw new Error(`no step with id "${id}"`);
  return step;
}

function runOf(job: Job, id: string): string {
  const run = stepById(job, id).run;
  if (typeof run !== "string") throw new Error(`step "${id}" has no run script`);
  return run;
}

function needsOf(job: Job): string[] {
  return job.needs === undefined ? [] : [job.needs].flat();
}

function everyJob(): { file: string; id: string; where: string; job: Job }[] {
  return WORKFLOW_FILES.flatMap((file) =>
    Object.entries(workflow(file).jobs ?? {}).map(([id, job]) => ({
      file,
      id,
      where: `${file} job ${id}`,
      job,
    })),
  );
}

function triggers(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys((on ?? {}) as Record<string, unknown>);
}

/** Every value under a key anywhere in a parsed workflow. */
function valuesOfKey(node: unknown, key: string): unknown[] {
  if (Array.isArray(node)) return node.flatMap((item) => valuesOfKey(item, key));
  if (node === null || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([name, value]) => [
    ...(name === key ? [value] : []),
    ...valuesOfKey(value, key),
  ]);
}

/** A step, by id or by what it runs or uses, for a readable order check. */
function describeStep(step: Step): string {
  if (step.id) return step.id;
  if (step.uses) return step.uses.split("@")[0];
  return `run ${step.run?.trim()}`;
}

/**
 * The environment a step's run: script sees from its YAML: the workflow's env:, the job's and the
 * step's, with each ${{ }} expression replaced by the value the test gives for it. An expression
 * with no value throws, so a test states every value the step depends on. `runner` adds the
 * variables GitHub's runner provides, such as RUNNER_TEMP and GITHUB_OUTPUT.
 */
function stepEnvironment(
  file: string,
  job: Job,
  step: Step,
  values: Record<string, string>,
  runner: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = { ...runner };
  for (const [name, value] of Object.entries({
    ...(workflow(file).env ?? {}),
    ...(job.env ?? {}),
    ...(step.env ?? {}),
  })) {
    env[name] = String(value).replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_match, expression: string) => {
      if (!(expression in values)) {
        throw new Error(`the test gives no value for \${{ ${expression} }} in ${name}`);
      }
      return values[expression];
    });
  }
  return env;
}

/** A directory holding an executable Node script under each name given. */
function nodeTools(dir: string, tools: Record<string, string>): string {
  const bin = join(dir, "tools-bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  }
  return bin;
}

/** A git stand-in that records each call's arguments as a JSON line and succeeds. */
function recordingGit(dir: string, log: string): string {
  writeFileSync(log, "");
  return nodeTools(dir, {
    git: [
      'const fs = require("fs");',
      "const args = process.argv.slice(2);",
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");`,
      'if (args[0] === "worktree" && args[1] === "add") fs.mkdirSync(args[3], { recursive: true });',
    ].join("\n"),
  });
}

function recorded(log: string): string[][] {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

const temp = new TempDirs();
afterEach(() => temp.removeAll(), PROCESS_TEST_TIMEOUT_MS);

describe("every workflow", () => {
  it("is loaded: every file in .github/workflows is a workflow this file reads", () => {
    const entries = readdirSync(WORKFLOW_DIR).sort();
    expect(entries, "a file the loader skips is a workflow nothing here checks").toEqual(
      WORKFLOW_FILES,
    );
    for (const file of entries) {
      expect(lstatSync(join(WORKFLOW_DIR, file)).isFile(), file).toBe(true);
    }
    expect(WORKFLOW_FILES).toContain(RELEASE);
  });

  it("parses cleanly, with no anchors, aliases or merge keys", () => {
    for (const file of WORKFLOW_FILES) {
      const document = documents[file];
      expect(
        [...document.errors, ...document.warnings].map((problem) => problem.message),
        file,
      ).toEqual([]);
      const found: string[] = [];
      visit(document, {
        Alias: () => {
          found.push("an alias");
        },
        Node: (_key, node) => {
          if (!isAlias(node) && node.anchor) found.push(`the anchor &${node.anchor}`);
        },
        Pair: (_key, pair) => {
          if (isScalar(pair.key) && pair.key.value === "<<") found.push("a merge key <<");
        },
      });
      expect(found, file).toEqual([]);
    }
  });

  it("holds exactly the permissions the table lists, workflow by workflow and job by job", () => {
    expect(WORKFLOW_FILES).toEqual(Object.keys(PERMISSIONS).sort());
    for (const file of WORKFLOW_FILES) {
      const expected = PERMISSIONS[file];
      expect(workflow(file).permissions, `${file} top-level permissions`).toEqual(
        expected.workflow,
      );
      expect(Object.keys(workflow(file).jobs ?? {}).sort(), `${file} jobs`).toEqual(
        Object.keys(expected.jobs).sort(),
      );
      for (const [id, permissions] of Object.entries(expected.jobs)) {
        expect(jobOf(file, id).permissions, `${file} job ${id} permissions`).toEqual(permissions);
      }
    }
  });

  it("never runs on a tag, so no old commit's workflow can publish", () => {
    for (const file of WORKFLOW_FILES) {
      const on = workflow(file).on;
      const events = triggers(on);
      // A tag's creation, and a release's, would run the workflow file in that tag's commit.
      for (const event of ["create", "release"]) {
        expect(events, `${file} runs on ${event}`).not.toContain(event);
      }
      if (!events.includes("push")) continue;
      // `on: push` with no filter, or any tags filter, runs on a tag push too.
      const push = (on as Record<string, unknown>)?.push as Record<string, unknown> | null;
      expect(push, `${file} runs on every push, tags included`).toBeTypeOf("object");
      expect(Object.keys(push ?? {}), `${file} push filters`).toEqual(["branches"]);
    }
  });

  it("runs every job on ubuntu-24.04 with a timeout", () => {
    for (const { where, job } of everyJob()) {
      if (job.uses !== undefined) continue;
      expect(job["runs-on"], where).toBe("ubuntu-24.04");
      expect(typeof job["timeout-minutes"], where).toBe("number");
    }
  });

  it("runs every run: script under bash, which GitHub runs with pipefail", () => {
    for (const file of WORKFLOW_FILES) {
      expect(workflow(file).defaults, `${file} defaults`).toEqual({ run: { shell: "bash" } });
    }
    for (const { where, job } of everyJob()) {
      expect(job.defaults, `${where} defaults`).toBeUndefined();
      for (const step of stepsOf(job)) {
        expect(step.shell, `${where} step "${step.name ?? step.run}"`).toBeUndefined();
      }
    }
  });

  it("pins every action to a full commit SHA with a # vX.Y.Z comment", () => {
    for (const file of WORKFLOW_FILES) {
      for (const line of sources[file].split("\n")) {
        const uses = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line);
        if (!uses || uses[1].startsWith("./")) continue;
        expect(line.trim(), file).toMatch(
          /^(?:-\s+)?uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/,
        );
      }
    }
    for (const { where, job } of everyJob()) {
      for (const uses of [job.uses, ...stepsOf(job).map((step) => step.uses)]) {
        if (uses === undefined || uses.startsWith("./")) continue;
        expect(uses, where).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      }
    }
  });

  it("sets no continue-on-error on any job or step", () => {
    for (const { where, job } of everyJob()) {
      expect(job["continue-on-error"], where).toBeUndefined();
      for (const step of stepsOf(job)) {
        expect(
          step["continue-on-error"],
          `${where} step "${step.name ?? step.run}"`,
        ).toBeUndefined();
      }
    }
  });

  it("keeps credentials out of every checkout, except in the jobs that push and run no dependency", () => {
    expect([...PUSHING_JOBS].every((job) => WRITE_SCOPED_JOBS.has(job))).toBe(true);
    let checkouts = 0;
    for (const { where, job } of everyJob()) {
      for (const step of stepsOf(job)) {
        if (!step.uses?.startsWith("actions/checkout@")) continue;
        checkouts++;
        if (PUSHING_JOBS.has(where.replace(" job ", " "))) {
          // Said outright, so the reason reads in the workflow and zizmor's artipacked audit sees it.
          expect(step.with?.["persist-credentials"], `${where} checkout`).toBe(true);
          for (const other of stepsOf(job)) {
            expect(other.run ?? "", `${where} pushes, so it runs no dependency`).not.toMatch(
              THIRD_PARTY_CODE,
            );
          }
        } else {
          expect(step.with?.["persist-credentials"], `${where} checkout`).toBe(false);
        }
      }
    }
    expect(checkouts).toBe(8);
  });

  it("puts no ${{ }} expression inside a run: script, where it would be spliced in as code", () => {
    for (const { where, job } of everyJob()) {
      for (const step of stepsOf(job)) {
        expect(step.run ?? "", `${where} step "${step.name ?? step.id}"`).not.toContain("${{");
      }
    }
  });

  it("never triggers on pull_request_target", () => {
    for (const file of WORKFLOW_FILES) {
      expect(triggers(workflow(file).on), file).not.toContain("pull_request_target");
    }
  });

  it("checks the lockfile in the step right after every npm install", () => {
    let installs = 0;
    for (const { where, job } of everyJob()) {
      const steps = stepsOf(job);
      steps.forEach((step, index) => {
        if (!/\bnpm (?:install|i|ci)\b/.test(step.run ?? "")) return;
        installs++;
        expect(step.run?.trim(), `${where}: the install`).toBe(INSTALL);
        expect(steps[index + 1]?.run?.trim(), `${where}: the step after "${step.run}"`).toBe(
          LOCKFILE_CHECK,
        );
      });
    }
    expect(installs, "npm install steps found").toBe(4);
  });

  it("builds with node, never through npm run, which puts node_modules/.bin first on PATH", () => {
    const builds: string[] = [];
    for (const { where, job } of everyJob()) {
      for (const step of stepsOf(job)) {
        const run = step.run ?? "";
        expect(run, `${where} step "${step.name ?? step.id}"`).not.toMatch(
          /\bnpm run build\b|\bnpm run-script build\b/,
        );
        if (!/\bscripts\/build\.mjs\b/.test(run)) continue;
        builds.push(where);
        expect(run.trim(), where).toBe(BUILD);
      }
    }
    expect(builds.sort()).toEqual(
      ["ci.yml job test", `${RELEASE} job build`, "real-zotero.yml job real-zotero"].sort(),
    );
  });

  it("pins the API version on every gh api call a step makes", () => {
    let calls = 0;
    for (const { where, job } of everyJob()) {
      for (const step of stepsOf(job)) {
        if (step.run === undefined) continue;
        for (const words of shellCommands(step.run).commands) {
          if (words[0] !== "gh" || words[1] !== "api") continue;
          calls++;
          const header = words.indexOf("-H");
          expect(unquote(words[header + 1] ?? ""), `${where}: ${words.join(" ")}`).toBe(
            API_VERSION_HEADER,
          );
        }
      }
    }
    expect(calls).toBeGreaterThan(0);
  });

  it("gives GH_TOKEN to every step that runs gh, directly or through a script it calls", () => {
    let steps = 0;
    for (const { file, where, job } of everyJob()) {
      for (const step of stepsOf(job)) {
        if (step.run === undefined || !runsGh(step.run, REPO_ROOT)) continue;
        steps++;
        const token = {
          ...(workflow(file).env ?? {}),
          ...(job.env ?? {}),
          ...(step.env ?? {}),
        }.GH_TOKEN;
        expect(
          ["${{ github.token }}", "${{ secrets.GITHUB_TOKEN }}"],
          `${where} step "${step.name ?? step.id}" runs gh`,
        ).toContain(token);
      }
    }
    // The guard, the channel check, the versioned release, the channel move, the badges refresh,
    // and okf-watch's drift check and issue step.
    expect(steps).toBe(7);
  });
});

describe("the write-scoped jobs", () => {
  it("are every job the permissions table gives a write scope, and the pushing jobs are among them", () => {
    // Read from the workflows themselves, so the set cannot be a list of names kept by hand.
    const writing = everyJob()
      .filter(({ job }) =>
        Object.values((job.permissions ?? {}) as Record<string, string>).includes("write"),
      )
      .map(({ where }) => where.replace(" job ", " "))
      .sort();
    expect(writing.length).toBeGreaterThan(0);
    expect([...WRITE_SCOPED_JOBS].sort()).toEqual(writing);
    expect(Object.keys(WRITE_SCOPED_ACTIONS).sort()).toEqual(writing);
    for (const job of PUSHING_JOBS) expect(WRITE_SCOPED_JOBS.has(job), job).toBe(true);
  });

  it("use no action but the ones listed for them", () => {
    for (const { where, job } of everyJob()) {
      const allowed = WRITE_SCOPED_ACTIONS[where.replace(" job ", " ")];
      if (allowed === undefined) continue;
      for (const step of stepsOf(job)) {
        if (step.uses === undefined) continue;
        expect(allowed, `${where} uses ${step.uses}`).toContain(step.uses.split("@")[0]);
      }
    }
  });

  it("run only allowlisted commands, in their steps and every script those call", () => {
    const problems: string[] = [];
    const followed = new Set<string>();
    for (const { where, job } of everyJob()) {
      if (!WRITE_SCOPED_JOBS.has(where.replace(" job ", " "))) continue;
      for (const step of stepsOf(job)) {
        if (step.run === undefined) continue;
        checkShell(
          step.run,
          `${where} step ${step.id ?? step.name}`,
          REPO_ROOT,
          problems,
          followed,
        );
      }
    }
    expect(problems).toEqual([]);
    expect([...followed].sort()).toEqual(
      [
        "scripts/check-channel-version-cli.mjs",
        "scripts/check-channel-version.mjs",
        "scripts/publish-update-channel.sh",
        "scripts/publish-versioned-release.sh",
        "scripts/readme-badges-cli.mjs",
        "scripts/readme-badges.mjs",
        "scripts/release-github.mjs",
        "scripts/verify-release-assets.sh",
        "scripts/version.mjs",
        "tools/okf-drift-check.sh",
      ].sort(),
    );
  });
});

describe("ci.yml", () => {
  it("triggers on push to main and pull requests only", () => {
    expect(triggers(workflow("ci.yml").on).sort()).toEqual(["pull_request", "push"]);
  });

  it("runs the install and every gate in order, then the build, in the test job", () => {
    const steps = stepsOf(jobOf("ci.yml", "test"));
    expect(steps.slice(0, 2).map((step) => step.uses?.split("@")[0])).toEqual([
      "actions/checkout",
      "actions/setup-node",
    ]);
    expect(steps.slice(2).map((step) => step.run?.trim())).toEqual([...GATES, BUILD]);
    for (const step of steps) expect(step.if, step.name ?? step.run).toBeUndefined();
  });

  it("runs the same gates in the same order as npm run verify, which is the local pre-commit line", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.build).toBe(BUILD);
    expect(pkg.scripts["check:sh"]).toBe("shellcheck scripts/*.sh");
    const verify = pkg.scripts.verify.split(" && ");
    const ciGates = stepsOf(jobOf("ci.yml", "test"))
      .slice(4)
      .map((step) => step.run?.trim());
    expect(verify).toEqual(
      ciGates.map((command) => (command === BUILD ? "npm run build" : command)),
    );
  });

  it("formats and checks the same files", () => {
    const { scripts } = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const globs = (script: string, flag: string) => {
      expect(script.startsWith(`prettier ${flag} `), script).toBe(true);
      return script.slice(`prettier ${flag} `.length);
    };
    expect(globs(scripts["format:check"], "--check")).toBe(globs(scripts.format, "--write"));
  });

  it("calls real-zotero.yml with no inputs, so pull requests run the default matrix", () => {
    const job = jobOf("ci.yml", "real-zotero");
    expect(job.uses).toBe("./.github/workflows/real-zotero.yml");
    expect(job.with).toBeUndefined();
  });

  it("audits every workflow with zizmor at a pinned version", () => {
    const steps = stepsOf(jobOf("ci.yml", "zizmor"));
    expect(steps.map((step) => step.uses?.split("@")[0])).toEqual([
      "actions/checkout",
      "zizmorcore/zizmor-action",
    ]);
    expect(steps[1].with).toEqual({
      version: "1.30.1",
      inputs: ".",
      collect: "workflows",
      "advanced-security": false,
      annotations: true,
    });
  });

  it("gates on every other job, always", () => {
    const gate = jobOf("ci.yml", "gate");
    expect(gate.name).toBe("CI gate");
    const others = Object.keys(workflow("ci.yml").jobs).filter((id) => id !== "gate");
    expect([...needsOf(gate)].sort()).toEqual(others.sort());
    expect(others).toContain("zizmor");
    // A skipped required check counts as passing, so the gate must run whatever its needs did.
    expect(gate.if).toBe("${{ always() }}");
    const steps = stepsOf(gate);
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBeUndefined();
    expect(steps[0].env?.RESULTS).toBe("${{ join(needs.*.result, ' ') }}");
  });

  it(
    "fails the gate unless every job result is success",
    () => {
      const run = stepsOf(jobOf("ci.yml", "gate"))[0]?.run ?? "exit 0";
      const dir = temp.make("gate");
      const status = (results: string) =>
        runScript(run, isolatedEnv(dir, { RESULTS: results }), dir).status;

      expect(status("success success")).toBe(0);
      for (const results of [
        "success failure",
        "cancelled success",
        "success skipped",
        "failure",
        "",
      ]) {
        expect(status(results), `RESULTS="${results}"`).not.toBe(0);
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("publish-release.yml: how a release starts", () => {
  it("runs only on a dispatch, with exactly a required version and an optional commit", () => {
    const on = workflow(RELEASE).on as {
      workflow_dispatch?: { inputs?: Record<string, Record<string, unknown>> };
    };
    expect(triggers(on)).toEqual(["workflow_dispatch"]);
    const inputs = on.workflow_dispatch?.inputs ?? {};
    expect(Object.keys(inputs).sort()).toEqual(["commit", "version"]);
    expect(inputs.version).toMatchObject({ type: "string", required: true });
    expect(inputs.commit).toMatchObject({ type: "string", required: false, default: "" });
  });

  it(
    "refuses, as its first step, a run started anywhere but main",
    () => {
      const build = jobOf(RELEASE, "build");
      expect(stepsOf(build)[0].id).toBe("dispatch-ref");
      const dir = temp.make("dispatch-ref");
      const status = (ref: string) =>
        runScript(
          runOf(build, "dispatch-ref"),
          isolatedEnv(dir, { GITHUB_REF: ref, GITHUB_SHA: COMMIT }),
          dir,
        ).status;
      expect(status("refs/heads/main")).toBe(0);
      for (const ref of [
        "refs/heads/release/v3.1.0",
        "refs/heads/main-old",
        "refs/heads/feature/main",
        "refs/tags/v3.1.0",
        "refs/pull/12/merge",
        "main",
        "",
      ]) {
        expect(status(ref), `GITHUB_REF="${ref}"`).toBe(1);
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it("runs every later job only once build has passed, directly or through it", () => {
    for (const id of ["real-zotero", "publish", "badges"]) {
      expect(needsOf(jobOf(RELEASE, id)), id).toContain(id === "badges" ? "publish" : "build");
    }
    expect([...needsOf(jobOf(RELEASE, "publish"))].sort()).toEqual([
      "build",
      "real-zotero",
      "verify",
    ]);
    for (const { where, job } of everyJob().filter(({ file }) => file === RELEASE)) {
      expect(job.if, where).toBeUndefined();
    }
  });
});

describe("publish-release.yml build", () => {
  const build = () => jobOf(RELEASE, "build");

  it("checks the dispatch, then main's copy of the guard, then builds the commit the guard resolved", () => {
    expect(stepsOf(build()).map(describeStep)).toEqual(BUILD_STEPS);
    for (const step of stepsOf(build())) expect(step.if, step.id).toBeUndefined();
    expect(stepById(build(), "checkout").with).toEqual({
      "persist-credentials": false,
      "fetch-depth": 0,
    });
    expect(stepById(build(), "release-guard")).toMatchObject({
      run: 'node scripts/release-guard-cli.mjs "$VERSION" "${COMMIT:-$GITHUB_SHA}"',
      env: {
        VERSION: "${{ inputs.version }}",
        COMMIT: "${{ inputs.commit }}",
        GH_TOKEN: "${{ github.token }}",
      },
    });
    expect(stepById(build(), "release-checkout")).toMatchObject({
      run: 'git checkout --quiet --detach "$COMMIT"',
      env: { COMMIT: "${{ steps.release-guard.outputs.commit }}" },
    });
    expect(runOf(build(), "install").trim()).toBe(INSTALL);
    expect(runOf(build(), "lockfile").trim()).toBe(LOCKFILE_CHECK);
    expect(runOf(build(), "digest")).not.toMatch(/\bnode\b/);
    expect(runOf(build(), "digest")).not.toMatch(THIRD_PARTY_CODE);
  });

  it(
    "gives the guard the commit input, or the run's own commit when that is empty",
    () => {
      const dir = temp.make("guard-step");
      const log = join(dir, "node-args.json");
      const bin = nodeTools(dir, {
        node: `require("fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));`,
      });
      const step = stepById(build(), "release-guard");
      const argsFor = (commit: string) => {
        const env = stepEnvironment(
          RELEASE,
          build(),
          step,
          { "inputs.version": "3.1.0", "inputs.commit": commit, "github.token": GH_TOKEN },
          { GITHUB_SHA: COMMIT },
        );
        expect(runScript(step.run ?? "", isolatedEnv(dir, env, [bin]), dir).status).toBe(0);
        return JSON.parse(readFileSync(log, "utf8")) as string[];
      };
      expect(argsFor("")).toEqual(["scripts/release-guard-cli.mjs", "3.1.0", COMMIT]);
      expect(argsFor("f".repeat(40))).toEqual([
        "scripts/release-guard-cli.mjs",
        "3.1.0",
        "f".repeat(40),
      ]);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it("builds with node alone, taking the time from the commit and nothing from the clock or the run", () => {
    const step = stepById(build(), "build");
    // No env:, with: or working-directory, so nothing reaches the build but the runner's own
    // environment; build.mjs then takes the build id and file times from the commit
    // (test/build-end-to-end.test.ts, "a reproducible production build").
    expect(step).toEqual({ name: "Build the release XPI", id: "build", run: BUILD });
    expect(workflow(RELEASE).env, "workflow env").toBeUndefined();
    expect(build().env, "build job env").toBeUndefined();
    expect(valuesOfKey(workflow(RELEASE), "SOURCE_DATE_EPOCH")).toEqual([]);
    const beforeBuild = stepsOf(build()).slice(0, BUILD_STEPS.indexOf("build"));
    for (const earlier of beforeBuild) {
      expect(earlier.run ?? "", `${earlier.id} sets nothing later steps inherit`).not.toMatch(
        /GITHUB_ENV|GITHUB_PATH/,
      );
    }
    expect(build()["runs-on"]).toBe("ubuntu-24.04");
  });

  it("restores no dependency cache in build or verify, and turns setup-node's own caching off", () => {
    let setups = 0;
    for (const id of ["build", "verify"]) {
      for (const step of stepsOf(jobOf(RELEASE, id))) {
        if (!step.uses?.startsWith("actions/setup-node@")) {
          expect(step.with?.cache, `${id} ${step.id ?? step.uses ?? step.run}`).toBeUndefined();
          continue;
        }
        setups++;
        expect(step.with, `${id} setup-node`).toEqual({
          "node-version": 22,
          "package-manager-cache": false,
        });
      }
    }
    expect(setups).toBe(2);
  });

  it("names the artifact per run attempt, and every consumer takes the release and its digests from build's outputs", () => {
    const job = build();
    const digest = stepById(job, "digest");
    expect(digest.env?.ARTIFACT).toBe("release-assets-${{ github.run_attempt }}");
    expect(digest.run).toContain('echo "artifact=$ARTIFACT"');
    expect(stepById(job, "upload").with?.name).toBe("${{ steps.digest.outputs.artifact }}");
    expect(job.outputs).toEqual({
      commit: "${{ steps.release-guard.outputs.commit }}",
      tag: "${{ steps.release-guard.outputs.tag }}",
      artifact: "${{ steps.digest.outputs.artifact }}",
      "asset-sums": "${{ steps.digest.outputs.sums }}",
      "xpi-sha256": "${{ steps.digest.outputs.xpi-sha256 }}",
    });

    const realZotero = jobOf(RELEASE, "real-zotero");
    expect(realZotero.uses).toBe("./.github/workflows/real-zotero.yml");
    expect(needsOf(realZotero)).toEqual(["build"]);
    expect(realZotero.with).toEqual({
      ref: "${{ needs.build.outputs.commit }}",
      "xpi-artifact": "${{ needs.build.outputs.artifact }}",
      "xpi-sha256": "${{ needs.build.outputs.xpi-sha256 }}",
    });

    const publish = jobOf(RELEASE, "publish");
    expect(stepById(publish, "download").with).toEqual({
      name: "${{ needs.build.outputs.artifact }}",
      path: "${{ runner.temp }}/release-assets",
    });
    expect(publish.env).toEqual({
      TAG: "${{ needs.build.outputs.tag }}",
      COMMIT: "${{ needs.build.outputs.commit }}",
      SUMS: "${{ needs.build.outputs.asset-sums }}",
      GH_REPO: "${{ github.repository }}",
    });
  });
});

describe("publish-release.yml verify", () => {
  it("checks out the commit build releases, then runs the install and every gate in order, and nothing else", () => {
    const steps = stepsOf(jobOf(RELEASE, "verify"));
    expect(steps[0].uses).toMatch(/^actions\/checkout@/);
    expect(steps[0].with).toEqual({
      "persist-credentials": false,
      ref: "${{ inputs.commit || github.sha }}",
    });
    expect(steps[1].uses).toMatch(/^actions\/setup-node@/);
    expect(steps.slice(2).map((step) => step.run?.trim())).toEqual(GATES);
    for (const step of steps) expect(step.if, step.name ?? step.run).toBeUndefined();
  });
});

describe("publish-release.yml publish", () => {
  const publish = () => jobOf(RELEASE, "publish");

  it("downloads build's artifact once, checks out the workflow's own commit, then proves the bytes before anything else", () => {
    const steps = stepsOf(publish());
    expect(
      steps.filter((step) => step.uses?.startsWith("actions/download-artifact@")),
    ).toHaveLength(1);
    expect(steps.slice(0, 3).map((step) => step.id)).toEqual([
      "download",
      "checkout",
      "digest-check",
    ]);
    expect(steps[0].uses).toMatch(/^actions\/download-artifact@/);
    expect(steps[1].uses).toMatch(/^actions\/checkout@/);
    expect(steps[1].with).toEqual({ "persist-credentials": true, "fetch-depth": 0 });
    expect(steps[2].run?.trim()).toBe(
      'bash scripts/verify-release-assets.sh "$RUNNER_TEMP/release-assets"',
    );
    expect(steps[2]["working-directory"]).toBeUndefined();
  });

  it("reads, then attests, then writes, each step with an id and no if:, and creates the tag only after every check", () => {
    const steps = stepsOf(publish());
    for (const step of steps) {
      expect(step.id, `publish step "${step.name ?? step.uses}" has an id`).toBeTruthy();
      expect(step.if, `publish step ${step.id}`).toBeUndefined();
    }
    expect(steps.map((step) => step.id)).toEqual([...PUBLISH_READS, "attest", ...PUBLISH_WRITES]);
    for (const id of PUBLISH_READS) {
      const run = stepById(publish(), id).run ?? "";
      expect(run, `read-only step ${id}`).not.toMatch(
        /gh release (?:create|upload|edit|delete)|git push|git tag|publish-|gh api -X/,
      );
    }
    expect(runOf(publish(), "tag-state")).toContain(
      'git ls-remote origin "refs/tags/$TAG" "refs/tags/$TAG^{}"',
    );
    expect(runOf(publish(), "channel-version")).toContain(
      'node scripts/check-channel-version-cli.mjs "${TAG#v}"',
    );
    expect(stepById(publish(), "tag").env).toEqual({
      TAG_STATE: "${{ steps.tag-state.outputs.state }}",
    });
    expect(runOf(publish(), "versioned-release")).toContain(
      'bash scripts/publish-versioned-release.sh "$TAG" "$RUNNER_TEMP/release-assets"',
    );
    const channel = stepById(publish(), "channel");
    expect(channel.env?.CHANNEL_STATE).toBe("${{ steps.channel-version.outputs.state }}");
    expect(channel.run).toContain("bash scripts/publish-update-channel.sh");
  });

  it("attests exactly the verified assets, before anything is published", () => {
    const attest = stepById(publish(), "attest");
    expect(attest.uses).toMatch(/^actions\/attest@[0-9a-f]{40}$/);
    expect(attest.with).toEqual({
      "subject-path":
        "${{ runner.temp }}/release-assets/citegeist-*.xpi\n${{ runner.temp }}/release-assets/update.json\n",
    });
    // The token scopes it needs, and only those, are the permissions table's.
    expect(publish().permissions).toEqual({
      contents: "write",
      "id-token": "write",
      attestations: "write",
    });
    for (const { where, job } of everyJob()) {
      const scopes = (job.permissions ?? {}) as Record<string, string>;
      if (where === `${RELEASE} job publish`) continue;
      expect(scopes["id-token"], `${where} can mint an OIDC token`).toBeUndefined();
      expect(scopes.attestations, `${where} can write attestations`).toBeUndefined();
    }
  });

  it("serializes in the release-channel group, queueing rather than cancelling, and nothing cancels a run in progress", () => {
    expect(publish().concurrency).toEqual({
      group: "release-channel",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(jobOf(RELEASE, "badges").concurrency).toEqual({
      group: "readme-badges",
      "cancel-in-progress": false,
    });
    expect(valuesOfKey(workflow(RELEASE), "cancel-in-progress")).not.toContain(true);
    expect(sources[RELEASE]).not.toMatch(/cancel-in-progress:\s*(?!false\b)\S/);
  });

  /** A bare origin, and a clone holding the release commit and a later one, as Publish's checkout does. */
  function repository() {
    const root = temp.make("publish-git");
    const env = isolatedEnv(root);
    const origin = join(root, "origin.git");
    const work = join(root, "work");
    git(root, env, "init", "--quiet", "--bare", origin);
    git(root, env, "init", "--quiet", work);
    git(work, env, "remote", "add", "origin", origin);
    git(work, env, "commit", "--quiet", "--allow-empty", "-m", "release commit");
    const released = git(work, env, "rev-parse", "HEAD");
    git(work, env, "commit", "--quiet", "--allow-empty", "-m", "a later commit");
    const later = git(work, env, "rev-parse", "HEAD");
    git(work, env, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    return { root, env, origin, work, released, later };
  }

  const values = (commit: string, extra: Record<string, string> = {}) => ({
    "needs.build.outputs.tag": "v3.0.0",
    "needs.build.outputs.commit": commit,
    "needs.build.outputs.asset-sums": "unused",
    "github.repository": REPOSITORY,
    "github.token": GH_TOKEN,
    ...extra,
  });

  it(
    "finds the version's tag absent, on this commit, or taken by another commit, and refuses only the last",
    () => {
      const { root, env, work, released, later } = repository();
      const step = stepById(publish(), "tag-state");
      const check = (commit: string) => {
        const output = join(root, "github-output");
        writeFileSync(output, "");
        const variables = stepEnvironment(RELEASE, publish(), step, values(commit), {
          GITHUB_OUTPUT: output,
        });
        const result = runScript(step.run ?? "", { ...env, ...variables }, work);
        return { status: result.status, output: readFileSync(output, "utf8") };
      };

      expect(check(released)).toEqual({ status: 0, output: "state=absent\n" });
      git(work, env, "tag", "v3.0.0", released);
      git(work, env, "push", "--quiet", "origin", "refs/tags/v3.0.0");
      expect(check(released), "a lightweight tag on this commit").toEqual({
        status: 0,
        output: "state=present\n",
      });
      expect(check(later), "the tag on another commit").toEqual({ status: 1, output: "" });

      git(work, env, "tag", "--force", "--annotate", "--message", "annotated", "v3.0.0", released);
      git(work, env, "push", "--quiet", "--force", "origin", "refs/tags/v3.0.0");
      expect(check(released), "an annotated tag on this commit").toEqual({
        status: 0,
        output: "state=present\n",
      });
      expect(check(later)).toEqual({ status: 1, output: "" });
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "creates and pushes the version's tag on the release commit when it is absent, and leaves one already there",
    () => {
      const { env, origin, work, released, later } = repository();
      const step = stepById(publish(), "tag");
      const run = (state: string, commit = released) =>
        runScript(
          step.run ?? "",
          {
            ...env,
            ...stepEnvironment(
              RELEASE,
              publish(),
              step,
              values(commit, { "steps.tag-state.outputs.state": state }),
            ),
          },
          work,
        ).status;
      const remoteTag = () =>
        git(work, env, "ls-remote", origin, "refs/tags/v3.0.0").split(/\s+/)[0] ?? "";

      for (const state of ["", "unknown"]) {
        expect(run(state), `state "${state}"`).toBe(1);
        expect(remoteTag()).toBe("");
      }
      expect(run("absent")).toBe(0);
      expect(remoteTag()).toBe(released);
      expect(run("present")).toBe(0);
      expect(remoteTag()).toBe(released);
      // A tag another run pushed in between is never moved: the push is refused.
      git(work, env, "tag", "--delete", "v3.0.0");
      expect(run("absent", later)).not.toBe(0);
      expect(remoteTag()).toBe(released);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "moves the channel only in a state the channel check reports, and not at all when it is current",
    () => {
      const dir = temp.make("channel-step");
      symlinkSync(join(REPO_ROOT, "scripts"), join(dir, "scripts"));
      mkdirSync(join(dir, "release-assets"));
      writeFileSync(join(dir, "release-assets/update.json"), '{"addons":{}}\n');
      const gitLog = join(dir, "git-calls.log");
      const gitBin = recordingGit(dir, gitLog);
      const gh = new GhStub(dir);
      const step = stepById(publish(), "channel");
      const run = (state: string) => {
        gh.reset({ releases: { release: { isDraft: false, assets: {} } } });
        writeFileSync(gitLog, "");
        const result = runScript(
          step.run ?? "",
          isolatedEnv(
            dir,
            {
              ...gh.env(),
              ...stepEnvironment(
                RELEASE,
                publish(),
                step,
                values(COMMIT, { "steps.channel-version.outputs.state": state }),
                { RUNNER_TEMP: dir, GITHUB_REPOSITORY: REPOSITORY },
              ),
            },
            [gitBin, gh.bin],
          ),
          dir,
        );
        return { status: result.status, git: recorded(gitLog), writes: gh.writes() };
      };

      expect(run("current")).toEqual({ status: 0, git: [], writes: [] });
      for (const state of ["", "unknown"]) {
        expect(run(state), `state "${state}"`).toEqual({ status: 1, git: [], writes: [] });
      }
      for (const state of ["advance", "first", "repair"]) {
        const moved = run(state);
        expect(moved.status, state).toBe(0);
        expect(moved.git).toEqual([
          ["tag", "-f", "release", COMMIT],
          ["push", "--force", "origin", "refs/tags/release:refs/tags/release"],
        ]);
        expect(moved.writes).toEqual([
          ["release", "upload", "release", join(dir, "release-assets/update.json"), "--clobber"],
        ]);
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("publish-release.yml badges", () => {
  it("runs after publish, in its own job, so it can fail and be re-run alone", () => {
    const badges = jobOf(RELEASE, "badges");
    expect([...needsOf(badges)].sort()).toEqual(["build", "publish"]);
    expect(badges.if).toBeUndefined();
    const refresh = runOf(badges, "refresh");
    expect(refresh).toContain(
      `gh api --paginate --slurp -H "${API_VERSION_HEADER}" "repos/$REPO/releases?per_page=100"`,
    );
    expect(refresh).toContain("node scripts/readme-badges-cli.mjs");
    for (const id of ["publish", "build", "verify"]) {
      for (const step of stepsOf(jobOf(RELEASE, id))) {
        expect(step.run ?? "", `${RELEASE} ${id}`).not.toContain("badges");
      }
    }
  });

  it(
    "commits the badges with the tag it refreshes after, from its own job's environment",
    () => {
      const dir = temp.make("badges-step");
      symlinkSync(join(REPO_ROOT, "scripts"), join(dir, "scripts"));
      const gitLog = join(dir, "git-calls.log");
      const gitBin = recordingGit(dir, gitLog);
      const gh = new GhStub(dir, {
        releases: {
          "v3.0.0": { isDraft: false, assets: { "citegeist-3.0.0.xpi": "x" }, downloads: {} },
        },
      });
      const badges = jobOf(RELEASE, "badges");
      const step = stepById(badges, "refresh");
      const result = runScript(
        step.run ?? "",
        isolatedEnv(
          dir,
          {
            ...gh.env(),
            ...stepEnvironment(
              RELEASE,
              badges,
              step,
              {
                "github.token": GH_TOKEN,
                "github.repository": REPOSITORY,
                "needs.build.outputs.tag": "v3.0.0",
              },
              { RUNNER_TEMP: dir },
            ),
          },
          [gitBin, gh.bin],
        ),
        dir,
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const commit = recorded(gitLog).find((call) => call.includes("commit"));
      expect(commit).toContain("chore(badges): refresh after v3.0.0");
      expect(recorded(gitLog).at(-1)).toEqual(["push", "--force", "origin", "badges-tmp:badges"]);
      expect(
        JSON.parse(readFileSync(join(dir, "cg-badges/badge-release.json"), "utf8")),
      ).toMatchObject({ message: "v3.0.0" });
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});
describe("real-zotero.yml", () => {
  const job = () => jobOf("real-zotero.yml", "real-zotero");
  const inputs = () =>
    ((
      workflow("real-zotero.yml").on as {
        workflow_call?: { inputs?: Record<string, { default?: unknown }> };
      }
    )?.workflow_call?.inputs ?? {}) as Record<string, { default?: unknown }>;
  const defaultVersions = () =>
    JSON.parse(String(inputs()["zotero-versions"]?.default)) as string[];

  it("takes exactly the ref, artifact, digest, versions and negative-control inputs", () => {
    expect(Object.keys(inputs()).sort()).toEqual(
      ["negative-control-version", "ref", "xpi-artifact", "xpi-sha256", "zotero-versions"].sort(),
    );
    expect(inputs().ref?.default).toBe("");
    expect(job().strategy?.matrix?.zotero).toBe("${{ fromJSON(inputs.zotero-versions) }}");
  });

  it("runs the caller's commit's specs, and in a release restores no dependency cache and builds nothing", () => {
    const steps = stepsOf(job());
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with).toEqual({
      "persist-credentials": false,
      ref: "${{ inputs.ref }}",
    });
    const setup = steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
    expect(setup?.with).toEqual({
      "node-version": 22,
      cache: "${{ inputs.xpi-artifact == '' && 'npm' || '' }}",
      "package-manager-cache": false,
    });
    const build = steps.find((step) => step.run?.includes("scripts/build.mjs"));
    expect(build).toMatchObject({ if: "${{ inputs.xpi-artifact == '' }}", run: BUILD });
  });

  it("runs the negative control on its default cell once the suite passed, and no caller overrides it", () => {
    const control = stepById(job(), "negative-control");
    expect(control.if).toBe("${{ success() && matrix.zotero == inputs.negative-control-version }}");
    const negative = inputs()["negative-control-version"]?.default;
    expect(typeof negative === "string" && negative !== "").toBe(true);
    expect(defaultVersions()).toContain(negative);
    for (const { where, job: caller } of everyJob()) {
      if (caller.uses !== "./.github/workflows/real-zotero.yml") continue;
      expect(caller.with ?? {}, where).not.toHaveProperty("negative-control-version");
      expect(caller.with ?? {}, where).not.toHaveProperty("zotero-versions");
    }
  });

  it("always stages the checked XPI, runs the suite and checks its log, and uploads logs on failure or cancellation", () => {
    for (const id of ["stage", "suite", "run-log"]) {
      expect(stepById(job(), id).if, id).toBeUndefined();
    }
    expect(runOf(job(), "stage")).toContain(
      'printf \'%s  %s\\n\' "$XPI_SHA256" "${xpis[0]}" | sha256sum --check --strict',
    );
    expect(runOf(job(), "run-log")).toContain(
      "node test/real-zotero/harness/runLog-cli.mjs passed ",
    );
    expect(stepById(job(), "upload-logs").if).toBe("${{ failure() || cancelled() }}");
  });

  it("has a cell for every Zotero major package.json's range admits, and the checklist names each cell", () => {
    const { config } = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      config: { zoteroMinVersion: string; zoteroMaxVersion: string };
    };
    const floor = Number(config.zoteroMinVersion.split(".")[0]);
    const cap = Number(config.zoteroMaxVersion.split(".")[0]);
    // Zotero 7 has no cell: the harness runs on Zotero 8 and later, and v3.0.0 raises the floor to
    // Zotero 8. An entry below the floor fails, so this cannot outlive its reason.
    const MAJORS_WITHOUT_A_CELL = [7];
    for (const major of MAJORS_WITHOUT_A_CELL) {
      expect(
        major,
        `Zotero ${major} is below the floor; remove it from the exemptions`,
      ).toBeGreaterThanOrEqual(floor);
    }
    for (let major = floor; major <= cap; major++) {
      if (MAJORS_WITHOUT_A_CELL.includes(major)) continue;
      expect(
        defaultVersions().some((version) => version.startsWith(`${major}.`)),
        `a Zotero ${major} cell`,
      ).toBe(true);
    }
    for (const version of defaultVersions()) expect(version).toMatch(/^\d+\.\d+\.\d+$/);

    const checklist = readFileSync(join(REPO_ROOT, "docs/RELEASE-CHECKLIST.md"), "utf8");
    const section0 = /\n## 0\.[^\n]*\n([\s\S]*?)\n## /.exec(checklist)?.[1] ?? "";
    const named = [...section0.matchAll(/Real Zotero \/ Zotero (\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    expect([...new Set(named)]).toEqual(defaultVersions());
  });

  it("checks every default Zotero version's tarball against a pinned or UNPINNED SHA-256", () => {
    const pins = JSON.parse(
      workflow("real-zotero.yml").env?.ZOTERO_TARBALL_SHA256 ?? "{}",
    ) as Record<string, unknown>;
    expect(defaultVersions().length).toBeGreaterThan(0);
    for (const version of defaultVersions()) {
      expect(String(pins[version]), `Zotero ${version}`).toMatch(/^(?:UNPINNED|[0-9a-f]{64})$/);
    }
    expect(runOf(job(), "zotero")).toContain("ZOTERO_TARBALL_SHA256");
  });

  it("bounds every slow step, and the bounds add up to less than the job's timeout", () => {
    const deadlines: string[] = [];
    let total = 0;
    for (const step of stepsOf(job())) {
      const minutes = deadlineMinutes(step);
      const slow = /\b(?:npm install|apt-get|curl|xvfb-run)\b/.test(step.run ?? "");
      if (slow) expect(minutes, `step "${step.name ?? step.id}" has a deadline`).toBeDefined();
      if (minutes === undefined) continue;
      deadlines.push(`${step.id ?? step.name} ${minutes}`);
      total += minutes;
    }
    expect(deadlines.length).toBeGreaterThanOrEqual(5);
    expect(total, deadlines.join(" + ")).toBeLessThan(Number(job()["timeout-minutes"]));
  });

  it(
    "fails a cell whose Zotero tarball differs from its pin or has no entry, and only warns while it is UNPINNED",
    () => {
      const dir = temp.make("zotero-download");
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const tarLog = join(dir, "tar.log");
      const nodeTool = (name: string, body: string) =>
        writeFileSync(join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
      nodeTool(
        "curl",
        'const a = process.argv.slice(2); require("fs").writeFileSync(a[a.indexOf("--output") + 1], "zotero tarball");',
      );
      nodeTool(
        "sha256sum",
        'const f = process.argv[2]; process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(f)).digest("hex") + "  " + f + "\\n");',
      );
      nodeTool(
        "jq",
        [
          "const a = process.argv.slice(2);",
          `if (a.at(-1) !== '.[$version] // "MISSING"') process.exit(99);`,
          'const pins = JSON.parse(require("fs").readFileSync(0, "utf8"));',
          'process.stdout.write(String(pins[a[a.indexOf("--arg") + 2]] ?? "MISSING") + "\\n");',
        ].join("\n"),
      );
      nodeTool(
        "tar",
        [
          'const fs = require("fs");',
          `fs.appendFileSync(${JSON.stringify(tarLog)}, process.argv.slice(2).join(" ") + "\\n");`,
          'fs.mkdirSync(".scaffold/zotero", { recursive: true });',
          'fs.writeFileSync(".scaffold/zotero/zotero", "#!/bin/sh\\n", { mode: 0o755 });',
        ].join("\n"),
      );
      const download = (pins: Record<string, string>) => {
        rmSync(join(dir, ".scaffold"), { recursive: true, force: true });
        writeFileSync(tarLog, "");
        const result = runScript(
          runOf(job(), "zotero"),
          isolatedEnv(
            dir,
            {
              ZOTERO_VERSION: "10.0.2",
              ZOTERO_TARBALL_SHA256: JSON.stringify(pins),
              ZOTERO_PLUGIN_ZOTERO_BIN_PATH: join(dir, ".scaffold/zotero/zotero"),
            },
            [bin],
          ),
          dir,
        );
        return {
          status: result.status,
          stdout: result.stdout,
          extracted: readFileSync(tarLog, "utf8") !== "",
        };
      };
      const hash = createHash("sha256").update("zotero tarball").digest("hex");

      expect(download({ "10.0.2": hash })).toMatchObject({ status: 0, extracted: true });
      const unpinned = download({ "10.0.2": "UNPINNED" });
      expect(unpinned).toMatchObject({ status: 0, extracted: true });
      expect(unpinned.stdout).toContain(
        `::warning::The Zotero 10.0.2 tarball is not pinned. Its SHA-256 is ${hash}`,
      );
      const mismatch = download({ "10.0.2": "0".repeat(64) });
      expect(mismatch).toMatchObject({ status: 1, extracted: false });
      expect(mismatch.stdout).toContain(`::error::The Zotero 10.0.2 tarball hashed ${hash}`);
      const missing = download({ "9.0.6": "UNPINNED" });
      expect(missing).toMatchObject({ status: 1, extracted: false });
      expect(missing.stdout).toContain("has no entry for Zotero 10.0.2");
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "refuses a Zotero version that is not MAJOR.MINOR.PATCH, a negative control outside the matrix, and an artifact without its digest",
    () => {
      const dir = temp.make("real-zotero-inputs");
      const status = (variables: Record<string, string>) =>
        runScript(
          runOf(job(), "inputs"),
          isolatedEnv(dir, {
            ZOTERO_VERSION: "10.0.2",
            NEGATIVE_CONTROL_VERSION: "10.0.2",
            NEGATIVE_CONTROL_IN_MATRIX: "true",
            XPI_ARTIFACT: "",
            XPI_SHA256: "",
            ...variables,
          }),
          dir,
        ).status;

      expect(status({})).toBe(0);
      expect(status({ XPI_ARTIFACT: "release-assets-1", XPI_SHA256: "a".repeat(64) })).toBe(0);
      for (const version of ["10.0", "10.0.2-beta.1", "10.0.2; touch pwned", "$(id)", ""]) {
        expect(status({ ZOTERO_VERSION: version }), `ZOTERO_VERSION="${version}"`).toBe(1);
      }
      expect(status({ NEGATIVE_CONTROL_IN_MATRIX: "false" })).toBe(1);
      expect(status({ XPI_ARTIFACT: "release-assets-1" })).toBe(1);
      expect(status({ XPI_ARTIFACT: "release-assets-1", XPI_SHA256: "A".repeat(64) })).toBe(1);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});

/**
 * A step's deadline in minutes: its timeout-minutes, or what its script bounds itself to with
 * `timeout --kill-after=Ns Mm` or curl's --max-time plus --retry-max-time (no attempt starts after
 * the retry limit, and each runs at most --max-time).
 */
function deadlineMinutes(step: Step): number | undefined {
  if (typeof step["timeout-minutes"] === "number") return step["timeout-minutes"];
  const run = step.run ?? "";
  const timeout = /\btimeout --kill-after=(\d+)s (\d+)m\b/.exec(run);
  if (timeout) return Number(timeout[2]) + Number(timeout[1]) / 60;
  if (/\bcurl\b/.test(run)) {
    const maxTime = /--max-time (\d+)/.exec(run);
    const retryMaxTime = /--retry-max-time (\d+)/.exec(run);
    if (maxTime && retryMaxTime) return (Number(maxTime[1]) + Number(retryMaxTime[1])) / 60;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The command allowlist for the write-scoped jobs.

/** What a write-scoped job may run: git, gh, the repository's own scripts and plain shell utilities. */
const ALLOWED_COMMANDS = new Set([
  "gh",
  "git",
  "bash",
  "node",
  ":",
  "[",
  "[[",
  "awk",
  "basename",
  "cat",
  "cd",
  "command",
  "cp",
  "cut",
  "dirname",
  "echo",
  "exit",
  "grep",
  "head",
  "local",
  "mkdir",
  "mktemp",
  "printf",
  "pwd",
  "read",
  "rm",
  "sed",
  "set",
  "sha256sum",
  "shasum",
  "shopt",
  "sort",
  "trap",
  "true",
]);
/** Child processes a release script may start from Node. */
const ALLOWED_NODE_CHILDREN = new Set(["gh", "git", "bash"]);
/** `bash <script>`: one of the repository's own shell scripts, or a sibling of the calling one. */
const BASH_TARGET = /^(?:scripts|tools|\$here)\/([\w.-]+\.sh)$/;
/** `node <script>`: one of the release scripts' command-line entry files. */
const NODE_TARGET = /^scripts\/[\w.-]+-cli\.mjs$/;

/** The repository file a `bash` or `node` command runs, or undefined for anything else. */
function scriptRun(name: string, target: string, baseDir: string): string | undefined {
  if (name === "bash") {
    const match = BASH_TARGET.exec(target);
    if (!match) return undefined;
    return target.startsWith("$here/") ? join(baseDir, match[1]) : join(REPO_ROOT, target);
  }
  if (name === "node" && NODE_TARGET.test(target)) return join(REPO_ROOT, target);
  return undefined;
}

/**
 * Checks every command a bash script runs against ALLOWED_COMMANDS, following `bash <script>` and
 * `node scripts/<name>-cli.mjs` into the repository files they run.
 */
function checkShell(
  script: string,
  where: string,
  baseDir: string,
  problems: string[],
  followed: Set<string>,
): void {
  const { commands, functions } = shellCommands(script);
  for (const words of commands) {
    const name = unquote(words[0]);
    if (functions.has(name)) continue;
    if (!ALLOWED_COMMANDS.has(name)) {
      problems.push(`${where} runs ${name}`);
      continue;
    }
    const target = unquote(words[1] ?? "");
    if (name === "bash" || name === "node") {
      const file = scriptRun(name, target, baseDir);
      if (file === undefined) {
        problems.push(
          `${where} runs ${name} on ${target || "nothing"}, not one of the repository's own ` +
            (name === "bash" ? "shell scripts" : "scripts/*-cli.mjs entries"),
        );
        continue;
      }
      followFile(file, problems, followed);
    } else if (name === "command" && target !== "-v") {
      problems.push(`${where} runs command ${target}, which can run anything`);
    } else if (name === "trap") {
      checkShell(target, `${where} trap`, baseDir, problems, followed);
    }
  }
}

/** The repository files a Node script imports, relative ones only; packages are reported. */
function nodeImports(file: string, problems: string[], relative: string): string[] {
  const source = readFileSync(file, "utf8");
  const imports: string[] = [];
  for (const match of source.matchAll(/^import\s(?:[\s\S]*?\sfrom\s)?"([^"]+)";/gm)) {
    const specifier = match[1];
    if (specifier.startsWith("node:")) continue;
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      problems.push(`${relative} imports the package ${specifier}`);
      continue;
    }
    imports.push(resolve(dirname(file), specifier));
  }
  return imports;
}

function followFile(file: string, problems: string[], followed: Set<string>): void {
  const relative = file.slice(REPO_ROOT.length).replace(/^\/+/, "");
  if (followed.has(relative)) return;
  followed.add(relative);
  const source = readFileSync(file, "utf8");
  if (file.endsWith(".sh")) {
    checkShell(source, relative, dirname(file), problems, followed);
    return;
  }
  for (const imported of nodeImports(file, problems, relative)) {
    followFile(imported, problems, followed);
  }
  const childProcess = /import\s*\{([^}]*)\}\s*from\s*"node:child_process"/.exec(source);
  for (const name of (childProcess?.[1] ?? "").split(",").map((part) => part.trim())) {
    if (name && name !== "spawnSync")
      problems.push(`${relative} imports ${name} from node:child_process`);
  }
  if (/\bimport\(|\beval\(|\bnew Function\b|shell:\s*true/.test(source)) {
    problems.push(`${relative} runs code it does not name`);
  }
  for (const match of source.matchAll(/\bspawnSync\(\s*([^,)]+)/g)) {
    const command = match[1].trim();
    if (!/^"[\w-]+"$/.test(command) || !ALLOWED_NODE_CHILDREN.has(unquote(command))) {
      problems.push(`${relative} spawns ${command}`);
    }
  }
  for (const match of source.matchAll(/new URL\("\.\/([\w.-]+\.sh)", import\.meta\.url\)/g)) {
    followFile(join(dirname(file), match[1]), problems, followed);
  }
}

/**
 * Whether a bash script runs gh, itself or through a repository script it calls: a shell script
 * that runs gh, or a Node script whose imports start it.
 */
function runsGh(script: string, baseDir: string, seen = new Set<string>()): boolean {
  for (const words of shellCommands(script).commands) {
    const name = unquote(words[0]);
    if (name === "gh") return true;
    const file = scriptRun(name, unquote(words[1] ?? ""), baseDir);
    if (file !== undefined && fileRunsGh(file, seen)) return true;
  }
  return false;
}

function fileRunsGh(file: string, seen: Set<string>): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  const source = readFileSync(file, "utf8");
  if (file.endsWith(".sh")) return runsGh(source, dirname(file), seen);
  if (/\bspawnSync\(\s*"gh"/.test(source)) return true;
  return nodeImports(file, [], "").some((imported) => fileRunsGh(imported, seen));
}

function unquote(word: string): string {
  return word.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
}

const SHELL_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "while",
  "until",
  "do",
  "done",
  "esac",
  "!",
  "{",
  "}",
  "time",
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

function closingDoubleQuote(
  source: string,
  open: number,
  onSubstitution?: (inner: string) => void,
): number {
  for (let i = open + 1; i < source.length; i++) {
    if (source[i] === "\\") {
      i++;
    } else if (source[i] === "$" && source[i + 1] === "(") {
      const close = closingParen(source, i + 1);
      onSubstitution?.(source.slice(i + 2, close));
      i = close;
    } else if (source[i] === '"') {
      return i;
    }
  }
  throw new Error("unterminated double quote in shell script");
}

function closingParen(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++;
    } else if (c === "'") {
      i = source.indexOf("'", i + 1);
      if (i < 0) break;
    } else if (c === '"') {
      i = closingDoubleQuote(source, i);
    } else if (c === "(") {
      depth++;
    } else if (c === ")" && --depth === 0) {
      return i;
    }
  }
  throw new Error("unterminated ( in shell script");
}

/**
 * The words of every simple command a bash script runs, including those inside $(...) and in
 * function bodies, and the names of the functions it defines. It reads the subset of bash the
 * workflows and scripts use, and throws on constructs it cannot read (heredocs, backticks) rather
 * than miss a command.
 */
function shellCommands(source: string): { commands: string[][]; functions: Set<string> } {
  const commands: string[][] = [];
  const functions = new Set<string>();
  const cases: ("pattern" | "body")[] = [];
  let words: string[] = [];
  let word: string | null = null;
  let redirect = false;

  const append = (text: string) => {
    word = (word ?? "") + text;
  };
  const nested = (inner: string) => {
    const scan = shellCommands(inner);
    commands.push(...scan.commands);
    for (const name of scan.functions) functions.add(name);
  };
  const endWord = () => {
    if (word === null) return;
    if (redirect) redirect = false;
    else words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    let start = 0;
    while (
      start < words.length &&
      (SHELL_KEYWORDS.has(words[start]) || ASSIGNMENT.test(words[start]))
    ) {
      start++;
    }
    const rest = words.slice(start);
    words = [];
    if (rest.length === 0 || rest[0] === "for") return;
    if (rest[0] === "case") {
      if (rest[rest.length - 1] !== "in")
        throw new Error("a case header must end its line with in");
      cases.push("pattern");
      return;
    }
    commands.push(rest);
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (cases[cases.length - 1] === "pattern" && word === null && words.length === 0) {
      if (/\s/.test(c)) {
        i++;
      } else if (/^esac\b/.test(source.slice(i))) {
        cases.pop();
        i += 4;
      } else {
        const close = source.indexOf(")", i);
        if (close < 0) throw new Error("unterminated case pattern");
        cases[cases.length - 1] = "body";
        i = close + 1;
      }
      continue;
    }
    if (c === "\\") {
      if (source[i + 1] !== "\n") append(source.slice(i, i + 2));
      i += 2;
    } else if (c === "#" && word === null) {
      const newline = source.indexOf("\n", i);
      i = newline < 0 ? source.length : newline;
    } else if (c === "'") {
      const close = source.indexOf("'", i + 1);
      if (close < 0) throw new Error("unterminated single quote in shell script");
      append(source.slice(i, close + 1));
      i = close + 1;
    } else if (c === '"') {
      const close = closingDoubleQuote(source, i, nested);
      append(source.slice(i, close + 1));
      i = close + 1;
    } else if (c === "$" && source[i + 1] === "(" && source[i + 2] === "(") {
      const close = source.indexOf("))", i + 3);
      if (close < 0) throw new Error("unterminated $(( in shell script");
      append(source.slice(i, close + 2));
      i = close + 2;
    } else if (c === "$" && source[i + 1] === "(") {
      const close = closingParen(source, i + 1);
      nested(source.slice(i + 2, close));
      append(source.slice(i, close + 1));
      i = close + 1;
    } else if (c === "$" && source[i + 1] === "{") {
      const close = source.indexOf("}", i + 2);
      if (close < 0) throw new Error("unterminated ${ in shell script");
      append(source.slice(i, close + 1));
      i = close + 1;
    } else if (c === "`") {
      throw new Error("backtick command substitution is not supported; use $(...)");
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === "\n") {
      endCommand();
      i++;
    } else if (c === ";") {
      endCommand();
      if (source[i + 1] === ";") {
        if (cases[cases.length - 1] === "body") cases[cases.length - 1] = "pattern";
        i += 2;
      } else {
        i++;
      }
    } else if (c === "<" || c === ">" || (c === "&" && source[i + 1] === ">")) {
      if (source.startsWith("<<", i) && !source.startsWith("<<<", i)) {
        throw new Error("heredocs are not supported");
      }
      if (word !== null && /^\d+$/.test(word)) word = null;
      else endWord();
      while (i < source.length && /[<>&]/.test(source[i])) i++;
      redirect = true;
    } else if (c === "&" || c === "|") {
      endCommand();
      i += source[i + 1] === c ? 2 : 1;
    } else if (c === "(" && word !== null && word.endsWith("=")) {
      const close = closingParen(source, i);
      append(source.slice(i, close + 1));
      i = close + 1;
    } else if (c === "(" && word !== null && source[i + 1] === ")") {
      functions.add(word);
      word = null;
      words = [];
      i += 2;
    } else if (c === "(" || c === ")") {
      endCommand();
      i++;
    } else if (
      word === null &&
      source.startsWith("[[ ", i) &&
      words.every((w) => SHELL_KEYWORDS.has(w))
    ) {
      const close = source.indexOf("]]", i);
      if (close < 0) throw new Error("unterminated [[ in shell script");
      words.push("[[");
      endCommand();
      i = close + 2;
    } else {
      append(c);
      i++;
    }
  }
  endCommand();
  return { commands, functions };
}

describe("the publish command allowlist reads commands where bash runs them", () => {
  it("finds commands in substitutions, pipelines, conditions, case bodies, functions and continuations", () => {
    const script = [
      "# npm install in a comment is not a command",
      'x=$(gh api "a $(printf b)" | sort)',
      "if ! curl -s example.invalid; then echo no; fi",
      'case "$s" in',
      "  a | b) wget x ;;",
      "  *)",
      "    npx y",
      "    ;;",
      "esac",
      "f() {",
      "  local list=() one",
      "  pnpm dlx z 2>/dev/null",
      "}",
      "git tag \\",
      "  release && python3 -c 1",
      "[[ $x =~ ^(a|b)$ ]] && yarn",
    ].join("\n");
    const { commands, functions } = shellCommands(script);
    expect(commands.map((words) => words[0])).toEqual(
      expect.arrayContaining([
        "gh",
        "printf",
        "sort",
        "curl",
        "echo",
        "wget",
        "npx",
        "local",
        "pnpm",
        "git",
        "python3",
        "[[",
        "yarn",
      ]),
    );
    expect(commands.map((words) => words[0])).not.toContain("npm");
    expect(commands.find((words) => words[0] === "git")).toEqual(["git", "tag", "release"]);
    expect([...functions]).toEqual(["f"]);
    expect(() => shellCommands("cat <<EOF\nx\nEOF\n")).toThrow(/heredocs/);
  });
});

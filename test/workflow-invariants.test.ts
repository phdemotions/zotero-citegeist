/**
 * Safety properties of the CI and release workflows (plan U5, KTD13). A
 * published release reaches every installed copy on its next update check, so
 * each test here closes one way a bad tag, a stale run or a compromised
 * dependency could get there. If one fails, fix the workflow; never weaken the
 * test.
 *
 * WORKFLOW_INVARIANTS_DIR points the suite at a copy of .github/workflows whose
 * repository root is two directories up. Running the suite against a mutated
 * copy is how each test is proven to fail when its property breaks.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { assertNewerThanChannel } from "../scripts/check-channel-version.mjs";

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: unknown;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "working-directory"?: string;
  "continue-on-error"?: unknown;
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
  "timeout-minutes"?: unknown;
  "continue-on-error"?: unknown;
  steps?: Step[];
}

interface Workflow {
  on?: { workflow_call?: { inputs?: Record<string, { default?: unknown }> } };
  permissions?: unknown;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}

const WORKFLOW_DIR = resolve(
  process.env.WORKFLOW_INVARIANTS_DIR ??
    fileURLToPath(new URL("../.github/workflows", import.meta.url)),
);
const REPO_ROOT = resolve(WORKFLOW_DIR, "..", "..");
const WORKFLOW_FILES = ["ci.yml", "release.yml", "real-zotero.yml"] as const;
type WorkflowFile = (typeof WORKFLOW_FILES)[number];

const source = Object.fromEntries(
  WORKFLOW_FILES.map((file) => [file, readFileSync(join(WORKFLOW_DIR, file), "utf8")]),
) as Record<WorkflowFile, string>;
const workflows = Object.fromEntries(
  WORKFLOW_FILES.map((file) => [file, parse(source[file]) as Workflow]),
) as Record<WorkflowFile, Workflow>;

/** A step that mentions any of these runs dependencies, test code or Zotero. */
const THIRD_PARTY_CODE = /\b(?:npm|npx|vitest|mocha|zotero-plugin|xvfb-run)\b/;
const LOCKFILE_CHECK = "git diff --exit-code package-lock.json";
/** Tests that build a throwaway git repository spawn a dozen processes; under a parallel run that outlasts vitest's 5 s default. */
const GIT_FIXTURE_TIMEOUT_MS = 60_000;
/** Publish's digest check uses GNU coreutils behaviour, so it is executed only where that exists. */
const GNU_SHA256SUM = /GNU coreutils/.test(
  spawnSync("sha256sum", ["--version"], { encoding: "utf8" }).stdout ?? "",
);

function jobOf(file: WorkflowFile, id: string): Job {
  const job = workflows[file].jobs?.[id];
  if (!job) throw new Error(`${file} has no job "${id}"`);
  return job;
}

function stepsOf(job: Job): Step[] {
  return job.steps ?? [];
}

function runOf(job: Job, stepId: string): string {
  const run = stepsOf(job).find((step) => step.id === stepId)?.run;
  if (typeof run !== "string") throw new Error(`no run step with id "${stepId}"`);
  return run;
}

function needsOf(job: Job): string[] {
  return job.needs === undefined ? [] : [job.needs].flat();
}

function everyJob(): { where: string; job: Job }[] {
  return WORKFLOW_FILES.flatMap((file) =>
    Object.entries(workflows[file].jobs).map(([id, job]) => ({ where: `${file} job ${id}`, job })),
  );
}

/** The scopes a permissions block grants beyond read. */
function writeScopes(permissions: unknown): string[] {
  if (permissions === undefined) return [];
  if (typeof permissions === "string") return permissions === "read-all" ? [] : [permissions];
  return Object.entries((permissions ?? {}) as Record<string, unknown>)
    .filter(([, level]) => level !== "read" && level !== "none")
    .map(([scope, level]) => `${scope}: ${String(level)}`);
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "citegeist-workflow-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function isolatedEnv(home: string): Record<string, string> {
  return {
    PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/** Run a step's script the way GitHub runs `run:` on Linux. */
function runStep(
  script: string,
  env: Record<string, string>,
  cwd = tmpdir(),
): SpawnSyncReturns<string> {
  return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
    cwd,
    encoding: "utf8",
    env: { ...isolatedEnv(cwd), ...env },
  });
}

function git(cwd: string, ...args: string[]): string {
  const config = [
    "user.name=Citegeist test",
    "user.email=test@example.invalid",
    "commit.gpgsign=false",
    "tag.gpgsign=false",
    "init.defaultBranch=main",
  ].flatMap((setting) => ["-c", setting]);
  const result = spawnSync("git", [...config, ...args], {
    cwd,
    encoding: "utf8",
    env: isolatedEnv(cwd),
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

describe("write access (KTD13)", () => {
  it("declares read-only top-level permissions in every workflow", () => {
    for (const file of WORKFLOW_FILES) {
      expect(workflows[file].permissions, `${file} top-level permissions`).toBeDefined();
      expect(writeScopes(workflows[file].permissions), `${file} top-level permissions`).toEqual([]);
    }
  });

  it("grants write scope to release.yml's publish job alone, and only contents: write", () => {
    for (const file of WORKFLOW_FILES) {
      for (const [id, job] of Object.entries(workflows[file].jobs)) {
        if (file === "release.yml" && id === "publish") {
          expect(job.permissions, "release.yml publish permissions").toEqual({ contents: "write" });
        } else {
          expect(writeScopes(job.permissions), `${file} job ${id} permissions`).toEqual([]);
        }
      }
    }
  });
});

describe("release.yml verify", () => {
  it("runs the prerelease, tag and version-bump guards before the first npm step", () => {
    const steps = stepsOf(jobOf("release.yml", "verify"));
    const firstNpm = steps.findIndex((step) => /\bnpm\b|\bnpx\b/.test(step.run ?? ""));
    expect(firstNpm, "verify runs npm").toBeGreaterThan(-1);
    for (const id of ["guard-final-tag", "guard-tag-version", "guard-version-bump"]) {
      const index = steps.findIndex((step) => step.id === id);
      expect(index, `verify has the ${id} step`).toBeGreaterThan(-1);
      expect(index, `${id} runs before "${steps[firstNpm].run}"`).toBeLessThan(firstNpm);
      expect(steps[index].if, `${id} is unconditional`).toBeUndefined();
    }
  });

  it("refuses a prerelease or malformed tag, pointing at U15, and accepts a final one", () => {
    const guard = runOf(jobOf("release.yml", "verify"), "guard-final-tag");
    expect(runStep(guard, { TAG: "v3.0.0" }).status).toBe(0);

    const prerelease = runStep(guard, { TAG: "v3.0.0-rc.1" });
    expect(prerelease.status).not.toBe(0);
    expect(prerelease.stdout).toContain("U15");

    for (const tag of ["v3.0", "3.0.0", "v03.0.0", "v3.0.0+build.1", "v3.0.0 "]) {
      expect(runStep(guard, { TAG: tag }).status, `tag "${tag}"`).not.toBe(0);
    }
  });

  it(
    "refuses a tag on a commit that does not itself bump package.json to the tag version",
    () => {
      const guard = runOf(jobOf("release.yml", "verify"), "guard-version-bump");
      const repo = tempDir();
      const commitVersion = (version: string) => {
        writeFileSync(join(repo, "package.json"), `${JSON.stringify({ version })}\n`);
        git(repo, "add", "package.json");
        git(repo, "commit", "--quiet", "--allow-empty", "-m", `version ${version}`);
      };
      const status = (tag: string) => runStep(guard, { TAG: tag }, repo).status;

      git(repo, "init", "--quiet");
      commitVersion("2.0.5");
      commitVersion("3.0.0");
      expect(status("v3.0.0"), "the commit that bumps the version").toBe(0);
      expect(status("v3.0.1"), "a tag that differs from package.json").not.toBe(0);

      commitVersion("3.0.0");
      expect(status("v3.0.0"), "a later commit that leaves the version alone").not.toBe(0);
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );

  it("feeds the real-Zotero matrix the XPI it built, checked against its digest", () => {
    const verify = jobOf("release.yml", "verify");
    const realZotero = jobOf("release.yml", "real-zotero");
    const upload = stepsOf(verify).find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );

    expect(realZotero.uses).toBe("./.github/workflows/real-zotero.yml");
    expect(needsOf(realZotero)).toEqual(["verify"]);
    expect(upload?.with?.name, "verify uploads the release assets").toBeTruthy();
    expect(realZotero.with?.["xpi-artifact"]).toBe(upload?.with?.name);
    expect(realZotero.with?.["xpi-sha256"]).toBe("${{ needs.verify.outputs.xpi-sha256 }}");
    expect(verify.outputs?.["xpi-sha256"]).toBe("${{ steps.digest.outputs.xpi-sha256 }}");
  });
});

describe("release.yml publish", () => {
  it("needs exactly verify and real-zotero, with no if: or continue-on-error to skip them", () => {
    const publish = jobOf("release.yml", "publish");
    expect([...needsOf(publish)].sort()).toEqual(["real-zotero", "verify"]);
    expect(publish.if, "publish if:").toBeUndefined();
    expect(publish["continue-on-error"], "publish continue-on-error").toBeUndefined();
  });

  it("runs no npm, test runner or Zotero, in its own steps or the scripts they call", () => {
    const scripts = new Set<string>();
    for (const step of stepsOf(jobOf("release.yml", "publish"))) {
      if (step.run === undefined) continue;
      expect(step.run, `publish step "${step.name ?? step.id}"`).not.toMatch(THIRD_PARTY_CODE);
      for (const script of step.run.match(/scripts\/[\w.-]+/g) ?? []) scripts.add(script);
    }
    expect(scripts.size, "publish calls its channel scripts").toBeGreaterThan(0);
    for (const script of scripts) {
      expect(readFileSync(join(REPO_ROOT, script), "utf8"), script).not.toMatch(THIRD_PARTY_CODE);
    }
  });

  it("uses no action but download-artifact and checkout", () => {
    for (const step of stepsOf(jobOf("release.yml", "publish"))) {
      if (step.uses === undefined) continue;
      expect(step.uses).toMatch(/^actions\/(?:download-artifact|checkout)@[0-9a-f]{40}$/);
    }
  });

  it("checks the artifact digests before anything else runs, with no way to ignore a mismatch", () => {
    const steps = stepsOf(jobOf("release.yml", "publish"));
    const index = steps.findIndex((step) => step.id === "digest-check");
    expect(index, "publish has the digest-check step").toBeGreaterThan(0);

    const download = steps[0];
    expect(steps.slice(0, index), "only the download precedes the digest check").toEqual([
      download,
    ]);
    expect(download.uses ?? "").toMatch(/^actions\/download-artifact@/);

    const check = steps[index];
    expect(check["working-directory"]).toBe(download.with?.path);
    expect(check.run).toContain("sha256sum --check --strict");
    expect(check.run).not.toMatch(/\|\|\s*(?:true|:)|set \+e/);
    expect(check.if).toBeUndefined();
    expect(check["continue-on-error"]).toBeUndefined();
  });

  it.skipIf(!GNU_SHA256SUM)(
    "digest check passes the verified bytes and fails tampered, missing, extra or unlisted files",
    () => {
      const check = runOf(jobOf("release.yml", "publish"), "digest-check");
      const dir = tempDir();
      const assets: Record<string, string> = {
        "citegeist-3.0.0.xpi": "xpi bytes",
        "update.json": "{}\n",
      };
      for (const [name, body] of Object.entries(assets)) writeFileSync(join(dir, name), body);
      const sums = Object.entries(assets)
        .map(([name, body]) => `${createHash("sha256").update(body).digest("hex")}  ${name}`)
        .join("\n");
      const status = (env: Record<string, string> = { SUMS: sums }) =>
        runStep(check, env, dir).status;

      expect(status(), "the verified assets").toBe(0);
      expect(
        status({ SUMS: sums.split("\n")[0] }),
        "update.json missing from the digests",
      ).not.toBe(0);
      expect(status({ SUMS: "" }), "no digests").not.toBe(0);

      writeFileSync(join(dir, "extra.js"), "");
      expect(status(), "an extra file").not.toBe(0);
      rmSync(join(dir, "extra.js"));

      writeFileSync(join(dir, "update.json"), '{"tampered":true}\n');
      expect(status(), "a tampered update.json").not.toBe(0);

      rmSync(join(dir, "update.json"));
      expect(status(), "a missing update.json").not.toBe(0);
    },
  );

  it("serializes in the release-channel concurrency group without cancelling a running publish", () => {
    expect(jobOf("release.yml", "publish").concurrency).toEqual({
      group: "release-channel",
      "cancel-in-progress": false,
    });
  });

  it("checks the tag and the live channel before it creates a release or moves the channel", () => {
    const steps = stepsOf(jobOf("release.yml", "publish"));
    const firstWrite = steps.findIndex((step) =>
      /gh release (?:create|upload)|git push|publish-update-channel/.test(step.run ?? ""),
    );
    expect(firstWrite, "publish writes a release").toBeGreaterThan(-1);

    const checks = [
      ["tag-current", 'git ls-remote origin "refs/tags/$TAG"'],
      ["channel-version", "scripts/check-channel-version.mjs"],
    ] as const;
    for (const [id, marker] of checks) {
      const index = steps.findIndex((step) => step.id === id);
      expect(index, `publish has the ${id} step`).toBeGreaterThan(-1);
      expect(index, `${id} runs before "${steps[firstWrite].name}"`).toBeLessThan(firstWrite);
      expect(steps[index].run).toContain(marker);
      expect(steps[index].if, `${id} is unconditional`).toBeUndefined();
    }
  });

  it(
    "refuses to publish once the tag has moved off the run's commit",
    () => {
      const check = runOf(jobOf("release.yml", "publish"), "tag-current");
      const root = tempDir();
      const origin = join(root, "origin.git");
      const work = join(root, "work");
      git(root, "init", "--quiet", "--bare", origin);
      git(root, "init", "--quiet", work);
      git(work, "remote", "add", "origin", origin);
      git(work, "commit", "--quiet", "--allow-empty", "-m", "release commit");
      const released = git(work, "rev-parse", "HEAD");
      git(work, "commit", "--quiet", "--allow-empty", "-m", "a later commit");
      const later = git(work, "rev-parse", "HEAD");
      git(work, "tag", "v3.0.0", released);
      git(work, "tag", "--annotate", "--message", "annotated", "v3.0.1", released);
      git(work, "push", "--quiet", "origin", "--tags");
      const status = (tag: string, sha: string) =>
        runStep(check, { TAG: tag, GITHUB_SHA: sha }, work).status;

      expect(status("v3.0.0", released), "a lightweight tag on the run's commit").toBe(0);
      expect(status("v3.0.1", released), "an annotated tag on the run's commit").toBe(0);
      expect(status("v3.0.2", released), "a tag missing from the remote").not.toBe(0);

      git(work, "tag", "--force", "v3.0.0", later);
      git(work, "push", "--quiet", "--force", "origin", "refs/tags/v3.0.0");
      expect(status("v3.0.0", released), "the run for a tag since moved").not.toBe(0);
      expect(status("v3.0.0", later), "the run for the tag's new commit").toBe(0);
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );
});

describe("ci.yml gate", () => {
  function gate(): [string, Job] {
    const entry = Object.entries(workflows["ci.yml"].jobs).find(
      ([, job]) => job.name === "CI gate",
    );
    if (!entry) throw new Error('ci.yml has no job named "CI gate"');
    return entry;
  }

  it("needs every other ci.yml job and runs always()", () => {
    const [gateId, gateJob] = gate();
    const others = Object.keys(workflows["ci.yml"].jobs).filter((id) => id !== gateId);
    expect([...needsOf(gateJob)].sort()).toEqual(others.sort());
    expect(String(gateJob.if)).toMatch(/\balways\(\)/);
  });

  it("exits non-zero unless every job result is success", () => {
    const [, gateJob] = gate();
    const step = stepsOf(gateJob).find((candidate) => candidate.run !== undefined);
    expect(step?.env?.RESULTS).toBe("${{ join(needs.*.result, ' ') }}");
    const status = (results: string) => runStep(step?.run ?? "exit 0", { RESULTS: results }).status;

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
  });
});

describe("real-zotero.yml", () => {
  const inputs = () => workflows["real-zotero.yml"].on?.workflow_call?.inputs ?? {};

  it("keys the matrix and the negative control off the caller's inputs", () => {
    for (const name of [
      "xpi-artifact",
      "xpi-sha256",
      "zotero-versions",
      "negative-control-version",
      "channel",
    ]) {
      expect(inputs(), `workflow_call input ${name}`).toHaveProperty(name);
    }
    const job = jobOf("real-zotero.yml", "real-zotero");
    expect(job.strategy?.matrix?.zotero).toBe("${{ fromJSON(inputs.zotero-versions) }}");

    const control = stepsOf(job).filter((step) => /negative control/i.test(step.name ?? ""));
    expect(control).toHaveLength(1);
    expect(String(control[0].if)).toContain("matrix.zotero == inputs.negative-control-version");
    expect(String(control[0].if)).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it("checks every default Zotero version's tarball against a pinned or UNPINNED SHA-256", () => {
    const versions = JSON.parse(String(inputs()["zotero-versions"]?.default)) as string[];
    const pins = JSON.parse(
      workflows["real-zotero.yml"].env?.ZOTERO_TARBALL_SHA256 ?? "{}",
    ) as Record<string, unknown>;
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect(String(pins[version]), `Zotero ${version}`).toMatch(/^(?:UNPINNED|[0-9a-f]{64})$/);
    }
    const download = stepsOf(jobOf("real-zotero.yml", "real-zotero")).find((step) =>
      /download\.zotero\.org/.test(step.run ?? ""),
    );
    expect(download?.run).toContain("ZOTERO_TARBALL_SHA256");
  });
});

describe("ci.yml, release.yml and real-zotero.yml", () => {
  it("pin every action to a full commit SHA with a # vX.Y.Z comment", () => {
    for (const file of WORKFLOW_FILES) {
      for (const line of source[file].split("\n")) {
        const uses = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line);
        if (!uses || uses[1].startsWith("./")) continue;
        expect(line.trim(), file).toMatch(
          /^(?:-\s+)?uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/,
        );
      }
      for (const [id, job] of Object.entries(workflows[file].jobs)) {
        for (const uses of [job.uses, ...stepsOf(job).map((step) => step.uses)]) {
          if (uses === undefined || uses.startsWith("./")) continue;
          expect(uses, `${file} job ${id}`).toMatch(/@[0-9a-f]{40}$/);
        }
      }
    }
  });

  it("set no continue-on-error on any job or step", () => {
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

  it("check the lockfile in the step right after every npm install", () => {
    let installs = 0;
    for (const { where, job } of everyJob()) {
      const steps = stepsOf(job);
      steps.forEach((step, index) => {
        if (!/\bnpm (?:install|i|ci)\b/.test(step.run ?? "")) return;
        installs++;
        expect(steps[index + 1]?.run?.trim(), `${where}: the step after "${step.run}"`).toBe(
          LOCKFILE_CHECK,
        );
      });
    }
    expect(installs, "npm install steps found").toBeGreaterThanOrEqual(3);
  });

  it("bound every job that runs on a runner with timeout-minutes", () => {
    for (const { where, job } of everyJob()) {
      if (job["runs-on"] === undefined) continue;
      expect(typeof job["timeout-minutes"], where).toBe("number");
    }
  });
});

describe("channel version guard (scripts/check-channel-version.mjs)", () => {
  const channel = (...versions: string[]) => ({
    addons: { "citegeist@opusvita.org": { updates: versions.map((version) => ({ version })) } },
  });

  it("accepts a version newer than every listed version, comparing numerically", () => {
    expect(() => assertNewerThanChannel("3.0.0", channel("2.0.5"))).not.toThrow();
    expect(() => assertNewerThanChannel("2.0.10", channel("2.0.9"))).not.toThrow();
    expect(() => assertNewerThanChannel("3.0.1", channel("2.0.6", "3.0.0"))).not.toThrow();
  });

  it("refuses a version equal to or older than any listed version", () => {
    expect(() => assertNewerThanChannel("2.0.5", channel("2.0.5"))).toThrow(
      /not newer than 2\.0\.5/,
    );
    expect(() => assertNewerThanChannel("2.0.9", channel("2.0.10"))).toThrow(
      /not newer than 2\.0\.10/,
    );
    expect(() => assertNewerThanChannel("3.0.0", channel("2.0.6", "3.0.1"))).toThrow(
      /not newer than 3\.0\.1/,
    );
  });

  it("refuses a version or a channel it cannot compare", () => {
    expect(() => assertNewerThanChannel("3.0.0-rc.1", channel("2.0.5"))).toThrow(
      /MAJOR\.MINOR\.PATCH/,
    );
    expect(() => assertNewerThanChannel("3.0.0", channel("3.0.0-rc.1"))).toThrow(
      /MAJOR\.MINOR\.PATCH/,
    );
    expect(() => assertNewerThanChannel("3.0.0", channel())).toThrow(/no versions/);
    expect(() => assertNewerThanChannel("3.0.0", {})).toThrow(/no addons/);
  });
});

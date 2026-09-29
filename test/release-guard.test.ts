/**
 * The release guard (scripts/release-guard.mjs), run through its CLI the way publish-release.yml's
 * Build job runs it: in a checkout that has only the commit to release until the guard fetches
 * main, against a history with a pull request for each way GitHub merges one, and a stand-in for
 * gh that answers which pull requests GitHub lists for each commit. Between releases main carries
 * the next version's -alpha.0, as docs/RELEASE-CHECKLIST.md, section 5, prescribes.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkRelease } from "../scripts/release-guard.mjs";
import {
  GH_TOKEN,
  GhStub,
  PROCESS_TEST_TIMEOUT_MS,
  REPO_ROOT,
  REPOSITORY,
  TempDirs,
  git,
  isolatedEnv,
} from "./release-fixtures";

const CLI = join(REPO_ROOT, "scripts/release-guard-cli.mjs");
const RUNBOOK = "docs/RELEASE-RUNBOOK.md";

interface PullRequest {
  number: number;
  merged_at: string | null;
  merge_commit_sha?: string | null;
  base: { ref: string; sha: string; repo: { full_name: string } };
}

const temp = new TempDirs();
const commits: Record<string, string> = {};
const pulls: Record<string, PullRequest[]> = {};
let root = "";
let origin = "";
let env: Record<string, string> = {};
let gh: GhStub;

function pullRequest(
  number: number,
  mergeCommit: string | null,
  base: string,
  { ref = "main", repository = REPOSITORY, merged = true } = {},
): PullRequest {
  return {
    number,
    merged_at: merged ? "2026-09-13T12:00:00Z" : null,
    merge_commit_sha: mergeCommit,
    base: { ref, sha: base, repo: { full_name: repository } },
  };
}

beforeAll(() => {
  root = temp.make("guard");
  origin = join(root, "origin.git");
  const work = join(root, "work");
  gh = new GhStub(root);
  env = isolatedEnv(root, { ...gh.env(), GITHUB_REPOSITORY: REPOSITORY, GH_TOKEN }, [gh.bin]);
  git(root, env, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(root, env, "init", "--quiet", "--initial-branch=main", work);

  // A distinct timestamp for every git call, so a cherry-picked commit never reproduces its
  // original's SHA, as GitHub's rebase merge never does.
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const g = (...args: string[]) => {
    clock += 60_000;
    const date = new Date(clock).toISOString();
    return git(work, { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, ...args);
  };
  // Each commit appends to a file; branches that merge after main has moved on use their own file,
  // so their squash or rebase applies without a conflict.
  const commit = (message: string, version?: string, file = "history.txt") => {
    if (version !== undefined) {
      writeFileSync(
        join(work, "package.json"),
        `${JSON.stringify({ name: "fixture", version })}\n`,
      );
    }
    appendFileSync(join(work, file), `${message}\n`);
    g("add", "--all");
    g("commit", "--quiet", "-m", message);
    return g("rev-parse", "HEAD");
  };
  const branch = (name: string, from = "main") => g("switch", "--quiet", "--create", name, from);
  const squash = (name: string, message: string) => {
    g("switch", "--quiet", "main");
    g("merge", "--quiet", "--squash", name);
    g("commit", "--quiet", "-m", message);
    return g("rev-parse", "HEAD");
  };
  const cherryPick = (sha: string) => {
    g("cherry-pick", sha);
    return g("rev-parse", "HEAD");
  };
  /** A squash-merged pull request that only changes the version, such as the next -alpha.0. */
  const versionPullRequest = (number: number, version: string) => {
    const base = g("rev-parse", "main");
    branch(`version-${number}`);
    commit(`chore: ${version}`, version);
    const merged = squash(`version-${number}`, `chore: ${version} (#${number})`);
    pulls[merged] = [pullRequest(number, merged, base)];
    return merged;
  };
  g("remote", "add", "origin", origin);

  // main has carried 3.0.0 since before the first pull request here, from its first commit.
  commits.start = commit("start", "3.0.0");
  pulls[commits.start] = [pullRequest(1, commits.start, commits.start)];

  // #10, squashed, leaves the version alone while main already carries 3.0.0.
  branch("docs-10");
  commit("docs: notes");
  commits.mainAlreadyAtVersion = squash("docs-10", "docs: notes (#10)");
  pulls[commits.mainAlreadyAtVersion] = [
    pullRequest(10, commits.mainAlreadyAtVersion, commits.start),
  ];

  const alpha11 = versionPullRequest(11, "3.1.0-alpha.0");

  // #12, squashed. Its branch's own release commit carries a change review later rejected.
  branch("release-3.1.0");
  commit("feat: a change review rejects");
  commits.unmergedBranchRelease = commit("release: v3.1.0", "3.1.0");
  commit("fix: the change review asked for");
  commits.squashRelease = squash("release-3.1.0", "release: v3.1.0 (#12)");
  pulls[commits.squashRelease] = [pullRequest(12, commits.squashRelease, alpha11)];
  pulls[commits.unmergedBranchRelease] = [pullRequest(12, commits.squashRelease, alpha11)];

  // #13 merges after the release and leaves 3.1.0 alone.
  branch("docs-13");
  commit("docs: after the release");
  commits.laterMainCommit = squash("docs-13", "docs: after the release (#13)");
  pulls[commits.laterMainCommit] = [
    pullRequest(13, commits.laterMainCommit, commits.squashRelease),
  ];

  const alpha14 = versionPullRequest(14, "3.2.0-alpha.0");

  // #15, with a merge commit.
  branch("release-3.2.0");
  commits.branchCommitInMerge = commit("release: v3.2.0", "3.2.0");
  g("switch", "--quiet", "main");
  g("merge", "--quiet", "--no-ff", "-m", "Merge pull request #15", "release-3.2.0");
  commits.mergeCommitRelease = g("rev-parse", "HEAD");
  pulls[commits.mergeCommitRelease] = [pullRequest(15, commits.mergeCommitRelease, alpha14)];
  pulls[commits.branchCommitInMerge] = [pullRequest(15, commits.mergeCommitRelease, alpha14)];

  const alpha16 = versionPullRequest(16, "3.3.0-alpha.0");

  // #17, rebased: one commit.
  branch("release-3.3.0");
  const release17 = commit("release: v3.3.0", "3.3.0");
  g("switch", "--quiet", "main");
  commits.rebaseOfOne = cherryPick(release17);
  pulls[commits.rebaseOfOne] = [pullRequest(17, commits.rebaseOfOne, alpha16)];

  const alpha18 = versionPullRequest(18, "3.4.0-alpha.0");

  // #19, rebased: two commits, the version bump first. GitHub records the last as the merge commit,
  // and the commit before it already carries 3.4.0, so only walking back past the whole pull
  // request finds 3.4.0-alpha.0.
  branch("release-3.4.0");
  const bump19 = commit("release: v3.4.0", "3.4.0");
  const notes19 = commit("docs: release notes");
  g("switch", "--quiet", "main");
  commits.rebaseOfTwoFirst = cherryPick(bump19);
  commits.rebaseOfTwoLast = cherryPick(notes19);
  pulls[commits.rebaseOfTwoFirst] = [pullRequest(19, commits.rebaseOfTwoLast, alpha18)];
  pulls[commits.rebaseOfTwoLast] = [pullRequest(19, commits.rebaseOfTwoLast, alpha18)];

  commits.pushedToMain = commit("release: v3.5.0, pushed straight to main", "3.5.0");
  pulls[commits.pushedToMain] = [];

  commits.intoAnotherBranch = commit("release: v3.6.0 via develop", "3.6.0");
  pulls[commits.intoAnotherBranch] = [
    pullRequest(21, commits.intoAnotherBranch, commits.pushedToMain, { ref: "develop" }),
  ];

  // A branch whose name starts with "main" is still another branch.
  commits.intoMainOld = commit("release: v3.6.1 via main-old", "3.6.1");
  pulls[commits.intoMainOld] = [
    pullRequest(22, commits.intoMainOld, commits.intoAnotherBranch, { ref: "main-old" }),
  ];

  commits.intoAnotherRepository = commit("release: v3.7.0 into a fork", "3.7.0");
  pulls[commits.intoAnotherRepository] = [
    pullRequest(23, commits.intoAnotherRepository, commits.intoMainOld, {
      repository: "someone/zotero-citegeist",
    }),
  ];

  commits.unmergedPullRequest = commit("release: v3.8.0 from an open pull request", "3.8.0");
  pulls[commits.unmergedPullRequest] = [
    pullRequest(24, commits.unmergedPullRequest, commits.intoAnotherRepository, { merged: false }),
  ];

  // What API version 2026-03-10 returns: a pull request with no merge_commit_sha at all.
  commits.noMergeCommitSha = commit("release: v3.9.0", "3.9.0");
  const withoutMergeCommit = pullRequest(25, null, commits.unmergedPullRequest);
  delete withoutMergeCommit.merge_commit_sha;
  pulls[commits.noMergeCommitSha] = [withoutMergeCommit];

  commits.sharedMergeCommit = commit("release: v3.10.0", "3.10.0");
  pulls[commits.sharedMergeCommit] = [
    pullRequest(26, commits.sharedMergeCommit, commits.noMergeCommitSha),
    pullRequest(27, commits.sharedMergeCommit, commits.noMergeCommitSha),
  ];

  // #32 opened while main carried 4.0.0-alpha.0, and GitHub kept that as its base.sha. #31
  // released 4.0.0 before #32 merged, so #32 merged onto a main that already carried 4.0.0.
  const alpha30 = versionPullRequest(30, "4.0.0-alpha.0");
  branch("release-32", alpha30);
  commit("release: v4.0.0, the second time", "4.0.0", "notes-32.txt");
  branch("release-31", alpha30);
  commit("release: v4.0.0", "4.0.0", "notes-31.txt");
  commits.release31 = squash("release-31", "release: v4.0.0 (#31)");
  pulls[commits.release31] = [pullRequest(31, commits.release31, alpha30)];
  commits.staleBaseSha = squash("release-32", "release: v4.0.0, the second time (#32)");
  pulls[commits.staleBaseSha] = [pullRequest(32, commits.staleBaseSha, alpha30)];

  // #37 is a rebase of three commits, opened while main carried 4.1.0-alpha.0. #38 released 4.1.0
  // first, then #37 was rebased onto it.
  const alpha36 = versionPullRequest(36, "4.1.0-alpha.0");
  branch("release-37", alpha36);
  const own37 = [
    commit("release: v4.1.0, the second time", "4.1.0", "notes-37.txt"),
    commit("docs: notes for #37", undefined, "notes-37.txt"),
    commit("fix: for #37", undefined, "notes-37.txt"),
  ];
  branch("release-38", alpha36);
  commit("release: v4.1.0", "4.1.0", "notes-38.txt");
  commits.release38 = squash("release-38", "release: v4.1.0 (#38)");
  pulls[commits.release38] = [pullRequest(38, commits.release38, alpha36)];
  const rebased37 = own37.map(cherryPick);
  commits.rebaseOfThreeStaleBase = rebased37[2];
  for (const sha of rebased37) {
    pulls[sha] = [pullRequest(37, commits.rebaseOfThreeStaleBase, alpha36)];
  }

  // #41 meant 4.2.0 and typed 42.0.0.
  versionPullRequest(40, "4.2.0-alpha.0");
  branch("release-41");
  commit("release: v42.0.0", "42.0.0");
  commits.typoVersion = squash("release-41", "release: v42.0.0 (#41)");
  pulls[commits.typoVersion] = [pullRequest(41, commits.typoVersion, g("rev-parse", "main^1"))];

  // #44 is listed after 100 other pull requests, on the API's second page.
  const alpha43 = versionPullRequest(43, "4.3.0-alpha.0");
  branch("release-4.3.0");
  commit("release: v4.3.0", "4.3.0");
  commits.secondPage = squash("release-4.3.0", "release: v4.3.0 (#44)");
  pulls[commits.secondPage] = [
    ...Array.from({ length: 100 }, (_, i) =>
      pullRequest(1000 + i, "a".repeat(40), alpha43, { merged: false }),
    ),
    pullRequest(44, commits.secondPage, alpha43),
  ];

  // #46, rebased: three commits, the version bump first, with a base.sha from long before.
  versionPullRequest(45, "4.4.0-alpha.0");
  branch("release-4.4.0");
  const own46 = [
    commit("release: v4.4.0", "4.4.0"),
    commit("docs: notes for #46"),
    commit("fix: for #46"),
  ];
  g("switch", "--quiet", "main");
  const rebased46 = own46.map(cherryPick);
  commits.rebaseOfThree = rebased46[2];
  for (const sha of rebased46) {
    pulls[sha] = [pullRequest(46, commits.rebaseOfThree, commits.start)];
  }

  // One push for main and every labelled commit: a push each is most of this hook's time.
  g(
    "push",
    "--quiet",
    "origin",
    "main",
    ...Object.entries(commits).map(([label, sha]) => `${sha}:refs/fixture/${label}`),
  );
}, 2 * PROCESS_TEST_TIMEOUT_MS);

// Removing every throwaway repository outlasts vitest's 10 s hook default on a loaded machine.
afterAll(() => temp.removeAll(), PROCESS_TEST_TIMEOUT_MS);

/**
 * A checkout of one commit and its history only: main is not there until the guard fetches it.
 */
function checkout(label: string): string {
  const dir = temp.make("runner");
  git(dir, env, "init", "--quiet");
  git(dir, env, "remote", "add", "origin", origin);
  git(
    dir,
    env,
    "fetch",
    "--quiet",
    "--no-tags",
    "origin",
    `+refs/fixture/${label}:refs/fixture/${label}`,
  );
  git(dir, env, "checkout", "--quiet", "--detach", commits[label]);
  return dir;
}

function guard(version: string, label: string, { cli = CLI, sha = commits[label] } = {}) {
  gh.reset({ pulls });
  const output = join(temp.make("output"), "github-output");
  writeFileSync(output, "");
  const result = spawnSync(process.execPath, [cli, version, sha], {
    cwd: checkout(label),
    env: { ...env, GITHUB_OUTPUT: output },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: readFileSync(output, "utf8"),
  };
}

describe("release guard: a release pull request's merge commit publishes", () => {
  it.each([
    ["a squash merge", "3.1.0", "squashRelease", "3.1.0-alpha.0", 12],
    ["a merge commit", "3.2.0", "mergeCommitRelease", "3.2.0-alpha.0", 15],
    ["a rebase merge of one commit", "3.3.0", "rebaseOfOne", "3.3.0-alpha.0", 17],
    [
      "a rebase merge of two commits, at the last one",
      "3.4.0",
      "rebaseOfTwoLast",
      "3.4.0-alpha.0",
      19,
    ],
    [
      "a rebase merge of three commits whose base.sha is long out of date",
      "4.4.0",
      "rebaseOfThree",
      "4.4.0-alpha.0",
      46,
    ],
    [
      "a release another pull request's release did not precede",
      "4.0.0",
      "release31",
      "4.0.0-alpha.0",
      31,
    ],
    ["a pull request GitHub lists on its second page", "4.3.0", "secondPage", "4.3.0-alpha.0", 44],
  ])(
    "%s",
    (_label, version, commit, before, number) => {
      const result = guard(version, commit);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(`${commits[commit]} is on main's first-parent history`);
      expect(result.stdout).toContain(
        `${commits[commit]} is the merge commit of pull request #${number} into main`,
      );
      expect(result.stdout).toContain(
        `changed package.json's version from ${before} to ${version}`,
      );
      expect(result.output).toBe(
        `commit=${commits[commit]}\nversion=${version}\ntag=v${version}\n`,
      );
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "asks GitHub with the pinned API version, and through every page",
    () => {
      guard("4.3.0", "secondPage");
      const calls = gh.calls().filter((call) => call[0] === "api");
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.slice(0, 3)).toEqual(["api", "-H", "X-GitHub-Api-Version: 2022-11-28"]);
        expect(call).toEqual(expect.arrayContaining(["--paginate", "--slurp"]));
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("release guard: refuses", () => {
  it(
    "a version that is not MAJOR.MINOR.PATCH, or a commit that is not a full SHA, before asking GitHub anything",
    () => {
      for (const version of [
        "v3.1.0",
        "3.1.0-rc.1",
        "3.1.0-alpha.0",
        "3.1",
        "03.1.0",
        "3.1.0 ",
        "1234567890.0.0",
      ]) {
        const result = guard(version, "squashRelease");
        expect(result.status, version).toBe(1);
        expect(result.stdout, version).toContain("is not MAJOR.MINOR.PATCH");
        expect(gh.calls(), version).toEqual([]);
        expect(result.output, version).toBe("");
      }
      for (const sha of [
        commits.squashRelease.slice(0, 12),
        "main",
        commits.squashRelease.toUpperCase(),
      ]) {
        const result = guard("3.1.0", "squashRelease", { sha });
        expect(result.status, sha).toBe(1);
        expect(result.stdout, sha).toContain("must be a full 40-character SHA");
        expect(gh.calls(), sha).toEqual([]);
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it.each([
    [
      "a version that is not package.json's",
      "3.1.1",
      "squashRelease",
      "has version 3.1.0, not 3.1.1",
    ],
    [
      "the release commit on a branch that has not merged",
      "3.1.0",
      "unmergedBranchRelease",
      "is not on main. It is most likely the release commit on a release branch that has not merged",
    ],
    [
      "a branch commit a merge commit brought in",
      "3.2.0",
      "branchCommitInMerge",
      "a merge commit brought it in from the release branch",
    ],
    [
      "a rebased commit that is not the pull request's last",
      "3.4.0",
      "rebaseOfTwoFirst",
      "came to main in pull request #19, whose merge commit is",
    ],
    [
      "a commit GitHub lists no pull request for, which may only be GitHub catching up",
      "3.5.0",
      "pushedToMain",
      "GitHub lists no pull request for",
    ],
    [
      "the merge commit of a pull request into another branch",
      "3.6.0",
      "intoAnotherBranch",
      `is the merge commit of pull request #21 into ${REPOSITORY}:develop, not into main`,
    ],
    [
      "the merge commit of a pull request into a branch named like main",
      "3.6.1",
      "intoMainOld",
      `is the merge commit of pull request #22 into ${REPOSITORY}:main-old, not into main`,
    ],
    [
      "the merge commit of a pull request into another repository",
      "3.7.0",
      "intoAnotherRepository",
      "into someone/zotero-citegeist:main, not into main of",
    ],
    [
      "a commit whose pull request never merged",
      "3.8.0",
      "unmergedPullRequest",
      "no merged pull request into main has it as its merge commit",
    ],
    [
      "an answer without merge_commit_sha, as API version 2026-03-10 gives",
      "3.9.0",
      "noMergeCommitSha",
      "has no merge_commit_sha",
    ],
    [
      "a commit two merged pull requests both record as their merge commit",
      "3.10.0",
      "sharedMergeCommit",
      "is the merge commit of more than one pull request (#26, #27)",
    ],
    [
      "a pull request merged after the release, which left the version alone",
      "3.1.0",
      "laterMainCommit",
      "package.json on main had 3.1.0 just before pull request #13",
    ],
    [
      "a pull request while main already carried the version",
      "3.0.0",
      "mainAlreadyAtVersion",
      "package.json on main had 3.0.0 just before pull request #10",
    ],
    [
      "a release whose base.sha still says 4.0.0-alpha.0, merged after another released 4.0.0",
      "4.0.0",
      "staleBaseSha",
      "package.json on main had 4.0.0 just before pull request #32",
    ],
    [
      "a rebase whose base.sha still says 4.1.0-alpha.0, merged after another released 4.1.0",
      "4.1.0",
      "rebaseOfThreeStaleBase",
      "package.json on main had 4.1.0 just before pull request #37",
    ],
    [
      "a typo that would outrank the version main was developing",
      "42.0.0",
      "typoVersion",
      "package.json on main had 4.2.0-alpha.0 just before pull request #41",
    ],
    [
      "a pull request at the first commit of main, with no version before it",
      "3.0.0",
      "start",
      "starts at the first commit of main",
    ],
  ])(
    "%s",
    (_label, version, commit, cause) => {
      const result = guard(version, commit);
      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toContain("::error::");
      expect(result.stdout).toContain(cause);
      expect(result.stdout).toContain(RUNBOOK);
      expect(result.output).toBe("");
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "names both versions when main was not developing the one to release",
    () => {
      const typo = guard("42.0.0", "typoVersion").stdout;
      expect(typo).toContain("releasing 42.0.0 requires 42.0.0-alpha.0 there");
      expect(typo).toContain("main was developing 4.2.0, not 42.0.0");
      const shipped = guard("4.0.0", "staleBaseSha").stdout;
      expect(shipped).toContain("releasing 4.0.0 requires 4.0.0-alpha.0 there");
      expect(shipped).toContain("main already carried 4.0.0 before it");
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "asks to re-run in a minute, not to change the version, when GitHub lists no pull request yet",
    () => {
      const { stdout } = guard("3.5.0", "pushedToMain");
      expect(stdout).toContain("re-run this job in a minute with Re-run failed jobs");
      expect(stdout).not.toContain("release the next");
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "names the last rebased commit when a rebase's earlier commit is given",
    () => {
      expect(guard("3.4.0", "rebaseOfTwoFirst").stdout).toContain(
        `so release ${commits.rebaseOfTwoLast}`,
      );
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "a commit that is not in the repository",
    () => {
      const result = guard("3.1.0", "squashRelease", { sha: "f".repeat(40) });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(`${"f".repeat(40)} is not a commit in ${REPOSITORY}`);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "when GitHub cannot say which pull request brought the commit, or gh has no token",
    () => {
      const dir = checkout("squashRelease");
      const run = (state: Parameters<GhStub["reset"]>[0], variables = env) => {
        gh.reset(state);
        return spawnSync(process.execPath, [CLI, "3.1.0", commits.squashRelease], {
          cwd: dir,
          env: variables,
          encoding: "utf8",
        });
      };
      const failing = run({ pulls, failApi: "HTTP 502: Bad Gateway" });
      expect(failing.status).toBe(1);
      expect(failing.stdout).toContain("Could not list the pull requests GitHub lists for");
      expect(failing.stdout).toContain("HTTP 502");

      const { GH_TOKEN: _token, ...withoutToken } = env;
      const unauthenticated = run({ pulls }, withoutToken);
      expect(unauthenticated.status).toBe(1);
      expect(unauthenticated.stdout).toContain("populate the GH_TOKEN environment variable");
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "when gh does not answer in time",
    () => {
      const bin = join(root, "slow-gh-bin");
      mkdirSync(bin, { recursive: true });
      // exec, so the process the deadline kills is the one holding the output pipes.
      writeFileSync(join(bin, "gh"), "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
      const cwd = checkout("squashRelease");
      const started = Date.now();
      expect(() =>
        checkRelease({
          version: "3.1.0",
          commit: commits.squashRelease,
          repository: REPOSITORY,
          cwd,
          env: isolatedEnv(root, { GH_TOKEN }, [bin]),
          timeoutMs: 5_000,
        }),
      ).toThrow(/did not finish within 5 s/);
      expect(Date.now() - started).toBeLessThan(45_000);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("release guard CLI (scripts/release-guard-cli.mjs)", () => {
  it(
    "exits 1 without both arguments, and runs the check through a symlinked path",
    () => {
      const cwd = checkout("squashRelease");
      const bare = (...args: string[]) =>
        spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8" }).status;
      expect(bare()).toBe(1);
      expect(bare("3.1.0")).toBe(1);

      const linked = join(root, "release-guard-cli-link.mjs");
      symlinkSync(CLI, linked);
      expect(guard("3.1.0", "squashRelease", { cli: linked }).status).toBe(0);
      expect(guard("3.1.0", "unmergedBranchRelease", { cli: linked }).status).toBe(1);
      expect(guard("3.1.0", "laterMainCommit", { cli: linked }).status).toBe(1);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});

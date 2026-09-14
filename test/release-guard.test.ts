/**
 * The release guard (scripts/release-guard.mjs), run through its CLI the way release.yml's build job
 * runs it: in a checkout of the tagged commit alone, against a history with a pull request for each
 * way GitHub merges one, and a stand-in for gh that answers which pull request put each commit on
 * main. Between releases main carries the next version's -alpha.0, as docs/RELEASE-CHECKLIST.md,
 * section 5, prescribes.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GhStub,
  PROCESS_TEST_TIMEOUT_MS,
  REPO_ROOT,
  REPOSITORY,
  TempDirs,
  git,
  isolatedEnv,
} from "./release-fixtures";

const CLI = join(REPO_ROOT, "scripts/release-guard-cli.mjs");
const PROCEDURE = "docs/RELEASE-CHECKLIST.md, section 5";

interface PullRequest {
  number: number;
  merged_at: string | null;
  merge_commit_sha: string | null;
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
  mergeCommit: string,
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
  env = isolatedEnv(root, { ...gh.env(), GITHUB_REPOSITORY: REPOSITORY, GH_TOKEN: "test" }, [
    gh.bin,
  ]);
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
  const commit = (message: string, version?: string) => {
    if (version !== undefined) {
      writeFileSync(
        join(work, "package.json"),
        `${JSON.stringify({ name: "fixture", version })}\n`,
      );
    }
    appendFileSync(join(work, "history.txt"), `${message}\n`);
    g("add", "--all");
    g("commit", "--quiet", "-m", message);
    return g("rev-parse", "HEAD");
  };
  const branch = (name: string) => g("switch", "--quiet", "--create", name, "main");
  const squash = (name: string, message: string) => {
    g("switch", "--quiet", "main");
    g("merge", "--quiet", "--squash", name);
    return commit(message);
  };
  const cherryPick = (sha: string) => {
    g("cherry-pick", sha);
    return g("rev-parse", "HEAD");
  };
  g("remote", "add", "origin", origin);

  // main has carried 3.0.0 since before the first pull request here.
  commits.start = commit("start", "3.0.0");

  // #10, squashed, leaves the version alone while main already carries 3.0.0.
  branch("docs-10");
  commit("docs: notes");
  commits.mainAlreadyAtVersion = squash("docs-10", "docs: notes (#10)");
  pulls[commits.mainAlreadyAtVersion] = [
    pullRequest(10, commits.mainAlreadyAtVersion, commits.start),
  ];

  branch("alpha-11");
  commit("chore: start 3.1.0", "3.1.0-alpha.0");
  const alpha11 = squash("alpha-11", "chore: start 3.1.0 (#11)");
  pulls[alpha11] = [pullRequest(11, alpha11, commits.mainAlreadyAtVersion)];

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

  branch("alpha-14");
  commit("chore: start 3.2.0", "3.2.0-alpha.0");
  const alpha14 = squash("alpha-14", "chore: start 3.2.0 (#14)");
  pulls[alpha14] = [pullRequest(14, alpha14, commits.laterMainCommit)];

  // #15, with a merge commit.
  branch("release-3.2.0");
  commits.branchCommitInMerge = commit("release: v3.2.0", "3.2.0");
  g("switch", "--quiet", "main");
  g("merge", "--quiet", "--no-ff", "-m", "Merge pull request #15", "release-3.2.0");
  commits.mergeCommitRelease = g("rev-parse", "HEAD");
  pulls[commits.mergeCommitRelease] = [pullRequest(15, commits.mergeCommitRelease, alpha14)];
  pulls[commits.branchCommitInMerge] = [pullRequest(15, commits.mergeCommitRelease, alpha14)];

  branch("alpha-16");
  commit("chore: start 3.3.0", "3.3.0-alpha.0");
  const alpha16 = squash("alpha-16", "chore: start 3.3.0 (#16)");
  pulls[alpha16] = [pullRequest(16, alpha16, commits.mergeCommitRelease)];

  // #17, rebased: one commit.
  branch("release-3.3.0");
  const release17 = commit("release: v3.3.0", "3.3.0");
  g("switch", "--quiet", "main");
  commits.rebaseOfOne = cherryPick(release17);
  pulls[commits.rebaseOfOne] = [pullRequest(17, commits.rebaseOfOne, alpha16)];

  branch("alpha-18");
  commit("chore: start 3.4.0", "3.4.0-alpha.0");
  const alpha18 = squash("alpha-18", "chore: start 3.4.0 (#18)");
  pulls[alpha18] = [pullRequest(18, alpha18, commits.rebaseOfOne)];

  // #19, rebased: two commits, the version bump first. GitHub records the last as the merge commit.
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

  commits.intoAnotherRepository = commit("release: v3.7.0 into a fork", "3.7.0");
  pulls[commits.intoAnotherRepository] = [
    pullRequest(22, commits.intoAnotherRepository, commits.intoAnotherBranch, {
      repository: "someone/zotero-citegeist",
    }),
  ];

  commits.unmergedPullRequest = commit("release: v3.8.0 from an open pull request", "3.8.0");
  pulls[commits.unmergedPullRequest] = [
    pullRequest(23, commits.unmergedPullRequest, commits.intoAnotherRepository, { merged: false }),
  ];

  commits.unreadableBase = commit("release: v3.9.0", "3.9.0");
  pulls[commits.unreadableBase] = [pullRequest(24, commits.unreadableBase, "f".repeat(40))];

  g("push", "--quiet", "origin", "main");
  for (const [label, sha] of Object.entries(commits)) {
    g("push", "--quiet", "origin", `${sha}:refs/fixture/${label}`);
  }
}, PROCESS_TEST_TIMEOUT_MS);

afterAll(() => temp.removeAll());

/**
 * A checkout of one commit and its history only, as actions/checkout leaves the tagged commit:
 * main is not there until the guard fetches it.
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

function guard(tag: string, label: string, cli = CLI) {
  gh.reset({ pulls });
  const result = spawnSync(process.execPath, [cli, tag, commits[label]], {
    cwd: checkout(label),
    env,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("release guard: a release pull request's merge commit publishes", () => {
  it.each([
    ["a squash merge", "v3.1.0", "squashRelease", "3.1.0-alpha.0"],
    ["a merge commit", "v3.2.0", "mergeCommitRelease", "3.2.0-alpha.0"],
    ["a rebase merge of one commit", "v3.3.0", "rebaseOfOne", "3.3.0-alpha.0"],
    [
      "a rebase merge of two commits, at the last one",
      "v3.4.0",
      "rebaseOfTwoLast",
      "3.4.0-alpha.0",
    ],
  ])(
    "%s",
    (_label, tag, commit, before) => {
      const result = guard(tag, commit);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(`${commits[commit]} is on main's first-parent history`);
      expect(result.stdout).toContain(
        `changed package.json's version from ${before} to ${tag.slice(1)}`,
      );
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("release guard: refuses", () => {
  it(
    "a tag that is not vMAJOR.MINOR.PATCH, before asking GitHub anything",
    () => {
      for (const tag of ["v3.1.0-rc.1", "v3.1.0-alpha.0", "3.1.0", "v3.1", "v03.1.0", "v3.1.0 "]) {
        const result = guard(tag, "squashRelease");
        expect(result.status, tag).toBe(1);
        expect(result.stdout, tag).toContain("is not a release tag");
        expect(result.stdout, tag).toContain(PROCEDURE);
        expect(gh.calls(), tag).toEqual([]);
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it.each([
    [
      "a tag whose version is not package.json's",
      "v3.1.1",
      "squashRelease",
      "package.json at",
      "has 3.1.0",
    ],
    [
      "the release commit on a branch that has not merged",
      "v3.1.0",
      "unmergedBranchRelease",
      "is not on main. It is most likely the release commit on a release branch that has not merged",
      PROCEDURE,
    ],
    [
      "a branch commit a merge commit brought in",
      "v3.2.0",
      "branchCommitInMerge",
      "a merge commit brought it in from the release branch",
      PROCEDURE,
    ],
    [
      "a rebased commit that is not the pull request's last",
      "v3.4.0",
      "rebaseOfTwoFirst",
      "came to main in pull request #19, whose merge commit is",
      "Squash-merge release pull requests",
    ],
    [
      "a commit pushed to main without a pull request",
      "v3.5.0",
      "pushedToMain",
      "no merged pull request into main has it as its merge commit",
      PROCEDURE,
    ],
    [
      "the merge commit of a pull request into another branch",
      "v3.6.0",
      "intoAnotherBranch",
      `is the merge commit of pull request #21 into ${REPOSITORY}:develop, not into main`,
      PROCEDURE,
    ],
    [
      "the merge commit of a pull request into another repository",
      "v3.7.0",
      "intoAnotherRepository",
      "into someone/zotero-citegeist:main, not into main of",
      PROCEDURE,
    ],
    [
      "a commit whose pull request never merged",
      "v3.8.0",
      "unmergedPullRequest",
      "no merged pull request into main has it as its merge commit",
      PROCEDURE,
    ],
    [
      "a pull request merged after the release, which left the version alone",
      "v3.1.0",
      "laterMainCommit",
      "Pull request #13 did not change package.json's version",
      "already had 3.1.0",
    ],
    [
      "a pull request while main already carried the version",
      "v3.0.0",
      "mainAlreadyAtVersion",
      "Pull request #10 did not change package.json's version",
      "development version such as 3.0.0-alpha.0",
    ],
    [
      "a pull request whose base commit cannot be read",
      "v3.9.0",
      "unreadableBase",
      "Cannot read pull request #24's base commit",
      "cannot tell whether it changed the version",
    ],
  ])(
    "%s",
    (_label, tag, commit, cause, pointer) => {
      const result = guard(tag, commit);
      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toContain("::error::");
      expect(result.stdout).toContain(cause);
      expect(result.stdout).toContain(pointer);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "names the last rebased commit when a rebase's earlier commit is tagged",
    () => {
      expect(guard("v3.4.0", "rebaseOfTwoFirst").stdout).toContain(
        `so tag ${commits.rebaseOfTwoLast}`,
      );
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "when GitHub cannot say which pull request brought the commit",
    () => {
      const dir = checkout("squashRelease");
      gh.reset({ pulls, failApi: "HTTP 502: Bad Gateway" });
      const result = spawnSync(process.execPath, [CLI, "v3.1.0", commits.squashRelease], {
        cwd: dir,
        env,
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Could not list the pull requests");
      expect(result.stdout).toContain("HTTP 502");
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
      expect(bare("v3.1.0")).toBe(1);

      const linked = join(root, "release-guard-cli-link.mjs");
      symlinkSync(CLI, linked);
      expect(guard("v3.1.0", "squashRelease", linked).status).toBe(0);
      expect(guard("v3.1.0", "unmergedBranchRelease", linked).status).toBe(1);
      expect(guard("v3.1.0", "laterMainCommit", linked).status).toBe(1);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});

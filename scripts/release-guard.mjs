/**
 * The build job's guard on a pushed tag: a release publishes only a commit review approved, and
 * only the first time its version ships. Every installed copy takes a published release on its
 * next update check, so a wrong tag is a fleet-wide incident.
 *
 * Every check must hold, in this order:
 *
 *   1. The tag is vMAJOR.MINOR.PATCH (release-tag.mjs).
 *   2. package.json at the tagged commit has the tag's version.
 *   3. The commit is on main's first-parent history. The guard fetches main itself first.
 *   4. The commit is the merge commit GitHub recorded for a merged pull request into main. That
 *      covers every merge method: GitHub's "Get a pull request" documentation says "If merged as a
 *      merge commit, merge_commit_sha represents the SHA of the merge commit. If merged via a
 *      squash, merge_commit_sha represents the SHA of the squashed commit on the base branch. If
 *      rebased, merge_commit_sha represents the commit that the base branch was updated to."
 *   5. That pull request changed the version: package.json at its base commit has another one.
 *
 * Without 3 and 4, a tag on the release branch's own commit would ship code review never saw.
 * Without 5, a tag on a later merge would ship a version that already exists. Each refusal names
 * its likely cause and the procedure in docs/RELEASE-CHECKLIST.md.
 *
 * It needs git with an `origin` remote, and `gh` authenticated to read the repository's pull
 * requests (the build job grants pull-requests: read). No dependency: it runs before npm install.
 */
import { spawnSync } from "node:child_process";
import { releaseTagVersion } from "./release-tag.mjs";

const PROCEDURE = "docs/RELEASE-CHECKLIST.md, section 5";
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAIN = "refs/remotes/origin/main";

/**
 * @typedef {{
 *   number?: number,
 *   merged_at?: string | null,
 *   merge_commit_sha?: string | null,
 *   base?: { ref?: string, sha?: string, repo?: { full_name?: string } },
 * }} PullRequest
 */

/**
 * Throws unless `sha` may publish as `tag`.
 *
 * @param {{
 *   tag: string,
 *   sha: string,
 *   repository: string,
 *   cwd?: string,
 *   env?: Record<string, string | undefined>,
 * }} options `repository` is owner/name; `cwd` is a clone whose `origin` is that repository.
 * @returns {string[]} one line for each check that passed
 */
export function checkReleaseTag({ tag, sha, repository, cwd = process.cwd(), env = process.env }) {
  const version = releaseTagVersion(tag);
  if (typeof sha !== "string" || !COMMIT_SHA.test(sha)) {
    throw new Error(`The commit to check must be a 40-digit SHA, got ${JSON.stringify(sha)}`);
  }
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) {
    throw new Error(`The repository must be owner/name, got ${JSON.stringify(repository)}`);
  }

  /** @param {string} command @param {string[]} args */
  const run = (command, args) =>
    spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  /** @param {string[]} args */
  const git = (...args) => {
    const result = run("git", args);
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${failureText(result)}`);
    }
    return result.stdout;
  };
  /** @param {string} commit */
  const versionAt = (commit) => {
    let version;
    try {
      version = JSON.parse(git("show", `${commit}:package.json`)).version;
    } catch (error) {
      throw new Error(`Cannot read package.json's version at ${commit}`, { cause: error });
    }
    if (typeof version !== "string") {
      throw new Error(`package.json at ${commit} has no version`);
    }
    return version;
  };

  const passed = [];
  git("fetch", "--no-tags", "--quiet", "origin", `+refs/heads/main:${MAIN}`);
  const commit = git("rev-parse", "--verify", "--quiet", `${sha}^{commit}`).trim();

  const tagged = versionAt(commit);
  if (tagged !== version) {
    throw new Error(
      `${tag} names version ${version}, but package.json at ${commit} has ${tagged}. Tag the ` +
        `commit the release pull request's merge put on main, whose package.json has ${version} ` +
        `(${PROCEDURE}).`,
    );
  }
  passed.push(`package.json at ${commit} has version ${version}`);

  const firstParent = new Set(git("rev-list", "--first-parent", MAIN).split("\n"));
  if (!firstParent.has(commit)) {
    const reachable = run("git", ["merge-base", "--is-ancestor", commit, MAIN]).status === 0;
    throw new Error(
      reachable
        ? `${commit} is not on main's own history: a merge commit brought it in from the release ` +
            `branch. Tag the merge commit of the release pull request instead (${PROCEDURE}).`
        : `${commit} is not on main. It is most likely the release commit on a release branch ` +
            `that has not merged, which review has not approved. Merge the release pull request, ` +
            `then tag the commit its merge put on main (${PROCEDURE}).`,
    );
  }
  passed.push(`${commit} is on main's first-parent history`);

  const pulls = pullRequestsFor({ run, repository, commit });
  const merged = pulls.filter((pull) => typeof pull?.merged_at === "string" && pull.merged_at);
  const intoMain = merged.filter(
    (pull) => pull.base?.ref === "main" && pull.base?.repo?.full_name === repository,
  );
  const releases = intoMain.filter((pull) => pull.merge_commit_sha === commit);
  if (releases.length === 0) {
    const rebased = intoMain[0];
    if (rebased) {
      throw new Error(
        `${commit} came to main in pull request #${rebased.number}, whose merge commit is ` +
          `${rebased.merge_commit_sha}. A rebase merge puts every commit of the pull request on ` +
          `main and GitHub records the last one as its merge commit, so tag ` +
          `${rebased.merge_commit_sha}. Squash-merge release pull requests to avoid this ` +
          `(${PROCEDURE}).`,
      );
    }
    const elsewhere = merged.find((pull) => pull.merge_commit_sha === commit);
    if (elsewhere) {
      throw new Error(
        `${commit} is the merge commit of pull request #${elsewhere.number} into ` +
          `${elsewhere.base?.repo?.full_name}:${elsewhere.base?.ref}, not into main of ` +
          `${repository}. Release through a pull request into main (${PROCEDURE}).`,
      );
    }
    throw new Error(
      `${commit} is on main, but no merged pull request into main has it as its merge commit: it ` +
        `reached main without review. Release through a pull request into main and tag its merge ` +
        `commit (${PROCEDURE}).`,
    );
  }
  if (releases.length > 1) {
    throw new Error(
      `${commit} is the merge commit of more than one pull request ` +
        `(${releases.map((pull) => `#${pull.number}`).join(", ")}), so the guard cannot tell ` +
        "which one review approved",
    );
  }
  const [release] = releases;
  passed.push(`${commit} is the merge commit of pull request #${release.number} into main`);

  const base = release.base?.sha;
  if (typeof base !== "string" || !COMMIT_SHA.test(base)) {
    throw new Error(`Pull request #${release.number} has no base commit SHA`);
  }
  const hasBase = () => run("git", ["cat-file", "-e", `${base}^{commit}`]).status === 0;
  // The base is normally on main's history already. If not, try the remote; a failure here is
  // caught by the check that follows.
  if (!hasBase()) run("git", ["fetch", "--no-tags", "--quiet", "origin", base]);
  if (!hasBase()) {
    throw new Error(
      `Cannot read pull request #${release.number}'s base commit ${base}, so the guard cannot ` +
        "tell whether it changed the version",
    );
  }
  const before = versionAt(base);
  if (before === version) {
    throw new Error(
      `Pull request #${release.number} did not change package.json's version: its base ${base} ` +
        `already had ${version}. Either it merged after ${version} was released, or main already ` +
        `carried ${version} before the release pull request. Between releases main carries a ` +
        `development version such as ${version}-alpha.0, and the release pull request changes it ` +
        `to ${version}; if ${version} has shipped, release the next version (${PROCEDURE}).`,
    );
  }
  passed.push(
    `Pull request #${release.number} changed package.json's version from ${before} to ${version}`,
  );
  return passed;
}

/**
 * The pull requests GitHub associates with a commit, across every page.
 * @param {{ run: (command: string, args: string[]) => import("node:child_process").SpawnSyncReturns<string>, repository: string, commit: string }} options
 * @returns {PullRequest[]}
 */
function pullRequestsFor({ run, repository, commit }) {
  const result = run("gh", [
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository}/commits/${commit}/pulls?per_page=100`,
  ]);
  if (result.status !== 0) {
    throw new Error(
      `Could not list the pull requests that brought ${commit} to main: ${failureText(result)}`,
    );
  }
  let pages;
  try {
    pages = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`gh api did not return JSON for ${commit}'s pull requests`, { cause: error });
  }
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error(`gh api did not return pages of pull requests for ${commit}`);
  }
  return pages.flat();
}

/** @param {import("node:child_process").SpawnSyncReturns<string>} result */
function failureText(result) {
  return (result.stderr || String(result.error ?? `exit ${result.status}`)).trim();
}

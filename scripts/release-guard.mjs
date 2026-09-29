/**
 * Build's guard on a release: a dispatch publishes only a commit review approved, and only as the
 * version its release pull request introduced. Every installed copy takes a published release on
 * its next update check, so a wrong commit or version is a fleet-wide incident.
 *
 * Every check must hold, in this order:
 *
 *   1. The version is MAJOR.MINOR.PATCH (version.mjs) and the commit a full SHA.
 *   2. package.json at the commit has that version.
 *   3. The commit is on main's first-parent history. The guard fetches main itself first.
 *   4. The commit is the merge commit GitHub recorded for a merged pull request into main. That
 *      covers every merge method: GitHub's "Get a pull request" documentation says "If merged as a
 *      merge commit, merge_commit_sha represents the SHA of the merge commit. If merged via a
 *      squash, merge_commit_sha represents the SHA of the squashed commit on the base branch. If
 *      rebased, merge_commit_sha represents the commit that the base branch was updated to."
 *   5. main carried the version's development version, `<version>-alpha.0`, just before that pull
 *      request: in package.json at the pull request's first-parent predecessor on main. For a squash
 *      or a merge commit that is the commit's first parent. A rebase puts every commit of the pull
 *      request on main, so the guard walks first parents back while GitHub lists the same pull
 *      request for them. It never reads the pull request's base.sha: GitHub records that when the
 *      pull request is opened or updated, not when it merges, so a release another pull request
 *      shipped in between would go unseen.
 *
 * Without 3 and 4, a release of the release branch's own commit would ship code review never saw.
 * Without 5, a later merge could ship a version that has already shipped, and a typo such as
 * 30.0.0 for 3.0.0 would pass and then outrank every 3.x release on the update channel.
 *
 * Each refusal names its likely cause and points to docs/RELEASE-RUNBOOK.md. The guard needs git
 * with an `origin` remote and `gh` authenticated to read the repository's pull requests; every gh
 * call goes through release-github.mjs. It uses no dependency: it runs before npm install.
 */
import { failureText, git, listAll, NETWORK_TIMEOUT_MS } from "./release-github.mjs";
import { assertReleaseVersion, developmentVersion, releaseTag } from "./version.mjs";

const RUNBOOK = "docs/RELEASE-RUNBOOK.md";
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAIN = "refs/remotes/origin/main";
/** A rebase merge longer than this is refused rather than walked: GitHub lists 250 commits per pull request. */
const MAX_REBASE_WALK = 300;

/**
 * @typedef {{
 *   number?: number,
 *   merged_at?: string | null,
 *   merge_commit_sha?: string | null,
 *   base?: { ref?: string, sha?: string, repo?: { full_name?: string } },
 * }} PullRequest
 */

/**
 * Throws unless `commit` may be released as `version`.
 *
 * @param {{
 *   version: string,
 *   commit: string,
 *   repository: string,
 *   cwd?: string,
 *   env?: Record<string, string | undefined>,
 *   timeoutMs?: number,
 * }} options `repository` is owner/name; `cwd` is a clone whose `origin` is that repository;
 *   `timeoutMs` is the deadline for each network call.
 * @returns {{ commit: string, version: string, tag: string, passed: string[] }} the release and one
 *   line for each check that passed
 */
export function checkRelease({
  version,
  commit: sha,
  repository,
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = NETWORK_TIMEOUT_MS,
}) {
  assertReleaseVersion(version, "The version to release");
  if (typeof sha !== "string" || !COMMIT_SHA.test(sha)) {
    throw new Error(
      `The commit to release must be a full 40-character SHA, got ${JSON.stringify(sha)}. Leave ` +
        "the commit empty to release main as it stands, or give the release pull request's merge " +
        `commit (${RUNBOOK}, "Guard refusals").`,
    );
  }
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) {
    throw new Error(`The repository must be owner/name, got ${JSON.stringify(repository)}`);
  }

  const local = { cwd, env };
  const network = { cwd, env, timeoutMs };
  /** @param {string[]} args @param {{ cwd?: string, timeoutMs?: number }} [options] */
  const gitOut = (args, options = local) => {
    const result = git(args, options);
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${failureText(result)}`);
    }
    return result.stdout;
  };
  /** The commit a revision names, or "" when it names none. @param {string} revision */
  const resolve = (revision) => {
    const result = git(["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], local);
    if (result.status === 0) return result.stdout.trim();
    if (result.status === 1 && !result.error) return "";
    throw new Error(`git rev-parse ${revision} failed: ${failureText(result)}`);
  };
  /** @param {string} at */
  const versionAt = (at) => {
    let found;
    try {
      found = JSON.parse(gitOut(["show", `${at}:package.json`])).version;
    } catch (error) {
      throw new Error(`Cannot read package.json's version at ${at}`, { cause: error });
    }
    if (typeof found !== "string") throw new Error(`package.json at ${at} has no version`);
    return found;
  };
  /** @param {string} at @returns {PullRequest[]} */
  const pullsFor = (at) =>
    listAll(
      `repos/${repository}/commits/${at}/pulls?per_page=100`,
      `the pull requests GitHub lists for ${at}`,
      network,
    );
  /** @param {PullRequest} pull */
  const mergedIntoMain = (pull) =>
    typeof pull?.merged_at === "string" &&
    pull.merged_at !== "" &&
    pull.base?.ref === "main" &&
    pull.base?.repo?.full_name === repository;

  const passed = [];
  gitOut(["fetch", "--no-tags", "--quiet", "origin", `+refs/heads/main:${MAIN}`], network);
  const commit = resolve(sha);
  if (commit === "") {
    throw new Error(
      `${sha} is not a commit in ${repository}. Check the commit you gave (${RUNBOOK}, ` +
        `"Guard refusals").`,
    );
  }

  const tagged = versionAt(commit);
  if (tagged !== version) {
    throw new Error(
      `package.json at ${commit} has version ${tagged}, not ${version}. Release the version the ` +
        `release pull request set, from the commit its merge put on main (${RUNBOOK}, ` +
        `"Guard refusals").`,
    );
  }
  passed.push(`package.json at ${commit} has version ${version}`);

  const firstParent = new Set(gitOut(["rev-list", "--first-parent", MAIN]).split("\n"));
  if (!firstParent.has(commit)) {
    const reachable = git(["merge-base", "--is-ancestor", commit, MAIN], local).status === 0;
    throw new Error(
      reachable
        ? `${commit} is not on main's own history: a merge commit brought it in from the release ` +
            `branch. Release the merge commit of the release pull request instead (${RUNBOOK}, ` +
            `"Guard refusals").`
        : `${commit} is not on main. It is most likely the release commit on a release branch ` +
            `that has not merged, which review has not approved. Merge the release pull request, ` +
            `then release the commit its merge put on main (${RUNBOOK}, "Guard refusals").`,
    );
  }
  passed.push(`${commit} is on main's first-parent history`);

  const pulls = pullsFor(commit);
  if (pulls.length === 0) {
    throw new Error(
      `GitHub lists no pull request for ${commit} yet. It links a merge commit to its pull ` +
        `request shortly after the merge, so re-run this job in a minute with Re-run failed ` +
        `jobs. If it still lists none, ${commit} reached main without a pull request, and only a ` +
        `release pull request's merge commit may be released (${RUNBOOK}, "Guard refusals").`,
    );
  }
  for (const pull of pulls) {
    if (pull !== null && typeof pull === "object" && !("merge_commit_sha" in pull)) {
      throw new Error(
        `GitHub's answer for pull request #${pull.number} has no merge_commit_sha, so the guard ` +
          "cannot tell which commit its merge put on main. REST API version 2026-03-10 removed " +
          "the field and the guard asks for 2022-11-28; if GitHub no longer serves that version, " +
          `the guard needs another source for the merge commit (${RUNBOOK}, "Upkeep").`,
      );
    }
  }
  const merged = pulls.filter((pull) => typeof pull?.merged_at === "string" && pull.merged_at);
  const intoMain = merged.filter(mergedIntoMain);
  const releases = intoMain.filter((pull) => pull.merge_commit_sha === commit);
  if (releases.length === 0) {
    const rebased = intoMain[0];
    if (rebased) {
      throw new Error(
        `${commit} came to main in pull request #${rebased.number}, whose merge commit is ` +
          `${rebased.merge_commit_sha}. A rebase merge puts every commit of the pull request on ` +
          `main and GitHub records the last one as its merge commit, so release ` +
          `${rebased.merge_commit_sha}. Squash-merge release pull requests to avoid this ` +
          `(${RUNBOOK}, "Guard refusals").`,
      );
    }
    const elsewhere = merged.find((pull) => pull.merge_commit_sha === commit);
    if (elsewhere) {
      throw new Error(
        `${commit} is the merge commit of pull request #${elsewhere.number} into ` +
          `${elsewhere.base?.repo?.full_name}:${elsewhere.base?.ref}, not into main of ` +
          `${repository}. Release through a pull request into main (${RUNBOOK}, ` +
          `"Guard refusals").`,
      );
    }
    throw new Error(
      `${commit} is on main, but no merged pull request into main has it as its merge commit: it ` +
        `reached main without review. Release through a pull request into main and release its ` +
        `merge commit (${RUNBOOK}, "Guard refusals").`,
    );
  }
  if (releases.length > 1) {
    throw new Error(
      `${commit} is the merge commit of more than one pull request ` +
        `(${releases.map((pull) => `#${pull.number}`).join(", ")}), so the guard cannot tell ` +
        `which one review approved (${RUNBOOK}, "Guard refusals")`,
    );
  }
  const [release] = releases;
  passed.push(`${commit} is the merge commit of pull request #${release.number} into main`);

  // The first commit the pull request put on main, then the commit main was at just before it.
  let first = commit;
  let predecessor = resolve(`${first}^1`);
  for (let walked = 0; ; walked++) {
    if (predecessor === "") {
      throw new Error(
        `Pull request #${release.number} starts at the first commit of main, so there is no ` +
          `version before it to compare (${RUNBOOK}, "Guard refusals")`,
      );
    }
    if (walked === MAX_REBASE_WALK) {
      throw new Error(
        `Pull request #${release.number} put more than ${MAX_REBASE_WALK} commits on main, so the ` +
          `guard stops looking for the commit before it. Squash-merge release pull requests ` +
          `(${RUNBOOK}, "Guard refusals").`,
      );
    }
    const samePull = pullsFor(predecessor).some(
      (pull) => pull?.number === release.number && mergedIntoMain(pull),
    );
    if (!samePull) break;
    first = predecessor;
    predecessor = resolve(`${first}^1`);
  }

  const before = versionAt(predecessor);
  const expected = developmentVersion(version);
  if (before !== expected) {
    const cause =
      before === version
        ? `main already carried ${version} before it, so ${version} was set by an earlier pull ` +
          `request and has most likely shipped. Release the next version.`
        : before.endsWith("-alpha.0")
          ? `main was developing ${before.slice(0, -"-alpha.0".length)}, not ${version}. Check ` +
            `${version} for a typo; a version that outranks the one main was developing would ` +
            `block every release below it.`
          : `Between releases main carries the next version's -alpha.0, and the release pull ` +
            `request changes it to the version.`;
    throw new Error(
      `package.json on main had ${before} just before pull request #${release.number} ` +
        `(at ${predecessor}), but releasing ${version} requires ${expected} there: ${cause} ` +
        `(${RUNBOOK}, "Guard refusals")`,
    );
  }
  passed.push(
    `Pull request #${release.number} changed package.json's version from ${before} to ${version}`,
  );
  return { commit, version, tag: releaseTag(version), passed };
}

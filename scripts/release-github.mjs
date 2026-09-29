/**
 * How the release scripts call gh and git, in one place: every GitHub REST call pins the API
 * version, every child process has a deadline, and absence is read from an HTTP 404 alone, never
 * from an error message's wording.
 *
 * The API version is 2022-11-28. The next version, 2026-03-10, removes merge_commit_sha from every
 * pull request payload, and the release guard reads it. GitHub supports 2022-11-28 until
 * 2028-03-10 (https://docs.github.com/en/rest/about-the-rest-api/api-versions); before then the
 * guard needs another source for a pull request's merge commit (docs/RELEASE-RUNBOOK.md, "Upkeep").
 *
 * The release guard runs before npm install and Publish installs nothing, so this file uses no
 * dependency. Each helper names its program literally, so test/workflow-invariants.test.ts can see
 * every program a write-scoped job starts.
 */
import { spawnSync } from "node:child_process";

export const API_VERSION = "2022-11-28";
export const API_VERSION_HEADER = `X-GitHub-Api-Version: ${API_VERSION}`;

/** The deadline for a gh or git call that talks to GitHub. */
export const NETWORK_TIMEOUT_MS = 120_000;
/** The deadline for a git call that only reads the local repository. */
export const LOCAL_TIMEOUT_MS = 60_000;

const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * @typedef {{ cwd?: string, env?: Record<string, string | undefined>, timeoutMs?: number }} RunOptions
 * @typedef {{
 *   status: number | null,
 *   signal: string | null,
 *   stdout: string,
 *   stderr: string,
 *   error?: Error & { code?: string },
 *   timeoutMs: number,
 * }} RunResult what spawnSync returns, with the deadline the process ran under
 */

/**
 * The options every child process runs with. A process past its deadline is killed.
 * @param {RunOptions} options
 * @param {number} defaultTimeoutMs
 */
function spawnOptions({ cwd, env = process.env, timeoutMs }, defaultTimeoutMs) {
  return {
    cwd,
    env,
    encoding: /** @type {const} */ ("utf8"),
    maxBuffer: MAX_BUFFER,
    timeout: timeoutMs ?? defaultTimeoutMs,
  };
}

/**
 * Runs gh.
 * @param {string[]} args
 * @param {RunOptions} [options]
 * @returns {RunResult}
 */
export function gh(args, options = {}) {
  const spawn = spawnOptions(options, NETWORK_TIMEOUT_MS);
  return { ...spawnSync("gh", args, spawn), timeoutMs: spawn.timeout };
}

/**
 * Runs git.
 * @param {string[]} args
 * @param {RunOptions} [options]
 * @returns {RunResult}
 */
export function git(args, options = {}) {
  const spawn = spawnOptions(options, LOCAL_TIMEOUT_MS);
  return { ...spawnSync("git", args, spawn), timeoutMs: spawn.timeout };
}

/**
 * Runs bash on one of the repository's scripts.
 * @param {string[]} args the script and its arguments
 * @param {RunOptions} [options]
 * @returns {RunResult}
 */
export function bash(args, options = {}) {
  const spawn = spawnOptions(options, NETWORK_TIMEOUT_MS);
  return { ...spawnSync("bash", args, spawn), timeoutMs: spawn.timeout };
}

/**
 * `gh api` with the pinned API version.
 * @param {string[]} args everything after `gh api`
 * @param {RunOptions} [options]
 * @returns {RunResult}
 */
export function ghApi(args, options) {
  return gh(["api", "-H", API_VERSION_HEADER, ...args], options);
}

/**
 * Why a child process failed, for an error message: its deadline, its stderr, or its exit status.
 * @param {RunResult} result
 * @returns {string}
 */
export function failureText(result) {
  const { error } = result;
  if (error?.code === "ETIMEDOUT") return `it did not finish within ${result.timeoutMs / 1000} s`;
  const stderr = `${result.stderr ?? ""}`.trim();
  if (stderr) return stderr;
  if (error) return String(error);
  return result.signal
    ? `it stopped on ${result.signal}`
    : `it exited with status ${result.status}`;
}

/**
 * Every item of a paginated REST list, read with `gh api --paginate --slurp`, which returns one
 * array per page.
 * @param {string} path such as repos/<owner>/<name>/releases?per_page=100
 * @param {string} what names the list in an error, such as "phdemotions/zotero-citegeist's releases"
 * @param {RunOptions} [options]
 * @returns {any[]}
 */
export function listAll(path, what, options) {
  const result = ghApi(["--paginate", "--slurp", path], options);
  if (result.status !== 0) {
    throw new Error(`Could not list ${what}: ${failureText(result)}`);
  }
  let pages;
  try {
    pages = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`gh api did not return JSON for ${what}`, { cause: error });
  }
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error(`gh api did not return pages of ${what}`);
  }
  return pages.flat();
}

/**
 * GETs one REST resource and returns its parsed body, or null when GitHub answers HTTP 404. Any
 * other outcome throws: a network failure, a missing token, a 5xx, a rate limit. `gh api
 * --include` prints the response's status line, so the status comes from GitHub itself.
 * @param {string} path
 * @param {string} what names the resource in an error, such as "release v3.0.0"
 * @param {RunOptions} [options]
 * @returns {any | null}
 */
export function getOrNull(path, what, options) {
  const result = ghApi(["--include", path], options);
  const output = `${result.stdout ?? ""}`;
  const status = /^HTTP\/[\d.]+ (\d{3})\b/.exec(output)?.[1];
  if (status === "404") return null;
  if (status === undefined || result.status !== 0 || status !== "200") {
    const cause = status === undefined ? failureText(result) : `HTTP ${status}`;
    throw new Error(`Could not tell whether ${what} exists: ${cause}`);
  }
  const body = output
    .split(/\r?\n\r?\n/)
    .slice(1)
    .join("\n\n");
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`gh api did not return JSON for ${what}`, { cause: error });
  }
}

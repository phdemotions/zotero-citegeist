/**
 * Decide from a real-Zotero runner log whether the run proved anything.
 *
 * scaffold exits 0 whenever Mocha reports no failure, including a run that
 * collected no tests and one where a spec file never loaded inside Zotero. So
 * the scaffold config's `test:bundleTests` hook prints how many tests the
 * bundles Zotero will load contain, and CI requires the run to end with exactly
 * that many passing. The negative control checks the inverse: a build Zotero
 * must refuse may not finish a clean run.
 *
 * Plain JavaScript, so the workflow runs its CLI with bare `node`:
 *   node test/real-zotero/harness/runLog-cli.mjs passed <log>
 *   node test/real-zotero/harness/runLog-cli.mjs refused <log>
 */
import { readFileSync } from "node:fs";

const COLLECTED = "Citegeist real-Zotero suite collected";
const COLLECTED_LINE = new RegExp(`${COLLECTED} (\\d+) tests`, "g");
const SUMMARY_LINE = /Test run completed - (\d+) passed(?:, (\d+) failed)?/g;
// Built from a char code so the pattern holds no literal control character.
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

/** The line the scaffold config prints after counting the tests. */
export function formatCollectedLine(tests, files) {
  return `${COLLECTED} ${tests} tests from ${files} spec files`;
}

export function stripAnsi(text) {
  return text.replace(ANSI_ESCAPE, "");
}

/**
 * @param {string} log
 * @returns {{ collected: number[], summaries: { passed: number, failed: number }[] }}
 */
export function parseRunLog(log) {
  const text = stripAnsi(log);
  return {
    collected: [...text.matchAll(COLLECTED_LINE)].map((m) => Number(m[1])),
    summaries: [...text.matchAll(SUMMARY_LINE)].map((m) => ({
      passed: Number(m[1]),
      failed: Number(m[2] ?? 0),
    })),
  };
}

/** Problems with a run that should have passed every collected test; empty when it did. */
export function problemsWithPassedRun(log) {
  const { collected, summaries } = parseRunLog(log);
  const problems = [];
  if (collected.length !== 1) {
    problems.push(
      `expected one "${COLLECTED}" line, found ${collected.length}: the test:bundleTests hook in zotero-plugin.config.ts did not run`,
    );
  } else if (collected[0] === 0) {
    problems.push("scaffold collected zero tests");
  }
  if (summaries.length !== 1) {
    problems.push(
      `expected one "Test run completed" summary, found ${summaries.length}: Zotero exited before Mocha finished`,
    );
  }
  if (problems.length > 0) return problems;

  const expected = collected[0];
  const { passed, failed } = summaries[0];
  if (failed > 0) problems.push(`${failed} test or hook failure(s)`);
  if (passed !== expected) {
    problems.push(
      `${passed} of ${expected} collected tests passed: a spec file did not load inside Zotero, or a test was skipped`,
    );
  }
  return problems;
}

/** Problems with a run that Zotero should have refused; empty unless it finished clean. */
export function problemsWithRefusedRun(log) {
  return parseRunLog(log)
    .summaries.filter((summary) => summary.failed === 0)
    .map(
      (summary) =>
        `a build Zotero must refuse finished a clean run (${summary.passed} passed, none failed)`,
    );
}

/**
 * What runLog-cli.mjs runs: checks a log, writes the result to stdout, and returns the exit status.
 * Any problem, a missing argument and an unreadable log all return 1.
 * @param {string[]} args `passed|refused <log>`
 * @returns {number}
 */
export function runLogCli([mode, path]) {
  const check = { passed: problemsWithPassedRun, refused: problemsWithRefusedRun }[mode];
  if (!check || !path) {
    process.stdout.write("::error::usage: node runLog-cli.mjs passed|refused <log>\n");
    return 1;
  }
  let log;
  try {
    log = readFileSync(path, "utf8");
  } catch (error) {
    process.stdout.write(`::error::Cannot read ${path}: ${error.message}\n`);
    return 1;
  }
  const problems = check(log);
  for (const problem of problems) process.stdout.write(`::error::${path}: ${problem}\n`);
  if (problems.length === 0) {
    const { collected, summaries } = parseRunLog(log);
    process.stdout.write(
      `${path}: ${mode} run confirmed (collected ${collected.join(", ") || "none"}; ` +
        `summaries ${JSON.stringify(summaries)})\n`,
    );
  }
  return problems.length === 0 ? 0 : 1;
}

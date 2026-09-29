/**
 * Runs the release guard (release-guard.mjs). The Publish release workflow's Build job calls it
 * before anything is installed:
 *
 *   GITHUB_REPOSITORY=<owner/name> GH_TOKEN=<token> \
 *     node scripts/release-guard-cli.mjs <MAJOR.MINOR.PATCH> <commit SHA>
 *
 * It prints each check that passed, appends `commit=`, `version=` and `tag=` lines to
 * $GITHUB_OUTPUT when that is set, and exits 1 on any refusal and on a missing argument. This file
 * does nothing but run the check: an "is this the main module" test can come out false through a
 * symlinked path, and the check would then silently not run.
 */
import { appendFileSync } from "node:fs";
import { checkRelease } from "./release-guard.mjs";

const [version, commit] = process.argv.slice(2);
try {
  if (!version || !commit) {
    throw new Error("usage: node scripts/release-guard-cli.mjs <MAJOR.MINOR.PATCH> <commit SHA>");
  }
  const release = checkRelease({
    version,
    commit,
    repository: process.env.GITHUB_REPOSITORY ?? "",
  });
  for (const line of release.passed) console.log(line);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `commit=${release.commit}\nversion=${release.version}\ntag=${release.tag}\n`,
    );
  }
} catch (error) {
  // GitHub reads workflow commands from stdout.
  console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

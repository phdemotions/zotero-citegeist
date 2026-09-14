/**
 * Runs Publish's channel check (check-channel-version.mjs):
 *
 *   SUMS=<build's asset sums> GH_REPO=<owner/name> GH_TOKEN=<token> \
 *     node scripts/check-channel-version-cli.mjs <MAJOR.MINOR.PATCH> <update.json URL>
 *
 * It prints what it found, appends `state=<state>` to $GITHUB_OUTPUT when that is set, and exits 1
 * on any refusal and on a missing argument. This file does nothing but run the check: an "is this
 * the main module" test can come out false through a symlinked path, and the check would then
 * silently not run.
 */
import { appendFileSync } from "node:fs";
import { checkChannel } from "./check-channel-version.mjs";

const [version, url] = process.argv.slice(2);
try {
  if (!version || !url) {
    throw new Error(
      "usage: SUMS=<asset sums> GH_REPO=<owner/name> node scripts/check-channel-version-cli.mjs " +
        "<MAJOR.MINOR.PATCH> <update.json URL>",
    );
  }
  const { state, message } = await checkChannel({
    version,
    url,
    sums: process.env.SUMS,
    repository: process.env.GH_REPO ?? "",
  });
  console.log(message);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `state=${state}\n`);
} catch (error) {
  // GitHub reads workflow commands from stdout.
  console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

/**
 * Runs the release guard (release-guard.mjs). release.yml's build job calls it before anything is
 * installed:
 *
 *   GITHUB_REPOSITORY=<owner/name> GH_TOKEN=<token> node scripts/release-guard-cli.mjs <tag> <commit SHA>
 *
 * It exits 1 on any refusal and on a missing argument. This file does nothing but run the check:
 * an "is this the main module" test can come out false through a symlinked path, and the check
 * would then silently not run.
 */
import { checkReleaseTag } from "./release-guard.mjs";

const [tag, sha] = process.argv.slice(2);
try {
  if (!tag || !sha) {
    throw new Error("usage: node scripts/release-guard-cli.mjs <tag> <commit SHA>");
  }
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  for (const line of checkReleaseTag({ tag, sha, repository })) console.log(line);
} catch (error) {
  // GitHub reads workflow commands from stdout.
  console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

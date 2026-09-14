/**
 * Writes the README badge JSON (readme-badges.mjs):
 *
 *   node scripts/readme-badges-cli.mjs <releases.json> <output dir>
 *
 * <releases.json> is `gh api --paginate --slurp "repos/<owner>/<name>/releases?per_page=100"`
 * output. It writes badge-release.json and badge-downloads.json into <output dir> and exits 1 on
 * any error.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { badgeValues } from "./readme-badges.mjs";

const [releasesFile, outputDir] = process.argv.slice(2);
try {
  if (!releasesFile || !outputDir) {
    throw new Error("usage: node scripts/readme-badges-cli.mjs <releases.json> <output dir>");
  }
  const { release, downloads } = badgeValues(JSON.parse(readFileSync(releasesFile, "utf8")));
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "badge-release.json"), `${JSON.stringify(release)}\n`);
  writeFileSync(join(outputDir, "badge-downloads.json"), `${JSON.stringify(downloads)}\n`);
  console.log(`Badges: release ${release.message}, downloads ${downloads.message}`);
} catch (error) {
  console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

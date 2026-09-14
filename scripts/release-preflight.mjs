#!/usr/bin/env node
/**
 * `npm run release` preflight. bumpp --all commits every tracked change into
 * `release: vX.Y.Z`, so anything besides the two release-note files would ride
 * into the release commit unreviewed. Untracked files are ignored: bumpp does
 * not commit them.
 */
import { execFileSync } from "node:child_process";

const RELEASE_NOTE_FILES = new Set(["CHANGELOG.md", "CITATION.cff"]);

const status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=no"], {
  encoding: "utf8",
});
const fields = status.split("\0");
const unexpected = [];
for (let i = 0; i < fields.length; i++) {
  const entry = fields[i];
  if (entry === "") continue;
  const code = entry.slice(0, 2);
  const paths = [entry.slice(3)];
  // A rename or copy is followed by its source path in the next field.
  if (code.includes("R") || code.includes("C")) paths.push(fields[++i]);
  for (const path of paths) {
    if (!RELEASE_NOTE_FILES.has(path)) unexpected.push(`${code} ${path}`);
  }
}

if (unexpected.length > 0) {
  console.error(
    "npm run release commits every tracked change, and these are not release notes:\n" +
      unexpected.map((line) => `  ${line}`).join("\n") +
      "\nCommit them separately or set them aside first. Only CHANGELOG.md and CITATION.cff may be uncommitted.",
  );
  process.exit(1);
}

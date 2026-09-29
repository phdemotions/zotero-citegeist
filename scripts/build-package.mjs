/**
 * Zipping the XPI so one commit always yields the same bytes. Publish's re-run, the channel repair
 * and a reused versioned release compare a new attempt's SHA-256 with the bytes an earlier attempt
 * published, so an XPI whose bytes change from one build to the next turns every re-run after a
 * half-done Publish into a refusal. zip records each entry's modification time, permissions and
 * the order it reads the files in, and all three are fixed here before it runs.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, readdirSync, utimesSync } from "node:fs";
import { join, relative, sep } from "node:path";

// The earliest time a zip entry can record. A build outside a git checkout, with SOURCE_DATE_EPOCH
// unset, stamps its files with it.
const FALLBACK_SOURCE_DATE = new Date("1980-01-01T00:00:00Z");

/**
 * The commit this build comes from and the time its outputs carry: SOURCE_DATE_EPOCH when it is
 * set, following the reproducible-builds convention, otherwise the commit's committer time, and
 * 1980-01-01 outside a git checkout. Returns `{ commit, date }`, where `commit` is the first 12
 * characters of HEAD's SHA, the same length in a shallow clone as in a full one, or "nogit".
 */
export function readBuildSource(root, { env = process.env, git = runGit } = {}) {
  const [sha, committedAt] = git(root, ["show", "-s", "--format=%H %ct", "HEAD"])?.split(" ") ?? [];
  const commit = sha ? sha.slice(0, 12) : "nogit";

  if (env.SOURCE_DATE_EPOCH !== undefined) {
    if (!/^\d+$/.test(env.SOURCE_DATE_EPOCH)) {
      throw new Error(
        `SOURCE_DATE_EPOCH must be a whole number of seconds since 1970, got ` +
          `${JSON.stringify(env.SOURCE_DATE_EPOCH)}`,
      );
    }
    return { commit, date: new Date(Number(env.SOURCE_DATE_EPOCH) * 1000) };
  }
  return {
    commit,
    date: committedAt ? new Date(Number(committedAt) * 1000) : FALLBACK_SOURCE_DATE,
  };
}

/** A build id from the commit and its time alone, such as "1f2a4aba46ff-20260913T184200Z". */
export function buildIdFor({ commit, date }) {
  return `${commit}-${date.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
}

function runGit(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    // Not a git checkout.
    return undefined;
  }
}

/**
 * Zips every file under `dir` into `xpiPath`, which must not exist yet, so the bytes depend only on
 * the files' contents and `date`. Each file and directory takes `date` as its modification time
 * and each file mode 644, since zip records both; zip reads a sorted list of paths rather than
 * walking the directory in the file system's order, and runs in UTC, because it records local
 * time. `-X` leaves out the extra fields that carry owner ids and a second timestamp, and `-D`
 * leaves out directory entries.
 */
export function zipReproducibly(dir, xpiPath, date) {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile()) {
      chmodSync(path, 0o644);
      files.push(relative(dir, path).split(sep).join("/"));
    }
    utimesSync(path, date, date);
  }
  utimesSync(dir, date, date);

  execFileSync("zip", ["-X", "-D", "-q", xpiPath, "-@"], {
    cwd: dir,
    input: `${files.sort().join("\n")}\n`,
    env: { ...process.env, TZ: "UTC" },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

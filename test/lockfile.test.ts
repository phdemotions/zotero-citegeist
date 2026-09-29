/**
 * No locked package may install a command named after a tool the build, the release jobs or these
 * tests run. `npm run` and `npx` put node_modules/.bin first on PATH, so a package declaring a `zip`
 * or `git` bin would run in place of the real one wherever a script started from npm spawns it.
 * The release workflow's Build job runs `node scripts/build.mjs` rather than `npm run build` for the
 * same reason; this test covers every other path, and fails on the pull request that adds such a
 * package, before it reaches a release.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./release-fixtures";

/** The tools the build, the release jobs and the release tests start by name. */
const SHADOWED_TOOLS = [
  "node",
  "git",
  "zip",
  "unzip",
  "sh",
  "bash",
  "sha256sum",
  "shasum",
  "cut",
  "sort",
  "find",
  "tar",
  "gh",
  "curl",
];

interface LockedPackage {
  name?: string;
  bin?: string | Record<string, string>;
}

/** Every command a lockfile installs, as "<command> (<package path>)". */
function lockedCommands(lock: { packages?: Record<string, LockedPackage> }): string[] {
  const commands: string[] = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (entry.bin === undefined) continue;
    // A string bin installs one command named after the package.
    const names =
      typeof entry.bin === "string"
        ? [(entry.name ?? path.split("node_modules/").at(-1) ?? "").split("/").at(-1) ?? ""]
        : Object.keys(entry.bin);
    for (const name of names) commands.push(`${name} (${path || "the project itself"})`);
  }
  return commands;
}

describe("package-lock.json", () => {
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8"));

  it("is lockfile version 3, which lists every package with the commands it installs", () => {
    expect(lock.lockfileVersion).toBe(3);
    expect(Object.keys(lock.packages ?? {}).length).toBeGreaterThan(100);
    expect(lockedCommands(lock)).toContain("esbuild (node_modules/esbuild)");
  });

  it("installs no command named after a tool the build or the release jobs run", () => {
    const shadowing = lockedCommands(lock).filter((command) =>
      SHADOWED_TOOLS.includes(command.split(" ")[0]),
    );
    expect(shadowing).toEqual([]);
  });

  it("reads both forms a bin takes", () => {
    expect(
      lockedCommands({
        packages: {
          "": { name: "fixture" },
          "node_modules/zip": { name: "zip", bin: "cli.js" },
          "node_modules/@scope/tools": { bin: { git: "git.js", other: "other.js" } },
          "node_modules/a/node_modules/tar": { bin: "index.js" },
        },
      }),
    ).toEqual([
      "zip (node_modules/zip)",
      "git (node_modules/@scope/tools)",
      "other (node_modules/@scope/tools)",
      "tar (node_modules/a/node_modules/tar)",
    ]);
  });
});

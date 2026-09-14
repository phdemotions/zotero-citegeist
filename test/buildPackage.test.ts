import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { buildIdFor, readBuildSource, zipReproducibly } from "../scripts/build-package.mjs";

const HEAD_SHA = "1f2a4aba46ff8170eb2f117bf136008b519e721c";
const COMMITTED_AT = 1_789_000_000;
const inCheckout = () => `${HEAD_SHA} ${COMMITTED_AT}`;
const outsideCheckout = () => undefined;

const MISSING_ZIP_TOOLS = ["zip", "unzip"].filter(
  (tool) => spawnSync(tool, ["-v"], { stdio: "ignore" }).error !== undefined,
);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("readBuildSource", () => {
  it("asks git for HEAD's full SHA and committer time, and takes the first 12 characters and that time", () => {
    const calls: unknown[] = [];
    const git = (cwd: string, args: string[]) => {
      calls.push([cwd, args]);
      return inCheckout();
    };

    expect(readBuildSource("/repo", { env: {}, git })).toEqual({
      commit: "1f2a4aba46ff",
      date: new Date(COMMITTED_AT * 1000),
    });
    expect(calls).toEqual([["/repo", ["show", "-s", "--format=%H %ct", "HEAD"]]]);
  });

  it("prefers SOURCE_DATE_EPOCH to the commit time", () => {
    const env = { SOURCE_DATE_EPOCH: "1700000000" };

    expect(readBuildSource("/repo", { env, git: inCheckout })).toEqual({
      commit: "1f2a4aba46ff",
      date: new Date(1_700_000_000_000),
    });
  });

  it("outside a git checkout takes SOURCE_DATE_EPOCH when set, and otherwise 1980-01-01", () => {
    expect(
      readBuildSource("/copy", { env: { SOURCE_DATE_EPOCH: "1700000000" }, git: outsideCheckout }),
    ).toEqual({ commit: "nogit", date: new Date(1_700_000_000_000) });
    expect(readBuildSource("/copy", { env: {}, git: outsideCheckout })).toEqual({
      commit: "nogit",
      date: new Date("1980-01-01T00:00:00Z"),
    });
  });

  it.each(["", "1.5", "-1", "soon", " 1700000000"])("refuses SOURCE_DATE_EPOCH %j", (value) => {
    expect(() =>
      readBuildSource("/repo", { env: { SOURCE_DATE_EPOCH: value }, git: inCheckout }),
    ).toThrow(`SOURCE_DATE_EPOCH must be a whole number of seconds since 1970, got "${value}"`);
  });
});

describe("buildIdFor", () => {
  it("joins the commit and its time in UTC, to the second", () => {
    const source = { commit: "1f2a4aba46ff", date: new Date("2026-09-13T18:42:07.999Z") };

    expect(buildIdFor(source)).toBe("1f2a4aba46ff-20260913T184207Z");
  });
});

/** Each entry of the archive as `unzip -Z -T` lists it, in the order the archive holds them. */
function zipEntries(xpi: string): Array<{ mode: string; time: string; name: string }> {
  return execFileSync("unzip", ["-Z", "-T", xpi], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns.length === 8 && /^[-dl][-rwxsStT]{9}$/.test(columns[0]))
    .map(([mode, , , , , , time, name]) => ({ mode, time, name }));
}

/** Writes each file, in the order given, with `mode` and `mtime`. Each file holds its own path. */
function writeTree(paths: string[], mode: number, mtime: Date): string {
  const dir = tempDir("citegeist-zip-tree-");
  for (const path of paths) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, path);
    chmodSync(file, mode);
    utimesSync(file, mtime, mtime);
  }
  return dir;
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const PATHS = ["z.js", "content/b.css", "manifest.json", "a-b.json", "content/a/c.svg"];
const SOURCE_DATE = new Date("2026-09-13T12:34:56Z");

describe.skipIf(MISSING_ZIP_TOOLS.length > 0 && !process.env.CI)("zipReproducibly", () => {
  it("records every file sorted by path, with no directory entries, mode 644 and the source date in UTC", () => {
    const dir = writeTree(PATHS, 0o600, new Date("2020-01-01T00:00:00Z"));
    const xpi = join(tempDir("citegeist-zip-"), "citegeist.xpi");

    zipReproducibly(dir, xpi, SOURCE_DATE);

    const entries = zipEntries(xpi);
    expect(entries.map(({ name }) => name)).toEqual([
      "a-b.json",
      "content/a/c.svg",
      "content/b.css",
      "manifest.json",
      "z.js",
    ]);
    expect(new Set(entries.map(({ mode }) => mode))).toEqual(new Set(["-rw-r--r--"]));
    expect(new Set(entries.map(({ time }) => time))).toEqual(new Set(["20260913.123456"]));
  });

  it("zips two copies of the same files to the same bytes, whatever order, mode and times they were written with", () => {
    const first = writeTree(PATHS, 0o600, new Date("2020-01-01T00:00:00Z"));
    const second = writeTree([...PATHS].reverse(), 0o664, new Date("2025-06-01T09:30:00Z"));
    const out = tempDir("citegeist-zip-");

    zipReproducibly(first, join(out, "first.xpi"), SOURCE_DATE);
    zipReproducibly(second, join(out, "second.xpi"), SOURCE_DATE);

    expect(sha256(join(out, "second.xpi"))).toBe(sha256(join(out, "first.xpi")));
  });
});

/**
 * The scripts release.yml runs and `npm run release` runs, each the way it is run for real: bash
 * scripts under `bash --noprofile --norc -eo pipefail`, Node CLIs through spawnSync, with gh replaced
 * by a stub that records every call and the update channel served by a local HTTP server.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assessLiveChannel,
  assessMissingChannel,
  parseSums,
} from "../scripts/check-channel-version.mjs";
import { badgeValues, formatCount } from "../scripts/readme-badges.mjs";
import {
  compareFinalVersions,
  isReleaseTag,
  newestFinalVersion,
  releaseTagVersion,
} from "../scripts/release-tag.mjs";
import {
  ChannelServer,
  GhStub,
  type GhState,
  PROCESS_TEST_TIMEOUT_MS,
  REPO_ROOT,
  REPOSITORY,
  TempDirs,
  findExecutable,
  git,
  isolatedEnv,
  runBash,
} from "./release-fixtures";

const scriptPath = (name: string) => join(REPO_ROOT, "scripts", name);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const sumsOf = (assets: Record<string, string>) =>
  Object.entries(assets)
    .map(([name, body]) => `${sha256(body)}  ${name}`)
    .join("\n");
const manifest = (...versions: string[]) =>
  `${JSON.stringify({
    addons: { "citegeist@opusvita.org": { updates: versions.map((version) => ({ version })) } },
  })}\n`;

const ASSETS = { "citegeist-3.0.0.xpi": "the 3.0.0 XPI", "update.json": manifest("3.0.0") };
const OTHER_ASSETS = { "citegeist-3.0.0.xpi": "another XPI", "update.json": manifest("3.0.0") };
const SUMS = sumsOf(ASSETS);

const GNU_SHA256SUM = /GNU coreutils/.test(
  spawnSync("sha256sum", ["--version"], { encoding: "utf8" }).stdout ?? "",
);
const SHASUM = findExecutable("shasum");
// Where neither checksum tool exists these skip locally, and fail on CI, so CI always runs them.
const CAN_CHECK_SUMS = GNU_SHA256SUM || SHASUM !== undefined || Boolean(process.env.CI);

const temp = new TempDirs();
afterEach(() => temp.removeAll());

function writeAssets(dir: string, assets: Record<string, string> = ASSETS): string {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(assets)) writeFileSync(join(dir, name), body);
  return dir;
}

describe("release tag grammar and version order (scripts/release-tag.mjs)", () => {
  it("accepts vMAJOR.MINOR.PATCH and nothing else", () => {
    for (const tag of ["v3.0.0", "v0.1.0", "v10.20.30", "v12345678901.0.0"]) {
      expect(isReleaseTag(tag), tag).toBe(true);
    }
    for (const tag of [
      "3.0.0",
      "v3.0",
      "v3.0.0.1",
      "v03.0.0",
      "v3.00.0",
      "v3.0.0-rc.1",
      "v3.0.0-alpha.0",
      "v3.0.0+b",
      "v3.0.0 ",
      " v3.0.0",
      "v3.0.0\n",
      "V3.0.0",
      "",
      undefined,
      3,
    ]) {
      expect(isReleaseTag(tag), JSON.stringify(tag)).toBe(false);
    }
    expect(releaseTagVersion("v3.0.0")).toBe("3.0.0");
    expect(() => releaseTagVersion("v3.0.0-rc.1")).toThrow(
      /is not a release tag.*docs\/RELEASE-CHECKLIST\.md, section 5/,
    );
  });

  it("orders versions numerically, whichever part differs, in both directions", () => {
    const newerOlder = [
      ["3.1.0", "3.0.9"],
      ["2.10.0", "2.9.0"],
      ["3.0.10", "3.0.9"],
      ["4.0.0", "3.99.99"],
      ["10.0.0", "9.0.0"],
      ["3.0.1", "3.0.0"],
      ["100000000000.0.0", "99999999999.0.0"],
    ];
    for (const [newer, older] of newerOlder) {
      expect(compareFinalVersions(newer, older), `${newer} is newer than ${older}`).toBe(1);
      expect(compareFinalVersions(older, newer), `${older} is older than ${newer}`).toBe(-1);
    }
    expect(compareFinalVersions("3.0.0", "3.0.0")).toBe(0);
    expect(newestFinalVersion(["2.9.0", "2.10.0", "2.0.6"])).toBe("2.10.0");
    expect(() => compareFinalVersions("3.0.0-alpha.0", "3.0.0")).toThrow(/MAJOR\.MINOR\.PATCH/);
  });
});

describe("asset verification (scripts/verify-release-assets.sh)", () => {
  /** `sums` null runs the script with no SUMS variable at all. */
  const verify = (dir: string, sums: string | null = SUMS) =>
    runBash(
      scriptPath("verify-release-assets.sh"),
      [dir],
      isolatedEnv(dir, sums === null ? {} : { SUMS: sums }),
      dir,
    );
  const fresh = () => writeAssets(join(temp.make("assets"), "assets"));

  it.skipIf(!CAN_CHECK_SUMS)(
    "passes exactly the recorded files, and fails any other set or any changed byte",
    () => {
      expect(verify(fresh()).status, "the recorded assets").toBe(0);
      expect(
        verify(fresh(), sumsOf({ "citegeist-3.0.0.xpi": ASSETS["citegeist-3.0.0.xpi"] })).status,
        "update.json missing from SUMS",
      ).not.toBe(0);
      expect(verify(fresh(), "").status, "empty SUMS").not.toBe(0);
      expect(verify(fresh(), null).status, "no SUMS").not.toBe(0);
      const malformed = verify(fresh(), SUMS.replace("  ", " "));
      expect(malformed.status, "a malformed line").not.toBe(0);
      expect(malformed.stdout, "a malformed line names the cause").toContain(
        'SUMS has a line that is not "<sha256>  <file name>"',
      );
      expect(
        verify(fresh(), `${SUMS}\n${SUMS.split("\n")[1]}`).status,
        "a file listed twice",
      ).not.toBe(0);

      const changes: [string, (dir: string) => void][] = [
        ["an extra file", (dir) => writeFileSync(join(dir, "extra.js"), "")],
        ["an extra dotfile", (dir) => writeFileSync(join(dir, ".hidden"), "")],
        [
          "a changed update.json",
          (dir) => writeFileSync(join(dir, "update.json"), manifest("3.0.1")),
        ],
        ["a missing update.json", (dir) => rmSync(join(dir, "update.json"))],
        [
          "a directory in place of update.json",
          (dir) => {
            rmSync(join(dir, "update.json"));
            mkdirSync(join(dir, "update.json"));
          },
        ],
        [
          "a symlink in place of update.json",
          (dir) => {
            const real = join(temp.make("elsewhere"), "update.json");
            writeFileSync(real, ASSETS["update.json"]);
            rmSync(join(dir, "update.json"));
            symlinkSync(real, join(dir, "update.json"));
          },
        ],
        [
          "no files",
          (dir) => {
            for (const name of Object.keys(ASSETS)) rmSync(join(dir, name));
          },
        ],
      ];
      for (const [label, change] of changes) {
        const dir = fresh();
        change(dir);
        expect(verify(dir).status, label).not.toBe(0);
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  /** A bin directory holding only the named tools from PATH, plus any files given. */
  function binWith(tools: string[], files: Record<string, string> = {}): string {
    const bin = join(temp.make("bin"), "bin");
    mkdirSync(bin);
    for (const tool of tools) {
      const path = findExecutable(tool);
      if (!path) throw new Error(`${tool} is not on PATH`);
      symlinkSync(path, join(bin, tool));
    }
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(bin, name), body, { mode: 0o755 });
    }
    return bin;
  }

  it("fails, rather than passing unchecked, when neither GNU sha256sum nor shasum exists", () => {
    const dir = fresh();
    const result = runBash(
      scriptPath("verify-release-assets.sh"),
      [dir],
      { ...isolatedEnv(dir, { SUMS }), PATH: binWith(["sort", "sed", "grep"]) },
      dir,
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Neither GNU sha256sum nor shasum");
  });

  it.skipIf(SHASUM === undefined && !process.env.CI)(
    "checks with shasum where sha256sum is not GNU's",
    () => {
      const bin = binWith(["sort", "sed", "grep", "shasum"], {
        sha256sum: "#!/bin/sh\necho 'sha256sum (Darwin) 1.0'\nexit 1\n",
      });
      const run = (dir: string) =>
        runBash(
          scriptPath("verify-release-assets.sh"),
          [dir],
          { ...isolatedEnv(dir, { SUMS }), PATH: `${bin}:/usr/bin:/bin` },
          dir,
        );
      expect(run(fresh()).status).toBe(0);
      const tampered = fresh();
      writeFileSync(join(tampered, "update.json"), manifest("3.0.1"));
      expect(run(tampered).status).not.toBe(0);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("channel check decisions (scripts/check-channel-version.mjs)", () => {
  const live = (versions: string[]) => {
    const body = manifest(...versions);
    return { manifest: JSON.parse(body), liveSha256: sha256(body) };
  };

  it("advances past a channel whose newest version is older, comparing each part numerically", () => {
    const cases: [string, string[]][] = [
      ["3.0.0", ["2.0.6"]],
      ["2.0.10", ["2.0.9"]],
      ["3.1.0", ["3.0.9"]],
      ["2.10.0", ["2.9.0"]],
      ["3.0.1", ["2.0.6", "3.0.0"]],
    ];
    for (const [version, listed] of cases) {
      const result = assessLiveChannel({ version, ...live(listed), verifiedSha256: "unused" });
      expect(result.state, `${version} over ${listed.join(", ")}`).toBe("advance");
    }
  });

  it("refuses a version older than the channel's newest, whichever part differs", () => {
    const cases: [string, string[], string][] = [
      ["2.0.9", ["2.0.10"], "2.0.10"],
      ["3.0.9", ["3.1.0"], "3.1.0"],
      ["2.9.0", ["2.10.0"], "2.10.0"],
      ["3.0.0", ["2.0.6", "3.0.1"], "3.0.1"],
      ["3.0.0", ["3.0.1", "2.0.6"], "3.0.1"],
    ];
    for (const [version, listed, newest] of cases) {
      expect(
        () => assessLiveChannel({ version, ...live(listed), verifiedSha256: "unused" }),
        `${version} under ${listed.join(", ")}`,
      ).toThrow(`${version} is older than ${newest}`);
    }
  });

  it("is current only when the channel serves this version from the verified update.json, byte for byte", () => {
    const body = manifest("3.0.0");
    const verifiedSha256 = sha256(body);
    expect(assessLiveChannel({ version: "3.0.0", ...live(["3.0.0"]), verifiedSha256 }).state).toBe(
      "current",
    );
    expect(() =>
      assessLiveChannel({
        version: "3.0.0",
        manifest: JSON.parse(body),
        liveSha256: sha256(`${body} `),
        verifiedSha256,
      }),
    ).toThrow("other than the one this run verified");
  });

  it("refuses a version or a channel it cannot compare", () => {
    const verifiedSha256 = "unused";
    expect(() =>
      assessLiveChannel({ version: "3.0.0-rc.1", ...live(["2.0.5"]), verifiedSha256 }),
    ).toThrow(/MAJOR\.MINOR\.PATCH/);
    expect(() =>
      assessLiveChannel({ version: "3.0.0", ...live(["3.0.0-rc.1"]), verifiedSha256 }),
    ).toThrow(/MAJOR\.MINOR\.PATCH/);
    expect(() => assessLiveChannel({ version: "3.0.0", ...live([]), verifiedSha256 })).toThrow(
      /no versions/,
    );
    expect(() =>
      assessLiveChannel({ version: "3.0.0", manifest: {}, liveSha256: "", verifiedSha256 }),
    ).toThrow(/no addons/);
  });

  it("starts a missing channel, and restores a missing update.json only from this tag's published, verified, newest release", () => {
    expect(assessMissingChannel({ version: "3.0.0", channelReleaseExists: false }).state).toBe(
      "first",
    );
    const repair = {
      version: "3.0.0",
      channelReleaseExists: true,
      release: { isDraft: false, assetsVerified: true },
      publishedVersions: ["2.0.6", "3.0.0"],
    };
    expect(assessMissingChannel(repair).state).toBe("repair");
    const refusals: [Partial<typeof repair> & { release?: unknown }, string][] = [
      [{ release: null as unknown as typeof repair.release }, "release v3.0.0 does not exist yet"],
      [{ release: { isDraft: true, assetsVerified: true } }, "release v3.0.0 is still a draft"],
      [{ release: { isDraft: false, assetsVerified: false } }, "carries assets other than"],
      [{ publishedVersions: ["3.0.0", "3.0.10"] }, "3.0.10 is a newer published release"],
    ];
    for (const [change, reason] of refusals) {
      const message = (() => {
        try {
          assessMissingChannel({ ...repair, ...change } as typeof repair);
          return "did not throw";
        } catch (error) {
          return (error as Error).message;
        }
      })();
      expect(message, reason).toContain(reason);
      expect(message, reason).toContain("gh release upload release <update.json> --clobber");
    }
  });

  it("reads SUMS strictly", () => {
    expect(parseSums(SUMS)).toEqual(
      new Map([
        ["citegeist-3.0.0.xpi", sha256(ASSETS["citegeist-3.0.0.xpi"])],
        ["update.json", sha256(ASSETS["update.json"])],
      ]),
    );
    expect(() => parseSums("")).toThrow(/no asset digests/);
    expect(() => parseSums(SUMS.replace("  ", " "))).toThrow(/is not/);
    expect(() => parseSums(`${SUMS}\n${SUMS.split("\n")[1]}`)).toThrow(/twice/);
  });
});

describe("channel check CLI (scripts/check-channel-version-cli.mjs)", () => {
  const dirs = new TempDirs();
  const CLI = scriptPath("check-channel-version-cli.mjs");
  const RELEASE_CHANNEL = { release: { isDraft: false, assets: {} } };
  let dir = "";
  let server: ChannelServer;
  let gh: GhStub;

  beforeAll(async () => {
    dir = dirs.make("channel");
    server = new ChannelServer(dir);
    await server.start();
    gh = new GhStub(dir);
  }, PROCESS_TEST_TIMEOUT_MS);

  afterAll(() => {
    server.stop();
    dirs.removeAll();
  });

  function check({
    channel,
    state = {},
    sums = SUMS,
    cli = CLI,
    args,
  }: {
    channel?: string;
    state?: GhState;
    sums?: string;
    cli?: string;
    args?: string[];
  } = {}) {
    server.reset();
    if (channel !== undefined) server.serve("/update.json", 200, channel);
    gh.reset(state);
    const output = join(dir, "github-output");
    writeFileSync(output, "");
    const result = spawnSync(
      process.execPath,
      [cli, ...(args ?? ["3.0.0", `${server.url}/update.json`])],
      {
        encoding: "utf8",
        env: isolatedEnv(
          dir,
          { ...gh.env(), SUMS: sums, GH_REPO: REPOSITORY, GITHUB_OUTPUT: output },
          [gh.bin],
        ),
      },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      output: readFileSync(output, "utf8"),
      writes: gh.writes(),
    };
  }

  it(
    "exits 1 without both arguments",
    () => {
      expect(check({ args: [] }).status).toBe(1);
      expect(check({ args: ["3.0.0"] }).status).toBe(1);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "reads the live channel: newer passes, older refuses, equal passes only with the verified bytes",
    () => {
      expect(check({ channel: manifest("2.0.6") })).toMatchObject({
        status: 0,
        output: "state=advance\n",
      });
      const older = check({ channel: manifest("3.0.1") });
      expect(older).toMatchObject({ status: 1, output: "" });
      expect(older.stdout).toContain("3.0.0 is older than 3.0.1");
      expect(check({ channel: ASSETS["update.json"] })).toMatchObject({
        status: 0,
        output: "state=current\n",
      });
      const differentBytes = check({ channel: `${ASSETS["update.json"]}\n` });
      expect(differentBytes).toMatchObject({ status: 1, output: "" });
      expect(differentBytes.stdout).toContain("other than the one this run verified");
      expect(check({ channel: "<html>not the channel</html>" })).toMatchObject({
        status: 1,
        output: "",
      });
      expect(check({ channel: manifest("2.0.6"), sums: sumsOf({ "a.xpi": "x" }) }).status).toBe(1);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "tolerates a missing update.json only as the first release, or as a repair it is allowed to make",
    () => {
      const published = { ...RELEASE_CHANNEL, "v3.0.0": { isDraft: false, assets: ASSETS } };
      const refused = (state: GhState, reason: string) => {
        const result = check({ state });
        expect(result, reason).toMatchObject({ status: 1, output: "" });
        expect(result.stdout, reason).toContain(reason);
      };

      expect(check({ state: {} })).toMatchObject({ status: 0, output: "state=first\n" });
      refused({ releases: RELEASE_CHANNEL }, "release v3.0.0 does not exist yet");
      if (CAN_CHECK_SUMS) {
        expect(check({ state: { releases: published } })).toMatchObject({
          status: 0,
          output: "state=repair\n",
        });
        expect(
          check({
            state: { releases: { ...published, "v9.0.0": { isDraft: true, assets: ASSETS } } },
          }),
          "a newer draft does not count",
        ).toMatchObject({ status: 0, output: "state=repair\n" });
        refused(
          {
            releases: { ...RELEASE_CHANNEL, "v3.0.0": { isDraft: false, assets: OTHER_ASSETS } },
          },
          "carries assets other than the ones this run verified",
        );
        refused(
          { releases: { ...published, "v3.0.1": { isDraft: false, assets: {} } } },
          "3.0.1 is a newer published release",
        );
      }
      refused(
        { releases: { ...RELEASE_CHANNEL, "v3.0.0": { isDraft: true, assets: ASSETS } } },
        "still a draft",
      );
      refused(
        { failRelease: "HTTP 502: Bad Gateway" },
        "Could not tell whether release release exists",
      );
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "never writes to a release",
    () => {
      for (const state of [
        {},
        { releases: RELEASE_CHANNEL },
        { releases: { ...RELEASE_CHANNEL, "v3.0.0": { isDraft: false, assets: ASSETS } } },
      ]) {
        expect(check({ state }).writes).toEqual([]);
        expect(check({ state, channel: manifest("2.0.6") }).writes).toEqual([]);
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "runs the check through a symlinked path",
    () => {
      const linked = join(dir, "check-channel-version-cli-link.mjs");
      symlinkSync(CLI, linked);
      expect(check({ cli: linked, channel: manifest("3.0.1") })).toMatchObject({ status: 1 });
      expect(check({ cli: linked, channel: manifest("2.0.6") })).toMatchObject({
        status: 0,
        output: "state=advance\n",
      });
      expect(check({ cli: linked, args: [] }).status).toBe(1);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("versioned release (scripts/publish-versioned-release.sh)", () => {
  function setup(state: GhState) {
    const dir = temp.make("versioned-release");
    const assets = writeAssets(join(dir, "assets"));
    const gh = new GhStub(dir, state);
    const run = () =>
      runBash(
        scriptPath("publish-versioned-release.sh"),
        ["v3.0.0", assets],
        isolatedEnv(dir, { ...gh.env(), SUMS, GH_REPO: REPOSITORY }, [gh.bin]),
        dir,
      );
    return { assets, gh, run };
  }
  const create = (assets: string) => [
    "release",
    "create",
    "v3.0.0",
    join(assets, "citegeist-3.0.0.xpi"),
    join(assets, "update.json"),
    "--verify-tag",
    "--generate-notes",
    "--title",
    "v3.0.0",
  ];

  it.skipIf(!CAN_CHECK_SUMS)(
    "creates the release from the verified assets when none exists",
    () => {
      const { assets, gh, run } = setup({});
      const result = run();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(gh.writes()).toEqual([create(assets)]);
      expect(gh.state().releases?.["v3.0.0"]).toMatchObject({ isDraft: false, assets: ASSETS });
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it.skipIf(!CAN_CHECK_SUMS)(
    "leaves a published release with the verified assets, and refuses one with any other, changing nothing",
    () => {
      const same = setup({ releases: { "v3.0.0": { isDraft: false, assets: ASSETS } } });
      expect(same.run().status).toBe(0);
      expect(same.gh.writes()).toEqual([]);

      for (const assets of [OTHER_ASSETS, { "update.json": ASSETS["update.json"] }, {}]) {
        const other = setup({ releases: { "v3.0.0": { isDraft: false, assets } } });
        const result = other.run();
        expect(result.status, JSON.stringify(assets)).toBe(1);
        expect(result.stdout).toContain("A published release is never changed");
        expect(other.gh.writes(), JSON.stringify(assets)).toEqual([]);
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it.skipIf(!CAN_CHECK_SUMS)(
    "publishes a draft that carries the verified assets",
    () => {
      const { gh, run } = setup({ releases: { "v3.0.0": { isDraft: true, assets: ASSETS } } });
      expect(run().status).toBe(0);
      expect(gh.writes()).toEqual([["release", "edit", "v3.0.0", "--draft=false"]]);
      expect(gh.state().releases?.["v3.0.0"]).toMatchObject({ isDraft: false, assets: ASSETS });
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it.skipIf(!CAN_CHECK_SUMS)(
    "replaces a draft whose assets are not the verified ones",
    () => {
      for (const draftAssets of [OTHER_ASSETS, {}]) {
        const { assets, gh, run } = setup({
          releases: { "v3.0.0": { isDraft: true, assets: draftAssets } },
        });
        expect(run().status, JSON.stringify(draftAssets)).toBe(0);
        expect(gh.writes()).toEqual([["release", "delete", "v3.0.0", "--yes"], create(assets)]);
        expect(gh.state().releases?.["v3.0.0"]).toMatchObject({ isDraft: false, assets: ASSETS });
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it.skipIf(!CAN_CHECK_SUMS)(
    "refuses when gh cannot say whether the release exists, or the local assets are not the verified ones",
    () => {
      const failing = setup({ failRelease: "HTTP 502: Bad Gateway" });
      expect(failing.run().status).toBe(1);
      expect(failing.gh.writes()).toEqual([]);

      const tampered = setup({});
      writeFileSync(join(tampered.assets, "update.json"), manifest("3.0.1"));
      expect(tampered.run().status).not.toBe(0);
      expect(tampered.gh.calls()).toEqual([]);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("update channel upload (scripts/publish-update-channel.sh)", () => {
  function setup(state: GhState, name = "update.json", body = manifest("3.0.0")) {
    const dir = temp.make("update-channel");
    mkdirSync(join(dir, "out"));
    const file = join(dir, "out", name);
    writeFileSync(file, body);
    const gh = new GhStub(dir, state);
    const run = () =>
      runBash(
        scriptPath("publish-update-channel.sh"),
        [file],
        isolatedEnv(dir, { ...gh.env(), GH_REPO: REPOSITORY }, [gh.bin]),
        dir,
      );
    return { file, gh, run };
  }

  it(
    "creates the channel release, not marked latest, when it does not exist, then uploads update.json",
    () => {
      const { file, gh, run } = setup({});
      const result = run();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(gh.writes()).toEqual([
        [
          "release",
          "create",
          "release",
          "--title",
          "Auto-update channel",
          "--latest=false",
          "--notes",
          expect.stringContaining("Serves update.json"),
        ],
        ["release", "upload", "release", file, "--clobber"],
      ]);
      expect(gh.state().releases?.release?.assets).toEqual({ "update.json": manifest("3.0.0") });
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "only uploads when the channel release exists",
    () => {
      const { file, gh, run } = setup({
        releases: { release: { isDraft: false, assets: { "update.json": manifest("2.0.6") } } },
      });
      expect(run().status).toBe(0);
      expect(gh.writes()).toEqual([["release", "upload", "release", file, "--clobber"]]);
      expect(gh.state().releases?.release?.assets).toEqual({ "update.json": manifest("3.0.0") });
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "refuses when gh cannot say whether the channel exists, a file not named update.json, and an empty file",
    () => {
      const failing = setup({ failRelease: "HTTP 502: Bad Gateway" });
      expect(failing.run().status).toBe(1);
      expect(failing.gh.writes()).toEqual([]);

      for (const [name, body] of [
        ["channel.json", manifest("3.0.0")],
        ["update.json", ""],
      ]) {
        const refused = setup({}, name, body);
        expect(refused.run().status, name).toBe(1);
        expect(refused.gh.calls(), name).toEqual([]);
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("README badges (scripts/readme-badges.mjs)", () => {
  const releases = () => {
    const list: unknown[] = Array.from({ length: 150 }, (_, i) => ({
      tag_name: `v2.${i}.0`,
      draft: false,
      assets: [
        { name: `citegeist-2.${i}.0.xpi`, download_count: 10 },
        { name: "update.json", download_count: 1000 },
      ],
    }));
    list.push(
      { tag_name: "v9.9.9", draft: true, assets: [] },
      { tag_name: "v3.0.0-rc.1", draft: false, assets: [] },
      { tag_name: "release", draft: false, assets: [{ name: "update.json", download_count: 99 }] },
    );
    return [list.slice(0, 100), list.slice(100)];
  };

  it("counts every page's XPI downloads and shows the newest published final version", () => {
    expect(badgeValues(releases())).toEqual({
      release: { schemaVersion: 1, label: "release", message: "v2.149.0", color: "5a9cff" },
      downloads: { schemaVersion: 1, label: "downloads", message: "1.5k", color: "30d158" },
    });
  });

  it("formats counts, and refuses input it cannot read", () => {
    expect([0, 999, 1000, 1500, 1_500_000].map(formatCount)).toEqual([
      "0",
      "999",
      "1.0k",
      "1.5k",
      "1.5M",
    ]);
    expect(() => badgeValues([[{ tag_name: "v3.0.0", draft: true, assets: [] }]])).toThrow(
      /no published/,
    );
    expect(() => badgeValues([{ tag_name: "v3.0.0" }])).toThrow(/array of pages/);
  });

  it(
    "writes both badge files from the CLI, and exits 1 on bad input",
    () => {
      const dir = temp.make("badges");
      const input = join(dir, "releases.json");
      writeFileSync(input, JSON.stringify(releases()));
      const cli = (...args: string[]) =>
        spawnSync(process.execPath, [scriptPath("readme-badges-cli.mjs"), ...args], {
          encoding: "utf8",
        }).status;
      expect(cli(input, join(dir, "out"))).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, "out/badge-release.json"), "utf8")).message).toBe(
        "v2.149.0",
      );
      expect(JSON.parse(readFileSync(join(dir, "out/badge-downloads.json"), "utf8")).message).toBe(
        "1.5k",
      );
      writeFileSync(input, "not json");
      expect(cli(input, join(dir, "out"))).toBe(1);
      expect(cli()).toBe(1);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("npm run release preflight (scripts/release-preflight.mjs)", () => {
  const FILES = {
    "CHANGELOG.md": "# Changelog\n",
    "CITATION.cff": "version: 3.0.0\n",
    "package.json": '{"version":"3.0.0-alpha.0"}\n',
    "src.ts": "export {};\n",
  };

  function repo(files: Record<string, string> = FILES) {
    const dir = temp.make("preflight");
    const env = isolatedEnv(dir);
    git(dir, env, "init", "--quiet");
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    git(dir, env, "add", "--all");
    git(dir, env, "commit", "--quiet", "-m", "start");
    const preflight = () =>
      spawnSync(process.execPath, [scriptPath("release-preflight.mjs")], {
        cwd: dir,
        env,
        encoding: "utf8",
      });
    return { dir, g: (...args: string[]) => git(dir, env, ...args), preflight };
  }

  it(
    "passes a clean tree, release-note edits staged or not, and untracked files",
    () => {
      const { dir, g, preflight } = repo();
      expect(preflight().status).toBe(0);
      writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## 3.0.0\n");
      writeFileSync(join(dir, "CITATION.cff"), "version: 3.0.1\n");
      g("add", "CITATION.cff");
      writeFileSync(join(dir, "scratch.txt"), "untracked\n");
      expect(preflight().status).toBe(0);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "refuses a staged package.json change, an edit, or a deletion outside the release notes",
    () => {
      const cases: [string, (dir: string, g: (...args: string[]) => string) => void, string][] = [
        [
          "a staged package.json change",
          (dir, g) => {
            writeFileSync(join(dir, "package.json"), '{"version":"3.0.0"}\n');
            g("add", "package.json");
          },
          "package.json",
        ],
        [
          "an unstaged edit",
          (dir) => writeFileSync(join(dir, "src.ts"), "export const x = 1;\n"),
          "src.ts",
        ],
        ["a staged deletion", (_dir, g) => g("rm", "--quiet", "src.ts"), "src.ts"],
        ["an unstaged deletion", (dir) => rmSync(join(dir, "src.ts")), "src.ts"],
      ];
      for (const [label, change, path] of cases) {
        const { dir, g, preflight } = repo();
        change(dir, g);
        const result = preflight();
        expect(result.status, label).toBe(1);
        expect(result.stderr, label).toContain(path);
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "refuses a rename into a release-note file, naming the file it came from",
    () => {
      const { g, preflight } = repo({ "CITATION.cff": "version: 3.0.0\n", "notes.txt": "notes\n" });
      g("mv", "notes.txt", "CHANGELOG.md");
      const result = preflight();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("notes.txt");
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});

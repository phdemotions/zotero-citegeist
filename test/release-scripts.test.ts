/**
 * The scripts the Publish release workflow runs and `npm run release` runs, each the way it is run
 * for real: bash scripts under `bash --noprofile --norc -eo pipefail`, Node CLIs through spawnSync,
 * with gh replaced by a stub that fails where gh and GitHub fail, and the update channel served by
 * a local HTTP server that redirects the way github.com does.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  FETCH_DEFAULTS,
  assessLiveChannel,
  assessMissingChannel,
  checkChannel,
  parseSums,
  retryAfterMs,
} from "../scripts/check-channel-version.mjs";
import { badgeValues, formatCount } from "../scripts/readme-badges.mjs";
import {
  ChannelServer,
  GH_TOKEN,
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
const assetsFor = (version: string, xpi = `the ${version} XPI`) => ({
  [`citegeist-${version}.xpi`]: xpi,
  "update.json": manifest(version),
});

const ASSETS = assetsFor("3.0.0");
const OTHER_ASSETS = assetsFor("3.0.0", "another XPI");
const SUMS = sumsOf(ASSETS);
const API_VERSION = ["-H", "X-GitHub-Api-Version: 2022-11-28"];

const GNU_SHA256SUM = /GNU coreutils/.test(
  spawnSync("sha256sum", ["--version"], { encoding: "utf8" }).stdout ?? "",
);
const SHASUM = findExecutable("shasum");
// Where neither checksum tool exists these skip locally, and fail on CI, so CI always runs them.
const CAN_CHECK_SUMS = GNU_SHA256SUM || SHASUM !== undefined || Boolean(process.env.CI);

const temp = new TempDirs();
afterEach(() => temp.removeAll(), PROCESS_TEST_TIMEOUT_MS);

function writeAssets(dir: string, assets: Record<string, string> = ASSETS): string {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(assets)) writeFileSync(join(dir, name), body);
  return dir;
}

/** The message a call throws, or "did not throw". */
function thrown(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return (error as Error).message;
  }
  return "did not throw";
}

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

  it("advances past a channel whose newest version is older, including where text order says otherwise", () => {
    const cases: [string, string[]][] = [
      ["3.0.0", ["2.0.6"]],
      ["2.0.10", ["2.0.9"]],
      ["3.0.10", ["3.0.9"]],
      ["3.1.0", ["3.0.9"]],
      ["2.10.0", ["2.9.0"]],
      ["3.0.1", ["2.0.6", "3.0.0"]],
    ];
    for (const [version, listed] of cases) {
      const result = assessLiveChannel({ version, ...live(listed), verifiedSha256: "unused" });
      expect(result.state, `${version} over ${listed.join(", ")}`).toBe("advance");
    }
  });

  it("refuses a version older than the channel's newest, including where text order says otherwise", () => {
    const cases: [string, string[], string][] = [
      ["2.0.9", ["2.0.10"], "2.0.10"],
      ["3.0.9", ["3.0.10"], "3.0.10"],
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
  });

  it("says a release is complete, and spends no version, when the channel serves its own published bytes", () => {
    const published = manifest("3.0.0");
    const rebuilt = `${published} `;
    const asked: string[] = [];
    const message = thrown(() =>
      assessLiveChannel({
        version: "3.0.0",
        manifest: JSON.parse(published),
        liveSha256: sha256(published),
        verifiedSha256: sha256(rebuilt),
        publishedSha256: () => {
          asked.push("asked");
          return sha256(published);
        },
      }),
    );
    expect(message).toContain("Release v3.0.0 is already complete");
    expect(message).toContain("no version is spent");
    expect(message).not.toContain("next patch version");
    expect(asked).toEqual(["asked"]);

    for (const publishedSha256 of [() => sha256("a republished cap raise"), () => null]) {
      const other = thrown(() =>
        assessLiveChannel({
          version: "3.0.0",
          manifest: JSON.parse(published),
          liveSha256: sha256(published),
          verifiedSha256: sha256(rebuilt),
          publishedSha256,
        }),
      );
      expect(other).toContain("neither the one this run verified");
      expect(other).toContain("ship any change as the next patch version");
    }
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

  it("starts a channel only while nothing but this version has been published", () => {
    for (const publishedTags of [[], ["v3.0.0"]]) {
      expect(
        assessMissingChannel({ version: "3.0.0", channelReleaseExists: false, publishedTags })
          .state,
        publishedTags.join(","),
      ).toBe("first");
    }
    for (const publishedTags of [["v2.0.5"], ["v3.0.0", "v2.0.5"], ["some-other-release"]]) {
      expect(
        thrown(() =>
          assessMissingChannel({ version: "3.0.0", channelReleaseExists: false, publishedTags }),
        ),
        publishedTags.join(","),
      ).toContain("No channel Release exists, but other releases have been published");
    }
  });

  it("restores a missing update.json only from this version's published, verified, newest release", () => {
    const repair = {
      version: "3.0.9",
      channelReleaseExists: true,
      release: { isDraft: false, assetsVerified: true },
      publishedTags: ["release", "v2.0.6", "v3.0.9", "v3.0.8"],
    };
    expect(assessMissingChannel(repair).state).toBe("repair");
    const refusals: [Partial<typeof repair> & { release?: unknown }, string][] = [
      [{ release: null as unknown as typeof repair.release }, "release v3.0.9 does not exist yet"],
      [{ release: { isDraft: true, assetsVerified: true } }, "release v3.0.9 is still a draft"],
      [{ release: { isDraft: false, assetsVerified: false } }, "carries assets other than"],
      // Newer by number, older as text.
      [{ publishedTags: ["v3.0.9", "v3.0.10"] }, "3.0.10 is a newer published release"],
      [{ publishedTags: ["v3.0.9", "v3.10.0"] }, "3.10.0 is a newer published release"],
    ];
    for (const [change, reason] of refusals) {
      const message = thrown(() => assessMissingChannel({ ...repair, ...change } as typeof repair));
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

  it("waits as long as a 429's Retry-After asks, within a cap", () => {
    const options = { ...FETCH_DEFAULTS, retryDelayMs: 5_000, maxRetryAfterMs: 60_000 };
    expect(retryAfterMs("2", options)).toBe(2_000);
    expect(retryAfterMs("0", options)).toBe(0);
    expect(retryAfterMs("3600", options)).toBe(60_000);
    expect(retryAfterMs(null, options)).toBe(5_000);
    expect(retryAfterMs("soon", options)).toBe(5_000);
    const inTenSeconds = new Date(Date.now() + 10_000).toUTCString();
    expect(retryAfterMs(inTenSeconds, options)).toBeGreaterThan(8_000);
    expect(retryAfterMs(inTenSeconds, options)).toBeLessThanOrEqual(10_000);
    expect(retryAfterMs(new Date(Date.now() - 10_000).toUTCString(), options)).toBe(0);
  });
});

describe("channel check against GitHub (scripts/check-channel-version.mjs)", () => {
  const dirs = new TempDirs();
  const CLI = scriptPath("check-channel-version-cli.mjs");
  const RELEASE_CHANNEL = { release: { isDraft: false, assets: {} } };
  const FAST = { retryDelayMs: 20, clobberRetryDelayMs: 20, maxRetryAfterMs: 3_000 };
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
  }, PROCESS_TEST_TIMEOUT_MS);

  const environment = (variables: Record<string, string> = {}) =>
    isolatedEnv(dir, { ...gh.env(), GH_TOKEN, ...variables }, [gh.bin]);

  /** Runs the check in this process, with short waits. */
  async function checkHere({
    version = "3.0.0",
    state = {},
    sums = SUMS,
    env = environment(),
  }: {
    version?: string;
    state?: GhState;
    sums?: string;
    env?: Record<string, string>;
  } = {}) {
    gh.reset(state);
    try {
      const result = await checkChannel({
        version,
        url: `${server.url}/update.json`,
        sums,
        repository: REPOSITORY,
        env,
        fetchOptions: FAST,
      });
      return { ...result, error: "" };
    } catch (error) {
      return { state: "", message: "", error: (error as Error).message };
    }
  }

  /** Runs the CLI, the way Publish runs it, with the channel behind github.com's redirect. */
  function checkCli({
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
    if (channel !== undefined) server.serveRedirected("/update.json", 200, channel);
    gh.reset(state);
    const output = join(dir, "github-output");
    writeFileSync(output, "");
    const result = spawnSync(
      process.execPath,
      [cli, ...(args ?? ["3.0.0", `${server.url}/update.json`])],
      {
        encoding: "utf8",
        env: environment({ SUMS: sums, GH_REPO: REPOSITORY, GITHUB_OUTPUT: output }),
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
    "reads the live channel through github.com's redirect: newer passes, older refuses, equal passes only with the verified bytes",
    () => {
      expect(checkCli({ channel: manifest("2.0.6") })).toMatchObject({
        status: 0,
        output: "state=advance\n",
      });
      expect(server.requests()).toEqual(["/update.json", "/release-assets/update.json"]);
      const older = checkCli({ channel: manifest("3.0.1") });
      expect(older).toMatchObject({ status: 1, output: "" });
      expect(older.stdout).toContain("3.0.0 is older than 3.0.1");
      expect(checkCli({ channel: ASSETS["update.json"] })).toMatchObject({
        status: 0,
        output: "state=current\n",
      });
      const differentBytes = checkCli({ channel: `${ASSETS["update.json"]}\n` });
      expect(differentBytes).toMatchObject({ status: 1, output: "" });
      expect(differentBytes.stdout).toContain("neither the one this run verified");
      expect(checkCli({ channel: "<html>not the channel</html>" })).toMatchObject({
        status: 1,
        output: "",
      });
      expect(checkCli({ channel: manifest("2.0.6"), sums: sumsOf({ "a.xpi": "x" }) }).status).toBe(
        1,
      );
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "retries a 502 and a 429 after its Retry-After, and gives up after three tries",
    async () => {
      server.reset();
      server.serveSequence("/update.json", [
        { status: 502, body: "Bad Gateway" },
        { status: 200, body: manifest("2.0.6") },
      ]);
      expect(await checkHere()).toMatchObject({ state: "advance", error: "" });
      expect(server.requests()).toEqual(["/update.json", "/update.json"]);

      server.reset();
      server.serveSequence("/update.json", [
        { status: 429, body: "slow down", headers: { "retry-after": "1" } },
        { status: 200, body: manifest("2.0.6") },
      ]);
      const started = Date.now();
      expect(await checkHere()).toMatchObject({ state: "advance", error: "" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
      expect(server.requests()).toHaveLength(2);

      server.reset();
      server.serve("/update.json", 502, "Bad Gateway");
      expect((await checkHere()).error).toContain("returned HTTP 502");
      expect(server.requests()).toHaveLength(3);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "treats only GitHub's own 404 as a missing release, and fails on any other answer",
    async () => {
      server.reset();
      const channelPath = `repos/${REPOSITORY}/releases/tags/release`;
      const transient = await checkHere({
        state: { releases: RELEASE_CHANNEL, apiStatus: { [channelPath]: 502 } },
      });
      expect(transient.state).toBe("");
      expect(transient.error).toContain(
        "Could not tell whether the channel Release exists: HTTP 502",
      );

      const unreachable = await checkHere({
        state: { failApi: "error connecting to api.github.com" },
      });
      expect(unreachable.error).toContain("error connecting to api.github.com");

      // gh's wording is not GitHub's answer: a failure that says "not found" with no 404 behind it
      // is still a failure, never an absent release.
      const worded = await checkHere({ state: { failApi: "release not found" } });
      expect(worded.state).toBe("");
      expect(worded.error).toContain("Could not tell whether the channel Release exists");

      const { GH_TOKEN: _token, ...withoutToken } = environment();
      const unauthenticated = await checkHere({ env: withoutToken });
      expect(unauthenticated.error).toContain("populate the GH_TOKEN environment variable");

      for (const call of gh.calls()) {
        if (call[0] === "api") expect(call.slice(1, 3)).toEqual(API_VERSION);
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "starts the channel only while no other release has been published",
    async () => {
      server.reset();
      expect(await checkHere({ state: {} })).toMatchObject({ state: "first", error: "" });
      expect(
        await checkHere({ state: { releases: { "v3.0.0": { isDraft: false, assets: ASSETS } } } }),
      ).toMatchObject({ state: "first", error: "" });
      expect(
        await checkHere({ state: { releases: { "v2.0.5": { isDraft: true, assets: {} } } } }),
        "a draft was never published",
      ).toMatchObject({ state: "first", error: "" });
      const deleted = await checkHere({
        state: { releases: { "v2.0.5": { isDraft: false, assets: assetsFor("2.0.5") } } },
      });
      expect(deleted.state).toBe("");
      expect(deleted.error).toContain(
        "No channel Release exists, but other releases have been published (v2.0.5)",
      );
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "restores a missing update.json only from this version's published, verified, newest release",
    async () => {
      server.reset();
      const own = assetsFor("3.0.9");
      const sums = sumsOf(own);
      const published = { ...RELEASE_CHANNEL, "v3.0.9": { isDraft: false, assets: own } };
      const refused = async (state: GhState, reason: string) => {
        const result = await checkHere({ version: "3.0.9", sums, state });
        expect(result.state, reason).toBe("");
        expect(result.error, reason).toContain(reason);
      };

      await refused({ releases: RELEASE_CHANNEL }, "release v3.0.9 does not exist yet");
      await refused(
        { releases: { ...RELEASE_CHANNEL, "v3.0.9": { isDraft: true, assets: own } } },
        "release v3.0.9 is still a draft",
      );
      if (CAN_CHECK_SUMS) {
        expect(
          await checkHere({ version: "3.0.9", sums, state: { releases: published } }),
        ).toMatchObject({
          state: "repair",
          error: "",
        });
        expect(
          await checkHere({
            version: "3.0.9",
            sums,
            state: { releases: { ...published, "v9.0.0": { isDraft: true, assets: own } } },
          }),
          "a newer draft does not count",
        ).toMatchObject({ state: "repair", error: "" });
        await refused(
          {
            releases: {
              ...RELEASE_CHANNEL,
              "v3.0.9": { isDraft: false, assets: assetsFor("3.0.9", "another XPI") },
            },
          },
          "carries assets other than the ones this run verified",
        );
        // Newer by number, older as text.
        await refused(
          { releases: { ...published, "v3.0.10": { isDraft: false, assets: {} } } },
          "3.0.10 is a newer published release",
        );
        await refused(
          { releases: { ...published, "v3.10.0": { isDraft: false, assets: {} } } },
          "3.10.0 is a newer published release",
        );
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "reads a missing update.json once more while this version's release exists, as an upload in flight leaves it",
    async () => {
      server.reset();
      server.serveSequence("/update.json", [
        { status: 404, body: "Not Found" },
        { status: 200, body: ASSETS["update.json"] },
      ]);
      const published = { ...RELEASE_CHANNEL, "v3.0.0": { isDraft: false, assets: ASSETS } };
      expect(await checkHere({ state: { releases: published } })).toMatchObject({
        state: "current",
        error: "",
      });
      expect(server.requests()).toEqual(["/update.json", "/update.json"]);

      server.reset();
      server.serveSequence("/update.json", [
        { status: 404, body: "Not Found" },
        { status: 200, body: manifest("2.0.6") },
      ]);
      const absent = await checkHere({ state: { releases: RELEASE_CHANNEL } });
      expect(absent.error).toContain("release v3.0.0 does not exist yet");
      expect(server.requests(), "no release, so no second read").toEqual(["/update.json"]);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "says the release is complete when the channel serves this version's published update.json and this attempt rebuilt other bytes",
    async () => {
      server.reset();
      const publishedUpdate = manifest("3.0.0");
      server.serve("/update.json", 200, publishedUpdate);
      const rebuilt = assetsFor("3.0.0", "a rebuilt XPI");
      rebuilt["update.json"] = `${publishedUpdate} `;
      const complete = await checkHere({
        sums: sumsOf(rebuilt),
        state: { releases: { ...RELEASE_CHANNEL, "v3.0.0": { isDraft: false, assets: ASSETS } } },
      });
      expect(complete.error).toContain("Release v3.0.0 is already complete");
      expect(complete.error).not.toContain("next patch version");

      const republished = await checkHere({
        sums: sumsOf(rebuilt),
        state: {
          releases: {
            ...RELEASE_CHANNEL,
            "v3.0.0": {
              isDraft: false,
              assets: { ...ASSETS, "update.json": manifest("3.0.0", "9.9.9") },
            },
          },
        },
      });
      expect(republished.error).toContain("neither the one this run verified");
      expect(republished.error).toContain("next patch version");
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "never writes to a release",
    async () => {
      for (const state of [
        {},
        { releases: RELEASE_CHANNEL },
        { releases: { ...RELEASE_CHANNEL, "v3.0.0": { isDraft: false, assets: ASSETS } } },
      ]) {
        server.reset();
        await checkHere({ state });
        expect(gh.writes()).toEqual([]);
        server.serve("/update.json", 200, manifest("2.0.6"));
        await checkHere({ state });
        expect(gh.writes()).toEqual([]);
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "exits 1 without both arguments, and runs the check through a symlinked path",
    () => {
      expect(checkCli({ args: [] }).status).toBe(1);
      expect(checkCli({ args: ["3.0.0"] }).status).toBe(1);
      const linked = join(dir, "check-channel-version-cli-link.mjs");
      symlinkSync(CLI, linked);
      expect(checkCli({ cli: linked, channel: manifest("3.0.1") })).toMatchObject({ status: 1 });
      expect(checkCli({ cli: linked, channel: manifest("2.0.6") })).toMatchObject({
        status: 0,
        output: "state=advance\n",
      });
      expect(checkCli({ cli: linked, args: [] }).status).toBe(1);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("versioned release (scripts/publish-versioned-release.sh)", () => {
  function setup(state: GhState, { token = true } = {}) {
    const dir = temp.make("versioned-release");
    const assets = writeAssets(join(dir, "assets"));
    const gh = new GhStub(dir, state);
    const run = () =>
      runBash(
        scriptPath("publish-versioned-release.sh"),
        ["v3.0.0", assets],
        isolatedEnv(
          dir,
          { ...gh.env(), ...(token ? { GH_TOKEN } : {}), SUMS, GH_REPO: REPOSITORY },
          [gh.bin],
        ),
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
  const TAGGED = { tags: ["v3.0.0"] };

  it.skipIf(!CAN_CHECK_SUMS)(
    "creates the release from the verified assets when none exists, and only on a tag that exists",
    () => {
      const { assets, gh, run } = setup(TAGGED);
      const result = run();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(gh.writes()).toEqual([create(assets)]);
      expect(gh.state().releases?.["v3.0.0"]).toMatchObject({ isDraft: false, assets: ASSETS });
      for (const call of gh.calls().filter((entry) => entry[0] === "api")) {
        expect(call.slice(1)).toEqual(expect.arrayContaining(API_VERSION));
      }

      const untagged = setup({});
      const refused = untagged.run();
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("doesn't exist in the repo");
      expect(untagged.gh.state().releases ?? {}).toEqual({});
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it.skipIf(!CAN_CHECK_SUMS)(
    "leaves a published release with the verified assets, and refuses one with any other, changing nothing",
    () => {
      const same = setup({ ...TAGGED, releases: { "v3.0.0": { isDraft: false, assets: ASSETS } } });
      expect(same.run().status).toBe(0);
      expect(same.gh.writes()).toEqual([]);

      for (const assets of [OTHER_ASSETS, { "update.json": ASSETS["update.json"] }, {}]) {
        const other = setup({ ...TAGGED, releases: { "v3.0.0": { isDraft: false, assets } } });
        const result = other.run();
        expect(result.status, JSON.stringify(assets)).toBe(1);
        expect(result.stdout).toContain("A published release is never changed");
        expect(other.gh.writes(), JSON.stringify(assets)).toEqual([]);
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it.skipIf(!CAN_CHECK_SUMS)(
    "refuses a published release whose assets cannot be downloaded to check, changing nothing",
    () => {
      const { gh, run } = setup({
        ...TAGGED,
        releases: { "v3.0.0": { isDraft: false, assets: ASSETS } },
        failDownload: { "v3.0.0": "HTTP 502: Bad Gateway" },
      });
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Could not download published release v3.0.0's assets");
      expect(gh.writes()).toEqual([]);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it.skipIf(!CAN_CHECK_SUMS)(
    "publishes a draft that carries the verified assets",
    () => {
      const { gh, run } = setup({
        ...TAGGED,
        releases: { "v3.0.0": { isDraft: true, assets: ASSETS } },
      });
      expect(run().status).toBe(0);
      expect(gh.writes()).toEqual([["release", "edit", "v3.0.0", "--draft=false"]]);
      expect(gh.state().releases?.["v3.0.0"]).toMatchObject({ isDraft: false, assets: ASSETS });
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it.skipIf(!CAN_CHECK_SUMS)(
    "replaces a draft whose assets are not the verified ones, or cannot be downloaded",
    () => {
      const drafts: GhState[] = [
        { releases: { "v3.0.0": { isDraft: true, assets: OTHER_ASSETS } } },
        { releases: { "v3.0.0": { isDraft: true, assets: {} } } },
        {
          releases: { "v3.0.0": { isDraft: true, assets: ASSETS } },
          failDownload: { "v3.0.0": "HTTP 502: Bad Gateway" },
        },
      ];
      for (const draft of drafts) {
        const { assets, gh, run } = setup({ ...TAGGED, ...draft });
        const result = run();
        expect(result.status, JSON.stringify(draft) + result.stdout + result.stderr).toBe(0);
        expect(gh.writes()).toEqual([["release", "delete", "v3.0.0", "--yes"], create(assets)]);
        expect(gh.state().releases?.["v3.0.0"]).toMatchObject({ isDraft: false, assets: ASSETS });
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it.skipIf(!CAN_CHECK_SUMS)(
    "refuses when GitHub lists more than one release for the tag",
    () => {
      const { gh, run } = setup({
        ...TAGGED,
        releases: { "v3.0.0": { isDraft: true, assets: ASSETS } },
        extraReleases: [{ tag_name: "v3.0.0", draft: true, assets: [] }],
      });
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("GitHub lists 2 releases for v3.0.0");
      expect(gh.writes()).toEqual([]);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it.skipIf(!CAN_CHECK_SUMS)(
    "refuses when gh cannot list the releases or has no token, or the local assets are not the verified ones",
    () => {
      for (const failing of [
        setup({ ...TAGGED, failApi: "HTTP 502: Bad Gateway" }),
        setup(TAGGED, { token: false }),
      ]) {
        expect(failing.run().status).not.toBe(0);
        expect(failing.gh.writes()).toEqual([]);
      }

      const tampered = setup(TAGGED);
      writeFileSync(join(tampered.assets, "update.json"), manifest("3.0.1"));
      expect(tampered.run().status).not.toBe(0);
      expect(tampered.gh.calls()).toEqual([]);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("update channel upload (scripts/publish-update-channel.sh)", () => {
  function setup(
    state: GhState,
    { name = "update.json", body = manifest("3.0.0"), token = true } = {},
  ) {
    const dir = temp.make("update-channel");
    mkdirSync(join(dir, "out"));
    const file = join(dir, "out", name);
    writeFileSync(file, body);
    const gh = new GhStub(dir, state);
    const run = () =>
      runBash(
        scriptPath("publish-update-channel.sh"),
        [file],
        isolatedEnv(dir, { ...gh.env(), ...(token ? { GH_TOKEN } : {}), GH_REPO: REPOSITORY }, [
          gh.bin,
        ]),
        dir,
      );
    return { file, gh, run };
  }

  it(
    "creates the channel release, not marked latest, when GitHub answers 404, then uploads update.json",
    () => {
      const { file, gh, run } = setup({});
      const result = run();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(gh.calls()[0]).toEqual([
        "api",
        "--include",
        ...API_VERSION,
        `repos/${REPOSITORY}/releases/tags/release`,
      ]);
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
    "refuses, writing nothing, when GitHub answers anything but 200 or 404, gh cannot reach it, or gh has no token",
    () => {
      const channelPath = `repos/${REPOSITORY}/releases/tags/release`;
      for (const failing of [
        setup({ apiStatus: { [channelPath]: 502 } }),
        setup({ failApi: "error connecting to api.github.com" }),
        // gh's wording, with no 404 from GitHub behind it.
        setup({ failApi: "release not found" }),
        setup({}, { token: false }),
      ]) {
        const result = failing.run();
        expect(result.status).toBe(1);
        expect(result.stdout).toContain("Could not tell whether the release channel exists");
        expect(failing.gh.writes()).toEqual([]);
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "refuses a file not named update.json and an empty file",
    () => {
      for (const [name, body] of [
        ["channel.json", manifest("3.0.0")],
        ["update.json", ""],
      ]) {
        const refused = setup({}, { name, body });
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

describe("the release runbook", () => {
  it("has a section for every one a release script, a workflow or a .github file points to", () => {
    const runbook = readFileSync(join(REPO_ROOT, "docs/RELEASE-RUNBOOK.md"), "utf8");
    const headings = new Set(
      [...runbook.matchAll(/^#{2,3} (.+)$/gm)].map((match) => match[1].trim()),
    );
    const files = [
      ...readdirSync(join(REPO_ROOT, "scripts")).map((file) => join("scripts", file)),
      ...readdirSync(join(REPO_ROOT, ".github/workflows")).map((file) =>
        join(".github/workflows", file),
      ),
      ".github/CODEOWNERS",
      ".github/pull_request_template.md",
    ];
    const pointers = new Map<string, string>();
    for (const file of files) {
      // Joins a string a script splits across lines, so a section's name reads whole.
      const source = readFileSync(join(REPO_ROOT, file), "utf8").replace(/["`]\s*\+\s*["`]/g, "");
      for (const match of source.matchAll(
        /(?:RELEASE-RUNBOOK\.md|\$\{RUNBOOK\}),? \(?\\?"([^"\\]+)\\?"/g,
      )) {
        pointers.set(match[1], file);
      }
    }
    expect(pointers.size).toBeGreaterThanOrEqual(10);
    for (const [section, file] of pointers) {
      expect(headings.has(section), `${file} points to "${section}"`).toBe(true);
    }
  });
});

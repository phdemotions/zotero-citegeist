import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { fileURLToPath } from "url";
import pkg from "../package.json";
import {
  PLACEHOLDER_FILE_EXTENSIONS,
  assertNoUnreplacedPlaceholders,
  assertRangeShape,
  placeholdersFor,
  promoteStaging,
  readBuildMetadata,
  recoverInterruptedPromotion,
  renameWithRetry,
  replacePlaceholders,
  updateManifestFor,
  verifyBuiltAddon,
  verifyPackagedAddon,
  verifyUpdateManifest,
} from "../scripts/build-metadata.mjs";

const ADDON_SOURCE = fileURLToPath(new URL("../addon", import.meta.url));

// A fixed range, independent of what package.json carries today, so these tests
// keep their meaning when a later release moves the floor or the cap.
const FIXTURE_RANGE = { zoteroMinVersion: "7.0.10", zoteroMaxVersion: "10.0.*" };
const meta = readBuildMetadata(withConfig(FIXTURE_RANGE));

function withConfig(overrides: Record<string, string>) {
  return { ...pkg, config: { ...pkg.config, ...overrides } };
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

function thrownMessage(fn: () => unknown): string {
  return (thrown(fn) as Error).message;
}

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

/** Copies addon/ into a temporary directory, placeholders and all. */
function copyAddon(): string {
  const dir = tempDir("citegeist-addon-");
  cpSync(ADDON_SOURCE, dir, { recursive: true });
  return dir;
}

/**
 * Copies addon/ into a temporary directory, applies `edit` to that copy, then replaces
 * placeholders the way scripts/build.mjs does.
 */
function stageAddon(edit: (dir: string) => void = () => {}): string {
  const dir = copyAddon();
  edit(dir);
  replacePlaceholders(dir, placeholdersFor(meta));
  return dir;
}

function editFile(dir: string, path: string, change: (content: string) => string): void {
  const file = join(dir, path);
  writeFileSync(file, change(readFileSync(file, "utf8")));
}

/** Zips `dir`'s contents the way scripts/build.mjs does and returns the archive's path. */
function zipDirectory(dir: string): string {
  const xpi = join(tempDir("citegeist-xpi-test-"), "citegeist.xpi");
  execFileSync("zip", ["-q", "-r", xpi, "."], { cwd: dir });
  return xpi;
}

describe("build metadata", () => {
  it("uses package Zotero compatibility in placeholders and update manifest", () => {
    const realMeta = readBuildMetadata(pkg);
    const placeholders = placeholdersFor(realMeta);
    const update = updateManifestFor(realMeta, "citegeist-2.0.0.xpi", "abc123");
    const app = update.addons[realMeta.addonID].updates[0].applications.zotero;

    expect(placeholders.__zoteroMinVersion__).toBe(pkg.config.zoteroMinVersion);
    expect(placeholders.__zoteroMaxVersion__).toBe(pkg.config.zoteroMaxVersion);
    expect(app.strict_min_version).toBe(pkg.config.zoteroMinVersion);
    expect(app.strict_max_version).toBe(pkg.config.zoteroMaxVersion);
    expect(JSON.stringify(update)).not.toContain("__zotero");
  });

  const { zoteroMaxVersion: _dropped, ...configWithoutMax } = pkg.config;

  it.each([
    ["missing", configWithoutMax],
    ["empty", { ...pkg.config, zoteroMaxVersion: "" }],
    ["blank", { ...pkg.config, zoteroMaxVersion: "   " }],
  ])("fails fast when zoteroMaxVersion is %s", (_label, config) => {
    expect(() => readBuildMetadata({ ...pkg, config })).toThrow(
      "package.json config.zoteroMaxVersion must be a non-empty string",
    );
  });
});

describe("Zotero range shape", () => {
  it("accepts the range package.json declares", () => {
    expect(() => readBuildMetadata(pkg)).not.toThrow();
  });

  it.each([
    "9.*",
    "10",
    "10.*",
    "*",
    "99.*",
    // A patch in place of the wildcard, or no wildcard at all
    "10.0",
    "10.0.0",
    "10.0.5",
    // Text at either end
    "x10.0.*",
    "10.0.*x",
    // A leading zero, and ten digits, which can pass int32 and then read as 0
    "010.0.*",
    "9999999999.0.*",
  ])("rejects the cap %s", (cap) => {
    const message = thrownMessage(() => readBuildMetadata(withConfig({ zoteroMaxVersion: cap })));

    expect(message).toContain(
      'Zotero cap in package.json config must be major.minor.* such as "10.0.*"',
    );
    expect(message).toContain(`got ${JSON.stringify(cap)}`);
  });

  it.each([
    "8.*",
    "*",
    "v7.0.10",
    "7..0",
    "7.0.",
    "7.0.10x",
    "07.0.10",
    "7.0.9999999999",
    // Firefox's versionString allows at most four parts
    "7.0.10.1.2",
  ])("rejects the floor %s", (floor) => {
    const message = thrownMessage(() => readBuildMetadata(withConfig({ zoteroMinVersion: floor })));

    expect(message).toContain(
      'Zotero floor in package.json config must be up to four dotted numbers such as "7.0.10"',
    );
    expect(message).toContain(`got ${JSON.stringify(floor)}`);
  });

  // A single-minor range such as 10.0 to 10.0.* must stay possible. "10" equals "10.0" because a
  // missing part counts as 0, and the largest part the shape admits still sorts below "*".
  it.each(["7.0.10", "7.0.10.1", "10", "10.0", "10.0.0", "10.0.1", "10.0.999999999"])(
    "accepts the floor %s under the cap 10.0.*",
    (floor) => {
      const config = { zoteroMinVersion: floor, zoteroMaxVersion: "10.0.*" };

      expect(readBuildMetadata(withConfig(config)).zoteroMinVersion).toBe(floor);
    },
  );

  it.each(["10.1", "10.1.0", "11.0"])("rejects the floor %s, above the cap 10.0.*", (floor) => {
    const config = { zoteroMinVersion: floor, zoteroMaxVersion: "10.0.*" };

    expect(() => readBuildMetadata(withConfig(config))).toThrow(
      `Zotero floor ${floor} in package.json config is above the cap 10.0.*`,
    );
  });

  it("names the source it is given, so a range from another file reports that file", () => {
    const label = "release-lines.json line 2.0.6";

    expect(() => assertRangeShape({ min: "7.0.10", max: "10.*" }, label)).toThrow(
      `Zotero cap in ${label} must be major.minor.*`,
    );
    expect(() => assertRangeShape({ min: "8.*", max: "10.0.*" }, label)).toThrow(
      `Zotero floor in ${label} must be up to four dotted numbers`,
    );
    expect(() => assertRangeShape({ min: "7.0.10", max: "10.0.*" }, label)).not.toThrow();
  });
});

describe("package.json version shape", () => {
  it.each([
    "3.0.0",
    "0.1.0",
    "10.20.30",
    "3.0.0-alpha.0",
    "3.0.0-beta.2",
    "3.0.0-rc.1",
    "3.0.0-rc.10",
  ])("accepts the version %s", (version) => {
    expect(readBuildMetadata({ ...pkg, version }).version).toBe(version);
  });

  it.each([
    "3.0",
    "3.0.0.1",
    "v3.0.0",
    " 3.0.0",
    "03.0.0",
    // Firefox compares "rc2" as text, so it would sort above "rc10"
    "3.0.0-rc2",
    "3.0.0-rc",
    "3.0.0-rc.01",
    "3.0.0-RC.1",
    "3.0.0-pre.1",
    "3.0.0-rc.1.2",
    // Firefox reads a "+" as the next number's prerelease: "3.0.0+b" sorts as "3.0.1pre"
    "3.0.0+b",
  ])("rejects the version %s", (version) => {
    const message = thrownMessage(() => readBuildMetadata({ ...pkg, version }));

    expect(message).toContain(
      "package.json version must be major.minor.patch, optionally followed by -alpha.N, -beta.N or -rc.N",
    );
    expect(message).toContain(`got ${JSON.stringify(version)}`);
  });
});

describe("cap against the real-Zotero matrix", () => {
  const WORKFLOW = ".github/workflows/real-zotero.yml";

  /** The Zotero versions in the workflow's `zotero: [...]` matrix line. */
  function matrixVersions(): string[] {
    const workflow = readFileSync(new URL(`../${WORKFLOW}`, import.meta.url), "utf8");
    const matrixStart = workflow.search(/^\s*matrix:\s*$/m);
    const line =
      matrixStart === -1 ? null : workflow.slice(matrixStart).match(/^\s*zotero:\s*\[([^\]]*)\]/m);
    if (!line) {
      throw new Error(
        `${WORKFLOW} no longer declares its matrix as zotero: ["x.y.z", ...]; update this test to read it`,
      );
    }
    return [...line[1].matchAll(/"([^"]*)"/g)].map((match) => match[1]);
  }

  it("caps at the highest tested Zotero's major.minor: raise the real-Zotero matrix before raising the cap", () => {
    const versions = matrixVersions();
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }

    const [highest] = versions
      .map((version) => version.split(".").map(Number))
      .sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
    const expectedCap = `${highest[0]}.${highest[1]}.*`;
    const cap = pkg.config.zoteroMaxVersion;

    expect(
      cap,
      `package.json config.zoteroMaxVersion is ${cap}, but the highest Zotero ${WORKFLOW} runs is ` +
        `${highest.join(".")}, so the cap must be ${expectedCap}. Raise the real-Zotero matrix ` +
        `before raising the cap (KTD2); raise the cap with the matrix.`,
    ).toBe(expectedCap);
  });
});

describe("update.json verification", () => {
  it("leaves addon/manifest.json with placeholders and no literal version string", () => {
    const raw = readFileSync(join(ADDON_SOURCE, "manifest.json"), "utf8");
    const zotero = JSON.parse(raw).applications.zotero;

    expect(zotero.strict_min_version).toBe("__zoteroMinVersion__");
    expect(zotero.strict_max_version).toBe("__zoteroMaxVersion__");
    // A quoted dotted version such as "7.0.10", "9.*" or "10.0.*" bypasses package.json.
    expect(raw).not.toMatch(/"\d+(?:\.(?:\d+|\*))+"/);
  });

  it("carries a 10.0.* cap into the placeholder map and the built version's update.json entry", () => {
    const update = updateManifestFor(meta, `citegeist-${meta.version}.xpi`, "abc123");

    expect(placeholdersFor(meta).__zoteroMaxVersion__).toBe("10.0.*");
    expect(verifyUpdateManifest(update, meta)).toEqual({ min: "7.0.10", max: "10.0.*" });
  });

  it.each([
    ["cap", { zoteroMaxVersion: "9.*" }, "7.0.10 to 9.*"],
    ["floor", { zoteroMinVersion: "7.0.9" }, "7.0.9 to 10.0.*"],
  ])(
    "fails when the built version's update.json entry has a different %s, showing both ranges",
    (_label, staleRange, publishedRange) => {
      const update = updateManifestFor({ ...meta, ...staleRange }, "citegeist.xpi", "abc123");

      const message = thrownMessage(() => verifyUpdateManifest(update, meta));
      expect(message).toContain(
        `update.json entry for ${meta.version} declares Zotero ${publishedRange}`,
      );
      expect(message).toContain("package.json config gives 7.0.10 to 10.0.*");
    },
  );

  it.each(["first", "last"])(
    "checks the entry for the version being built when a stale line's entry comes %s",
    (position) => {
      const update = updateManifestFor(meta, "citegeist.xpi", "abc123");
      const staleLine = updateManifestFor(
        { ...meta, version: "2.0.6", zoteroMaxVersion: "9.*" },
        "citegeist-2.0.6.xpi",
        "def456",
      ).addons[meta.addonID].updates[0];
      const entries = update.addons[meta.addonID].updates;
      if (position === "first") entries.unshift(staleLine);
      else entries.push(staleLine);

      expect(entries.map((entry: { version: string }) => entry.version)).toEqual(
        position === "first" ? ["2.0.6", meta.version] : [meta.version, "2.0.6"],
      );
      expect(verifyUpdateManifest(update, meta).max).toBe("10.0.*");
    },
  );

  it("fails when update.json has no entry, or more than one, for the version being built", () => {
    const otherVersionOnly = updateManifestFor({ ...meta, version: "2.0.6" }, "old.xpi", "abc123");
    const duplicated = updateManifestFor(meta, "citegeist.xpi", "abc123");
    const entries = duplicated.addons[meta.addonID].updates;
    entries.push({ ...entries[0] });

    expect(() => verifyUpdateManifest(otherVersionOnly, meta)).toThrow(
      `exactly one entry for ${meta.addonID} ${meta.version}, found 0`,
    );
    expect(() => verifyUpdateManifest({}, meta)).toThrow("found 0");
    expect(() => verifyUpdateManifest(duplicated, meta)).toThrow("found 2");
  });
});

describe("verifyBuiltAddon", () => {
  it("returns the manifest's range for a clean build of addon/", () => {
    expect(verifyBuiltAddon(stageAddon(), meta)).toEqual({ min: "7.0.10", max: "10.0.*" });
  });

  it("fails when the built manifest is capped at 9.*, showing both ranges", () => {
    const dir = stageAddon();
    editFile(dir, "manifest.json", (content) => content.replace('"10.0.*"', '"9.*"'));

    const message = thrownMessage(() => verifyBuiltAddon(dir, meta));
    expect(message).toContain("manifest.json does not match package.json");
    expect(message).toContain(
      "Zotero range is 7.0.10 to 9.*, package.json config gives 7.0.10 to 10.0.*",
    );
  });

  it("fails on a misspelt placeholder in an .xhtml file, naming the file", () => {
    const dir = stageAddon((source) =>
      editFile(source, "content/preferences.xhtml", (content) =>
        content.replace("</", "<label>__zoteroMaxVerison__</label></"),
      ),
    );

    expect(() => verifyBuiltAddon(dir, meta)).toThrow(
      "Unreplaced build placeholders in shipped files:\n  content/preferences.xhtml: __zoteroMaxVerison__",
    );
  });

  it("skips a file with an unlisted extension containing a NUL byte, even when its bytes spell a placeholder", () => {
    const placeholderBytes = Buffer.from("__x__");
    const binary = stageAddon((source) =>
      writeFileSync(
        join(source, "content/icons/stray.png"),
        Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), placeholderBytes]),
      ),
    );
    // Positive control: the same bytes without the NUL are text, so the scan reads them.
    const text = stageAddon((source) =>
      writeFileSync(join(source, "content/icons/stray.png"), placeholderBytes),
    );

    expect(verifyBuiltAddon(binary, meta)).toEqual({ min: "7.0.10", max: "10.0.*" });
    expect(() => verifyBuiltAddon(text, meta)).toThrow("content/icons/stray.png: __x__");
  });

  it("fails on a NUL byte in a file with a listed extension, such as UTF-16 text, naming the file", () => {
    const dir = copyAddon();
    writeFileSync(
      join(dir, "locale/en-US/extra.ftl"),
      Buffer.from("extra = __addonName__", "utf16le"),
    );

    expect(() => replacePlaceholders(dir, placeholdersFor(meta))).toThrow(
      "locale/en-US/extra.ftl contains a NUL byte, so it is not UTF-8 text",
    );
    expect(() => verifyBuiltAddon(dir, meta)).toThrow(
      "locale/en-US/extra.ftl contains a NUL byte, so it is not UTF-8 text",
    );
  });

  it("fails on a placeholder in a text file whose extension the build never replaces, naming the list", () => {
    const dir = stageAddon((source) =>
      writeFileSync(join(source, "content/notes.txt"), "Built for __addonRef__"),
    );

    expect(readFileSync(join(dir, "content/notes.txt"), "utf8")).toContain("__addonRef__");
    const message = thrownMessage(() => verifyBuiltAddon(dir, meta));
    expect(message).toContain(
      `not in PLACEHOLDER_FILE_EXTENSIONS (${PLACEHOLDER_FILE_EXTENSIONS.join(", ")})`,
    );
    expect(message).toContain("content/notes.txt: __addonRef__");
    expect(message).not.toContain("Unreplaced build placeholders");
  });

  // Each placeholder addon/manifest.json uses, read from the file, so a new placeholder-backed
  // field fails here until verifyBuiltAddon checks its value.
  const manifestPlaceholders = [
    ...new Set(readFileSync(join(ADDON_SOURCE, "manifest.json"), "utf8").match(/__[A-Za-z]+__/g)),
  ];
  const misspellings: Array<[string, (token: string) => string]> = [
    ["a dropped underscore", (token) => token.slice(0, -1)],
    ["a capital", (token) => `__${token[2].toUpperCase()}${token.slice(3)}`],
    ["snake_case", (token) => token.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)],
  ];

  it("reads every placeholder-backed field from addon/manifest.json", () => {
    expect(manifestPlaceholders.sort()).toEqual(
      [
        "__addonID__",
        "__addonName__",
        "__buildVersion__",
        "__zoteroMaxVersion__",
        "__zoteroMinVersion__",
      ].sort(),
    );
  });

  it.each(
    manifestPlaceholders.flatMap((token) =>
      misspellings.map(([label, misspell]) => [token, label, misspell(token)]),
    ),
  )(
    "fails when manifest.json spells %s with %s (%s), which the scan's shape misses",
    (token, _label, misspelt) => {
      const dir = stageAddon((source) =>
        editFile(source, "manifest.json", (content) => content.replace(token, misspelt)),
      );

      const message = thrownMessage(() => verifyBuiltAddon(dir, meta));
      expect(message).toContain("manifest.json does not match package.json");
      expect(message).toContain(misspelt);
    },
  );
});

describe("verifyPackagedAddon", () => {
  it("returns the range of an XPI zipped from a verified build", () => {
    expect(verifyPackagedAddon(zipDirectory(stageAddon()), meta)).toEqual({
      min: "7.0.10",
      max: "10.0.*",
    });
  });

  it("fails on an XPI zipped from addon/ itself, whose placeholders were never replaced", () => {
    const xpi = zipDirectory(ADDON_SOURCE);

    const message = thrownMessage(() => verifyPackagedAddon(xpi, meta));
    expect(message).toContain(`The packaged XPI ${xpi} fails verification`);
    expect(message).toContain("Unreplaced build placeholders in shipped files");
    expect(message).toContain("manifest.json: __addonName__");
  });

  it("fails on an XPI whose manifest cap differs from package.json, showing both ranges", () => {
    const dir = stageAddon();
    editFile(dir, "manifest.json", (content) => content.replace('"10.0.*"', '"9.*"'));
    const xpi = zipDirectory(dir);

    const message = thrownMessage(() => verifyPackagedAddon(xpi, meta));
    expect(message).toContain(`The packaged XPI ${xpi} fails verification`);
    expect(message).toContain(
      "Zotero range is 7.0.10 to 9.*, package.json config gives 7.0.10 to 10.0.*",
    );
  });

  it("fails naming the file when it is not a zip archive", () => {
    const xpi = join(tempDir("citegeist-xpi-test-"), "citegeist.xpi");
    writeFileSync(xpi, "not a zip archive");

    expect(() => verifyPackagedAddon(xpi, meta)).toThrow(`Could not extract ${xpi} to verify it`);
  });
});

describe("promotion", () => {
  function layout() {
    const root = tempDir("citegeist-promote-");
    return {
      root,
      staging: join(root, ".addon-staging"),
      target: join(root, "addon"),
      previous: join(root, ".addon-previous"),
    };
  }

  function makeCopy(dir: string, marker: string): void {
    mkdirSync(dir);
    writeFileSync(join(dir, marker), marker);
  }

  function errorWithCode(code: string, message = code): NodeJS.ErrnoException {
    return Object.assign(new Error(message), { code });
  }

  /** A rename that records each move by base name, and throws `failWith` for the sources given. */
  function recordingRename(failWith: Map<string, Error> = new Map()) {
    const moves: string[] = [];
    const rename = (from: string, to: string) => {
      const failure = failWith.get(from);
      if (failure) throw failure;
      moves.push(`${basename(from)} -> ${basename(to)}`);
      renameSync(from, to);
    };
    return { moves, rename };
  }

  it("moves the old copy aside, moves staging in, and deletes the old copy only then", () => {
    const paths = layout();
    makeCopy(paths.target, "old.marker");
    makeCopy(paths.staging, "new.marker");
    const { moves, rename } = recordingRename();

    promoteStaging(paths, { rename, delayMs: 0 });

    expect(moves).toEqual(["addon -> .addon-previous", ".addon-staging -> addon"]);
    expect(readdirSync(paths.root)).toEqual(["addon"]);
    expect(readdirSync(paths.target)).toEqual(["new.marker"]);
  });

  it("moves staging in when there is no copy yet", () => {
    const paths = layout();
    makeCopy(paths.staging, "new.marker");
    const { moves, rename } = recordingRename();

    promoteStaging(paths, { rename, delayMs: 0 });

    expect(moves).toEqual([".addon-staging -> addon"]);
    expect(readdirSync(paths.root)).toEqual(["addon"]);
  });

  it("moves the old copy back and rethrows the original error when staging cannot move in", () => {
    const paths = layout();
    makeCopy(paths.target, "old.marker");
    makeCopy(paths.staging, "new.marker");
    const failure = errorWithCode("ENOSPC", "no space left on device");
    const { rename } = recordingRename(new Map([[paths.staging, failure]]));

    expect(thrown(() => promoteStaging(paths, { rename, delayMs: 0 }))).toBe(failure);
    expect(readdirSync(paths.root).sort()).toEqual([".addon-staging", "addon"]);
    expect(readdirSync(paths.target)).toEqual(["old.marker"]);
  });

  it("keeps the old copy aside and reports both errors when it cannot move back either, and the next build restores it", () => {
    const paths = layout();
    makeCopy(paths.target, "old.marker");
    makeCopy(paths.staging, "new.marker");
    const stagingFailure = errorWithCode("ENOSPC", "staging stuck");
    const restoreFailure = errorWithCode("ENOSPC", "restore stuck");
    const { rename } = recordingRename(
      new Map([
        [paths.staging, stagingFailure],
        [paths.previous, restoreFailure],
      ]),
    );

    const error = thrown(() => promoteStaging(paths, { rename, delayMs: 0 }));

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([stagingFailure, restoreFailure]);
    expect(existsSync(paths.target)).toBe(false);
    expect(readdirSync(paths.previous)).toEqual(["old.marker"]);

    recoverInterruptedPromotion(paths);

    expect(readdirSync(paths.target)).toEqual(["old.marker"]);
    expect(existsSync(paths.previous)).toBe(false);
  });

  it("deletes a moved-aside copy left beside a finished promotion, keeping the current copy", () => {
    const paths = layout();
    makeCopy(paths.target, "new.marker");
    makeCopy(paths.previous, "old.marker");

    recoverInterruptedPromotion(paths);

    expect(readdirSync(paths.root)).toEqual(["addon"]);
    expect(readdirSync(paths.target)).toEqual(["new.marker"]);
  });

  it.each(["EPERM", "EBUSY", "EACCES"])(
    "retries a rename locked with %s and succeeds once the lock clears",
    (code) => {
      let calls = 0;
      const rename = () => {
        calls++;
        if (calls < 3) throw errorWithCode(code);
      };

      renameWithRetry("from", "to", { rename, delayMs: 0 });

      expect(calls).toBe(3);
    },
  );

  it("gives up after the attempts allowed, throwing the last lock error", () => {
    let calls = 0;
    const errors: Error[] = [];
    const rename = () => {
      calls++;
      const error = errorWithCode("EBUSY", `locked ${calls}`);
      errors.push(error);
      throw error;
    };

    expect(thrown(() => renameWithRetry("from", "to", { rename, attempts: 4, delayMs: 0 }))).toBe(
      errors[3],
    );
    expect(calls).toBe(4);
  });

  it("does not retry an error that is not a lock", () => {
    let calls = 0;
    const failure = errorWithCode("ENOENT");
    const rename = () => {
      calls++;
      throw failure;
    };

    expect(thrown(() => renameWithRetry("from", "to", { rename, delayMs: 0 }))).toBe(failure);
    expect(calls).toBe(1);
  });
});

describe("placeholder scan", () => {
  it("names each file that holds a placeholder, reporting a repeated token once", () => {
    const message = thrownMessage(() =>
      assertNoUnreplacedPlaceholders([
        { path: "bootstrap.js", content: 'registerChrome("citegeist");' },
        { path: "manifest.json", content: '{ "strict_max_version": "__zoteroMaxVersion__" }' },
        {
          path: "content/preferences.xhtml",
          content: "<label>v__buildVersion__ (__buildVersion__)</label>",
        },
      ]),
    );

    expect(message).toContain("manifest.json: __zoteroMaxVersion__");
    expect(message).toContain("content/preferences.xhtml: __buildVersion__");
    expect(message).not.toContain("__buildVersion__, __buildVersion__");
    expect(message).not.toContain("bootstrap.js");
  });

  it("flags a misspelt placeholder but not JavaScript dunder names or bundler annotations", () => {
    expect(() =>
      assertNoUnreplacedPlaceholders([
        {
          path: "content/scripts/citegeist.js",
          content:
            'var a = /* @__PURE__ */ f(); if (k === "__proto__") return; o.__defineGetter__("x", g); ' +
            "o.__iterator__; o.__noSuchMethod__; o.__parent__;",
        },
      ]),
    ).not.toThrow();
    expect(() =>
      assertNoUnreplacedPlaceholders([
        { path: "manifest.json", content: '"__zoteroMaxVerison__"' },
      ]),
    ).toThrow("manifest.json: __zoteroMaxVerison__");
  });

  it("recognises every placeholder the build defines", () => {
    for (const token of Object.keys(placeholdersFor(meta))) {
      expect(() =>
        assertNoUnreplacedPlaceholders([{ path: "manifest.json", content: token }]),
      ).toThrow(`manifest.json: ${token}`);
    }
  });
});

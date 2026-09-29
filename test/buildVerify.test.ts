import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import pkg from "../package.json";
import {
  placeholdersFor,
  readBuildMetadata,
  updateManifestFor,
} from "../scripts/build-metadata.mjs";
import {
  PLACEHOLDER_FILE_EXTENSIONS,
  assertNoSymbolicLinks,
  assertNoUnreplacedPlaceholders,
  replacePlaceholders,
  verifyBuiltAddon,
  verifyPackagedAddon,
  verifyUpdateManifest,
} from "../scripts/build-verify.mjs";

const ADDON_SOURCE = fileURLToPath(new URL("../addon", import.meta.url));

// A fixed range, independent of what package.json carries today, so these tests
// keep their meaning when a later release moves the floor or the cap.
const FIXTURE_RANGE = { zoteroMinVersion: "7.0.10", zoteroMaxVersion: "10.0.*" };
const meta = readBuildMetadata({ ...pkg, config: { ...pkg.config, ...FIXTURE_RANGE } });

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the call to throw");
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

/** Zips `dir`'s contents with zip and returns the archive's path. */
function zipDirectory(dir: string): string {
  const xpi = join(tempDir("citegeist-xpi-test-"), "citegeist.xpi");
  execFileSync("zip", ["-q", "-r", xpi, "."], { cwd: dir });
  return xpi;
}

// verifyPackagedAddon runs unzip, and its tests zip with zip. Without either on PATH those tests
// skip, except in CI, where they run and fail.
const MISSING_ZIP_TOOLS = ["zip", "unzip"].filter(
  (tool) => spawnSync(tool, ["-v"], { stdio: "ignore" }).error !== undefined,
);

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

describe("symbolic links in the addon", () => {
  const OUTSIDE_CONTENT = '{ "version": "__buildVersion__" }';

  it("accepts addon/ as it is", () => {
    expect(() => assertNoSymbolicLinks(ADDON_SOURCE)).not.toThrow();
  });

  it.for(["file", "directory"] as const)(
    "refuses a link to a %s outside the addon in every walk, naming the link and writing nothing through it",
    (kind, { skip }) => {
      // A file symlink needs a privilege most Windows accounts lack; a junction does not.
      skip(process.platform === "win32" && kind === "file", "file symlinks need a privilege");
      const addon = copyAddon();
      const outside = tempDir("citegeist-outside-");
      const outsideFile = join(outside, "about.json");
      writeFileSync(outsideFile, OUTSIDE_CONTENT);
      const link = join(addon, "content", kind === "file" ? "about.json" : "shared");
      if (kind === "file") symlinkSync(outsideFile, link, "file");
      else symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");

      const refusal = `${link} is a symbolic link`;
      expect(() => assertNoSymbolicLinks(addon)).toThrow(refusal);
      expect(() => replacePlaceholders(addon, placeholdersFor(meta))).toThrow(refusal);
      expect(() => verifyBuiltAddon(addon, meta)).toThrow(refusal);
      expect(readFileSync(outsideFile, "utf8")).toBe(OUTSIDE_CONTENT);
    },
  );

  it("refuses an addon directory that is itself a link", () => {
    const parent = tempDir("citegeist-linked-addon-");
    const real = join(parent, "real");
    mkdirSync(real);
    const link = join(parent, "addon");
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");

    expect(() => assertNoSymbolicLinks(link)).toThrow(`${link} is a symbolic link`);
  });
});

describe.skipIf(MISSING_ZIP_TOOLS.length > 0 && !process.env.CI)("verifyPackagedAddon", () => {
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

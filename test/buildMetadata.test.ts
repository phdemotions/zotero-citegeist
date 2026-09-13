import { afterEach, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import pkg from "../package.json";
import {
  PLACEHOLDER_FILE_EXTENSIONS,
  assertNoUnreplacedPlaceholders,
  compareVersions,
  placeholdersFor,
  readBuildMetadata,
  replacePlaceholders,
  updateManifestFor,
  verifyBuiltAddon,
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

/**
 * Copies addon/ into a temporary directory, applies `edit` to that copy, then replaces
 * placeholders the way scripts/build.mjs does.
 */
function stageAddon(edit: (dir: string) => void = () => {}): string {
  const dir = mkdtempSync(join(tmpdir(), "citegeist-addon-"));
  tempDirs.push(dir);
  cpSync(ADDON_SOURCE, dir, { recursive: true });
  edit(dir);
  replacePlaceholders(dir, placeholdersFor(meta));
  return dir;
}

function editFile(dir: string, path: string, change: (content: string) => string): void {
  const file = join(dir, path);
  writeFileSync(file, change(readFileSync(file, "utf8")));
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

  it.each(["9.*", "10", "10.*", "*", "99.*"])("rejects the cap %s", (cap) => {
    const message = thrownMessage(() => readBuildMetadata(withConfig({ zoteroMaxVersion: cap })));

    expect(message).toContain('config.zoteroMaxVersion must be major.minor.* such as "10.0.*"');
    expect(message).toContain(`got ${JSON.stringify(cap)}`);
  });

  it.each(["8.*", "*"])("rejects the floor %s", (floor) => {
    const message = thrownMessage(() => readBuildMetadata(withConfig({ zoteroMinVersion: floor })));

    expect(message).toContain('config.zoteroMinVersion must be a dotted number such as "7.0.10"');
    expect(message).toContain(`got ${JSON.stringify(floor)}`);
  });

  // A single-minor range such as 10.0 to 10.0.* must stay possible.
  it.each(["7.0.10", "10.0", "10.0.0", "10.0.1"])(
    "accepts the floor %s under the cap 10.0.*",
    (floor) => {
      const config = { zoteroMinVersion: floor, zoteroMaxVersion: "10.0.*" };

      expect(readBuildMetadata(withConfig(config)).zoteroMinVersion).toBe(floor);
    },
  );

  it.each(["10.1", "10.1.0", "11.0"])("rejects the floor %s, above the cap 10.0.*", (floor) => {
    const config = { zoteroMinVersion: floor, zoteroMaxVersion: "10.0.*" };

    expect(() => readBuildMetadata(withConfig(config))).toThrow(
      `package.json config.zoteroMinVersion ${floor} is above the cap 10.0.*`,
    );
  });

  it.each([
    ["7.0.10", "10.0", -1],
    ["10", "10.0", 0],
    ["10.0.1", "10.0", 1],
    ["10.0.1", "10.0.*", -1],
    ["10.1", "10.0.*", 1],
    ["10.0.*", "10.0.*", 0],
  ])(
    "compares %s with %s as Firefox does, a missing part as 0 and * above any number",
    (a, b, expected) => {
      expect(compareVersions(a, b)).toBe(expected);
    },
  );
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

  it("skips a file containing a NUL byte even when its bytes spell a placeholder", () => {
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

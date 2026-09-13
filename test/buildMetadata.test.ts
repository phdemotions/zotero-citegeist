import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import pkg from "../package.json";

// A fixed range, independent of what package.json carries today, so these tests
// keep their meaning when a later release moves the floor or the cap.
const FIXTURE_RANGE = { zoteroMinVersion: "7.0.10", zoteroMaxVersion: "10.0.*" };

async function withFixtureRange() {
  const metadata = await import("../scripts/build-metadata.mjs");
  const meta = metadata.readBuildMetadata({ ...pkg, config: { ...pkg.config, ...FIXTURE_RANGE } });
  return { ...metadata, meta };
}

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the call to throw");
}

describe("build metadata", () => {
  it("uses package Zotero compatibility in placeholders and update manifest", async () => {
    const { placeholdersFor, readBuildMetadata, updateManifestFor } =
      await import("../scripts/build-metadata.mjs");

    const meta = readBuildMetadata(pkg);
    const placeholders = placeholdersFor(meta);
    const update = updateManifestFor(meta, "citegeist-2.0.0.xpi", "abc123");
    const app = update.addons[meta.addonID].updates[0].applications.zotero;

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
  ])("fails fast when zoteroMaxVersion is %s", async (_label, config) => {
    const { readBuildMetadata } = await import("../scripts/build-metadata.mjs");

    expect(() => readBuildMetadata({ ...pkg, config })).toThrow(
      "package.json config.zoteroMaxVersion must be a non-empty string",
    );
  });
});

describe("single-source Zotero compatibility range", () => {
  it("leaves addon/manifest.json with placeholders and no literal version string", () => {
    const raw = readFileSync(new URL("../addon/manifest.json", import.meta.url), "utf8");
    const zotero = JSON.parse(raw).applications.zotero;

    expect(zotero.strict_min_version).toBe("__zoteroMinVersion__");
    expect(zotero.strict_max_version).toBe("__zoteroMaxVersion__");
    // A quoted dotted version such as "7.0.10", "9.*" or "10.0.*" bypasses package.json.
    expect(raw).not.toMatch(/"\d+(?:\.(?:\d+|\*))+"/);
  });

  it("carries a 10.0.* cap into the placeholder map and the built version's update.json entry", async () => {
    const { assertUpdateManifestRange, meta, placeholdersFor, updateManifestFor } =
      await withFixtureRange();
    const update = updateManifestFor(meta, `citegeist-${meta.version}.xpi`, "abc123");

    expect(placeholdersFor(meta).__zoteroMaxVersion__).toBe("10.0.*");
    expect(assertUpdateManifestRange(update, meta)).toEqual({
      strict_min_version: "7.0.10",
      strict_max_version: "10.0.*",
    });
  });

  it.each([
    ["cap", { zoteroMaxVersion: "9.*" }, 'strict_max_version "9.*"', 'zoteroMaxVersion "10.0.*"'],
    [
      "floor",
      { zoteroMinVersion: "7.0.9" },
      'strict_min_version "7.0.9"',
      'zoteroMinVersion "7.0.10"',
    ],
  ])(
    "fails when the built version's update.json entry has a different %s, showing both values",
    async (_label, staleRange, publishedValue, packageValue) => {
      const { assertUpdateManifestRange, meta, updateManifestFor } = await withFixtureRange();
      const update = updateManifestFor({ ...meta, ...staleRange }, "citegeist.xpi", "abc123");

      const message = thrownMessage(() => assertUpdateManifestRange(update, meta));
      expect(message).toContain(`update.json entry for ${meta.version}`);
      expect(message).toContain(publishedValue);
      expect(message).toContain(packageValue);
    },
  );

  it("checks the entry for the version being built, not whichever entry comes first", async () => {
    const { assertUpdateManifestRange, meta, updateManifestFor } = await withFixtureRange();
    const update = updateManifestFor(meta, "citegeist.xpi", "abc123");
    const olderLine = updateManifestFor(
      { ...meta, version: "2.0.6", zoteroMaxVersion: "9.*" },
      "citegeist-2.0.6.xpi",
      "def456",
    ).addons[meta.addonID].updates[0];
    update.addons[meta.addonID].updates.unshift(olderLine);

    expect(assertUpdateManifestRange(update, meta).strict_max_version).toBe("10.0.*");
  });

  it("fails when update.json has no entry, or more than one, for the version being built", async () => {
    const { assertUpdateManifestRange, meta, updateManifestFor } = await withFixtureRange();
    const otherVersionOnly = updateManifestFor({ ...meta, version: "2.0.6" }, "old.xpi", "abc123");
    const duplicated = updateManifestFor(meta, "citegeist.xpi", "abc123");
    const entries = duplicated.addons[meta.addonID].updates;
    entries.push({ ...entries[0] });

    expect(() => assertUpdateManifestRange(otherVersionOnly, meta)).toThrow(
      `exactly one entry for ${meta.addonID} ${meta.version}, found 0`,
    );
    expect(() => assertUpdateManifestRange({}, meta)).toThrow("found 0");
    expect(() => assertUpdateManifestRange(duplicated, meta)).toThrow("found 2");
  });

  it("fails when the built manifest declares a different range, naming the file", async () => {
    const { assertZoteroRange, meta } = await withFixtureRange();
    const label = "build/addon/manifest.json";

    expect(() =>
      assertZoteroRange(label, { strict_min_version: "7.0.10", strict_max_version: "9.*" }, meta),
    ).toThrow(`${label} has strict_min_version "7.0.10" and strict_max_version "9.*"`);
    expect(() => assertZoteroRange(label, undefined, meta)).toThrow("strict_max_version undefined");
  });

  it("fails on an unreplaced placeholder in a built file, naming each file that holds one", async () => {
    const { assertNoUnreplacedPlaceholders } = await import("../scripts/build-metadata.mjs");

    const message = thrownMessage(() =>
      assertNoUnreplacedPlaceholders([
        { path: "build/addon/bootstrap.js", content: 'registerChrome("citegeist");' },
        {
          path: "build/addon/manifest.json",
          content: '{ "strict_max_version": "__zoteroMaxVersion__" }',
        },
        {
          path: "build/addon/content/preferences.xhtml",
          content: "<label>v__buildVersion__ (__buildVersion__)</label>",
        },
      ]),
    );

    expect(message).toContain("build/addon/manifest.json: __zoteroMaxVersion__");
    expect(message).toContain("build/addon/content/preferences.xhtml: __buildVersion__");
    // A token repeated within one file is reported once.
    expect(message).not.toContain("__buildVersion__, __buildVersion__");
    expect(message).not.toContain("bootstrap.js");
  });

  it("flags a misspelt placeholder but not JavaScript dunder names or bundler annotations", async () => {
    const { assertNoUnreplacedPlaceholders } = await import("../scripts/build-metadata.mjs");

    expect(() =>
      assertNoUnreplacedPlaceholders([
        {
          path: "build/addon/content/scripts/citegeist.js",
          content:
            'var a = /* @__PURE__ */ f(); if (k === "__proto__") return; o.__defineGetter__("x", g);',
        },
      ]),
    ).not.toThrow();
    expect(() =>
      assertNoUnreplacedPlaceholders([
        { path: "build/addon/manifest.json", content: '"__zoteroMaxVerison__"' },
      ]),
    ).toThrow("build/addon/manifest.json: __zoteroMaxVerison__");
  });

  it("recognises every placeholder the build defines", async () => {
    const { assertNoUnreplacedPlaceholders, meta, placeholdersFor } = await withFixtureRange();

    for (const token of Object.keys(placeholdersFor(meta))) {
      expect(() =>
        assertNoUnreplacedPlaceholders([{ path: "build/addon/manifest.json", content: token }]),
      ).toThrow(`build/addon/manifest.json: ${token}`);
    }
  });
});

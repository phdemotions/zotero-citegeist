import { describe, expect, it } from "vitest";
import pkg from "../package.json";

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

  it("fails fast when required package metadata is missing", async () => {
    const { readBuildMetadata } = await import("../scripts/build-metadata.mjs");

    expect(() =>
      readBuildMetadata({
        ...pkg,
        config: { ...pkg.config, zoteroMaxVersion: "" },
      }),
    ).toThrow("package.json config.zoteroMaxVersion must be a non-empty string");
  });
});

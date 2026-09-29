/**
 * Citegeist's version rules (scripts/version.mjs): the shapes a version may take, the release tag
 * grammar, and the order Zotero puts versions in, which every build and release script shares.
 */
import { describe, expect, it } from "vitest";
import {
  RELEASE_VERSION,
  VERSION_SHAPE,
  assertReleaseVersion,
  compareVersions,
  developmentVersion,
  isReleaseTag,
  isReleaseVersion,
  newestVersion,
  releaseTag,
  releaseTagVersion,
} from "../scripts/version.mjs";

describe("version order (compareVersions, Firefox's nsVersionComparator)", () => {
  it("sorts main's development version below every prerelease of its version and the version itself", () => {
    // docs/RELEASE-CHECKLIST.md, section 5: main carries X.Y.Z-alpha.0 between releases.
    for (const later of ["3.0.0-alpha.1", "3.0.0-beta.1", "3.0.0-rc.1", "3.0.0"]) {
      expect(compareVersions("3.0.0-alpha.0", later), `3.0.0-alpha.0 < ${later}`).toBe(-1);
      expect(compareVersions(later, "3.0.0-alpha.0"), `${later} > 3.0.0-alpha.0`).toBe(1);
    }
    expect(compareVersions("2.0.6", "3.0.0-alpha.0")).toBe(-1);
    // Firefox compares the text as a string, so a "-dev" suffix would sort above every beta.
    expect(compareVersions("3.0.0-dev.0", "3.0.0-beta.1")).toBe(1);
  });

  it("orders release versions by number where their text sorts the other way, in both directions", () => {
    // Pairs whose text sorts the other way round, so a string comparison gets each one wrong.
    const textDisagrees = [
      ["3.0.10", "3.0.9"],
      ["2.10.0", "2.9.0"],
      ["10.0.0", "9.0.0"],
      ["100000000.0.0", "99999999.0.0"],
    ];
    for (const [newer, older] of textDisagrees) {
      expect(newer < older, `"${newer}" sorts before "${older}" as text`).toBe(true);
    }
    const newerOlder = [
      ...textDisagrees,
      ["3.1.0", "3.0.9"],
      ["4.0.0", "3.99.99"],
      ["3.0.1", "3.0.0"],
    ];
    for (const [newer, older] of newerOlder) {
      expect(compareVersions(newer, older), `${newer} is newer than ${older}`).toBe(1);
      expect(compareVersions(older, newer), `${older} is older than ${newer}`).toBe(-1);
    }
    expect(compareVersions("3.0.0", "3.0.0")).toBe(0);
    expect(newestVersion(["2.9.0", "2.10.0", "2.0.6"])).toBe("2.10.0");
    expect(newestVersion(["3.0.9", "3.0.10", "3.0.1"])).toBe("3.0.10");
    expect(() => newestVersion([])).toThrow(/no version/);
  });

  it("follows Firefox's rules for numbers, text, missing parts, * and +", () => {
    expect(compareVersions("3.0.0-rc.9", "3.0.0-rc.10")).toBe(-1);
    expect(compareVersions("3.0.0-rc2", "3.0.0-rc10")).toBe(1);
    expect(compareVersions("3.0.0+b", "3.0.1pre")).toBe(0);
    expect(compareVersions("10", "10.0")).toBe(0);
    expect(compareVersions("10.0.1", "10.0.*")).toBe(-1);
    expect(compareVersions("10.1", "10.0.*")).toBe(1);
    expect(compareVersions("1.0a", "1.0")).toBe(-1);
    expect(compareVersions("1.0.0.1", "1.0")).toBe(1);
  });

  it("reads a part beyond the int32 range as 0, as Firefox does, so no shape here admits one", () => {
    expect(compareVersions("10000000000.0", "0.0")).toBe(0);
    expect(compareVersions("2147483648.0.0", "1.0.0")).toBe(-1);
    expect(compareVersions("2147483647.0.0", "1.0.0")).toBe(1);
    for (const version of ["1234567890.0.0", "3.2147483648.0", "3.0.10000000000"]) {
      expect(isReleaseVersion(version), version).toBe(false);
      expect(VERSION_SHAPE.test(version), version).toBe(false);
    }
  });
});

describe("release versions and tags", () => {
  it("accepts MAJOR.MINOR.PATCH and nothing else as a release version", () => {
    for (const version of ["3.0.0", "0.1.0", "10.20.30", "999999999.0.0"]) {
      expect(isReleaseVersion(version), version).toBe(true);
      expect(RELEASE_VERSION.test(version), version).toBe(true);
      expect(assertReleaseVersion(version, "The version")).toBe(version);
    }
    for (const version of [
      "v3.0.0",
      "3.0",
      "3.0.0.1",
      "03.0.0",
      "3.00.0",
      "3.0.0-rc.1",
      "3.0.0-alpha.0",
      "3.0.0 ",
      "1234567890.0.0",
      "",
      undefined,
      3,
    ]) {
      expect(isReleaseVersion(version), JSON.stringify(version)).toBe(false);
      expect(() => assertReleaseVersion(version, "The version"), JSON.stringify(version)).toThrow(
        /is not MAJOR\.MINOR\.PATCH/,
      );
    }
  });

  it("reads vMAJOR.MINOR.PATCH as a release tag and nothing else", () => {
    for (const tag of ["v3.0.0", "v0.1.0", "v10.20.30"]) {
      expect(isReleaseTag(tag), tag).toBe(true);
      expect(releaseTagVersion(tag), tag).toBe(tag.slice(1));
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
      "v12345678901.0.0",
      "release",
      "",
      undefined,
      3,
    ]) {
      expect(isReleaseTag(tag), JSON.stringify(tag)).toBe(false);
      expect(releaseTagVersion(tag), JSON.stringify(tag)).toBeNull();
    }
    expect(releaseTag("3.0.0")).toBe("v3.0.0");
    expect(() => releaseTag("3.0.0-rc.1")).toThrow(/is not MAJOR\.MINOR\.PATCH/);
  });

  it("names the development version main carries before a release", () => {
    expect(developmentVersion("3.1.0")).toBe("3.1.0-alpha.0");
    expect(compareVersions(developmentVersion("3.1.0"), "3.1.0")).toBe(-1);
    expect(compareVersions(developmentVersion("3.1.0"), "3.0.9")).toBe(1);
    expect(() => developmentVersion("3.1.0-alpha.0")).toThrow(/is not MAJOR\.MINOR\.PATCH/);
  });

  it("admits package.json's development and prerelease versions, and only those shapes", () => {
    for (const version of ["3.0.0", "3.0.0-alpha.0", "3.0.0-beta.2", "3.0.0-rc.1", "3.0.0-rc.10"]) {
      expect(VERSION_SHAPE.test(version), version).toBe(true);
    }
    for (const version of ["3.0.0-rc2", "3.0.0-rc", "3.0.0-rc.01", "3.0.0-dev.0", "3.0.0+b"]) {
      expect(VERSION_SHAPE.test(version), version).toBe(false);
    }
  });
});

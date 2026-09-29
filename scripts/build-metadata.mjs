/**
 * What the build reads from package.json: the add-on's metadata, its version, and the Zotero
 * range it ships with. The version shapes and the order Zotero applies to versions live in
 * scripts/version.mjs, and the checks on the files the build writes in scripts/build-verify.mjs.
 */
import { PART, VERSION_SHAPE, compareVersions } from "./version.mjs";

export function readBuildMetadata(pkg) {
  const config = pkg.config ?? {};

  const meta = {
    addonName: requiredString(config, "addonName", "package.json config.addonName"),
    addonID: requiredString(config, "addonID", "package.json config.addonID"),
    addonRef: requiredString(config, "addonRef", "package.json config.addonRef"),
    addonInstance: requiredString(config, "addonInstance", "package.json config.addonInstance"),
    prefsPrefix: requiredString(config, "prefsPrefix", "package.json config.prefsPrefix"),
    zoteroMinVersion: requiredString(
      config,
      "zoteroMinVersion",
      "package.json config.zoteroMinVersion",
    ),
    zoteroMaxVersion: requiredString(
      config,
      "zoteroMaxVersion",
      "package.json config.zoteroMaxVersion",
    ),
    version: requiredString(pkg, "version", "package.json version"),
  };
  assertVersionShape(meta.version);
  assertRangeShape(rangeFromMetadata(meta), "package.json config");
  return meta;
}

function requiredString(source, key, label) {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

// PART (scripts/version.mjs) is 0 or at most nine digits with no leading zero. nsVersionComparator
// reads a part outside the int32 range as 0, so a tenth digit could silently turn a cap of
// 10000000000.0.* into 0.0.*.
//
// Firefox's add-on manager, which Zotero runs, reads these fields with nsVersionComparator: a
// missing part counts as 0 and "*" as INT32_MAX, above any part PART admits. A cap of "10"
// therefore refuses 10.0.1, while "10.*" and "*" admit Zotero minors the suite has never run on: a
// new minor that passes the suite gets a cap raise, not a looser cap. XPIInstall throws on any "*"
// in strict_min_version, and versionString allows at most four parts.
const FLOOR_SHAPE = new RegExp(`^${PART}(?:\\.${PART}){0,3}$`);
const CAP_SHAPE = new RegExp(`^${PART}\\.${PART}\\.\\*$`);

// VERSION_SHAPE (scripts/version.mjs) is major.minor.patch, optionally followed by -alpha.N,
// -beta.N or -rc.N. Firefox's manifest schema also reads the version, and it wants plain dotted
// numbers. For a prerelease such as "3.0.0-rc.1", whose third part is "0-rc", it logs a warning,
// not an error. That warning is expected on every prerelease build and does not mean anything
// failed.
function assertVersionShape(version) {
  if (!VERSION_SHAPE.test(version)) {
    throw new Error(
      `package.json version must be major.minor.patch, optionally followed by -alpha.N, -beta.N ` +
        `or -rc.N, such as "3.0.0" or "3.0.0-rc.1", each number 0 or at most nine digits with no ` +
        `leading zero (Zotero orders other shapes wrongly: "3.0.0-rc2" sorts above "3.0.0-rc10"), ` +
        `got ${JSON.stringify(version)}. A prerelease such as "3.0.0-rc.1" makes Firefox's ` +
        `manifest schema log a warning about its "0-rc" part; that is a warning, not an error, ` +
        `and it is expected.`,
    );
  }
}

/**
 * Throws unless `{ min, max }` is a range Zotero reads the way the build means it: a numeric
 * floor, a major.minor.* cap, and the floor no higher than the cap. `sourceLabel` names where the
 * range came from, such as "package.json config", and leads each message.
 */
export function assertRangeShape({ min, max }, sourceLabel) {
  if (typeof min !== "string" || !FLOOR_SHAPE.test(min)) {
    throw new Error(
      `Zotero floor in ${sourceLabel} must be up to four dotted numbers such as "7.0.10", each 0 ` +
        `or at most nine digits with no leading zero (Zotero refuses "*" in strict_min_version), ` +
        `got ${JSON.stringify(min)}`,
    );
  }
  if (typeof max !== "string" || !CAP_SHAPE.test(max)) {
    throw new Error(
      `Zotero cap in ${sourceLabel} must be major.minor.* such as "10.0.*", each number 0 or at ` +
        `most nine digits with no leading zero (a bare "10" refuses 10.0.1; "10.*" or "*" admits ` +
        `untested minors), got ${JSON.stringify(max)}`,
    );
  }
  if (compareVersions(min, max) > 0) {
    throw new Error(
      `Zotero floor ${min} in ${sourceLabel} is above the cap ${max}, ` +
        `so no Zotero version satisfies the range`,
    );
  }
}

// Every layout that carries a Zotero range normalises to `{ min, max }`, so the checks and
// the build log compare and print one shape.

/** The range package.json's config declares. */
export function rangeFromMetadata(meta) {
  return { min: meta.zoteroMinVersion, max: meta.zoteroMaxVersion };
}

/** The range in an `applications.zotero` block, the layout manifest.json and update.json share. */
export function rangeFromApplication(zotero) {
  return { min: zotero?.strict_min_version, max: zotero?.strict_max_version };
}

function applicationFromRange({ min, max }) {
  return { strict_min_version: min, strict_max_version: max };
}

export function rangesEqual(a, b) {
  return a.min === b.min && a.max === b.max;
}

export function formatRange({ min, max }) {
  return `${formatVersion(min)} to ${formatVersion(max)}`;
}

function formatVersion(value) {
  if (typeof value === "string") return value;
  return value === undefined ? "(missing)" : JSON.stringify(value);
}

export function placeholdersFor(meta) {
  return {
    __addonName__: meta.addonName,
    __addonID__: meta.addonID,
    __addonRef__: meta.addonRef,
    __addonInstance__: meta.addonInstance,
    __buildVersion__: meta.version,
    __prefsPrefix__: meta.prefsPrefix,
    __zoteroMinVersion__: meta.zoteroMinVersion,
    __zoteroMaxVersion__: meta.zoteroMaxVersion,
  };
}

export function updateManifestFor(meta, xpiName, hash) {
  return {
    addons: {
      [meta.addonID]: {
        updates: [
          {
            version: meta.version,
            update_link: `https://github.com/phdemotions/zotero-citegeist/releases/download/v${meta.version}/${xpiName}`,
            update_hash: `sha256:${hash}`,
            applications: {
              zotero: applicationFromRange(rangeFromMetadata(meta)),
            },
          },
        ],
      },
    },
  };
}

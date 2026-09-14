/**
 * What the build reads from package.json: the add-on's metadata, its version, and the Zotero
 * range it ships with, with the version order Zotero applies to them. The checks on the files the
 * build writes live in scripts/build-verify.mjs.
 */
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

// One version part as Firefox's versionString format writes it: 0, or at most nine digits with no
// leading zero. nsVersionComparator reads a part outside the int32 range as 0, so a tenth digit
// could silently turn a cap of 10000000000.0.* into 0.0.*.
const PART = "(?:0|[1-9]\\d{0,8})";

// Firefox's add-on manager, which Zotero runs, reads these fields with nsVersionComparator: a
// missing part counts as 0 and "*" as INT32_MAX, above any part PART admits. A cap of "10"
// therefore refuses 10.0.1, while "10.*" and "*" admit Zotero minors the suite has never run on: a
// new minor that passes the suite gets a cap raise, not a looser cap. XPIInstall throws on any "*"
// in strict_min_version, and versionString allows at most four parts.
const FLOOR_SHAPE = new RegExp(`^${PART}(?:\\.${PART}){0,3}$`);
const CAP_SHAPE = new RegExp(`^${PART}\\.${PART}\\.\\*$`);

// nsVersionComparator compares any text after a part's number as a string, so "3.0.0-rc2" sorts
// above "3.0.0-rc10". With the prerelease number in a part of its own it compares as a number:
// "3.0.0-rc.9" sorts below "3.0.0-rc.10", alpha below beta below rc, and every prerelease below
// "3.0.0", because a part with trailing text sorts below the same part without it.
//
// Between releases main carries the next version's "-alpha.0", such as "3.1.0-alpha.0" after 3.0.0
// ships. It sorts below every other prerelease of that version and below the version itself, so a
// copy built from main is still offered each of them.
//
// Firefox's manifest schema also reads the version, and it wants plain dotted numbers. For a
// prerelease such as "3.0.0-rc.1", whose third part is "0-rc", it logs a warning, not an error.
// That warning is expected on every prerelease build and does not mean anything failed.
const VERSION_SHAPE = new RegExp(`^${PART}\\.${PART}\\.${PART}(?:-(?:alpha|beta|rc)\\.${PART})?$`);

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

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

/**
 * Compares two version strings the way Firefox's nsVersionComparator does
 * (xpcom/base/nsVersionComparator.cpp at FIREFOX_140_15_0esr_RELEASE), which is how Zotero orders
 * add-on versions and reads strict_min_version and strict_max_version. Returns -1, 0 or 1.
 *
 * Each dot-separated part reads as a number, then text up to the next digit, "+" or "-", then a
 * number, then the rest. A missing part counts as 0 and "*" as INT32_MAX, so "10" equals "10.0",
 * and "10.0.1" sorts below "10.0.*" while "10.1" sorts above it. Any text sorts below no text, and
 * texts compare as strings: "3.0.0-alpha.0" sorts below "3.0.0-alpha.1", "3.0.0-beta.1",
 * "3.0.0-rc.1" and "3.0.0", while "3.0.0-rc2" sorts above "3.0.0-rc10".
 */
export function compareVersions(a, b) {
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = versionPart(left[i]);
    const y = versionPart(right[i]);
    const order =
      compareNumbers(x.numA, y.numA) ||
      compareText(x.strB, y.strB) ||
      compareNumbers(x.numC, y.numC) ||
      compareText(x.extraD, y.extraD);
    if (order !== 0) return order;
  }
  return 0;
}

/** One part as ParseVP reads it. A missing or empty part reads as 0. */
function versionPart(part = "") {
  if (part === "*") return { numA: INT32_MAX, strB: null, numC: 0, extraD: null };
  const [numA, rest] = leadingNumber(part);
  if (rest === "") return { numA, strB: null, numC: 0, extraD: null };
  // "1.0+" means "1.1pre".
  if (rest.startsWith("+")) return { numA: numA + 1, strB: "pre", numC: 0, extraD: null };
  const end = rest.search(/[0-9+-]/);
  if (end === -1) return { numA, strB: rest, numC: 0, extraD: null };
  const [numC, extraD] = leadingNumber(rest.slice(end));
  return { numA, strB: rest.slice(0, end), numC, extraD: extraD === "" ? null : extraD };
}

/** strtol: the leading integer and the text after it, 0 and all the text when there is none. */
function leadingNumber(text) {
  const match = /^\s*[+-]?\d+/.exec(text);
  if (!match) return [0, text];
  const value = Number(match[0]);
  // Firefox reads a number outside the int32 range as 0.
  const inRange = Number.isSafeInteger(value) && value >= INT32_MIN && value <= INT32_MAX;
  return [inRange ? value : 0, text.slice(match[0].length)];
}

function compareNumbers(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Any text sorts before no text; texts compare character by character. */
function compareText(a, b) {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a === b ? 0 : a < b ? -1 : 1;
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

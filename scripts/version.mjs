/**
 * Citegeist's version rules, in one place: the shapes package.json's version may take, what a
 * release version and its tag are, and the order Zotero puts versions in. The build, the release
 * guard, the channel check and the README badges all import them, so they can never disagree about
 * which version is newer or what may be released.
 *
 * Zotero orders add-on versions, and reads strict_min_version and strict_max_version, with
 * Firefox's nsVersionComparator. compareVersions is a port of it, so every script orders versions
 * the way installed copies do. Every number the shapes below admit is 0 or at most nine digits, so
 * it fits the int32 range Firefox reads a part in, and within that range Firefox's order is
 * numeric order: 3.0.10 is newer than 3.0.9. A part outside that range reads as 0 in Firefox, and
 * compareVersions does the same.
 *
 * Publish runs these scripts with the runner image's own Node and installs nothing, so this file
 * uses no dependency.
 */

/** One version part as Firefox's versionString format writes it: 0, or up to nine digits with no leading zero. */
export const PART = "(?:0|[1-9]\\d{0,8})";

/** A release version: MAJOR.MINOR.PATCH, such as 3.0.0. Only these publish. */
export const RELEASE_VERSION = new RegExp(`^${PART}\\.${PART}\\.${PART}$`);

/**
 * package.json's version: a release version, or one followed by -alpha.N, -beta.N or -rc.N.
 *
 * nsVersionComparator compares any text after a part's number as a string, so "3.0.0-rc2" would
 * sort above "3.0.0-rc10". With the prerelease number in a part of its own it compares as a
 * number: "3.0.0-rc.9" sorts below "3.0.0-rc.10", alpha below beta below rc, and every prerelease
 * below "3.0.0", because a part with trailing text sorts below the same part without it.
 *
 * Between releases main carries the next version's development version, "-alpha.0" (see
 * developmentVersion). It sorts below every other prerelease of that version and below the version
 * itself, so a copy built from main is still offered each of them.
 */
export const VERSION_SHAPE = new RegExp(
  `^${PART}\\.${PART}\\.${PART}(?:-(?:alpha|beta|rc)\\.${PART})?$`,
);

const RELEASE_TAG = new RegExp(`^v(${PART}\\.${PART}\\.${PART})$`);

/**
 * @param {unknown} version
 * @returns {version is string}
 */
export function isReleaseVersion(version) {
  return typeof version === "string" && RELEASE_VERSION.test(version);
}

/**
 * Throws unless `version` is MAJOR.MINOR.PATCH.
 * @param {unknown} version
 * @param {string} what names the value in the error, such as "The release version"
 * @returns {string} the version
 */
export function assertReleaseVersion(version, what) {
  if (!isReleaseVersion(version)) {
    throw new Error(
      `${what} ${JSON.stringify(version)} is not MAJOR.MINOR.PATCH, such as 3.0.0: each part 0 ` +
        "or up to nine digits with no leading zero, and no v in front",
    );
  }
  return version;
}

/**
 * The tag a release version publishes under: v followed by the version, such as v3.0.0.
 * @param {unknown} version
 * @returns {string}
 */
export function releaseTag(version) {
  return `v${assertReleaseVersion(version, "The release version")}`;
}

/**
 * @param {unknown} tag
 * @returns {boolean}
 */
export function isReleaseTag(tag) {
  return typeof tag === "string" && RELEASE_TAG.test(tag);
}

/**
 * The release version a release tag names, or null for any other tag, such as the channel's
 * `release` or a prerelease tag like v3.0.0-rc.1.
 * @param {unknown} tag
 * @returns {string | null}
 */
export function releaseTagVersion(tag) {
  const match = typeof tag === "string" ? RELEASE_TAG.exec(tag) : null;
  return match ? match[1] : null;
}

/**
 * The version main carries while `version` is being developed, and must carry just before the pull
 * request that releases it: `${version}-alpha.0`.
 * @param {unknown} version
 * @returns {string}
 */
export function developmentVersion(version) {
  return `${assertReleaseVersion(version, "The release version")}-alpha.0`;
}

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

/**
 * Compares two version strings the way Firefox's nsVersionComparator does
 * (xpcom/base/nsVersionComparator.cpp at FIREFOX_140_15_0esr_RELEASE). Returns -1, 0 or 1.
 *
 * Each dot-separated part reads as a number, then text up to the next digit, "+" or "-", then a
 * number, then the rest. A missing part counts as 0 and "*" as INT32_MAX, so "10" equals "10.0",
 * and "10.0.1" sorts below "10.0.*" while "10.1" sorts above it. Any text sorts below no text, and
 * texts compare as strings: "3.0.0-alpha.0" sorts below "3.0.0-alpha.1", "3.0.0-beta.1",
 * "3.0.0-rc.1" and "3.0.0", while "3.0.0-rc2" sorts above "3.0.0-rc10". A number outside the int32
 * range reads as 0.
 * @param {string} a
 * @param {string} b
 * @returns {number}
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

/**
 * The newest of a non-empty list of versions, by compareVersions.
 * @param {string[]} versions
 * @returns {string}
 */
export function newestVersion(versions) {
  if (versions.length === 0) throw new Error("There is no version to pick the newest from");
  return versions.reduce((newest, version) =>
    compareVersions(version, newest) > 0 ? version : newest,
  );
}

/**
 * One part as ParseVP reads it. A missing or empty part reads as 0.
 * @param {string} [part]
 */
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

/**
 * strtol: the leading integer and the text after it, 0 and all the text when there is none.
 * @param {string} text
 * @returns {[number, string]}
 */
function leadingNumber(text) {
  const match = /^\s*[+-]?\d+/.exec(text);
  if (!match) return [0, text];
  const value = Number(match[0]);
  // Firefox reads a number outside the int32 range as 0.
  const inRange = Number.isSafeInteger(value) && value >= INT32_MIN && value <= INT32_MAX;
  return [inRange ? value : 0, text.slice(match[0].length)];
}

/**
 * @param {number} a
 * @param {number} b
 */
function compareNumbers(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Any text sorts before no text; texts compare character by character.
 * @param {string | null} a
 * @param {string | null} b
 */
function compareText(a, b) {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a === b ? 0 : a < b ? -1 : 1;
}

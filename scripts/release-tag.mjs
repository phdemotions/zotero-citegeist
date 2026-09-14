/**
 * The release tag grammar and version order, in one place, so the build's release guard and
 * Publish's channel check can never disagree about what a release tag is or which version is
 * newer.
 *
 * A release tag is v followed by MAJOR.MINOR.PATCH, each part 0 or a number with no leading zero,
 * such as v3.0.0. A prerelease tag such as v3.0.0-rc.1 does not publish. Parts compare as digit
 * strings, so a part of any length orders exactly.
 *
 * Publish runs these scripts with the runner image's own Node and installs nothing, so this file
 * uses no dependency.
 */

const PART = "(0|[1-9][0-9]*)";
const RELEASE_TAG = new RegExp(`^v${PART}\\.${PART}\\.${PART}$`);
const FINAL_VERSION = new RegExp(`^${PART}\\.${PART}\\.${PART}$`);

/**
 * @param {unknown} tag
 * @returns {boolean}
 */
export function isReleaseTag(tag) {
  return typeof tag === "string" && RELEASE_TAG.test(tag);
}

/**
 * The version a release tag names, without its v. Throws for anything that is not a release tag.
 * @param {unknown} tag
 * @returns {string}
 */
export function releaseTagVersion(tag) {
  if (!isReleaseTag(tag)) {
    throw new Error(
      `${JSON.stringify(tag)} is not a release tag. Only vMAJOR.MINOR.PATCH publishes, such as ` +
        "v3.0.0; a prerelease tag such as v3.0.0-rc.1 does not (docs/RELEASE-CHECKLIST.md, section 5).",
    );
  }
  return /** @type {string} */ (tag).slice(1);
}

/**
 * The three parts of a final version, as digit strings.
 * @param {unknown} version
 * @param {string} what names the value in the error, such as "The release version"
 * @returns {string[]}
 */
export function finalVersionParts(version, what) {
  const match = typeof version === "string" ? FINAL_VERSION.exec(version) : null;
  if (!match) {
    throw new Error(`${what} ${JSON.stringify(version)} is not MAJOR.MINOR.PATCH`);
  }
  return match.slice(1);
}

/**
 * Negative, zero or positive as `a` is older than, equal to or newer than `b`. Both must be final
 * versions.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareFinalVersions(a, b) {
  const left = finalVersionParts(a, "Version");
  const right = finalVersionParts(b, "Version");
  for (let i = 0; i < left.length; i++) {
    // No leading zeros, so a longer part is a larger number, and equal lengths compare as text.
    const order =
      Math.sign(left[i].length - right[i].length) ||
      (left[i] < right[i] ? -1 : left[i] > right[i] ? 1 : 0);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * The newest of a non-empty list of final versions.
 * @param {string[]} versions
 * @returns {string}
 */
export function newestFinalVersion(versions) {
  if (versions.length === 0) throw new Error("There is no version to pick the newest from");
  return versions.reduce((newest, version) =>
    compareFinalVersions(version, newest) > 0 ? version : newest,
  );
}

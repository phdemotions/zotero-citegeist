import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, sep } from "node:path";

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
// therefore refuses 10.0.1, "10.*" and "*" admit Zotero minors the suite has never run on (KTD2),
// and XPIInstall throws on any "*" in strict_min_version. versionString allows at most four parts.
const FLOOR_SHAPE = new RegExp(`^${PART}(?:\\.${PART}){0,3}$`);
const CAP_SHAPE = new RegExp(`^${PART}\\.${PART}\\.\\*$`);

// nsVersionComparator compares any text after a part's number as a string, so "3.0.0-rc2" sorts
// above "3.0.0-rc10". With the prerelease number in a part of its own it compares as a number:
// "3.0.0-rc.9" sorts below "3.0.0-rc.10", alpha below beta below rc, and every prerelease below
// "3.0.0", because a part with trailing text sorts below the same part without it.
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

const INT32_MAX = 2 ** 31 - 1;

/**
 * Compares two versions FLOOR_SHAPE or CAP_SHAPE admit, the way nsVersionComparator does: a
 * missing part counts as 0 and "*" as INT32_MAX. So "10" equals "10.0", and "10.0.1" sorts below
 * "10.0.*" while "10.1" sorts above it. Returns -1, 0 or 1. It reads numbers and "*" only, so it
 * would misorder a prerelease such as "3.0.0-rc.1", and nothing outside assertRangeShape calls it.
 */
function compareVersions(a, b) {
  const parse = (version) =>
    version.split(".").map((part) => (part === "*" ? INT32_MAX : Number(part)));
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const leftPart = left[i] ?? 0;
    const rightPart = right[i] ?? 0;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

// Every layout that carries a Zotero range normalises to `{ min, max }`, so the checks and
// the build log compare and print one shape. U15's release-lines.json adds a reader here.

/** The range package.json's config declares. */
function rangeFromMetadata(meta) {
  return { min: meta.zoteroMinVersion, max: meta.zoteroMaxVersion };
}

/** The range in an `applications.zotero` block, the layout manifest.json and update.json share. */
function rangeFromApplication(zotero) {
  return { min: zotero?.strict_min_version, max: zotero?.strict_max_version };
}

function applicationFromRange({ min, max }) {
  return { strict_min_version: min, strict_max_version: max };
}

function rangesEqual(a, b) {
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

/**
 * The text files the build replaces placeholders in, by extension. The scan in
 * `verifyBuiltAddon` reads the same list: a text file with any other extension that
 * carries a placeholder fails the build rather than shipping it unreplaced.
 */
export const PLACEHOLDER_FILE_EXTENSIONS = Object.freeze([
  ".json",
  ".js",
  ".xhtml",
  ".ftl",
  ".html",
  ".css",
  ".svg",
]);

function isPlaceholderFile(path) {
  return PLACEHOLDER_FILE_EXTENSIONS.includes(extname(path));
}

/**
 * Every file under `dir`, sorted, found without following any link. A symbolic link, or a
 * junction on Windows, throws, naming the link: copying addon/ keeps a link as a link, so
 * replacing placeholders in the copy would write this build's values through it into the file it
 * points at. That file would then hold values instead of placeholders, and every later build,
 * after a version bump too, would ship those stale values.
 */
function listFiles(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const fullPath = join(dir, entry);
      const stats = lstatSync(fullPath);
      if (stats.isSymbolicLink()) throw symbolicLinkError(fullPath);
      return stats.isDirectory() ? listFiles(fullPath) : [fullPath];
    });
}

function symbolicLinkError(path) {
  return new Error(
    `${path} is a symbolic link. The build refuses links, because it would write this build's ` +
      `values through the link into what it points at. Replace the link with a copy of its target.`,
  );
}

/**
 * Throws if `dir` or anything under it is a symbolic link, naming the first one. scripts/build.mjs
 * runs it on addon/ before copying anything, and every later walk of a copy refuses links too.
 */
export function assertNoSymbolicLinks(dir) {
  if (lstatSync(dir).isSymbolicLink()) throw symbolicLinkError(dir);
  listFiles(dir);
}

/**
 * Every text file under `dir`, with its path relative to `dir`. A file holding a NUL byte is a
 * binary asset such as the PNG icons, which neither replacement nor the scan reads, unless its
 * extension is in PLACEHOLDER_FILE_EXTENSIONS. There a NUL byte means text in another encoding,
 * such as UTF-16, whose placeholders the build could neither replace nor find, so it throws.
 */
function readTextFiles(dir) {
  return listFiles(dir).flatMap((file) => {
    const path = relative(dir, file).split(sep).join("/");
    const bytes = readFileSync(file);
    if (bytes.includes(0)) {
      if (isPlaceholderFile(path)) {
        throw new Error(
          `${path} contains a NUL byte, so it is not UTF-8 text and the build can neither replace ` +
            `nor find placeholders in it. Save it as UTF-8; UTF-16 is the usual cause.`,
        );
      }
      return [];
    }
    return [{ file, path, content: bytes.toString("utf-8") }];
  });
}

/** Replaces each placeholder in the addon's text files whose extension is listed. */
export function replacePlaceholders(addonDir, placeholders) {
  for (const { file, path, content } of readTextFiles(addonDir)) {
    if (!isPlaceholderFile(path)) continue;
    let replaced = content;
    for (const [token, value] of Object.entries(placeholders)) {
      replaced = replaced.replaceAll(token, value);
    }
    if (replaced !== content) writeFileSync(file, replaced);
  }
}

// The scan matches a lowerCamelCase name between double underscores, the shape of every key
// in `placeholdersFor` (a test holds each key to it). That catches an unreplaced placeholder
// and a misspelt name such as `__zoteroMaxVerison__`, and passes esbuild's `/* @__PURE__ */`
// annotations and the `__BUILD_ID__` define. It misses a misspelling that breaks the shape:
// `__buildVersion_`, `__BuildVersion__`, `__build_version__`. `verifyBuiltAddon` catches
// those in manifest.json only, by checking each placeholder-backed field against package.json.
const PLACEHOLDER_TOKEN = /__[a-z][A-Za-z0-9]*__/g;

// Legacy JavaScript properties share that shape but are real code.
const JS_DUNDER_NAMES = new Set([
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__iterator__",
  "__noSuchMethod__",
  "__parent__",
]);

/**
 * Throws if any shipped text file still holds a `__name__` placeholder, naming each file and
 * token. A file whose extension is outside `PLACEHOLDER_FILE_EXTENSIONS` is reported under
 * its own heading, because the fix there is the list rather than the file.
 *
 * @param {Array<{ path: string, content: string }>} files
 */
export function assertNoUnreplacedPlaceholders(files) {
  const unreplaced = [];
  const unlisted = [];
  for (const { path, content } of files) {
    const tokens = [...new Set(content.match(PLACEHOLDER_TOKEN) ?? [])].filter(
      (token) => !JS_DUNDER_NAMES.has(token),
    );
    if (tokens.length === 0) continue;
    (isPlaceholderFile(path) ? unreplaced : unlisted).push(`  ${path}: ${tokens.join(", ")}`);
  }

  const sections = [];
  if (unreplaced.length > 0) {
    sections.push(`Unreplaced build placeholders in shipped files:\n${unreplaced.join("\n")}`);
  }
  if (unlisted.length > 0) {
    sections.push(
      `Placeholders in shipped files the build never replaces, because their extension is ` +
        `not in PLACEHOLDER_FILE_EXTENSIONS (${PLACEHOLDER_FILE_EXTENSIONS.join(", ")}):\n` +
        unlisted.join("\n"),
    );
  }
  if (sections.length > 0) {
    throw new Error(sections.join("\n"));
  }
}

/**
 * Verifies a built addon directory before anything ships or loads from it: no placeholder
 * survives in a text file, and manifest.json's name, version, id and Zotero range equal
 * package.json's. Returns the manifest's range.
 */
export function verifyBuiltAddon(addonDir, meta) {
  const files = readTextFiles(addonDir);
  assertNoUnreplacedPlaceholders(files);

  const manifestFile = files.find(({ path }) => path === "manifest.json");
  if (!manifestFile) {
    throw new Error(`${addonDir} has no manifest.json`);
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestFile.content);
  } catch (error) {
    throw new Error(`manifest.json in ${addonDir} is not valid JSON: ${error.message}`);
  }

  const zotero = manifest.applications?.zotero;
  const mismatches = [
    ["name", manifest.name, meta.addonName],
    ["version", manifest.version, meta.version],
    ["applications.zotero.id", zotero?.id, meta.addonID],
  ]
    .filter(([, actual, expected]) => actual !== expected)
    .map(
      ([field, actual, expected]) =>
        `  ${field} is ${JSON.stringify(actual)}, package.json gives ${JSON.stringify(expected)}`,
    );

  const range = rangeFromApplication(zotero);
  const expectedRange = rangeFromMetadata(meta);
  if (!rangesEqual(range, expectedRange)) {
    mismatches.push(
      `  Zotero range is ${formatRange(range)}, package.json config gives ${formatRange(expectedRange)}`,
    );
  }

  if (mismatches.length > 0) {
    throw new Error(`manifest.json does not match package.json:\n${mismatches.join("\n")}`);
  }
  return range;
}

/**
 * Verifies the XPI itself rather than the directory it was zipped from: extracts it into a
 * temporary directory with `unzip` and runs `verifyBuiltAddon` there. A build that zipped the
 * wrong directory, such as addon/ with its placeholders or a previous build's copy, fails here
 * before the XPI's hash reaches update.json. Returns the packaged manifest's range.
 */
export function verifyPackagedAddon(xpiPath, meta) {
  const extracted = mkdtempSync(join(tmpdir(), "citegeist-xpi-"));
  try {
    try {
      execFileSync("unzip", ["-q", xpiPath, "-d", extracted], { stdio: "pipe" });
    } catch (error) {
      const detail = error.stderr?.toString().trim() || error.message;
      throw new Error(`Could not extract ${xpiPath} to verify it: ${detail}`, { cause: error });
    }
    try {
      return verifyBuiltAddon(extracted, meta);
    } catch (error) {
      throw new Error(`The packaged XPI ${xpiPath} fails verification:\n${error.message}`, {
        cause: error,
      });
    }
  } finally {
    rmSync(extracted, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Finds update.json's entry for the version being built and throws unless it declares
 * package.json's range. Returns that range.
 *
 * While build.mjs makes update.json from the same metadata this check cannot fail. U15 builds
 * update.json from every line in release-lines.json, and this equality then holds only at a tag
 * build, where the tagged version's entry must equal package.json (KTD3). Outside a tag build a
 * line's published cap may exceed package.json's, which is how a same-version cap raise works,
 * but never fall below it (AE6). U15 must therefore call this check only in tag context, and
 * apply the never-below rule otherwise.
 */
export function verifyUpdateManifest(updateManifest, meta) {
  const updates = updateManifest?.addons?.[meta.addonID]?.updates;
  const entries = Array.isArray(updates)
    ? updates.filter((entry) => entry?.version === meta.version)
    : [];
  if (entries.length !== 1) {
    throw new Error(
      `update.json must have exactly one entry for ${meta.addonID} ${meta.version}, ` +
        `found ${entries.length}`,
    );
  }

  const range = rangeFromApplication(entries[0].applications?.zotero);
  const expectedRange = rangeFromMetadata(meta);
  if (!rangesEqual(range, expectedRange)) {
    throw new Error(
      `update.json entry for ${meta.version} declares Zotero ${formatRange(range)}, ` +
        `but package.json config gives ${formatRange(expectedRange)}`,
    );
  }
  return range;
}

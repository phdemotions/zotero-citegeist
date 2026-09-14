/**
 * What the build checks on disk. It walks addon/ and every copy without following a link,
 * replaces placeholders in the staging copy, and verifies that copy, the XPI zipped from it, and
 * the update.json entry for the version being built against package.json. The metadata, version
 * and range rules those checks apply live in scripts/build-metadata.mjs.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import {
  formatRange,
  rangeFromApplication,
  rangeFromMetadata,
  rangesEqual,
} from "./build-metadata.mjs";

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
    throw new Error(`manifest.json in ${addonDir} is not valid JSON: ${error.message}`, {
      cause: error,
    });
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
 * package.json's range. package.json is the source of the range an XPI ships with, so the entry
 * that offers this version's XPI must declare exactly the range inside it. Returns that range.
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

/**
 * Build script for Citegeist.
 *
 * Before it reads package.json, the build finishes any promotion an interrupted build left half
 * done and removes everything an earlier build left in build/ except build/addon, so no earlier
 * XPI or update.json survives a build that then fails. Every later step works on a staging copy,
 * build/.addon-staging/:
 *
 * 1. Refuses a symbolic link anywhere in addon/, then copies addon/ into it and replaces
 *    __placeholders__ with values from package.json
 * 2. Compiles TypeScript into it via the esbuild JS API
 * 3. Verifies it: no placeholder survives, and manifest.json's name, version, id and
 *    Zotero range equal package.json's
 * 4. In production mode: zips it into the XPI, extracts the XPI and verifies what it holds the
 *    same way, then hashes the XPI, verifies the update.json object for this version and writes it
 * 5. Swaps it in as build/addon, moving the previous copy aside and deleting that only once the
 *    new copy is in place (scripts/build-promotion.mjs)
 *
 * A dev install loads build/addon through a proxy file, so it only ever sees a copy that
 * passed every check. If any step throws, the build removes the staging copy, the XPI and
 * update.json, and build/addon keeps the last copy that passed. When a failed swap could not move
 * that copy back either, it waits in build/.addon-previous, which cleanup never removes, and the
 * next build moves it back before anything else.
 */

import { build } from "esbuild";
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "fs";
import { basename, join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { execFileSync, execSync } from "child_process";
import {
  readBuildMetadata,
  placeholdersFor,
  replacePlaceholders,
  updateManifestFor,
  assertNoSymbolicLinks,
  verifyBuiltAddon,
  verifyPackagedAddon,
  verifyUpdateManifest,
  formatRange,
} from "./build-metadata.mjs";
import { promoteStaging, recoverInterruptedPromotion } from "./build-promotion.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const BUILD_DIR = join(ROOT, "build");
const ADDON_DIR = join(BUILD_DIR, "addon");
const STAGING_DIR = join(BUILD_DIR, ".addon-staging");
const PREVIOUS_DIR = join(BUILD_DIR, ".addon-previous");
const isDev = process.argv.includes("--dev");

/**
 * Removes everything in build/ except build/addon and build/.addon-previous. The second exists
 * here only when a promotion could not move it back, and it is then the last copy that passed.
 */
function removeStaleArtefacts() {
  const kept = new Set([basename(ADDON_DIR), basename(PREVIOUS_DIR)]);
  for (const entry of readdirSync(BUILD_DIR)) {
    if (!kept.has(entry)) {
      rmSync(join(BUILD_DIR, entry), { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

mkdirSync(BUILD_DIR, { recursive: true });
recoverInterruptedPromotion({ target: ADDON_DIR, previous: PREVIOUS_DIR });
removeStaleArtefacts();

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const meta = readBuildMetadata(pkg);
const { version } = meta;
const xpiName = `citegeist-${version}.xpi`;
const XPI_PATH = join(BUILD_DIR, xpiName);
const UPDATE_JSON_PATH = join(BUILD_DIR, "update.json");

let gitSha = "nogit";
try {
  gitSha = execSync("git rev-parse --short HEAD", {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .trim();
} catch {
  // Not a git checkout — the timestamp alone still identifies the build.
}
const buildId = `${gitSha}-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;

console.log(
  `\n  Citegeist build — v${version} (${isDev ? "dev" : "production"}) build ${buildId}\n`,
);

try {
  // Step 1: Stage and replace placeholders. A link in addon/ fails here, before anything is
  // copied: the copy would keep the link, and replacing placeholders would write through it.
  assertNoSymbolicLinks(join(ROOT, "addon"));
  cpSync(join(ROOT, "addon"), STAGING_DIR, { recursive: true });
  replacePlaceholders(STAGING_DIR, placeholdersFor(meta));
  console.log("  [1/4] Placeholders replaced");

  // Step 2: Compile TypeScript via esbuild JS API
  const scriptsDir = join(STAGING_DIR, "content", "scripts");
  mkdirSync(scriptsDir, { recursive: true });

  await build({
    entryPoints: [join(ROOT, "src/index.ts")],
    bundle: true,
    format: "iife",
    globalName: "CitegeistBundle",
    target: "firefox115",
    platform: "browser",
    outfile: join(scriptsDir, "citegeist.js"),
    sourcemap: isDev ? "inline" : false,
    minify: !isDev,
    define: {
      // Every build gets a unique stamp. The version alone is useless for telling
      // builds apart: we deliberately hold the version steady across many
      // iterations, and Zotero will happily keep running an older same-version
      // copy — which cost real debugging time. This is logged at startup so
      // "which build is actually running?" is answerable from Debug Output.
      __BUILD_ID__: JSON.stringify(buildId),
    },
    logLevel: "info",
  });
  console.log("  [2/4] TypeScript compiled");

  // Step 3: Verify the staging copy in both modes. The XPI is zipped from it, and a dev
  // install loads it once it becomes build/addon.
  const builtRange = verifyBuiltAddon(STAGING_DIR, meta);
  console.log(
    `  [3/4] Shipped files verified; manifest.json declares Zotero ${formatRange(builtRange)}`,
  );

  // Step 4: Package XPI (production only)
  if (!isDev) {
    execFileSync("zip", ["-q", "-r", XPI_PATH, "."], { cwd: STAGING_DIR, stdio: "pipe" });

    // The XPI is what ships, so it is verified itself, before its hash goes into update.json.
    const packagedRange = verifyPackagedAddon(XPI_PATH, meta);

    const xpiBuffer = readFileSync(XPI_PATH);
    const hash = createHash("sha256").update(xpiBuffer).digest("hex");

    // Checked as an object before it is written, so a failing check leaves no update.json.
    const updateJson = updateManifestFor(meta, xpiName, hash);
    const publishedRange = verifyUpdateManifest(updateJson, meta);
    writeFileSync(UPDATE_JSON_PATH, JSON.stringify(updateJson, null, 2));

    console.log(`  [4/4] XPI packaged: ${xpiName} (${(xpiBuffer.length / 1024).toFixed(1)} KB)`);
    console.log(`        manifest.json inside it declares Zotero ${formatRange(packagedRange)}`);
    console.log(`        SHA-256: ${hash}`);
    console.log(
      `        update.json entry for ${version} declares Zotero ${formatRange(publishedRange)}`,
    );
  } else {
    console.log("  [4/4] Dev mode — skipping XPI packaging");
  }

  // Step 5: Every check passed, so the staging copy becomes build/addon.
  promoteStaging({ staging: STAGING_DIR, target: ADDON_DIR, previous: PREVIOUS_DIR });
} catch (error) {
  // A failure to clean up is reported beside the build error, never in place of it.
  try {
    removeStaleArtefacts();
    const waiting =
      !existsSync(ADDON_DIR) && existsSync(PREVIOUS_DIR)
        ? "\n  build/.addon-previous holds the last copy that passed; the next build moves it " +
          "back to build/addon."
        : "";
    console.error(
      `\n  Build failed; removed the staging copy, the XPI and update.json.${waiting}\n`,
    );
  } catch (cleanupError) {
    console.error(
      `\n  Build failed, and removing the staging copy, the XPI and update.json failed too: ` +
        `${cleanupError.message}\n`,
    );
  }
  throw error;
}

console.log("\n  Build complete.\n");

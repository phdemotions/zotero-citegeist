/**
 * Build script for Citegeist.
 *
 * The build first refuses a build/ that is a symbolic link, then takes build/.build.lock
 * (scripts/build-lock.mjs), so a second build in this checkout stops before it changes anything in
 * build/. Holding the lock, it finishes any promotion an interrupted build left half done and
 * removes everything an earlier build left in build/ except build/addon, so no earlier XPI or
 * update.json survives a build that then fails. Every later step works on a staging copy,
 * build/.addon-staging/:
 *
 * 1. Refuses a symbolic link anywhere in addon/, then copies addon/ into it and replaces
 *    __placeholders__ with values from package.json
 * 2. Compiles TypeScript into it via the esbuild JS API
 * 3. Verifies it: no placeholder survives, and manifest.json's name, version, id and
 *    Zotero range equal package.json's
 * 4. In production mode: zips it into the XPI so one commit always yields the same bytes
 *    (scripts/build-package.mjs), extracts the XPI and verifies what it holds the same way, then
 *    hashes the XPI, verifies the update.json object for this version and writes it
 * 5. Swaps it in as build/addon, moving the previous copy aside and deleting that only once the
 *    new copy is in place (scripts/build-promotion.mjs)
 *
 * A dev install loads build/addon through a proxy file, so it only ever sees a copy that
 * passed every check. If any step throws, or SIGINT or SIGTERM stops the build before step 5,
 * the build removes the staging copy, the XPI and update.json, and build/addon keeps the last copy
 * that passed. When a failed swap could not move that copy back either, it waits in
 * build/.addon-previous, which cleanup never removes, and the next build moves it back before
 * anything else. However the build ends, it releases the lock; a build killed outright leaves a
 * lock naming a pid that no longer runs, and the next build replaces it.
 */

import { build } from "esbuild";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "fs";
import { constants } from "os";
import { basename, join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { acquireBuildLock } from "./build-lock.mjs";
import {
  formatRange,
  placeholdersFor,
  readBuildMetadata,
  updateManifestFor,
} from "./build-metadata.mjs";
import { buildIdFor, readBuildSource, zipReproducibly } from "./build-package.mjs";
import { promoteStaging, recoverInterruptedPromotion } from "./build-promotion.mjs";
import {
  assertNoSymbolicLinks,
  replacePlaceholders,
  verifyBuiltAddon,
  verifyPackagedAddon,
  verifyUpdateManifest,
} from "./build-verify.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const BUILD_DIR = join(ROOT, "build");
const ADDON_DIR = join(BUILD_DIR, "addon");
const STAGING_DIR = join(BUILD_DIR, ".addon-staging");
const PREVIOUS_DIR = join(BUILD_DIR, ".addon-previous");
const LOCK_PATH = join(BUILD_DIR, ".build.lock");
const isDev = process.argv.includes("--dev");

/**
 * Throws if build/ is a symbolic link. Cleanup deletes what it finds in build/, so through a link
 * it would delete the files in the directory the link points at.
 */
function refuseLinkedBuildDirectory() {
  let stats;
  try {
    stats = lstatSync(BUILD_DIR);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(
      `${BUILD_DIR} is a symbolic link to ${readlinkSync(BUILD_DIR)}. The build deletes earlier ` +
        `output from build/, so through the link it would delete files there. Remove the link; ` +
        `the build creates build/ itself.`,
    );
  }
}

/**
 * Removes everything in build/ except build/addon, build/.addon-previous and the lock this build
 * holds. build/.addon-previous exists here only when a promotion could not move it back, and it is
 * then the last copy that passed.
 */
function removeStaleArtefacts() {
  const kept = new Set([basename(ADDON_DIR), basename(PREVIOUS_DIR), basename(LOCK_PATH)]);
  for (const entry of readdirSync(BUILD_DIR)) {
    if (!kept.has(entry)) {
      rmSync(join(BUILD_DIR, entry), { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

// Set once step 5 has made the staging copy build/addon, after which stopping removes nothing.
let promoted = false;

async function buildAddon() {
  recoverInterruptedPromotion({ target: ADDON_DIR, previous: PREVIOUS_DIR });
  removeStaleArtefacts();

  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  const meta = readBuildMetadata(pkg);
  const { version } = meta;
  const xpiName = `citegeist-${version}.xpi`;
  const XPI_PATH = join(BUILD_DIR, xpiName);
  const UPDATE_JSON_PATH = join(BUILD_DIR, "update.json");

  // A production build's id comes from the commit alone, so two builds of one commit compile the
  // same bundle and zip the same XPI bytes: Publish's re-run, the channel repair and a reused
  // versioned release compare a new attempt's SHA-256 with the bytes an earlier attempt
  // published. A dev build adds the time of day, because Zotero keeps running an older copy of
  // the same version, and the id it logs at startup shows which build is actually running.
  const source = readBuildSource(ROOT);
  const buildId = isDev
    ? `${source.commit}-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`
    : buildIdFor(source);

  console.log(
    `\n  Citegeist build — v${version} (${isDev ? "dev" : "production"}) build ${buildId}\n`,
  );

  try {
    // Step 1: Stage and replace placeholders. A link in addon/ fails here, before anything is
    // copied: the copy would keep the link, and replacing placeholders would write through it.
    assertNoSymbolicLinks(join(ROOT, "addon"));
    cpSync(join(ROOT, "addon"), STAGING_DIR, { recursive: true });
    replacePlaceholders(STAGING_DIR, placeholdersFor(meta));
    console.log("  [1/5] Placeholders replaced");

    // Step 2: Compile TypeScript via esbuild JS API
    const scriptsDir = join(STAGING_DIR, "content", "scripts");
    mkdirSync(scriptsDir, { recursive: true });

    // esbuild hands the bundle back instead of writing it. Its own process would otherwise go on
    // writing into the staging copy after SIGINT or SIGTERM had removed it, leaving it behind.
    const { outputFiles } = await build({
      entryPoints: [join(ROOT, "src/index.ts")],
      bundle: true,
      format: "iife",
      globalName: "CitegeistBundle",
      target: "firefox115",
      platform: "browser",
      outfile: join(scriptsDir, "citegeist.js"),
      write: false,
      sourcemap: isDev ? "inline" : false,
      minify: !isDev,
      define: {
        // Logged at startup, so "which build is actually running?" is answerable from Debug
        // Output. The version alone cannot tell builds apart: it is held steady across many
        // iterations.
        __BUILD_ID__: JSON.stringify(buildId),
      },
      logLevel: "info",
    });
    for (const { path, contents } of outputFiles) writeFileSync(path, contents);
    console.log("  [2/5] TypeScript compiled");

    // Step 3: Verify the staging copy in both modes. The XPI is zipped from it, and a dev
    // install loads it once it becomes build/addon.
    const builtRange = verifyBuiltAddon(STAGING_DIR, meta);
    console.log(
      `  [3/5] Shipped files verified; manifest.json declares Zotero ${formatRange(builtRange)}`,
    );

    // Step 4: Package XPI (production only)
    if (!isDev) {
      // Reproducible bytes, for the same reason as the build id above.
      zipReproducibly(STAGING_DIR, XPI_PATH, source.date);

      // The XPI is what ships, so it is verified itself, before its hash goes into update.json.
      const packagedRange = verifyPackagedAddon(XPI_PATH, meta);

      const xpiBuffer = readFileSync(XPI_PATH);
      const hash = createHash("sha256").update(xpiBuffer).digest("hex");

      // Checked as an object before it is written, so a failing check leaves no update.json.
      const updateJson = updateManifestFor(meta, xpiName, hash);
      const publishedRange = verifyUpdateManifest(updateJson, meta);
      writeFileSync(UPDATE_JSON_PATH, JSON.stringify(updateJson, null, 2));

      console.log(`  [4/5] XPI packaged: ${xpiName} (${(xpiBuffer.length / 1024).toFixed(1)} KB)`);
      console.log(`        manifest.json inside it declares Zotero ${formatRange(packagedRange)}`);
      console.log(`        SHA-256: ${hash}`);
      console.log(
        `        update.json entry for ${version} declares Zotero ${formatRange(publishedRange)}`,
      );
    } else {
      console.log("  [4/5] Dev mode — skipping XPI packaging");
    }

    // Step 5: Every check passed, so the staging copy becomes build/addon.
    promoteStaging({ staging: STAGING_DIR, target: ADDON_DIR, previous: PREVIOUS_DIR });
    promoted = true;
    console.log("  [5/5] Verified copy is now build/addon");
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
}

refuseLinkedBuildDirectory();
mkdirSync(BUILD_DIR, { recursive: true });
const lock = acquireBuildLock(LOCK_PATH);
if (lock.recoveredFrom) {
  const { pid, startedAt } = lock.recoveredFrom;
  console.log(
    `\n  Replaced ${LOCK_PATH}, left by pid ${pid} at ${startedAt}, which is no longer running.`,
  );
}

/**
 * Stops the build on SIGINT or SIGTERM as a failure would, then exits with the signal's status.
 * Node runs this only while the build waits, during compilation or once the script has finished,
 * so it never lands inside a synchronous step such as a rename.
 */
function stopOnSignal(signal) {
  let removed = "";
  if (!promoted) {
    try {
      removeStaleArtefacts();
      removed = "; removed the staging copy, the XPI and update.json";
    } catch (error) {
      removed = `; removing the staging copy, the XPI and update.json failed: ${error.message}`;
    }
  }
  lock.release();
  console.error(`\n  Build stopped by ${signal}${removed}.\n`);
  process.exit(128 + constants.signals[signal]);
}
process.once("SIGINT", stopOnSignal);
process.once("SIGTERM", stopOnSignal);

try {
  await buildAddon();
} finally {
  lock.release();
}

console.log("\n  Build complete.\n");

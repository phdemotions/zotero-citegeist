/**
 * Build script for Citegeist.
 *
 * Every step works on a staging copy, build/.addon-staging/:
 *
 * 1. Copies addon/ into it and replaces __placeholders__ with values from package.json
 * 2. Compiles TypeScript into it via the esbuild JS API
 * 3. Verifies it: no placeholder survives, and manifest.json's name, version, id and
 *    Zotero range equal package.json's
 * 4. In production mode: zips it into the XPI, verifies the update.json object for this
 *    version, then writes update.json
 * 5. Replaces build/addon with it
 *
 * A dev install loads build/addon through a proxy file, so it only ever sees a copy that
 * passed every check. If any step throws, the build removes the staging copy, the XPI and
 * update.json, and does not replace build/addon.
 */

import { build } from "esbuild";
import {
  cpSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
} from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { execSync } from "child_process";
import {
  readBuildMetadata,
  placeholdersFor,
  replacePlaceholders,
  updateManifestFor,
  verifyBuiltAddon,
  verifyUpdateManifest,
  formatRange,
} from "./build-metadata.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const BUILD_DIR = join(ROOT, "build");
const ADDON_DIR = join(BUILD_DIR, "addon");
const STAGING_DIR = join(BUILD_DIR, ".addon-staging");
const isDev = process.argv.includes("--dev");

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

// Clear everything the previous build left except build/addon, which only a passing build replaces.
mkdirSync(BUILD_DIR, { recursive: true });
for (const entry of readdirSync(BUILD_DIR)) {
  if (entry !== "addon") rmSync(join(BUILD_DIR, entry), { recursive: true, force: true });
}

try {
  // Step 1: Stage and replace placeholders
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
    execSync(`cd "${STAGING_DIR}" && zip -r "${XPI_PATH}" .`, { stdio: "pipe" });

    const xpiBuffer = readFileSync(XPI_PATH);
    const hash = createHash("sha256").update(xpiBuffer).digest("hex");

    // Checked as an object before it is written, so a failing check leaves no update.json.
    const updateJson = updateManifestFor(meta, xpiName, hash);
    const publishedRange = verifyUpdateManifest(updateJson, meta);
    writeFileSync(UPDATE_JSON_PATH, JSON.stringify(updateJson, null, 2));

    console.log(`  [4/4] XPI packaged: ${xpiName} (${(xpiBuffer.length / 1024).toFixed(1)} KB)`);
    console.log(`        SHA-256: ${hash}`);
    console.log(
      `        update.json entry for ${version} declares Zotero ${formatRange(publishedRange)}`,
    );
  } else {
    console.log("  [4/4] Dev mode — skipping XPI packaging");
  }

  // Step 5: Every check passed, so the staging copy becomes build/addon.
  rmSync(ADDON_DIR, { recursive: true, force: true });
  renameSync(STAGING_DIR, ADDON_DIR);
} catch (error) {
  for (const artefact of [STAGING_DIR, XPI_PATH, UPDATE_JSON_PATH]) {
    rmSync(artefact, { recursive: true, force: true });
  }
  console.error("\n  Build failed; removed the staging copy, the XPI and update.json.\n");
  throw error;
}

console.log("\n  Build complete.\n");

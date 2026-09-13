/**
 * Build script for Citegeist.
 *
 * 1. Copies addon/ to build/addon/
 * 2. Replaces __placeholders__ with values from package.json
 * 3. Compiles TypeScript via esbuild JS API
 * 4. Fails if a placeholder survives in a shipped file, or if the built
 *    manifest's Zotero range differs from package.json
 * 5. In production mode: creates .xpi and update.json, and fails if update.json's
 *    entry for this version declares a different Zotero range
 */

import { build } from "esbuild";
import {
  cpSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "fs";
import { join, resolve, dirname, relative } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { execSync } from "child_process";
import {
  readBuildMetadata,
  placeholdersFor,
  updateManifestFor,
  assertNoUnreplacedPlaceholders,
  assertZoteroRange,
  assertUpdateManifestRange,
} from "./build-metadata.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const BUILD_DIR = join(ROOT, "build");
const ADDON_DIR = join(BUILD_DIR, "addon");
const isDev = process.argv.includes("--dev");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const meta = readBuildMetadata(pkg);
const { addonID, version } = meta;

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

// Step 1: Clean and copy
if (existsSync(BUILD_DIR)) {
  rmSync(BUILD_DIR, { recursive: true });
}
mkdirSync(ADDON_DIR, { recursive: true });
cpSync(join(ROOT, "addon"), ADDON_DIR, { recursive: true });

// Step 2: Replace placeholders
const placeholders = placeholdersFor(meta);

function listFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    return statSync(fullPath).isDirectory() ? listFiles(fullPath) : [fullPath];
  });
}

for (const file of listFiles(ADDON_DIR)) {
  if (!/\.(json|js|xhtml|ftl|html|css|svg)$/.test(file)) continue;
  let content = readFileSync(file, "utf-8");
  for (const [key, value] of Object.entries(placeholders)) {
    content = content.replaceAll(key, value);
  }
  writeFileSync(file, content);
}
console.log("  [1/4] Placeholders replaced");

// Step 3: Compile TypeScript via esbuild JS API
const scriptsDir = join(ADDON_DIR, "content", "scripts");
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

// Step 4: Verify what ships. Everything under build/addon goes into the XPI, and a
// dev build loads that directory directly, so both modes check it before packaging.
const shippedTextFiles = listFiles(ADDON_DIR).flatMap((file) => {
  const bytes = readFileSync(file);
  // A NUL byte marks a binary asset (the PNG icons), which replacement never touches.
  return bytes.includes(0)
    ? []
    : [{ path: relative(ROOT, file), content: bytes.toString("utf-8") }];
});
assertNoUnreplacedPlaceholders(shippedTextFiles);

const manifestPath = join(ADDON_DIR, "manifest.json");
const builtRange = JSON.parse(readFileSync(manifestPath, "utf-8")).applications?.zotero;
assertZoteroRange(relative(ROOT, manifestPath), builtRange, meta);
console.log(
  `  [3/4] Shipped files verified; manifest.json declares Zotero ` +
    `${builtRange.strict_min_version} to ${builtRange.strict_max_version}`,
);

// Step 5: Package XPI (production only)
if (!isDev) {
  const xpiName = `citegeist-${version}.xpi`;
  const xpiPath = join(BUILD_DIR, xpiName);

  execSync(`cd "${ADDON_DIR}" && zip -r "${xpiPath}" .`, { stdio: "pipe" });

  const xpiBuffer = readFileSync(xpiPath);
  const hash = createHash("sha256").update(xpiBuffer).digest("hex");

  const updateJson = updateManifestFor(meta, xpiName, hash);
  const updateJsonPath = join(BUILD_DIR, "update.json");

  writeFileSync(updateJsonPath, JSON.stringify(updateJson, null, 2));

  // Check the file as written rather than the object, so the gate still holds once
  // update.json carries entries that did not come from this build's metadata.
  const publishedRange = assertUpdateManifestRange(
    JSON.parse(readFileSync(updateJsonPath, "utf-8")),
    meta,
  );

  console.log(`  [4/4] XPI packaged: ${xpiName} (${(xpiBuffer.length / 1024).toFixed(1)} KB)`);
  console.log(`        SHA-256: ${hash}`);
  console.log(
    `        update.json entry for ${version} declares Zotero ` +
      `${publishedRange.strict_min_version} to ${publishedRange.strict_max_version}`,
  );
} else {
  console.log("  [4/4] Dev mode — skipping XPI packaging");
}

console.log("\n  Build complete.\n");

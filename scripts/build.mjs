/**
 * Build script for Citegeist.
 *
 * 1. Copies addon/ to build/addon/
 * 2. Replaces __placeholders__ with values from package.json
 * 3. Compiles TypeScript via esbuild JS API
 * 4. In production mode: creates .xpi and update.json
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
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { execSync } from "child_process";
import { readBuildMetadata, placeholdersFor, updateManifestFor } from "./build-metadata.mjs";

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

function replacePlaceholders(dir) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      replacePlaceholders(fullPath);
    } else if (/\.(json|js|xhtml|ftl|html|css|svg)$/.test(entry)) {
      let content = readFileSync(fullPath, "utf-8");
      for (const [key, value] of Object.entries(placeholders)) {
        content = content.replaceAll(key, value);
      }
      writeFileSync(fullPath, content);
    }
  }
}

replacePlaceholders(ADDON_DIR);
console.log("  [1/3] Placeholders replaced");

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
    __DEV__: isDev ? "true" : "false",
    // Every build gets a unique stamp. The version alone is useless for telling
    // builds apart: we deliberately hold the version steady across many
    // iterations, and Zotero will happily keep running an older same-version
    // copy — which cost real debugging time. This is logged at startup so
    // "which build is actually running?" is answerable from Debug Output.
    __BUILD_ID__: JSON.stringify(buildId),
  },
  logLevel: "info",
});
console.log("  [2/3] TypeScript compiled");

// Step 4: Package XPI (production only)
if (!isDev) {
  const xpiName = `citegeist-${version}.xpi`;
  const xpiPath = join(BUILD_DIR, xpiName);

  execSync(`cd "${ADDON_DIR}" && zip -r "${xpiPath}" .`, { stdio: "pipe" });

  const xpiBuffer = readFileSync(xpiPath);
  const hash = createHash("sha256").update(xpiBuffer).digest("hex");

  const updateJson = updateManifestFor(meta, xpiName, hash);

  writeFileSync(join(BUILD_DIR, "update.json"), JSON.stringify(updateJson, null, 2));

  console.log(`  [3/3] XPI packaged: ${xpiName} (${(xpiBuffer.length / 1024).toFixed(1)} KB)`);
  console.log(`        SHA-256: ${hash}`);
} else {
  console.log("  [3/3] Dev mode — skipping XPI packaging");
}

console.log("\n  Build complete.\n");

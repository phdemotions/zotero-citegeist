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
  cpSync, mkdirSync, rmSync, readFileSync, writeFileSync,
  existsSync, readdirSync, statSync,
} from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const BUILD_DIR = join(ROOT, "build");
const ADDON_DIR = join(BUILD_DIR, "addon");
const isDev = process.argv.includes("--dev");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const { addonName, addonID, addonRef, addonInstance, prefsPrefix } = pkg.config;
const version = pkg.version;

console.log(`\n  Citegeist build — v${version} (${isDev ? "dev" : "production"})\n`);

// Step 1: Clean and copy
if (existsSync(BUILD_DIR)) {
  rmSync(BUILD_DIR, { recursive: true });
}
mkdirSync(ADDON_DIR, { recursive: true });
cpSync(join(ROOT, "addon"), ADDON_DIR, { recursive: true });

// Step 2: Replace placeholders
const placeholders = {
  __addonName__: addonName,
  __addonID__: addonID,
  __addonRef__: addonRef,
  __addonInstance__: addonInstance,
  __buildVersion__: version,
  __prefsPrefix__: prefsPrefix,
};

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
  define: { __DEV__: isDev ? "true" : "false" },
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

  const updateJson = {
    addons: {
      [addonID]: {
        updates: [
          {
            version,
            update_link: `https://github.com/opusvita/zotero-citegeist/releases/download/v${version}/${xpiName}`,
            update_hash: `sha256:${hash}`,
            applications: {
              zotero: { strict_min_version: "6.999" },
            },
          },
        ],
      },
    },
  };

  writeFileSync(join(BUILD_DIR, "update.json"), JSON.stringify(updateJson, null, 2));

  console.log(`  [3/3] XPI packaged: ${xpiName} (${(xpiBuffer.length / 1024).toFixed(1)} KB)`);
  console.log(`        SHA-256: ${hash}`);
} else {
  console.log("  [3/3] Dev mode — skipping XPI packaging");
}

console.log("\n  Build complete.\n");

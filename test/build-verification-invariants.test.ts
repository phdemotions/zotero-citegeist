/**
 * Guards for the order of the checks in scripts/build.mjs.
 *
 * buildMetadata.test.ts covers what each check rejects, which protects nothing once the build
 * stops calling a check or calls it after an artefact exists. With all three calls deleted from
 * build.mjs, every test still passed while a production build shipped a manifest capped at 9.*
 * beside an update.json capped at 10.0.*. Only the order of statements in the script shows this,
 * so these are static source assertions, like diagnostics-guard-invariants.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Removes block comments and whole-line `//` comments, so prose naming a call is not the call. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const source = stripComments(
  readFileSync(new URL("../scripts/build.mjs", import.meta.url), "utf8"),
);

function positionOf(snippet: string): number {
  const index = source.indexOf(snippet);
  if (index === -1) {
    throw new Error(`scripts/build.mjs no longer contains \`${snippet}\``);
  }
  return index;
}

function expectInOrder(...snippets: string[]): void {
  for (let i = 1; i < snippets.length; i++) {
    expect(
      positionOf(snippets[i - 1]),
      `\`${snippets[i - 1]}\` must come before \`${snippets[i]}\` in scripts/build.mjs`,
    ).toBeLessThan(positionOf(snippets[i]));
  }
}

const STAGE = 'cpSync(join(ROOT, "addon"), STAGING_DIR';
const VERIFY_ADDON = "verifyBuiltAddon(STAGING_DIR, meta)";
const VERIFY_UPDATE = "verifyUpdateManifest(updateJson, meta)";
const PROMOTE = "renameSync(STAGING_DIR, ADDON_DIR)";

describe("build verification wiring", () => {
  it("verifies the compiled staging copy, in both modes, before zipping it", () => {
    expectInOrder(
      STAGE,
      "replacePlaceholders(STAGING_DIR",
      "const scriptsDir = join(STAGING_DIR",
      "await build(",
      VERIFY_ADDON,
      "if (!isDev)",
      "zip -r",
    );
  });

  it("verifies the update.json object before writing it", () => {
    expectInOrder("updateManifestFor(", VERIFY_UPDATE, "writeFileSync(UPDATE_JSON_PATH");
  });

  it("touches build/addon only after every check has passed", () => {
    expectInOrder(VERIFY_ADDON, VERIFY_UPDATE, PROMOTE);

    const declaration = positionOf("const ADDON_DIR =") + "const ".length;
    const uses = [...source.matchAll(/\bADDON_DIR\b/g)]
      .map((match) => match.index ?? -1)
      .filter((index) => index !== declaration);
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      expect(use, "build/addon is changed before update.json is verified").toBeGreaterThan(
        positionOf(VERIFY_UPDATE),
      );
    }
  });

  it("removes the staging copy, the XPI and update.json when any step throws", () => {
    const failure = source.match(/\bcatch \((\w+)\) \{([\s\S]*?)\bthrow \1;/);
    if (!failure || failure.index === undefined) {
      throw new Error("scripts/build.mjs has no catch block that cleans up and rethrows");
    }
    for (const artefact of ["STAGING_DIR", "XPI_PATH", "UPDATE_JSON_PATH"]) {
      expect(failure[2]).toContain(artefact);
    }

    // The try opens directly before the staging copy is made, and its catch follows promotion.
    const stage = positionOf(STAGE);
    const tryOpen = source.lastIndexOf("try {", stage);
    expect(tryOpen).toBeGreaterThan(-1);
    expect(source.slice(tryOpen + "try {".length, stage).trim()).toBe("");
    expect(failure.index).toBeGreaterThan(positionOf(PROMOTE));
  });
});

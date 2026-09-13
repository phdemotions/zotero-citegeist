/**
 * zotero-plugin-scaffold configuration, used ONLY for its real-Zotero test
 * runner (`npm run test:zotero`). Citegeist's build stays `scripts/build.mjs`
 * and its unit tests stay vitest.
 *
 * The suite must exercise the shipped files (plan KTD6). CI builds the release
 * XPI and unzips it into `.scaffold/xpi`; scaffold's build step copies that tree
 * verbatim into the directory it loads, with manifest generation, Fluent
 * prefixing and pref-key prefixing all switched off (each would rewrite
 * Citegeist's output), and the `test:prebuild` hook proves the copy is
 * byte-identical before Zotero starts. See test/real-zotero/harness/scaffold.ts.
 */
import { readFileSync } from "node:fs";
import { defineConfig } from "zotero-plugin-scaffold";
import { PREF_OPENALEX_BASE_URL } from "./src/constants";
import { startOpenAlexStub, type OpenAlexStub } from "./test/real-zotero/harness/openalexStub";
import {
  SCAFFOLD_DIST_DIR,
  SPEC_TIMEOUT_MS,
  STAGED_XPI_DIR,
  STARTUP_DELAY_MS,
  WAIT_FOR_CITEGEIST,
  assertLoadedMatchesStaged,
  assertStagedXpi,
  seedPinnedChai,
} from "./test/real-zotero/harness/scaffold";

const { config: addon } = JSON.parse(readFileSync("package.json", "utf8")) as {
  config: { addonID: string; addonName: string; addonRef: string; prefsPrefix: string };
};

let stub: OpenAlexStub | undefined;

export default defineConfig({
  // `source` is the prefix scaffold strips when copying assets into `${dist}/addon`.
  source: STAGED_XPI_DIR,
  dist: SCAFFOLD_DIST_DIR,
  name: addon.addonName,
  id: addon.addonID,
  namespace: addon.addonRef,
  xpiName: addon.addonRef,
  build: {
    assets: [`${STAGED_XPI_DIR}/**/*`],
    define: {},
    fluent: { prefixFluentMessages: false, prefixLocaleFiles: false, ignore: [], dts: false },
    prefs: { prefixPrefKeys: false, prefix: addon.prefsPrefix, dts: false },
    esbuildOptions: [],
    makeManifest: { enable: false },
  },
  // `--jsdebugger` would open a Browser Toolbox window beside the one under test.
  server: { devtools: false, startArgs: [] },
  test: {
    entries: ["test/real-zotero"],
    waitForPlugin: WAIT_FOR_CITEGEIST,
    startupDelay: STARTUP_DELAY_MS,
    mocha: { timeout: SPEC_TIMEOUT_MS },
    abortOnFail: false,
    watch: false,
    prefs: {
      // Keep Debug Output in memory from launch so specs can scan it for errors.
      "extensions.zotero.debug.store": true,
    },
    hooks: {
      "test:init": async (ctx) => {
        assertStagedXpi(addon.addonID);
        seedPinnedChai();
        stub = await startOpenAlexStub();
        ctx.test.prefs[PREF_OPENALEX_BASE_URL] = stub.url;
      },
      "test:prebuild": () => {
        assertLoadedMatchesStaged();
      },
      "test:exit": () => {
        void stub?.close();
      },
    },
  },
});

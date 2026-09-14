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
 *
 * A run must also prove something. `test:bundleTests` counts the tests in the
 * bundles Zotero will load and prints the total, and CI fails unless the run
 * passes exactly that many (test/real-zotero/harness/runLog.mjs).
 * test/realZoteroHarness.test.ts calls every hook here directly.
 */
import { readFileSync } from "node:fs";
import { defineConfig } from "zotero-plugin-scaffold";
import { PREF_AUTO_FETCH, PREF_OPENALEX_BASE_URL } from "./src/constants";
import { collectScaffoldBundles } from "./test/real-zotero/harness/collectTests";
import { startOpenAlexStub, type OpenAlexStub } from "./test/real-zotero/harness/openalexStub";
import { formatCollectedLine } from "./test/real-zotero/harness/runLog.mjs";
import {
  SCAFFOLD_DIST_DIR,
  SCAFFOLD_WAIT_FOR_PLUGIN,
  STAGED_XPI_DIR,
  assertLoadedMatchesStaged,
  assertPinnedMocha,
  assertPinnedZoteroBinary,
  assertStagedXpi,
  seedPinnedChai,
} from "./test/real-zotero/harness/scaffold";
import { SCAFFOLD_STARTUP_DELAY_MS, SPEC_TIMEOUT_MS } from "./test/real-zotero/shared/timeouts";

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
    // Always true: scaffold's own wait gives up after 10 s and still exits 0, so
    // the suite's root before hook waits for Citegeist's ready flag instead.
    waitForPlugin: SCAFFOLD_WAIT_FOR_PLUGIN,
    startupDelay: SCAFFOLD_STARTUP_DELAY_MS,
    mocha: { timeout: SPEC_TIMEOUT_MS },
    abortOnFail: false,
    watch: false,
    prefs: {
      // Keep Debug Output in memory from launch so specs can scan it for errors.
      "extensions.zotero.debug.store": true,
      // Specs start every fetch themselves. With auto-fetch on, painting a column
      // queues a fetch of its own that races the one a spec is checking.
      [PREF_AUTO_FETCH]: false,
    },
    hooks: {
      "test:init": async (ctx) => {
        assertPinnedZoteroBinary(process.env);
        assertStagedXpi(addon.addonID);
        assertPinnedMocha();
        seedPinnedChai();
        stub = await startOpenAlexStub();
        ctx.test.prefs[PREF_OPENALEX_BASE_URL] = stub.url;
      },
      "test:prebuild": () => {
        assertLoadedMatchesStaged();
      },
      "test:bundleTests": () => {
        const run = collectScaffoldBundles();
        process.stdout.write(`${formatCollectedLine(run.tests, run.files.length)}\n`);
      },
      "test:exit": () => {
        void stub?.close();
      },
    },
  },
});

/**
 * The Node side of the real-Zotero suite, and the identifiers its specs mirror.
 *
 * The specs in test/real-zotero/ run only inside real Zotero (`npm run
 * test:zotero`, .github/workflows/real-zotero.yml). What can be proven without
 * Zotero is proven here:
 * - the loopback stub answers what Citegeist asks;
 * - the scaffold config's hooks, called directly, refuse a drifted load
 *   directory, an unpinned Zotero or mocha, and a run with no tests, and point
 *   Citegeist at a live stub;
 * - every spec file bundles the way scaffold bundles it and counts outside Zotero;
 * - the run-log guard fails a run that proved nothing;
 * - the root hooks' line and console comparisons behave;
 * - every composed wait fits the Mocha timeout that governs it;
 * - the spec constants still match src/, scaffold 0.9.2 and the workflow.
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Config } from "zotero-plugin-scaffold";
import { PREF_AUTO_FETCH, PREF_OPENALEX_BASE_URL } from "../src/constants";
import {
  type CollectedFile,
  collectTests,
  specScriptsIn,
} from "./real-zotero/harness/collectTests";
import { startOpenAlexStub } from "./real-zotero/harness/openalexStub";
import {
  formatCollectedLine,
  parseRunLog,
  problemsWithPassedRun,
  problemsWithRefusedRun,
  stripAnsi,
} from "./real-zotero/harness/runLog.mjs";
import {
  PINNED_MOCHA_PATH,
  SCAFFOLD_CACHE_DIR,
  SCAFFOLD_DIST_DIR,
  SCAFFOLD_LOAD_DIR,
  SCAFFOLD_TESTER_DIR,
  SCAFFOLD_WAIT_FOR_PLUGIN,
  STAGED_XPI_DIR,
  assertLoadedMatchesStaged,
  assertStagedXpi,
  diffTrees,
} from "./real-zotero/harness/scaffold";
import {
  type ConsoleRecord,
  UNREGISTERED_CHROME_MESSAGE,
  isCitegeistConsoleProblem,
  linesAdded,
  unexpectedLines,
} from "./real-zotero/shared/debugLines";
import { EXPECTED_ZOTERO_VERSION_ENV, LOG_DIR_ENV } from "./real-zotero/shared/env";
import {
  STUB_CITED_BY_COUNT,
  STUB_DOI,
  STUB_REQUEST_LOG_PATH,
  STUB_SOURCE_ID,
  STUB_WORK_ID,
  routeOpenAlexRequest,
} from "./real-zotero/shared/fixture";
import {
  BUDGETS,
  READY_WAIT_TIMEOUT_MS,
  SCAFFOLD_STARTUP_DELAY_MS,
  SPEC_TIMEOUT_MS,
} from "./real-zotero/shared/timeouts";
import {
  ADDON_ID,
  COLUMN_DATA_KEYS,
  ERROR_DEBUG_MARK,
  ITEM_MENU_L10N_IDS,
  PANE_ICON_FILE,
  PANE_ID,
  SHUTDOWN_COMPLETE_DEBUG_LINE,
  STARTUP_COMPLETE_DEBUG_LINE,
} from "./real-zotero/support/citegeist";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SPEC_DIR = join(REPO_ROOT, "test/real-zotero");
const repoFile = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");
const manifest = (id: string) => JSON.stringify({ applications: { zotero: { id } } });

type Hook = (ctx: unknown) => unknown;
let config: Awaited<ReturnType<typeof Config.loadConfig>>;

beforeAll(async () => {
  config = await Config.loadConfig({});
}, 60_000);

function configHook(name: string): Hook {
  const hook = (config.test.hooks as Record<string, Hook | undefined>)[name];
  if (typeof hook !== "function") throw new Error(`zotero-plugin.config.ts has no ${name} hook`);
  return hook;
}

/** Run a config hook; a synchronous throw becomes a rejection. */
const runHook = async (name: string, ctx: unknown) => configHook(name)(ctx);

const tempRoots: string[] = [];

function tempTree(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), "citegeist-harness-"));
  tempRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

afterEach(() => {
  process.chdir(REPO_ROOT);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Spec entry points as scaffold 0.9.2 globs them: `${entry}/**\/*.{spec,test}.[jt]s`. */
function specEntryPoints(): string[] {
  return (readdirSync(SPEC_DIR, { recursive: true }) as string[])
    .filter((path) => /\.(?:spec|test)\.[jt]s$/.test(path))
    .map((path) => join(SPEC_DIR, path))
    .sort();
}

/** Bundle the specs with scaffold 0.9.2's esbuild options and write the page it would generate. */
async function bundleSpecsLikeScaffold(root: string): Promise<string> {
  const contentDir = join(root, SCAFFOLD_TESTER_DIR, "content");
  await build({
    entryPoints: specEntryPoints(),
    outdir: join(contentDir, "units"),
    bundle: true,
    target: "firefox115",
    logLevel: "silent",
  });
  const scripts = (readdirSync(contentDir, { recursive: true }) as string[])
    .filter((path) => /\.(?:spec|test)\.js$/.test(path))
    .sort();
  writeFileSync(
    join(contentDir, "index.xhtml"),
    `<html><body>\n    ${scripts.map((src) => `<script src="${src}"></script>`).join("\n    ")}\n</body></html>`,
  );
  return contentDir;
}

function scaffoldSource(): string {
  const dir = join(REPO_ROOT, "node_modules/zotero-plugin-scaffold/dist/shared");
  const file = readdirSync(dir).find((name) => /^scaffold-src-.*\.mjs$/.test(name));
  if (!file) throw new Error(`no scaffold-src-*.mjs in ${dir}`);
  return readFileSync(join(dir, file), "utf8");
}

function refusesConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

describe("OpenAlex stub routing", () => {
  it("serves the fixture work for the DOI path Citegeist builds", () => {
    const res = routeOpenAlexRequest(
      `/works/doi:${encodeURIComponent(STUB_DOI)}?select=id,cited_by_count`,
    );
    expect(res.status).toBe(200);
    expect((res.body as { cited_by_count: number }).cited_by_count).toBe(STUB_CITED_BY_COUNT);
  });

  it("matches the DOI case-insensitively, as DOIs are", () => {
    expect(routeOpenAlexRequest(`/works/doi:${STUB_DOI.toUpperCase()}`).status).toBe(200);
  });

  it("serves the work by id, its source, and an empty page for list queries", () => {
    expect(routeOpenAlexRequest(`/works/${STUB_WORK_ID}?select=id`).status).toBe(200);
    expect(routeOpenAlexRequest(`/sources/${STUB_SOURCE_ID}?select=id`).status).toBe(200);
    const list = routeOpenAlexRequest("/works?filter=title.search:anything");
    expect(list.status).toBe(200);
    expect((list.body as { results: unknown[] }).results).toEqual([]);
  });

  it("answers 404 for anything else, which Citegeist reads as not on OpenAlex", () => {
    expect(routeOpenAlexRequest("/works/doi:10.1000%2Fother").status).toBe(404);
    expect(routeOpenAlexRequest("/authors/A1").status).toBe(404);
  });
});

describe("loopback stub server", () => {
  it("listens on 127.0.0.1, answers OpenAlex routes and logs them", async () => {
    const stub = await startOpenAlexStub();
    try {
      expect(stub.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const work = await fetch(`${stub.url}/works/doi:${encodeURIComponent(STUB_DOI)}`);
      expect(work.status).toBe(200);
      expect(((await work.json()) as { id: string }).id).toContain(STUB_WORK_ID);
      expect((await fetch(`${stub.url}/authors/A1`)).status).toBe(404);
      expect((await fetch(`${stub.url}/works`, { method: "POST" })).status).toBe(405);

      const log = (await (await fetch(`${stub.url}${STUB_REQUEST_LOG_PATH}`)).json()) as {
        requests: string[];
      };
      expect(log.requests).toEqual([`/works/doi:${encodeURIComponent(STUB_DOI)}`, "/authors/A1"]);
    } finally {
      await stub.close();
    }
  });
});

describe("staged XPI guard", () => {
  it("accepts a built XPI for Citegeist", () => {
    const root = tempTree({ "xpi/manifest.json": manifest(ADDON_ID) });
    expect(() => assertStagedXpi(ADDON_ID, join(root, "xpi"))).not.toThrow();
  });

  it("rejects a missing, unbuilt or foreign XPI with an actionable message", () => {
    const root = tempTree({
      "unbuilt/manifest.json": manifest("__addonID__"),
      "foreign/manifest.json": manifest("other@example.org"),
    });
    expect(() => assertStagedXpi(ADDON_ID, join(root, "nothing"))).toThrow(/No unzipped XPI/);
    expect(() => assertStagedXpi(ADDON_ID, join(root, "unbuilt"))).toThrow(/unbuilt addon\/ tree/);
    expect(() => assertStagedXpi(ADDON_ID, join(root, "foreign"))).toThrow(/other@example\.org/);
  });

  it("passes only when the load directory is byte-identical to the staged XPI", () => {
    const icon = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const root = tempTree({
      "staged/manifest.json": manifest(ADDON_ID),
      "staged/content/icons/icon.png": icon,
      "same/manifest.json": manifest(ADDON_ID),
      "same/content/icons/icon.png": icon,
      "drifted/manifest.json": manifest(ADDON_ID),
      "drifted/content/icons/icon.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xfe]),
      "drifted/locale/en-US/citegeist-citegeist.ftl": "renamed by a prefixing build",
      "partial/manifest.json": manifest(ADDON_ID),
    });
    const staged = join(root, "staged");
    expect(() => assertLoadedMatchesStaged(staged, join(root, "same"))).not.toThrow();
    expect(diffTrees(staged, join(root, "drifted"))).toEqual([
      "changed: content/icons/icon.png",
      "unexpected: locale/en-US/citegeist-citegeist.ftl",
    ]);
    expect(diffTrees(staged, join(root, "partial"))).toEqual(["missing: content/icons/icon.png"]);
    expect(() => assertLoadedMatchesStaged(staged, join(root, "drifted"))).toThrow(
      /not be testing the shipped files/,
    );
  });
});

describe("scaffold config hooks", () => {
  /** A repository layout the init hook accepts, with a stand-in Zotero binary. */
  function initRepo(): { root: string; zotero: string } {
    const root = tempTree({
      [`${STAGED_XPI_DIR}/manifest.json`]: manifest(ADDON_ID),
      "node_modules/chai/chai.js": "/* pinned chai */",
      [PINNED_MOCHA_PATH]: "/* pinned mocha */",
      "zotero/zotero": "#!/bin/sh\n",
    });
    process.chdir(root);
    return { root, zotero: join(root, "zotero/zotero") };
  }

  const initContext = () => ({ test: { prefs: {} as Record<string, unknown> } });

  it("test:prebuild refuses a load directory that differs from the staged XPI", async () => {
    const root = tempTree({
      [`${STAGED_XPI_DIR}/manifest.json`]: manifest(ADDON_ID),
      [`${STAGED_XPI_DIR}/content/icons/icon.png`]: Buffer.from([1, 2, 3]),
      [`${SCAFFOLD_LOAD_DIR}/manifest.json`]: manifest(ADDON_ID),
      [`${SCAFFOLD_LOAD_DIR}/content/icons/icon.png`]: Buffer.from([1, 2, 4]),
    });
    process.chdir(root);
    await expect(runHook("test:prebuild", {})).rejects.toThrow(
      /changed: content\/icons\/icon\.png/,
    );

    writeFileSync(join(root, SCAFFOLD_LOAD_DIR, "content/icons/icon.png"), Buffer.from([1, 2, 3]));
    await expect(runHook("test:prebuild", {})).resolves.toBeUndefined();
  });

  it("test:init refuses an unset or missing Zotero binary, so scaffold never downloads the beta channel", async () => {
    const { root } = initRepo();
    vi.stubEnv("ZOTERO_PLUGIN_ZOTERO_BIN_PATH", undefined);
    await expect(runHook("test:init", initContext())).rejects.toThrow(
      /ZOTERO_PLUGIN_ZOTERO_BIN_PATH is not set/,
    );
    vi.stubEnv("ZOTERO_PLUGIN_ZOTERO_BIN_PATH", join(root, "no-such-zotero"));
    await expect(runHook("test:init", initContext())).rejects.toThrow(/does not exist/);
  });

  it("test:init refuses to run without the pinned mocha, so scaffold never fetches one", async () => {
    const { root, zotero } = initRepo();
    vi.stubEnv("ZOTERO_PLUGIN_ZOTERO_BIN_PATH", zotero);
    rmSync(join(root, PINNED_MOCHA_PATH));
    await expect(runHook("test:init", initContext())).rejects.toThrow(/mocha\.js is missing/);
  });

  it("test:init points the base-URL override at a live loopback stub, and test:exit stops it", async () => {
    const { root, zotero } = initRepo();
    vi.stubEnv("ZOTERO_PLUGIN_ZOTERO_BIN_PATH", zotero);
    const ctx = initContext();
    await runHook("test:init", ctx);
    const url = String(ctx.test.prefs[PREF_OPENALEX_BASE_URL]);
    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(existsSync(join(root, SCAFFOLD_CACHE_DIR, "chai.js"))).toBe(true);
      expect((await fetch(`${url}/works/doi:${encodeURIComponent(STUB_DOI)}`)).status).toBe(200);
    } finally {
      await runHook("test:exit", ctx);
    }
    await expect.poll(() => refusesConnections(Number(new URL(url).port))).toBe(true);
  });

  it("loads the directory scaffold 0.9.2 installs, and reads the files its tester reads", () => {
    expect(SCAFFOLD_LOAD_DIR).toBe(join(config.dist, "addon"));
    const source = scaffoldSource();
    expect(source).toContain('sourceDir: join(this.ctx.dist, "addon")');
    expect(source).toContain(`const TESTER_PLUGIN_DIR = \`${SCAFFOLD_TESTER_DIR}\`;`);
    expect(source).toContain(`const CACHE_DIR = \`${SCAFFOLD_CACHE_DIR}\`;`);
    expect(source).toContain(`local: "${PINNED_MOCHA_PATH}"`);
    expect(source).toContain("Test run completed - ${this.passed} passed");
    const generated = source.indexOf("await this.testBundler.generate();");
    expect(generated).toBeGreaterThan(-1);
    expect(source.indexOf('callHook("test:bundleTests"', generated)).toBeGreaterThan(generated);
  });

  it("the effective config loads the unzipped XPI unchanged (KTD6) and leaves waiting to the suite", () => {
    expect(config.id).toBe(ADDON_ID);
    expect(config.source).toBe(STAGED_XPI_DIR);
    expect(config.dist).toBe(SCAFFOLD_DIST_DIR);
    expect(config.build.assets).toEqual([`${STAGED_XPI_DIR}/**/*`]);
    expect(config.build.makeManifest.enable).toBe(false);
    expect(config.build.fluent.prefixFluentMessages).toBe(false);
    expect(config.build.fluent.prefixLocaleFiles).toBe(false);
    expect(config.build.fluent.dts).toBe(false);
    expect(config.build.prefs.prefixPrefKeys).toBe(false);
    expect(config.build.prefs.dts).toBe(false);
    expect(config.build.esbuildOptions).toEqual([]);
    expect(config.build.define).toEqual({});

    expect(config.test.entries).toEqual(["test/real-zotero"]);
    expect(config.test.waitForPlugin).toBe(SCAFFOLD_WAIT_FOR_PLUGIN);
    expect(new Function(`return (${SCAFFOLD_WAIT_FOR_PLUGIN})();`)()).toBe(true);
    expect(config.test.startupDelay).toBe(SCAFFOLD_STARTUP_DELAY_MS);
    expect(config.test.watch).toBe(false);
    expect(config.test.prefs["extensions.zotero.debug.store"]).toBe(true);
    expect(config.test.prefs[PREF_AUTO_FETCH]).toBe(false);
    expect(repoFile("addon/prefs.js")).toContain(`pref("${PREF_AUTO_FETCH}", true);`);
    expect(config.server.devtools).toBe(false);
    for (const hook of ["test:init", "test:prebuild", "test:bundleTests", "test:exit"]) {
      expect(typeof configHook(hook)).toBe("function");
    }
  });
});

describe("spec bundles, collected outside Zotero", () => {
  let bundleRoot: string;
  let contentDir: string;
  let files: CollectedFile[];

  beforeAll(async () => {
    bundleRoot = mkdtempSync(join(tmpdir(), "citegeist-bundles-"));
    contentDir = await bundleSpecsLikeScaffold(bundleRoot);
    files = specScriptsIn(readFileSync(join(contentDir, "index.xhtml"), "utf8")).map((src) =>
      collectTests(readFileSync(join(contentDir, src), "utf8"), src),
    );
  }, 60_000);

  afterAll(() => {
    rmSync(bundleRoot, { recursive: true, force: true });
  });

  it("bundles and evaluates every spec file, counting tests a loop generates", () => {
    expect(files.map((file) => file.file)).toEqual(
      specEntryPoints().map((path) => `units/${basename(path).replace(/\.ts$/, ".js")}`),
    );
    const tests = Object.fromEntries(files.map((file) => [file.file, file.tests]));
    expect(tests["units/04-icons.spec.js"]).toBe(4);
    for (const file of files.filter((f) => f.file !== "units/00-root-hooks.spec.js")) {
      expect(file.tests, file.file).toBeGreaterThan(0);
    }
  });

  it("00 registers each root hook once, and no other spec file registers any", () => {
    for (const file of files) {
      const count = file.file === "units/00-root-hooks.spec.js" ? 1 : 0;
      expect(file.rootHooks, file.file).toEqual({
        before: count,
        after: count,
        beforeEach: count,
        afterEach: count,
      });
    }
  });

  it("test:bundleTests prints the count the run-log guard requires", async () => {
    process.chdir(bundleRoot);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runHook("test:bundleTests", {});
    const printed = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    const total = files.reduce((sum, file) => sum + file.tests, 0);
    expect(printed).toContain(formatCollectedLine(total, files.length));
    expect(problemsWithPassedRun(`${printed}Test run completed - ${total} passed\n`)).toEqual([]);
    expect(
      problemsWithPassedRun(`${printed}Test run completed - ${total - 1} passed\n`),
    ).not.toEqual([]);
  });

  it("test:bundleTests refuses a page that loads no tests", async () => {
    const root = tempTree({
      [`${SCAFFOLD_TESTER_DIR}/content/index.xhtml`]: "<html><body></body></html>",
    });
    process.chdir(root);
    await expect(runHook("test:bundleTests", {})).rejects.toThrow(/holding no tests/);
  });

  it("refuses to count a spec file that touches Zotero at load time", () => {
    expect(() => collectTests("Zotero.debug('too early');", "units/early.spec.js")).toThrow(
      /may not touch host objects/,
    );
  });
});

describe("spec file layout", () => {
  const sourceFiles = (readdirSync(SPEC_DIR, { recursive: true }) as string[]).filter((path) =>
    /\.(?:ts|mjs)$/.test(path),
  );

  it("only spec files numbered 90-99 disable, reload, restart or quit Citegeist", () => {
    const names = specEntryPoints().map((path) => basename(path));
    expect(names).toContain("90-lifecycle.spec.ts");
    for (const name of names.filter((n) => !/^9\d-/.test(n))) {
      expect(readFileSync(join(SPEC_DIR, name), "utf8"), name).not.toMatch(
        /\.(?:disable|enable|reload|uninstall)\(|Internal\.quit\(|ensureCitegeistReady\(/,
      );
    }
  });

  it("keeps harness/ out of the in-Zotero bundles, and shared/ free of Node and host helpers", () => {
    for (const path of sourceFiles.filter((p) => !p.startsWith("harness/"))) {
      expect(readFileSync(join(SPEC_DIR, path), "utf8"), path).not.toMatch(/from "[^"]*harness\//);
    }
    for (const path of sourceFiles.filter((p) => p.startsWith("shared/"))) {
      expect(readFileSync(join(SPEC_DIR, path), "utf8"), path).not.toMatch(
        /from "(?:node:|[^"]*(?:support|harness)\/)/,
      );
    }
  });
});

describe("run-log guard (harness/runLog.mjs)", () => {
  const ESC = String.fromCharCode(27);
  const coloured = (text: string) => `${ESC}[32m${text}${ESC}[39m`;
  const log = (collected: number | null, summary: string | null) =>
    [
      "Build finished in 1.2 s.",
      collected === null ? "" : formatCollectedLine(collected, 9),
      summary === null ? "" : coloured(`✔ ${summary}`),
    ].join("\n");

  it("reads the counts through ANSI colour codes", () => {
    expect(stripAnsi(coloured("plain"))).toBe("plain");
    expect(parseRunLog(log(12, "Test run completed - 12 passed"))).toEqual({
      collected: [12],
      summaries: [{ passed: 12, failed: 0 }],
    });
  });

  it("accepts only a run that passed exactly the tests it collected", () => {
    expect(problemsWithPassedRun(log(12, "Test run completed - 12 passed"))).toEqual([]);
    expect(problemsWithPassedRun(log(12, "Test run completed - 11 passed"))).toEqual([
      expect.stringMatching(/11 of 12 collected tests passed/),
    ]);
    expect(
      problemsWithPassedRun(log(12, "Test run completed - 12 passed, 1 failed")),
    ).toContainEqual(expect.stringMatching(/1 test or hook failure/));
  });

  it("fails a run that collected nothing, never counted, or never finished", () => {
    expect(problemsWithPassedRun(log(0, "Test run completed - 0 passed"))).toContainEqual(
      expect.stringMatching(/collected zero tests/),
    );
    expect(problemsWithPassedRun(log(null, "Test run completed - 12 passed"))).toContainEqual(
      expect.stringMatching(/test:bundleTests hook/),
    );
    expect(problemsWithPassedRun(log(12, null))).toContainEqual(
      expect.stringMatching(/Zotero exited before Mocha finished/),
    );
  });

  it("fails the negative control only when a refused build finishes a clean run", () => {
    expect(problemsWithRefusedRun(log(12, null))).toEqual([]);
    expect(problemsWithRefusedRun(log(12, "Test run completed - 0 passed, 1 failed"))).toEqual([]);
    expect(problemsWithRefusedRun(log(12, "Test run completed - 12 passed"))).toHaveLength(1);
  });

  // Sixteen Node processes run one after another here, so the default 5 s test
  // budget is too tight under the parallel suite or on a small CI runner.
  it(
    "sets the exit status the workflow steps rely on, through a symlinked path too",
    {
      timeout: 60_000,
    },
    () => {
      const root = tempTree({
        "good.log": log(3, "Test run completed - 3 passed"),
        "empty.log": log(0, "Test run completed - 0 passed"),
        "unfinished.log": log(3, null),
      });
      const cli = join(SPEC_DIR, "harness/runLog-cli.mjs");
      // A path whose real file differs is how an "is this the main module" test fails open.
      const linked = join(root, "runLog-cli-link.mjs");
      symlinkSync(cli, linked);
      const status = (entry: string, ...args: string[]) =>
        spawnSync(process.execPath, [entry, ...args], { encoding: "utf8" }).status;

      for (const entry of [cli, linked]) {
        expect(status(entry, "passed", join(root, "good.log")), entry).toBe(0);
        expect(status(entry, "passed", join(root, "empty.log")), entry).toBe(1);
        expect(status(entry, "passed", join(root, "unfinished.log")), entry).toBe(1);
        expect(status(entry, "passed", join(root, "missing.log")), entry).toBe(1);
        expect(status(entry, "refused", join(root, "good.log")), entry).toBe(1);
        expect(status(entry, "refused", join(root, "empty.log")), entry).toBe(1);
        expect(status(entry, "unknown", join(root, "good.log")), entry).toBe(1);
        expect(status(entry), entry).toBe(1);
      }
    },
  );
});

describe("root-hook comparisons (shared/debugLines.ts)", () => {
  it("finds a new line even when the buffer dropped an old one and kept its length", () => {
    expect(linesAdded(["a", "b", "c"], ["b", "c", "d"])).toEqual(["d"]);
  });

  it("counts a repeated line once per repeat", () => {
    expect(linesAdded(["x"], ["x", "x"])).toEqual(["x"]);
    expect(linesAdded(["x", "x"], ["x"])).toEqual([]);
  });

  it("ignores only the lines a spec allowed", () => {
    const line = (detail: string) => `(3)(+0000001): ${ERROR_DEBUG_MARK} ${detail}`;
    expect(
      unexpectedLines(
        [line("old")],
        [line("old"), line("cache close: expected"), line("boom")],
        [/cache close/],
      ),
    ).toEqual([line("boom")]);
  });

  it("flags console errors that point at Citegeist, never warnings or a mere path mention", () => {
    const markers = ["chrome://citegeist/", "[Citegeist]", ADDON_ID];
    const record = (fields: Partial<ConsoleRecord>): ConsoleRecord => ({
      message: "",
      sourceName: "",
      isError: true,
      ...fields,
    });
    const flagged = (fields: Partial<ConsoleRecord>) =>
      isCitegeistConsoleProblem(record(fields), markers);
    expect(flagged({ sourceName: "chrome://citegeist/content/scripts/citegeist.js" })).toBe(true);
    expect(flagged({ message: `Error in bootstrap of ${ADDON_ID}` })).toBe(true);
    expect(
      flagged({ message: `${UNREGISTERED_CHROME_MESSAGE}/content/icons/x.svg`, isError: false }),
    ).toBe(true);
    expect(flagged({ sourceName: "chrome://citegeist/content/x.css", isError: false })).toBe(false);
    expect(
      flagged({ message: "cannot open /home/runner/work/zotero-citegeist/.scaffold/test/profile" }),
    ).toBe(false);
  });
});

describe("real-Zotero deadlines", () => {
  it("every composed wait finishes inside the Mocha timeout that governs it", () => {
    for (const [name, budget] of Object.entries(BUDGETS)) {
      const total = budget.waits.reduce((sum, wait) => sum + wait, 0);
      expect(total, `${name}: ${budget.waits.join(" + ")} ms`).toBeLessThan(budget.timeoutMs);
    }
  });

  it("gives a cold start at least 90 s, under the Mocha timeout scaffold is configured with", () => {
    expect(READY_WAIT_TIMEOUT_MS).toBeGreaterThanOrEqual(90_000);
    expect(config.test.mocha.timeout).toBe(SPEC_TIMEOUT_MS);
  });
});

describe("real-zotero workflow wiring", () => {
  const workflow = repoFile(".github/workflows/real-zotero.yml");

  it("passes every cell its pinned Zotero version and log directory", () => {
    expect(workflow).toContain(`${EXPECTED_ZOTERO_VERSION_ENV}: \${{ matrix.zotero }}`);
    expect(workflow).toContain(`${LOG_DIR_ENV}: `);
  });

  it("gives every xvfb-run an explicit screen, which MenuManager's overflow grouping measures", () => {
    const runs = workflow.match(/xvfb-run[^\n]*/g) ?? [];
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(run).toContain('--server-args="-screen 0 1920x1080x24"');
  });

  it("checks the suite run and the negative control with the run-log guard", () => {
    expect(workflow).toMatch(/node test\/real-zotero\/harness\/runLog-cli\.mjs passed /);
    expect(workflow).toMatch(/node test\/real-zotero\/harness\/runLog-cli\.mjs refused /);
  });
});

describe("in-Zotero spec identifiers mirror src/", () => {
  it("PANE_ID and the pane icon match citationPane.ts", () => {
    const pane = repoFile("src/modules/citationPane.ts");
    expect(pane).toContain(`const PANE_ID = "${PANE_ID}";`);
    expect(pane).toContain(`content/icons/${PANE_ICON_FILE}`);
  });

  it("column dataKeys match the COL_* constants in citationColumn.ts", () => {
    const declared = [
      ...repoFile("src/modules/citationColumn.ts").matchAll(/^const COL_\w+ = "([^"]+)";$/gm),
    ].map((m) => m[1]);
    expect(new Set(declared)).toEqual(new Set(COLUMN_DATA_KEYS));
  });

  it("item context-menu l10nIDs are registered in menu/registration.ts", () => {
    const menu = repoFile("src/modules/menu/registration.ts");
    for (const l10nID of ITEM_MENU_L10N_IDS) {
      expect(menu).toContain(`l10nID: "${l10nID}"`);
    }
  });

  it("the Debug Output lines the specs wait for and scan are the ones src/ writes", () => {
    const hooks = repoFile("src/hooks.ts");
    expect(hooks).toContain(`Zotero.debug("${STARTUP_COMPLETE_DEBUG_LINE}");`);
    expect(hooks).toContain(`Zotero.debug("${SHUTDOWN_COMPLETE_DEBUG_LINE}");`);
    expect(repoFile("src/modules/utils.ts")).toContain(
      "Zotero.debug(`" + ERROR_DEBUG_MARK + " ${context}: ${detail}`);",
    );
  });

  it("ADDON_ID is the add-on id package.json builds into the manifest", () => {
    expect(ADDON_ID).toBe(JSON.parse(repoFile("package.json")).config.addonID);
  });
});

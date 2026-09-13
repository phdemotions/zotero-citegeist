/**
 * The Node side of the real-Zotero suite, and the identifiers its specs mirror.
 *
 * The specs in test/real-zotero/ run only inside real Zotero (`npm run
 * test:zotero`, CI job `real-zotero`). What CAN be proven without Zotero is
 * proven here: the loopback stub answers what Citegeist asks, the staged-XPI
 * guard catches a load directory that differs from the release XPI, the
 * effective scaffold config keeps every output-rewriting option off (plan KTD6),
 * and the spec constants still match src/.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STUB_CITED_BY_COUNT,
  STUB_DOI,
  STUB_REQUEST_LOG_PATH,
  STUB_SOURCE_ID,
  STUB_WORK_ID,
  routeOpenAlexRequest,
} from "./real-zotero/harness/fixture";
import { startOpenAlexStub } from "./real-zotero/harness/openalexStub";
import {
  STAGED_XPI_DIR,
  SCAFFOLD_DIST_DIR,
  WAIT_FOR_CITEGEIST,
  assertLoadedMatchesStaged,
  assertStagedXpi,
  diffTrees,
} from "./real-zotero/harness/scaffold";
import {
  ADDON_ID,
  COLUMN_DATA_KEYS,
  ITEM_MENU_L10N_IDS,
  PANE_ICON_FILE,
  PANE_ID,
} from "./real-zotero/support/citegeist";

const repoFile = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

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
  let root: string;

  function tree(dir: string, files: Record<string, string | Buffer>): string {
    const base = join(root, dir);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(base, path)), { recursive: true });
      writeFileSync(join(base, path), content);
    }
    return base;
  }

  const manifest = (id: string) => JSON.stringify({ applications: { zotero: { id } } });

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("accepts a built XPI for Citegeist", () => {
    root = mkdtempSync(join(tmpdir(), "citegeist-harness-"));
    const staged = tree("xpi", { "manifest.json": manifest(ADDON_ID) });
    expect(() => assertStagedXpi(ADDON_ID, staged)).not.toThrow();
  });

  it("rejects a missing, unbuilt or foreign XPI with an actionable message", () => {
    root = mkdtempSync(join(tmpdir(), "citegeist-harness-"));
    expect(() => assertStagedXpi(ADDON_ID, join(root, "nothing"))).toThrow(/No unzipped XPI/);
    const unbuilt = tree("unbuilt", { "manifest.json": manifest("__addonID__") });
    expect(() => assertStagedXpi(ADDON_ID, unbuilt)).toThrow(/unbuilt addon\/ tree/);
    const foreign = tree("foreign", { "manifest.json": manifest("other@example.org") });
    expect(() => assertStagedXpi(ADDON_ID, foreign)).toThrow(/other@example\.org/);
  });

  it("passes only when the load directory is byte-identical to the staged XPI", () => {
    root = mkdtempSync(join(tmpdir(), "citegeist-harness-"));
    const icon = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const files = { "manifest.json": manifest(ADDON_ID), "content/icons/icon.png": icon };
    const staged = tree("staged", files);
    expect(() => assertLoadedMatchesStaged(staged, tree("same", files))).not.toThrow();

    const drifted = tree("drifted", {
      "manifest.json": manifest(ADDON_ID),
      "content/icons/icon.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xfe]),
      "locale/en-US/citegeist-citegeist.ftl": "renamed by a prefixing build",
    });
    expect(diffTrees(staged, drifted)).toEqual([
      "changed: content/icons/icon.png",
      "unexpected: locale/en-US/citegeist-citegeist.ftl",
    ]);
    expect(diffTrees(staged, tree("partial", { "manifest.json": manifest(ADDON_ID) }))).toEqual([
      "missing: content/icons/icon.png",
    ]);
    expect(() => assertLoadedMatchesStaged(staged, drifted)).toThrow(
      /not be testing the shipped files/,
    );
  });
});

describe("scaffold tester contract", () => {
  it("the waitForPlugin condition survives being pasted into a double-quoted string", () => {
    expect(WAIT_FOR_CITEGEIST).not.toMatch(/["\\\n]/);
  });

  it("the waitForPlugin condition reads the bridge ready flag", () => {
    const evaluate = new Function("Zotero", `return (${WAIT_FOR_CITEGEIST})();`) as (
      zotero: unknown,
    ) => boolean;
    expect(evaluate({ Citegeist: { ready: true } })).toBe(true);
    expect(evaluate({ Citegeist: { ready: false } })).toBe(false);
    expect(evaluate({})).toBe(false);
  });

  it("the effective config loads the unzipped XPI unchanged (KTD6)", async () => {
    const { Config } = await import("zotero-plugin-scaffold");
    const config = await Config.loadConfig({});

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
    expect(config.test.waitForPlugin).toBe(WAIT_FOR_CITEGEIST);
    expect(config.test.watch).toBe(false);
    expect(config.test.prefs["extensions.zotero.debug.store"]).toBe(true);
    expect(config.server.devtools).toBe(false);
    for (const hook of ["test:init", "test:prebuild", "test:exit"] as const) {
      expect(typeof config.test.hooks[hook]).toBe("function");
    }
  }, 60_000);
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

  it("item context-menu l10nIDs are registered in menu.ts", () => {
    const menu = repoFile("src/modules/menu.ts");
    for (const l10nID of ITEM_MENU_L10N_IDS) {
      expect(menu).toContain(`l10nID: "${l10nID}"`);
    }
  });

  it("ADDON_ID is the add-on id package.json builds into the manifest", () => {
    expect(ADDON_ID).toBe(JSON.parse(repoFile("package.json")).config.addonID);
  });
});

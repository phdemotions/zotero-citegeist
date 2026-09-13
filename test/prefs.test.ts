/**
 * U18: Citegeist reads and writes its preferences under their real names.
 *
 * Every earlier build passed full pref names to `Zotero.Prefs` without its
 * `global` argument, so each read looked up
 * `extensions.zotero.extensions.zotero.citegeist.*`: the settings pane and the
 * `addon/prefs.js` defaults were never seen. The fake behind these tests applies
 * Zotero's prefixing rule, so a call in that old pattern fails here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CACHE_LIFETIME_DAYS,
  DEFAULT_NETWORK_PAGE_SIZE,
  PREF_AUTHOR_RELATIONS_PURGED,
  PREF_AUTO_FETCH,
  PREF_CACHE_LIFETIME_DAYS,
  PREF_LAST_BACKUP_PATH,
  PREF_LAST_ORPHAN_GC_AT,
  PREF_MIGRATION_COMPLETE,
  PREF_NETWORK_PAGE_SIZE,
  PREF_OPENALEX_API_KEY,
  PREF_OPENALEX_BASE_URL,
  NETWORK_PAGE_SIZE_MAX,
} from "../src/constants";
import { clearDiagnostics, recentDiagnostics } from "../src/modules/diagnostics";
import {
  LEGACY_DOUBLED_PREFS,
  getCacheLifetimeDays,
  getNetworkPageSize,
  getOpenAlexApiKey,
  getPref,
  getTimestampPref,
  isAutoFetchEnabled,
  setPref,
  timestampPrefValue,
} from "../src/modules/prefs";
import { ZOTERO_PREF_BRANCH, makeFakePrefs, type FakePrefs } from "./_helpers/fakePrefs";

let prefs: FakePrefs;

function useZotero(fake: FakePrefs): void {
  prefs = fake;
  vi.stubGlobal("Zotero", { Prefs: fake, debug: vi.fn() });
}

const doubled = (name: string): string => ZOTERO_PREF_BRANCH + name;

beforeEach(() => {
  clearDiagnostics();
  useZotero(makeFakePrefs({ addonDefaults: true }));
});

describe("the Zotero.Prefs fake", () => {
  it("misses a full pref name used without `global`, as Zotero does", () => {
    prefs.user.set(PREF_NETWORK_PAGE_SIZE, 50);
    expect(Zotero.Prefs.get(PREF_NETWORK_PAGE_SIZE)).toBeUndefined();
    expect(Zotero.Prefs.get(PREF_NETWORK_PAGE_SIZE, true)).toBe(50);

    Zotero.Prefs.set(PREF_AUTO_FETCH, false);
    expect(prefs.user.get(doubled(PREF_AUTO_FETCH))).toBe(false);
    expect(Zotero.Prefs.get(PREF_AUTO_FETCH, true), "the real pref is untouched").toBe(true);
  });

  it("stores a new integer pref in 32 bits, as Gecko does", () => {
    const now = 1_789_300_000_000;
    Zotero.Prefs.set(PREF_LAST_ORPHAN_GC_AT, now, true);
    expect(Zotero.Prefs.get(PREF_LAST_ORPHAN_GC_AT, true)).toBe(now | 0);
    expect(now | 0).not.toBe(now);
  });
});

describe("user-facing settings", () => {
  const settings = [
    { name: PREF_AUTO_FETCH, read: isAutoFetchEnabled, chosen: false },
    { name: PREF_OPENALEX_API_KEY, read: getOpenAlexApiKey, chosen: "sk-chosen-key" },
    { name: PREF_CACHE_LIFETIME_DAYS, read: getCacheLifetimeDays, chosen: 30 },
    { name: PREF_NETWORK_PAGE_SIZE, read: getNetworkPageSize, chosen: 50 },
  ];

  it.each(settings)("reads $name as the settings pane stored it", ({ name, read, chosen }) => {
    prefs.user.set(name, chosen);
    expect(read()).toBe(chosen);
  });

  it.each(settings)(
    "reads $name as addon/prefs.js ships it when never changed",
    ({ name, read }) => {
      expect(prefs.defaults.has(name), `addon/prefs.js has no default for ${name}`).toBe(true);
      expect(read()).toBe(prefs.defaults.get(name));
    },
  );

  it.each(settings)(
    "ignores a $name value found only under the doubled name",
    ({ name, read, chosen }) => {
      prefs.user.set(doubled(name), chosen);
      expect(read()).toBe(prefs.defaults.get(name));
      expect(prefs.get).not.toHaveBeenCalledWith(doubled(name), true);
    },
  );

  it("falls back to Citegeist's own defaults when the prefs.js defaults are missing", () => {
    useZotero(makeFakePrefs());
    expect(isAutoFetchEnabled()).toBe(false);
    expect(getOpenAlexApiKey()).toBe("");
    expect(getCacheLifetimeDays()).toBe(DEFAULT_CACHE_LIFETIME_DAYS);
    expect(getNetworkPageSize()).toBe(DEFAULT_NETWORK_PAGE_SIZE);
  });

  it("trims the API key", () => {
    prefs.user.set(PREF_OPENALEX_API_KEY, "  sk-chosen-key \n");
    expect(getOpenAlexApiKey()).toBe("sk-chosen-key");
  });

  it.each([
    [0, DEFAULT_CACHE_LIFETIME_DAYS],
    [-3, DEFAULT_CACHE_LIFETIME_DAYS],
    [90, 90],
  ])("reads a cache lifetime of %s days as %s", (stored, expected) => {
    prefs.user.set(PREF_CACHE_LIFETIME_DAYS, stored);
    expect(getCacheLifetimeDays()).toBe(expected);
  });

  it.each([
    [500, NETWORK_PAGE_SIZE_MAX],
    [NETWORK_PAGE_SIZE_MAX, NETWORK_PAGE_SIZE_MAX],
    [1, 1],
    [0, DEFAULT_NETWORK_PAGE_SIZE],
    [-5, DEFAULT_NETWORK_PAGE_SIZE],
  ])("reads a page size of %s as %s, within what OpenAlex accepts", (stored, expected) => {
    prefs.user.set(PREF_NETWORK_PAGE_SIZE, stored);
    expect(getNetworkPageSize()).toBe(expected);
  });

  it("reads the base-URL override under its real name", () => {
    prefs.user.set(PREF_OPENALEX_BASE_URL, "http://127.0.0.1:43121");
    expect(getPref(PREF_OPENALEX_BASE_URL)).toBe("http://127.0.0.1:43121");
  });
});

describe("flags earlier builds stored under the doubled name", () => {
  const flags = [
    { name: PREF_MIGRATION_COMPLETE, legacy: true, real: false },
    { name: PREF_AUTHOR_RELATIONS_PURGED, legacy: true, real: false },
    {
      name: PREF_LAST_BACKUP_PATH,
      legacy: "/tmp/zotero-test-data/citegeist-migration-backup-old.json",
      real: "",
    },
  ];

  it("falls back only for the one-shot flags those builds wrote", () => {
    expect([...LEGACY_DOUBLED_PREFS].sort()).toEqual(flags.map((f) => f.name).sort());
  });

  it.each(flags)(
    "reads $name from the doubled name when the real name is unset, and copies it forward",
    ({ name, legacy }) => {
      prefs.user.set(doubled(name), legacy);

      expect(getPref(name)).toBe(legacy);
      expect(prefs.user.get(name)).toBe(legacy);
      // Kept for a downgraded copy, which reads only the doubled name.
      expect(prefs.user.get(doubled(name))).toBe(legacy);
    },
  );

  it.each(flags)(
    "prefers $name under its real name, even a falsy value",
    ({ name, legacy, real }) => {
      prefs.user.set(name, real);
      prefs.user.set(doubled(name), legacy);

      expect(getPref(name)).toBe(real);
      expect(prefs.get).not.toHaveBeenCalledWith(doubled(name), true);
    },
  );

  it("reads undefined when neither name is set", () => {
    expect(getPref(PREF_MIGRATION_COMPLETE)).toBeUndefined();
    expect(prefs.user.size).toBe(0);
  });

  it("answers from the doubled name when the copy forward fails, logs it, and retries on the next read", () => {
    prefs.user.set(doubled(PREF_MIGRATION_COMPLETE), true);
    prefs.set.mockImplementation(() => {
      throw new Error("prefs.js is locked");
    });

    expect(getPref(PREF_MIGRATION_COMPLETE)).toBe(true);
    expect(getPref(PREF_MIGRATION_COMPLETE)).toBe(true);

    expect(prefs.set).toHaveBeenCalledTimes(2);
    expect(prefs.user.has(PREF_MIGRATION_COMPLETE)).toBe(false);
    expect(recentDiagnostics().at(-1)?.context).toContain("migrationV1Complete");
  });

  it("does not carry forward lastOrphanGcAt, whose doubled-name value is a wrapped integer", () => {
    prefs.user.set(doubled(PREF_LAST_ORPHAN_GC_AT), 1_789_300_000_000 | 0);

    expect(getTimestampPref(PREF_LAST_ORPHAN_GC_AT)).toBe(0);
    expect(prefs.user.has(PREF_LAST_ORPHAN_GC_AT)).toBe(false);
  });
});

describe("writing", () => {
  it("setPref writes under the real name", () => {
    setPref(PREF_AUTHOR_RELATIONS_PURGED, true);
    expect(prefs.user.get(PREF_AUTHOR_RELATIONS_PURGED)).toBe(true);
    expect(prefs.user.has(doubled(PREF_AUTHOR_RELATIONS_PURGED))).toBe(false);
  });

  it("round-trips a millisecond timestamp, which an integer pref cannot hold", () => {
    const now = Date.now();
    setPref(PREF_LAST_ORPHAN_GC_AT, timestampPrefValue(now));
    expect(getTimestampPref(PREF_LAST_ORPHAN_GC_AT)).toBe(now);
  });

  it("reads a timestamp stored as a number, or as anything but digits, as never", () => {
    setPref(PREF_LAST_ORPHAN_GC_AT, Date.now());
    expect(getTimestampPref(PREF_LAST_ORPHAN_GC_AT)).toBe(0);
    prefs.user.set(PREF_LAST_ORPHAN_GC_AT, "yesterday");
    expect(getTimestampPref(PREF_LAST_ORPHAN_GC_AT)).toBe(0);
  });
});

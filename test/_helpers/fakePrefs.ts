/**
 * An in-memory `Zotero.Prefs` that follows Zotero's own rules
 * (`chrome/content/zotero/xpcom/prefs.js`, the same at 7.0.10 and 10.0.2), so a
 * test fails the way Zotero would:
 *
 * - `get`, `set` and `clear` prepend `extensions.zotero.` to the name unless
 *   `global` is true, so a full pref name used without it misses;
 * - `get` returns the user value, else the default, else `undefined`;
 * - `set` keeps an existing pref's type, and creates a new one as a boolean, a
 *   string or an integer, wrapping the integer to 32 bits as Gecko does.
 */
import { readFileSync } from "node:fs";
import { vi } from "vitest";

export type FakePrefValue = boolean | string | number;

/** Zotero's `ZOTERO_CONFIG.PREF_BRANCH`. */
export const ZOTERO_PREF_BRANCH = "extensions.zotero.";

/** The defaults `addon/prefs.js` ships, by pref name. */
export function addonPrefDefaults(): Map<string, FakePrefValue> {
  const source = readFileSync(new URL("../../addon/prefs.js", import.meta.url), "utf8");
  const defaults = new Map<string, FakePrefValue>();
  for (const [, name, value] of source.matchAll(/^pref\("([^"]+)",\s*(.+)\);$/gm)) {
    defaults.set(name, JSON.parse(value) as FakePrefValue);
  }
  return defaults;
}

export function makeFakePrefs(
  options: { user?: Record<string, FakePrefValue>; addonDefaults?: boolean } = {},
) {
  /** User values by full pref name: what Zotero keeps in the profile's prefs.js. */
  const user = new Map<string, FakePrefValue>(Object.entries(options.user ?? {}));
  /** The default branch, by full pref name. */
  const defaults = options.addonDefaults ? addonPrefDefaults() : new Map<string, FakePrefValue>();
  const resolve = (pref: string, global?: boolean) => (global ? pref : ZOTERO_PREF_BRANCH + pref);
  const read = (name: string) => (user.has(name) ? user.get(name) : defaults.get(name));

  return {
    user,
    defaults,
    get: vi.fn((pref: string, global?: boolean): FakePrefValue | undefined =>
      read(resolve(pref, global)),
    ),
    set: vi.fn((pref: string, value: unknown, global?: boolean): void => {
      const name = resolve(pref, global);
      const existing = read(name);
      if (typeof existing === "boolean") user.set(name, Boolean(value));
      else if (typeof existing === "string") user.set(name, String(value));
      else if (typeof existing === "number") user.set(name, Number(value) | 0);
      else if (typeof value === "boolean" || typeof value === "string") user.set(name, value);
      else if (Number.isInteger(value)) user.set(name, (value as number) | 0);
      else throw new Error(`Error setting preference '${name}'`);
    }),
    clear: vi.fn((pref: string, global?: boolean): void => {
      user.delete(resolve(pref, global));
    }),
  };
}

export type FakePrefs = ReturnType<typeof makeFakePrefs>;

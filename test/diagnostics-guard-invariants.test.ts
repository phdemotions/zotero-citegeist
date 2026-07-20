/**
 * Guards for the diagnostics layer.
 *
 * These lock two things that have already failed in production once:
 *
 * 1. **Every host callback is wrapped.** Zotero does nothing useful with an
 *    exception thrown from a callback it registered — a rejected
 *    `onAsyncRender` left the pane's loading spinner up forever, with no error
 *    and nothing for the user to report. A new entry point that ships unguarded
 *    reintroduces exactly that failure, silently, so the rule is machine-checked
 *    rather than left to review.
 *
 * 2. **Diagnostic codes are append-only.** A code is a permanent public
 *    identifier: a user quotes `CG-DB01` in an issue in 2027 and it must still
 *    mean what it meant when they hit it. Renumbering or reusing one silently
 *    invalidates every report that already cited it.
 *
 * Static source assertions, not behavioural ones — the point is that the
 * *shape of the code* can't drift, which no runtime test can observe.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  ALL_DIAGNOSTIC_CODES,
  DIAGNOSTIC_CODES,
  describeCode,
  clearDiagnostics,
  recentDiagnostics,
  recordDiagnostic,
  guard,
  guardAsync,
} from "../src/modules/diagnostics";
import { DIAGNOSTIC_RING_BUFFER_SIZE } from "../src/constants";

function src(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
}

describe("diagnostic code registry", () => {
  it("every entry's key matches its own code field", () => {
    for (const key of ALL_DIAGNOSTIC_CODES) {
      expect(DIAGNOSTIC_CODES[key].code).toBe(key);
    }
  });

  it("codes are unique and follow the CG-AREA## shape", () => {
    const seen = new Set<string>();
    for (const key of ALL_DIAGNOSTIC_CODES) {
      expect(key, `duplicate code ${key}`).not.toBe([...seen].find((s) => s === key));
      seen.add(key);
      expect(key).toMatch(/^CG-[A-Z]+\d{2}$/);
      expect(key.startsWith(`CG-${DIAGNOSTIC_CODES[key].area}`)).toBe(true);
    }
    expect(seen.size).toBe(ALL_DIAGNOSTIC_CODES.length);
  });

  it("every message is plain user-facing copy — no exception text, no 'Error:' prefix", () => {
    for (const key of ALL_DIAGNOSTIC_CODES) {
      const { message } = DIAGNOSTIC_CODES[key];
      expect(message.length, `${key} message too short to help`).toBeGreaterThan(20);
      expect(message, `${key} leads with a redundant Error: prefix`).not.toMatch(/^error:/i);
      // First person reads as the app apologizing rather than telling the user
      // what happened and what to do.
      expect(message, `${key} speaks in the first person`).not.toMatch(/\bI (can'?t|couldn'?t)\b/i);
    }
  });

  /**
   * The registry is append-only. This pins the codes that exist today; a
   * failure here means one was renamed or removed, which breaks every issue
   * that already quotes it. Adding a new code means adding it to this list —
   * deliberately, not incidentally.
   */
  it("retains every published code (append-only contract)", () => {
    const published = [
      "CG-NET01",
      "CG-API01",
      "CG-API42",
      "CG-API50",
      "CG-DB01",
      "CG-DB02",
      "CG-MATCH01",
      "CG-MATCH02",
      "CG-ID01",
      "CG-UI01",
      "CG-BUG01",
    ];
    for (const code of published) {
      expect(ALL_DIAGNOSTIC_CODES, `code ${code} was removed or renamed`).toContain(code);
    }
  });

  it("describeCode falls back to CG-BUG01 rather than throwing on an unknown code", () => {
    expect(describeCode("CG-NOPE99").code).toBe("CG-BUG01");
  });
});

describe("ring buffer", () => {
  beforeEach(() => clearDiagnostics());

  it("keeps the most recent entries and drops the oldest past the cap", () => {
    for (let i = 0; i < DIAGNOSTIC_RING_BUFFER_SIZE + 10; i++) {
      recordDiagnostic("CG-BUG01", `ctx${i}`, "boom");
    }
    const entries = recentDiagnostics();
    expect(entries).toHaveLength(DIAGNOSTIC_RING_BUFFER_SIZE);
    // Oldest-first, so the tail is the newest write.
    expect(entries[entries.length - 1].context).toBe(`ctx${DIAGNOSTIC_RING_BUFFER_SIZE + 9}`);
    expect(entries[0].context).toBe("ctx10");
  });

  it("hands out a copy — a caller cannot mutate the buffer", () => {
    recordDiagnostic("CG-BUG01", "ctx", "boom");
    recentDiagnostics().length = 0;
    expect(recentDiagnostics()).toHaveLength(1);
  });
});

describe("guard", () => {
  beforeEach(() => {
    clearDiagnostics();
    vi.stubGlobal("Zotero", { debug: vi.fn() });
  });

  it("swallows a throw, records it, and reports the code to the fallback", () => {
    const fallback = vi.fn();
    const out = guard(
      "unit",
      () => {
        throw new Error("boom");
      },
      fallback,
    );

    expect(out).toBeUndefined();
    expect(fallback).toHaveBeenCalledWith("CG-BUG01");
    expect(recentDiagnostics()[0]).toMatchObject({ code: "CG-BUG01", context: "unit" });
  });

  it("does not rethrow when the fallback itself throws", () => {
    expect(() =>
      guard(
        "unit",
        () => {
          throw new Error("boom");
        },
        () => {
          throw new Error("fallback also broke");
        },
      ),
    ).not.toThrow();
  });

  it("passes the value straight through on success", () => {
    expect(guard("unit", () => 42)).toBe(42);
    expect(recentDiagnostics()).toHaveLength(0);
  });

  it("guardAsync catches a rejection and resolves to undefined", async () => {
    const fallback = vi.fn();
    await expect(
      guardAsync("unit async", async () => Promise.reject(new Error("boom")), fallback),
    ).resolves.toBeUndefined();
    expect(fallback).toHaveBeenCalledWith("CG-BUG01");
  });
});

/**
 * Every function Zotero calls into must sit behind a boundary. Checked
 * statically because the failure mode is a *missing* wrapper — there is no
 * runtime signal to assert on until a user is already looking at a hung pane.
 */
describe("host entry points are guarded", () => {
  it("the pane wraps every callback Zotero invokes", () => {
    const pane = src("src/modules/citationPane.ts");
    for (const [callback, wrapper] of [
      ["onItemChange", "pane onItemChange"],
      ["onRender", "pane onRender"],
      ["onAsyncRender", "pane onAsyncRender"],
      ["sectionButtons refresh", "pane refresh button"],
      ["sectionButtons settings", "pane settings button"],
    ]) {
      expect(pane, `${callback} is not guarded`).toContain(`"${wrapper}"`);
    }
  });

  it("column dataProviders are guarded at the registration choke point", () => {
    const column = src("src/modules/citationColumn.ts");
    // Guarding inside safeRegister (rather than at each of the nine columns)
    // is what makes a column added later automatically protected.
    expect(column).toContain("column dataProvider");
    expect(column).toMatch(/const safeRegister[\s\S]{0,600}guard\(/);
  });

  it("menu handlers are guarded at the registration choke point", () => {
    const menu = src("src/modules/menu.ts");
    expect(menu).toContain("function guardMenus");
    // Both registered menu trees pass through the wrapper.
    expect(menu.match(/menus: guardMenus\(\[/g) ?? []).toHaveLength(2);
  });

  it("the network dialog binds every listener through bindGuarded", () => {
    for (const file of [
      "src/modules/citationNetwork/dialog.ts",
      "src/modules/citationNetwork/collectionPicker.ts",
    ]) {
      const text = src(file);
      // A raw addEventListener means a handler whose throw goes nowhere: the
      // click silently does nothing and the modal reads as frozen. The two
      // permitted exceptions are the `earlyClose` bindings, which must keep
      // their identity so removeEventListener can find them.
      const raw = [...text.matchAll(/\.addEventListener\(\s*"[^"]+"\s*,\s*(\S+)/g)]
        .map((m) => m[1])
        .filter((handler) => !handler.startsWith("earlyClose"));
      expect(raw, `${file} has raw listeners`).toEqual([]);
      expect(text).toContain("bindGuarded(");
    }
  });

  it("the dialog renders coded failure states instead of hand-written copy", () => {
    const dialog = src("src/modules/citationNetwork/dialog.ts");
    expect(dialog).toContain("renderDialogDiagnostic");
    expect(dialog).toContain("buildDiagnosticElement");
    // The old copy told the user nothing and gave a report nothing to quote.
    expect(dialog).not.toContain("An unexpected error occurred");
  });

  it("there is exactly one error classifier — codeForError, not a parallel mapper", () => {
    // profileErrorState mapped the same errors to a second, unrelated vocabulary.
    // Two classifiers drift; the registry is the single source.
    for (const file of ["src/modules/authorProfile.ts", "src/modules/citationNetwork/dialog.ts"]) {
      expect(src(file), `${file} still has a parallel classifier`).not.toContain(
        "profileErrorState",
      );
    }
  });

  it("logError is the single funnel that records — no module records directly", () => {
    const utils = src("src/modules/utils.ts");
    expect(utils).toContain("recordDiagnostic(codeForError(e), context, detail)");
    // A direct recordDiagnostic call elsewhere would bypass API-key redaction,
    // which only happens inside normalizeError.
    for (const file of [
      "src/modules/citationPane.ts",
      "src/modules/citationService.ts",
      "src/modules/openalex.ts",
      "src/modules/citationColumn.ts",
      "src/modules/menu.ts",
    ]) {
      expect(src(file), `${file} records diagnostics directly`).not.toContain("recordDiagnostic(");
    }
  });
});

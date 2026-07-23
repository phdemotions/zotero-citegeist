/**
 * Behavioral tests for the copy-paste diagnostic report.
 *
 * The report is designed to be pasted into public GitHub issues, so its privacy
 * behavior is load-bearing: the data-directory line must classify (local vs a
 * cloud-sync folder) WITHOUT emitting the raw path, which carries the OS
 * username. It must also never throw — a broken "Copy report" leaves the user
 * with no way forward.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

function stubZotero(dataDir: string): void {
  vi.stubGlobal("Zotero", {
    version: "9.0.1",
    platform: "MacIntel",
    locale: "en-US",
    debug: vi.fn(),
    DataDirectory: { dir: dataDir },
  });
}

import {
  buildDiagnosticReport,
  copyToClipboard,
  setPluginVersion,
  recordDiagnostic,
  clearDiagnostics,
} from "../src/modules/diagnostics";

beforeEach(() => {
  clearDiagnostics();
  setPluginVersion("3.0.0");
});

describe("buildDiagnosticReport", () => {
  it("classifies a cloud-sync data dir WITHOUT leaking the path or username", () => {
    stubZotero("/Users/janedoe/Library/CloudStorage/Box-Box/Zotero");
    const report = buildDiagnosticReport({});
    expect(report).toContain("cloud-sync");
    expect(report).not.toContain("janedoe");
    expect(report).not.toContain("/Users/");
  });

  it("classifies a plain local data dir as local, still no path", () => {
    stubZotero("/Users/janedoe/Zotero");
    const report = buildDiagnosticReport({});
    expect(report).toContain("local");
    expect(report).not.toContain("janedoe");
  });

  it("includes the build id, Zotero version, and platform", () => {
    stubZotero("/Users/x/Zotero");
    const report = buildDiagnosticReport({});
    expect(report).toContain("3.0.0");
    expect(report).toContain("9.0.1");
    expect(report).toContain("MacIntel");
    // __BUILD_ID__ is injected as "test" by vitest.config.ts — assert the
    // build-stamp line so a regression in it is caught.
    expect(report).toContain("build test");
  });

  it("renders the current code's message and lists recent problems", () => {
    stubZotero("/Users/x/Zotero");
    recordDiagnostic("CG-DB01", "cacheWorkData", "locked");
    const report = buildDiagnosticReport({ code: "CG-DB01", context: "cacheWorkData" });
    expect(report).toContain("CG-DB01");
    expect(report).toContain("cacheWorkData");
    expect(report).toContain("Recent problems (1)");
  });

  it("never throws — a host API that misbehaves still yields a report string", () => {
    vi.stubGlobal("Zotero", {
      debug: vi.fn(),
      get version(): string {
        throw new Error("host exploded");
      },
      DataDirectory: { dir: "/Users/x/Zotero" },
    });
    expect(() => buildDiagnosticReport({})).not.toThrow();
    expect(typeof buildDiagnosticReport({})).toBe("string");
  });
});

describe("copyToClipboard", () => {
  it("copies via Zotero and returns true when the clipboard API is available", () => {
    const copy = vi.fn();
    vi.stubGlobal("Zotero", {
      debug: vi.fn(),
      Utilities: { Internal: { copyTextToClipboard: copy } },
    });
    expect(copyToClipboard("hello")).toBe(true);
    expect(copy).toHaveBeenCalledWith("hello");
  });

  it("returns false instead of throwing when the clipboard API is missing", () => {
    // A failed copy must not take out the error panel it lives in.
    vi.stubGlobal("Zotero", { debug: vi.fn() });
    expect(copyToClipboard("x")).toBe(false);
  });
});

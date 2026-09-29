/**
 * Tests for logErrorUnlessBuffered (src/modules/diagnostics/logOnce.ts): a
 * failure a surface hits every time it opens records once while its entry is in
 * the ring buffer, and again once that entry is gone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DIAGNOSTIC_RING_BUFFER_SIZE } from "../src/constants";
import {
  clearDiagnostics,
  logErrorUnlessBuffered,
  recentDiagnostics,
} from "../src/modules/diagnostics";
import { CitegeistError, logError } from "../src/modules/utils";

beforeEach(() => {
  vi.stubGlobal("Zotero", { debug: vi.fn() });
  clearDiagnostics();
});

/** Built at one call site, so each error's detail, first stack frame included, is identical. */
const unreadable = (message = "pane rows are unreadable") => new CitegeistError(message, "CG-UI02");

const summary = () => recentDiagnostics().map((d) => [d.code, d.context]);

describe("logErrorUnlessBuffered", () => {
  it("records a failure as logError does", () => {
    logErrorUnlessBuffered("collection menu selection", unreadable());
    expect(summary()).toEqual([["CG-UI02", "collection menu selection"]]);
  });

  it("records a repeat once while the first entry is still buffered", () => {
    for (let i = 0; i < 5; i++) logErrorUnlessBuffered("collection menu selection", unreadable());
    expect(summary()).toHaveLength(1);
  });

  it("records the same failure on another surface, a different failure, and another code, each once", () => {
    const otherCode = () => new CitegeistError("pane rows are unreadable", "CG-BUG01");
    for (let i = 0; i < 2; i++) {
      logErrorUnlessBuffered("collection menu selection", unreadable());
      logErrorUnlessBuffered("network dialog default collection", unreadable());
      logErrorUnlessBuffered(
        "collection menu selection",
        unreadable("context rows are not an array"),
      );
      logErrorUnlessBuffered("collection menu selection", otherCode());
    }
    expect(recentDiagnostics().map((d) => [d.code, d.context, d.detail.split(" (")[0]])).toEqual([
      ["CG-UI02", "collection menu selection", "pane rows are unreadable"],
      ["CG-UI02", "network dialog default collection", "pane rows are unreadable"],
      ["CG-UI02", "collection menu selection", "context rows are not an array"],
      ["CG-BUG01", "collection menu selection", "pane rows are unreadable"],
    ]);
  });

  it("matches the context as logError stores it, redacted", () => {
    const context = "backup /Users/someone/Zotero/citegeist-backup.json";
    logErrorUnlessBuffered(context, unreadable());
    logErrorUnlessBuffered(context, unreadable());
    expect(recentDiagnostics()).toHaveLength(1);
    expect(recentDiagnostics()[0].context).not.toContain("someone");
  });

  it("records again once the earlier entry has left the buffer", () => {
    logErrorUnlessBuffered("collection menu selection", unreadable());
    for (let i = 0; i < DIAGNOSTIC_RING_BUFFER_SIZE; i++) {
      logError(`later failure ${i}`, new Error("unrelated"));
    }
    expect(recentDiagnostics().filter((d) => d.code === "CG-UI02")).toHaveLength(0);

    logErrorUnlessBuffered("collection menu selection", unreadable());
    expect(recentDiagnostics().filter((d) => d.code === "CG-UI02")).toHaveLength(1);
  });

  it("records again after the buffer is cleared", () => {
    logErrorUnlessBuffered("collection menu selection", unreadable());
    clearDiagnostics();
    logErrorUnlessBuffered("collection menu selection", unreadable());
    expect(summary()).toEqual([["CG-UI02", "collection menu selection"]]);
  });
});

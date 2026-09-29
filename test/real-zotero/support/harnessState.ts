/**
 * State the root hooks (00-root-hooks.spec.ts) share with the other spec files.
 *
 * scaffold bundles every spec file separately, so a module-level variable would
 * exist once per bundle. This state lives on the Mocha window's global object,
 * which every bundle shares.
 */
import type { ConsoleRecord } from "../shared/debugLines";
import { type ErrorLedger, allowInSuiteHooks, createErrorLedger } from "../shared/errorLedger";

export interface HarnessState {
  /** Every `[Citegeist] ERROR` line since launch, by test window and gap (shared/errorLedger.ts). */
  errorLedger: ErrorLedger;
  /** Error-line patterns the current test allows; cleared before every test. */
  allowedForTest: RegExp[];
  /** Every pattern any test or suite allowed, applied to the run-wide console check. */
  allowedForRun: RegExp[];
  /** The nsIConsoleListener the root before hook registered. */
  consoleListener: unknown;
  /** Console messages seen since recording began, including the backlog it started with. */
  consoleMessagesSeen: number;
  /** Errors and chrome-registration messages kept for the run-wide check. */
  consoleRecords: ConsoleRecord[];
}

const STATE_KEY = Symbol.for("citegeist.realZotero.harnessState");

export function harnessState(): HarnessState {
  const holder = globalThis as unknown as Record<symbol, HarnessState | undefined>;
  holder[STATE_KEY] ??= {
    errorLedger: createErrorLedger(),
    allowedForTest: [],
    allowedForRun: [],
    consoleListener: undefined,
    consoleMessagesSeen: 0,
    consoleRecords: [],
  };
  return holder[STATE_KEY];
}

/**
 * Let the current test log `[Citegeist] ERROR` lines matching `patterns` without
 * failing. Call it from the test body or from a beforeEach in the spec. The
 * patterns also excuse matching console errors in the run-wide check. Patterns
 * must not be global.
 */
export function allowCitegeistErrors(...patterns: RegExp[]): void {
  const state = harnessState();
  state.allowedForTest.push(...patterns);
  state.allowedForRun.push(...patterns);
}

/**
 * Let `[Citegeist] ERROR` lines matching `patterns` pass when the calling
 * describe logs them outside its tests: in its before and after hooks, and
 * between its tests, where a session a hook or a test started may still be
 * logging. Call it in the describe body, for a suite that provokes those lines
 * on purpose. A line inside a test still needs that test's allowCitegeistErrors,
 * so a suite never widens what its tests allow. The patterns also excuse
 * matching console errors in the run-wide check. Patterns must not be global.
 */
export function allowCitegeistErrorsInSuiteHooks(...patterns: RegExp[]): void {
  // Registered at load time, recorded when the suite starts: the ledger judges a
  // gap only once the next test starts or the run ends, so an allowance recorded
  // by any before hook of the suite is in place for every line of its gaps.
  before(function () {
    const state = harnessState();
    allowInSuiteHooks(state.errorLedger, this.test.parent, patterns);
    state.allowedForRun.push(...patterns);
  });
}

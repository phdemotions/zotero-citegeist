/**
 * State the root hooks (00-root-hooks.spec.ts) share with the other spec files.
 *
 * scaffold bundles every spec file separately, so a module-level variable would
 * exist once per bundle. This state lives on the Mocha window's global object,
 * which every bundle shares.
 */
import type { ConsoleRecord } from "../shared/debugLines";

export interface HarnessState {
  /** `[Citegeist] ERROR` lines Debug Output held when the current test began. */
  errorLinesBefore: string[];
  /** Error-line patterns the current test allows; cleared before every test. */
  allowedForTest: RegExp[];
  /** Every pattern any test allowed, applied to the run-wide console check. */
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
    errorLinesBefore: [],
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

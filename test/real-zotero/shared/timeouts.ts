/**
 * Every deadline in the real-Zotero suite.
 *
 * Pure, so the specs running inside Zotero, the scaffold config and
 * test/realZoteroHarness.test.ts all import the same numbers. The unit test
 * fails if any budget below composes waits that could outlast the Mocha timeout
 * governing them: a wait that outlives its Mocha timeout fails with Mocha's bare
 * "Timeout of N ms exceeded" instead of naming what it waited for.
 */

/** How often `waitFor` re-checks a host condition. */
export const POLL_INTERVAL_MS = 50;
/** Longest a spec waits on one host condition: a row, a section, a window. */
export const WAIT_TIMEOUT_MS = 20_000;
/** Citegeist's first startup on a cold CI profile, which creates the SQLite cache. */
export const READY_WAIT_TIMEOUT_MS = 90_000;
/** Startup after enable or upgrade, which reopens the existing cache. */
export const STARTUP_WAIT_TIMEOUT_MS = 45_000;
/** Shutdown after disable or upgrade, through the "[Citegeist] Shutdown complete" line. */
export const SHUTDOWN_WAIT_TIMEOUT_MS = 30_000;
/** scaffold's pause before it opens the Mocha window. It treats 0 as 1000. */
export const SCAFFOLD_STARTUP_DELAY_MS = 1_000;
/** Mocha's default per-test and per-hook timeout (scaffold `test.mocha.timeout`). */
export const SPEC_TIMEOUT_MS = 60_000;
/** Headroom over a composed wait for the host work between its waits. */
export const TIMEOUT_MARGIN_MS = 10_000;

export interface WaitBudget {
  /** Deadlines one test or hook can spend in sequence, worst case. */
  readonly waits: readonly number[];
  /** The Mocha timeout governing them; tests and hooks pass it to `this.timeout()`. */
  readonly timeoutMs: number;
}

const total = (waits: readonly number[]): number => waits.reduce((sum, wait) => sum + wait, 0);

/** A budget whose Mocha timeout is sized from its own waits. */
function sized(...waits: number[]): WaitBudget {
  return { waits, timeoutMs: total(waits) + TIMEOUT_MARGIN_MS };
}

/** A budget that must fit Mocha's default timeout. */
function standard(...waits: number[]): WaitBudget {
  return { waits, timeoutMs: SPEC_TIMEOUT_MS };
}

export const BUDGETS = {
  /** 00 root before hook: Citegeist's first startup. */
  rootReady: sized(READY_WAIT_TIMEOUT_MS),
  /** useStubItem({ select: true }): the row appears, then the item pane loads it. */
  selectStubItem: sized(WAIT_TIMEOUT_MS, WAIT_TIMEOUT_MS),
  /** 03: the section, then its hero metric. */
  itemPane: standard(WAIT_TIMEOUT_MS, WAIT_TIMEOUT_MS),
  /** 04 before hook: the sidenav button. */
  iconSidenav: standard(WAIT_TIMEOUT_MS),
  /** 04: the theme switch. */
  iconTheme: standard(WAIT_TIMEOUT_MS),
  /** 05: the row and cell render, then the cell repaints with the stub's count. */
  columnRepaint: standard(WAIT_TIMEOUT_MS, WAIT_TIMEOUT_MS),
  /** 06: the settings window, then the Citegeist pane. */
  preferencePane: standard(WAIT_TIMEOUT_MS, WAIT_TIMEOUT_MS),
  /** 90: shutdown complete, add-on inactive, section removed. */
  lifecycleDisable: sized(SHUTDOWN_WAIT_TIMEOUT_MS, WAIT_TIMEOUT_MS, WAIT_TIMEOUT_MS),
  /** 90: startup after enable, then exactly one section. */
  lifecycleEnable: sized(STARTUP_WAIT_TIMEOUT_MS, WAIT_TIMEOUT_MS),
  /** 90 upgrade before hook: startup, when an earlier test left Citegeist disabled. */
  lifecycleEnsureReady: sized(STARTUP_WAIT_TIMEOUT_MS),
  /** 90: the old copy's shutdown, the new copy's startup, then exactly one section. */
  lifecycleUpgrade: sized(SHUTDOWN_WAIT_TIMEOUT_MS, STARTUP_WAIT_TIMEOUT_MS, WAIT_TIMEOUT_MS),
  /** 92: row, item pane, section, Citing works button, then the citing-works request. */
  preferencePageSize: sized(
    WAIT_TIMEOUT_MS,
    WAIT_TIMEOUT_MS,
    WAIT_TIMEOUT_MS,
    WAIT_TIMEOUT_MS,
    WAIT_TIMEOUT_MS,
  ),
  /** 92 before hook: startup, when an earlier spec left Citegeist disabled. */
  preferenceEnsureReady: sized(STARTUP_WAIT_TIMEOUT_MS),
  /** 92: two restarts, each the old copy's shutdown then the new copy's startup. */
  preferenceLegacyFlag: sized(
    SHUTDOWN_WAIT_TIMEOUT_MS,
    STARTUP_WAIT_TIMEOUT_MS,
    SHUTDOWN_WAIT_TIMEOUT_MS,
    STARTUP_WAIT_TIMEOUT_MS,
  ),
} as const satisfies Record<string, WaitBudget>;

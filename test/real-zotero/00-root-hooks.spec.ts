/**
 * Root hooks for the real-Zotero suite, and the rule for numbering spec files.
 *
 * File order is run order: scaffold loads the bundled spec files sorted by
 * name. 00 holds these hooks. 01-89 are specs that leave Citegeist running.
 * 90-99 are for specs that disable, reload, restart or quit Citegeist, so they
 * run after every spec that expects the copy Zotero started with. A `*.todo.ts`
 * file is not collected; its number only holds its place.
 *
 * Spec files register describe, it and hooks at load time and touch no host
 * object until a test or hook runs: the scaffold config evaluates every bundle
 * outside Zotero to count the tests CI requires to pass.
 *
 * Every `[Citegeist] ERROR` line from launch to the end of the run is judged
 * once, by the test window or the gap it was logged in (shared/errorLedger.ts):
 *
 * - before: record console messages for the whole run, then wait for
 *   Citegeist's first startup. scaffold's own wait gives up after 10 s and still
 *   exits 0, so the config switches it off and a slow start fails here instead,
 *   as a Mocha failure scaffold reports, with the logs still written.
 * - beforeEach: close the gap before this test (startup, suite hooks, the time
 *   since the last test) and open the test's window.
 * - afterEach: fail the test if Citegeist logged an error line in its window that
 *   the test did not allow (allowCitegeistErrors).
 * - after: close the last gap, write Debug Output, Zotero's errors and
 *   Citegeist's console problems to CITEGEIST_REAL_ZOTERO_LOG_DIR, then fail if
 *   a gap held an error line no suite around it allowed
 *   (allowCitegeistErrorsInSuiteHooks), or if there were console problems.
 */
import { type ConsoleRecord, formatConsoleRecord } from "./shared/debugLines";
import {
  type LedgerTest,
  type StrayLine,
  closeGap,
  closeTestWindow,
  formatStrayLines,
} from "./shared/errorLedger";
import { LOG_DIR_ENV } from "./shared/env";
import { BUDGETS, READY_WAIT_TIMEOUT_MS } from "./shared/timeouts";
import { harnessState } from "./support/harnessState";
import {
  citegeistErrorLines,
  startConsoleRecorder,
  stopConsoleRecorder,
  waitForCitegeistReady,
} from "./support/zotero";

/** The parts of a Mocha test and its suites the ledger reads. */
interface MochaTest {
  fullTitle(): string;
  parent?: MochaSuite;
}
interface MochaSuite {
  parent?: MochaSuite;
}

/** A Mocha test as the error ledger sees it: its full title and every suite it sits in. */
function ledgerTest(test: MochaTest): LedgerTest {
  const suites: MochaSuite[] = [];
  for (let suite = test.parent; suite; suite = suite.parent) suites.push(suite);
  return { title: test.fullTitle(), suites };
}

before(async function () {
  this.timeout(BUDGETS.rootReady.timeoutMs);
  startConsoleRecorder();
  await waitForCitegeistReady("Citegeist to finish its first startup", READY_WAIT_TIMEOUT_MS);
});

beforeEach(function () {
  const state = harnessState();
  // Only records what the gap held; the after hook fails on it. A failure raised
  // here, in a root beforeEach, would skip every remaining test.
  closeGap(state.errorLedger, citegeistErrorLines(), ledgerTest(this.currentTest));
  state.allowedForTest = [];
});

afterEach(function () {
  const state = harnessState();
  const unexpected = closeTestWindow(
    state.errorLedger,
    citegeistErrorLines(),
    ledgerTest(this.currentTest),
    state.allowedForTest,
  );
  if (unexpected.length === 0) return;
  // `this.test` is this hook. error() has Mocha fail the test that just ran and
  // carry on; a throw from a root afterEach would skip every remaining test.
  this.test.error(
    new Error(
      `Citegeist logged ${unexpected.length} error line(s) during this test ` +
        `(a spec that expects one calls allowCitegeistErrors):\n${unexpected.join("\n")}`,
    ),
  );
});

after(async function () {
  const state = harnessState();
  let strays: readonly StrayLine[] = [];
  let problems: ConsoleRecord[] = [];
  let failure: unknown = null;
  try {
    closeGap(state.errorLedger, citegeistErrorLines(), null);
    strays = state.errorLedger.strays;
  } catch (e) {
    failure = e;
  }
  try {
    problems = await stopConsoleRecorder();
  } catch (e) {
    failure ??= e;
  }
  try {
    await writeRunLogs(problems);
  } catch (e) {
    failure ??= e;
  }
  // An after-all hook has no current test to hand an error to, so once the logs
  // are on disk it fails itself, which scaffold counts as a failure.
  const reports: string[] = [];
  if (strays.length > 0) {
    reports.push(
      `Citegeist logged ${strays.length} error line(s) outside every test, at startup, in a ` +
        `suite's before or after hook, or between tests (a suite that expects one calls ` +
        `allowCitegeistErrorsInSuiteHooks):\n${formatStrayLines(strays)}`,
    );
  }
  if (problems.length > 0) {
    reports.push(
      `Citegeist caused ${problems.length} console problem(s) during the run:\n` +
        problems.map(formatConsoleRecord).join("\n"),
    );
  }
  if (reports.length > 0) throw new Error(reports.join("\n\n"));
  if (failure) throw failure;
});

async function writeRunLogs(consoleProblems: readonly ConsoleRecord[]): Promise<void> {
  const dir: string = Services.env.get(LOG_DIR_ENV);
  if (!dir) return;
  await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
  const prefix = PathUtils.join(dir, `zotero-${Zotero.version}`);
  await IOUtils.writeUTF8(
    `${prefix}-debug-output.txt`,
    Zotero.Debug.getConsoleViewerOutput().join("\n"),
  );
  await IOUtils.writeUTF8(`${prefix}-errors.txt`, Zotero.getErrors(true).join("\n\n"));
  await IOUtils.writeUTF8(
    `${prefix}-citegeist-console.txt`,
    consoleProblems.map(formatConsoleRecord).join("\n\n"),
  );
}

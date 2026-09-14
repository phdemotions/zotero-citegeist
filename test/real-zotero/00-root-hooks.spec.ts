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
 * - before: record console messages for the whole run, then wait for
 *   Citegeist's first startup. scaffold's own wait gives up after 10 s and still
 *   exits 0, so the config switches it off and a slow start fails here instead,
 *   as a Mocha failure scaffold reports, with the logs still written.
 * - beforeEach and afterEach: fail any test during which Citegeist logged an
 *   `[Citegeist] ERROR` line its spec did not allow (allowCitegeistErrors).
 * - after: write Debug Output, Zotero's errors and Citegeist's console problems
 *   to CITEGEIST_REAL_ZOTERO_LOG_DIR, then fail if there were console problems.
 */
import { type ConsoleRecord, formatConsoleRecord, unexpectedLines } from "./shared/debugLines";
import { LOG_DIR_ENV } from "./shared/env";
import { BUDGETS, READY_WAIT_TIMEOUT_MS } from "./shared/timeouts";
import { harnessState } from "./support/harnessState";
import {
  citegeistErrorLines,
  startConsoleRecorder,
  stopConsoleRecorder,
  waitForCitegeistReady,
} from "./support/zotero";

before(async function () {
  this.timeout(BUDGETS.rootReady.timeoutMs);
  startConsoleRecorder();
  await waitForCitegeistReady("Citegeist to finish its first startup", READY_WAIT_TIMEOUT_MS);
});

beforeEach(function () {
  const state = harnessState();
  state.errorLinesBefore = citegeistErrorLines();
  state.allowedForTest = [];
});

afterEach(function () {
  const state = harnessState();
  const unexpected = unexpectedLines(
    state.errorLinesBefore,
    citegeistErrorLines(),
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
  let problems: ConsoleRecord[] = [];
  let failure: unknown = null;
  try {
    problems = await stopConsoleRecorder();
  } catch (e) {
    failure = e;
  }
  try {
    await writeRunLogs(problems);
  } catch (e) {
    failure ??= e;
  }
  // An after-all hook has no current test to hand an error to, so once the logs
  // are on disk it fails itself, which scaffold counts as a failure.
  if (problems.length > 0) {
    throw new Error(
      `Citegeist caused ${problems.length} console problem(s) during the run:\n` +
        problems.map(formatConsoleRecord).join("\n"),
    );
  }
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

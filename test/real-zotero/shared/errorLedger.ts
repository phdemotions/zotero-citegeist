/**
 * The run's account of Citegeist's `[Citegeist] ERROR` Debug Output lines, so
 * every line from launch to the end of the run is judged exactly once.
 *
 * The root hooks (00-root-hooks.spec.ts) cut the run at each test boundary. A
 * line logged inside a test's window, from the root beforeEach to the root
 * afterEach, belongs to that test, and the root afterEach fails the test unless
 * the test allowed the line. Every other line falls in a gap: logged at
 * startup, in a suite's before or after hook, or between two tests, where work a
 * hook or a test started may still be logging. A gap line passes only when a
 * suite around the gap allowed it for its hooks, and the root after hook fails
 * the run on the rest.
 *
 * Gaps are as fine as the root hooks can see: a gap between two tests holds the
 * after hooks of every suite the first test leaves and the before hooks of every
 * suite the second enters, so an allowance from any of those suites, or from a
 * suite holding both tests, covers the whole gap.
 *
 * Pure, and it never sees Mocha: a suite is an opaque key, so
 * test/realZoteroHarness.test.ts drives the ledger directly.
 */
import { linesAdded } from "./debugLines";

/** A test as the ledger sees it. */
export interface LedgerTest {
  /** The test's full title, for failure messages. */
  readonly title: string;
  /** Every suite the test sits in, innermost first, as opaque keys. */
  readonly suites: readonly unknown[];
}

/** A gap line no suite allowed, and the gap it was logged in. */
export interface StrayLine {
  readonly line: string;
  readonly where: string;
}

export interface ErrorLedger {
  /** The error lines Debug Output held at the last test boundary; none at launch. */
  checkpoint: string[];
  /** The test whose window closed last; null until one has. */
  lastTest: LedgerTest | null;
  /** The patterns each suite allowed in its hooks and between its tests. */
  readonly suiteAllowances: Map<unknown, RegExp[]>;
  /** Gap lines no suite allowed, oldest first. */
  readonly strays: StrayLine[];
}

export function createErrorLedger(): ErrorLedger {
  return { checkpoint: [], lastTest: null, suiteAllowances: new Map(), strays: [] };
}

/** Let gap lines matching `patterns` pass around `suite`'s tests. Patterns must not be global. */
export function allowInSuiteHooks(
  ledger: ErrorLedger,
  suite: unknown,
  patterns: readonly RegExp[],
): void {
  const allowed = ledger.suiteAllowances.get(suite) ?? [];
  allowed.push(...patterns);
  ledger.suiteAllowances.set(suite, allowed);
}

/**
 * Close the gap that ends as `next` starts, or as the run ends when `next` is
 * null. `now` is every error line Debug Output holds at this moment. Lines the
 * gap added that no suite of the tests on either side allowed become strays.
 */
export function closeGap(
  ledger: ErrorLedger,
  now: readonly string[],
  next: LedgerTest | null,
): void {
  const added = linesAdded(ledger.checkpoint, now);
  ledger.checkpoint = [...now];
  if (added.length === 0) return;
  const around = new Set([...(ledger.lastTest?.suites ?? []), ...(next?.suites ?? [])]);
  const allowed = [...around].flatMap((suite) => ledger.suiteAllowances.get(suite) ?? []);
  const where = gapName(ledger.lastTest, next);
  for (const line of added) {
    if (!allowed.some((pattern) => pattern.test(line))) ledger.strays.push({ line, where });
  }
}

/**
 * Close `test`'s window, and return the lines it added that `allowed`, the
 * test's own allowances, does not excuse. `now` is every error line Debug
 * Output holds at this moment. A suite's hook allowances never apply here.
 */
export function closeTestWindow(
  ledger: ErrorLedger,
  now: readonly string[],
  test: LedgerTest,
  allowed: readonly RegExp[],
): string[] {
  const added = linesAdded(ledger.checkpoint, now);
  ledger.checkpoint = [...now];
  ledger.lastTest = test;
  return added.filter((line) => !allowed.some((pattern) => pattern.test(line)));
}

function gapName(last: LedgerTest | null, next: LedgerTest | null): string {
  if (last && next) return `between "${last.title}" and "${next.title}"`;
  if (next) return `at startup or before the first test, "${next.title}"`;
  if (last) return `after the last test, "${last.title}"`;
  return "before any test ran";
}

/** One stray per line, each after the gap it was logged in. */
export function formatStrayLines(strays: readonly StrayLine[]): string {
  return strays.map(({ line, where }) => `${where}: ${line}`).join("\n");
}

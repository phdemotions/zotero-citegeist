/**
 * Promotion: how scripts/build.mjs makes a verified staging copy current. build/.addon-staging
 * becomes build/addon through build/.addon-previous, so the last copy that passed is never deleted
 * before its replacement is in place, and a build finishes any swap an earlier build left half
 * done.
 */
import { existsSync, renameSync, rmSync } from "node:fs";

// On Windows an antivirus scanner or search indexer opens files just written, and renaming the
// directory that holds one fails with one of these codes until it closes the file. Scanning a
// large file takes seconds, so graceful-fs retries a rename on these codes for up to 60 s. The
// build does the same, waiting 10 ms after the first failure and doubling each wait up to 1 s, so
// a lock that clears at once costs milliseconds and one that holds for seconds still clears.
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_RETRY_FIRST_WAIT_MS = 10;
const RENAME_RETRY_MAX_WAIT_MS = 1000;
const RENAME_RETRY_TOTAL_MS = 60_000;

/**
 * Renames `from` to `to`, retrying a rename that fails with a lock code until it succeeds or
 * RENAME_RETRY_TOTAL_MS has passed since the first attempt, and then throwing the last attempt's
 * error. Any other error throws at once, and so does a lock code while `to` exists: Windows
 * reports a destination in the way with EPERM too, and waiting does not move it (graceful-fs
 * stops there as well). `now` and `sleep` stand in for the clock in tests.
 */
export function renameWithRetry(
  from,
  to,
  { rename = renameSync, exists = existsSync, now = Date.now, sleep = sleepSync } = {},
) {
  const start = now();
  let wait = RENAME_RETRY_FIRST_WAIT_MS;
  for (;;) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      if (!RETRYABLE_RENAME_CODES.has(error?.code)) throw error;
      const remaining = RENAME_RETRY_TOTAL_MS - (now() - start);
      if (remaining <= 0 || exists(to)) throw error;
      sleep(Math.min(wait, remaining));
      wait = Math.min(wait * 2, RENAME_RETRY_MAX_WAIT_MS);
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Finishes a promotion an earlier build was interrupted in. With `target` missing and `previous`
 * present, that build stopped after moving the last good copy aside, so it moves back. With both
 * present, the swap finished and `previous` is a redundant older copy, so it goes.
 */
export function recoverInterruptedPromotion({ target, previous }, renameOptions) {
  if (!existsSync(previous)) return;
  if (existsSync(target)) {
    rmSync(previous, { recursive: true, force: true, maxRetries: 3 });
  } else {
    renameWithRetry(previous, target, renameOptions);
  }
}

/**
 * Replaces `target` with `staging` without deleting the last good copy before its replacement is
 * in place: `target` moves aside to `previous`, `staging` moves in, and only then does `previous`
 * go. If `staging` cannot move in, `previous` moves back before the error propagates. If that
 * fails too, the copy stays at `previous` and `recoverInterruptedPromotion` restores it.
 *
 * Once `staging` has moved in, the promotion has succeeded, so a failure to delete `previous`,
 * such as EBUSY while Windows still holds a file in it open, prints a warning instead of throwing.
 * The next build's `recoverInterruptedPromotion` deletes the leftover.
 */
export function promoteStaging({ staging, target, previous }, renameOptions) {
  recoverInterruptedPromotion({ target, previous }, renameOptions);
  const hadTarget = existsSync(target);
  if (hadTarget) renameWithRetry(target, previous, renameOptions);
  try {
    renameWithRetry(staging, target, renameOptions);
  } catch (error) {
    if (hadTarget) {
      try {
        renameWithRetry(previous, target, renameOptions);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Could not move ${staging} to ${target}, nor move the last good copy back from ` +
            `${previous}; the next build restores it from there`,
          { cause: restoreError },
        );
      }
    }
    throw error;
  }
  try {
    rmSync(previous, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    console.warn(
      `\n  Warning: ${target} holds the new copy, but deleting the previous copy at ${previous} ` +
        `failed: ${error.message}. The next build deletes it.`,
    );
  }
}

/**
 * Promotion: how scripts/build.mjs makes a verified staging copy current. build/.addon-staging
 * becomes build/addon through build/.addon-previous, so the last copy that passed is never deleted
 * before its replacement is in place, and a build finishes any swap an earlier build left half
 * done.
 */
import { existsSync, renameSync, rmSync } from "node:fs";

// Windows, antivirus and indexing tools briefly lock a directory that was just written, and a
// rename then fails with one of these codes. graceful-fs retries renames on the same three.
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Renames `from` to `to`, retrying a rename that fails with a lock code up to `attempts` times
 * in all, pausing `delayMs` times the attempt number between tries. Any other error, and the
 * last locked attempt's error, propagates.
 */
export function renameWithRetry(
  from,
  to,
  { rename = renameSync, attempts = 5, delayMs = 50 } = {},
) {
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts || !RETRYABLE_RENAME_CODES.has(error?.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs * attempt);
    }
  }
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

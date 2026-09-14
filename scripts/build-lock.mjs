/**
 * The build lock. Two builds in one checkout share build/.addon-staging, and each deletes what the
 * other left in build/, so one can exit 0 and print its XPI's SHA-256 while build/ holds only
 * build/addon. scripts/build.mjs takes build/.build.lock before it changes anything in build/, and
 * a second build stops there, naming the pid of the build that holds it.
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

// A build creates its lock and then writes its pid into it, so another build can find the lock
// empty for that moment, and a build removing a stale lock holds a mark for as long as two file
// operations take. A build that finds either reads the lock again every LOCK_POLL_MS, and gives up
// after LOCK_WAIT_MS, far longer than either step takes, since what it waits on has then stopped.
const LOCK_POLL_MS = 10;
const LOCK_WAIT_MS = 2000;

/**
 * Takes the lock at `lockPath`, created with this process's pid and the time, and returns
 * `{ release, recoveredFrom }`. `release` deletes the lock while it is still this build's, and
 * does nothing after the first call. `recoveredFrom` is the `{ pid, startedAt }` of a stale lock
 * this call replaced, or undefined.
 *
 * A lock whose pid is running throws, naming the pid. A lock whose pid is not running, or is this
 * process's own, was left by a build that was killed, and is replaced. Two builds can find the
 * same stale lock at once, so each removes it only under the mark `removalMarkFor` names, which
 * one of them can create, and only if the lock still holds what it read.
 */
export function acquireBuildLock(
  lockPath,
  { pid = process.pid, isRunning = processIsRunning, sleep = sleepSync } = {},
) {
  const content = `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`;
  let recoveredFrom;
  let waitedMs = 0;
  const wait = (timeoutError) => {
    if (waitedMs >= LOCK_WAIT_MS) throw timeoutError();
    sleep(LOCK_POLL_MS);
    waitedMs += LOCK_POLL_MS;
  };

  for (;;) {
    if (createExclusive(lockPath, content)) {
      let released = false;
      return {
        recoveredFrom,
        release() {
          if (released) return;
          released = true;
          if (readIfPresent(lockPath) === content) rmSync(lockPath, { force: true });
        },
      };
    }

    const held = readIfPresent(lockPath);
    // Its holder released it after this build tried to create it.
    if (held === undefined) continue;
    const holder = parseHolder(held);
    if (holder === undefined) {
      wait(() => unreadableLockError(lockPath, held));
      continue;
    }
    if (holder.pid !== pid && isRunning(holder.pid)) throw heldLockError(lockPath, holder);

    const removal = removeStaleLock(lockPath, held);
    if (removal === "removed") recoveredFrom = holder;
    if (removal === "busy") wait(() => stuckRemovalError(lockPath, held, holder));
  }
}

/**
 * The file a build creates, with the lock's own exclusive create, before it removes the stale lock
 * holding `staleContent`. Its name comes from that content, so only one build removes a given
 * stale lock, and a lock taken after it gets a different mark.
 */
export function removalMarkFor(lockPath, staleContent) {
  const digest = createHash("sha256").update(staleContent).digest("hex").slice(0, 16);
  return `${lockPath}.removing-${digest}`;
}

/**
 * Removes the lock if it still holds `staleContent`, under that content's removal mark. Returns
 * "removed", "replaced" when the lock no longer holds that content, which leaves it alone, or
 * "busy" when another build holds the mark.
 */
function removeStaleLock(lockPath, staleContent) {
  const mark = removalMarkFor(lockPath, staleContent);
  if (!createExclusive(mark, "")) return "busy";
  try {
    if (readIfPresent(lockPath) !== staleContent) return "replaced";
    rmSync(lockPath, { force: true });
    return "removed";
  } finally {
    rmSync(mark, { force: true });
  }
}

/** Creates `path` holding `content` unless it exists. Returns whether it created it. */
function createExclusive(path, content) {
  let fd;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  try {
    if (content !== "") writeSync(fd, content);
  } catch (error) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw error;
  }
  closeSync(fd);
  return true;
}

function readIfPresent(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** The `{ pid, startedAt }` a lock names, or undefined while it is empty or partly written. */
function parseHolder(content) {
  let holder;
  try {
    holder = JSON.parse(content);
  } catch {
    return undefined;
  }
  const { pid, startedAt } = holder ?? {};
  return Number.isSafeInteger(pid) && pid > 0 && typeof startedAt === "string"
    ? { pid, startedAt }
    : undefined;
}

/** A pid names a running process if signal 0 reaches it, or if it exists but belongs to another user. */
function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function heldLockError(lockPath, { pid, startedAt }) {
  return new Error(
    `Another build is running in this checkout: ${lockPath} is held by pid ${pid}, which took it ` +
      `at ${startedAt} and is still running. Two builds in one checkout delete each other's ` +
      `output, so this build stopped before changing anything in build/. Build again once pid ` +
      `${pid} exits, or delete ${lockPath} if that process is not a build.`,
  );
}

function unreadableLockError(lockPath, content) {
  return new Error(
    `${lockPath} names no build: it holds ${JSON.stringify(content)}. A build writes its pid ` +
      `there as it creates the file, so the build that created this one stopped at that moment. ` +
      `If no build is running, delete ${lockPath}.`,
  );
}

function stuckRemovalError(lockPath, content, { pid }) {
  const mark = removalMarkFor(lockPath, content);
  return new Error(
    `${lockPath} is held by pid ${pid}, which is not running, and another build began removing ` +
      `it but stopped: ${mark} is still there. If no build is running, delete both files.`,
  );
}

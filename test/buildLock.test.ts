import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { acquireBuildLock, removalMarkFor } from "../scripts/build-lock.mjs";

const THIS_BUILD = 1001;
const RUNNING = 4242;
const STOPPED = 4343;
const isRunning = (pid: number) => pid === RUNNING;
const noSleep = () => {};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "citegeist-lock-"));
  tempDirs.push(dir);
  return join(dir, ".build.lock");
}

function lockOf(pid: number, startedAt = "2026-09-13T08:00:00.000Z"): string {
  return `${JSON.stringify({ pid, startedAt })}\n`;
}

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the call to throw");
}

describe("acquireBuildLock", () => {
  it("takes a free lock with this build's pid and start time, and release deletes it once", () => {
    const path = lockPath();

    const lock = acquireBuildLock(path, { pid: THIS_BUILD, isRunning, sleep: noSleep });

    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.pid).toBe(THIS_BUILD);
    expect(Number.isNaN(Date.parse(written.startedAt))).toBe(false);
    expect(lock.recoveredFrom).toBeUndefined();
    lock.release();
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, lockOf(RUNNING));
    lock.release();
    expect(readFileSync(path, "utf8")).toBe(lockOf(RUNNING));
  });

  it("refuses a lock whose pid is running, naming the pid, and leaves the lock in place", () => {
    const path = lockPath();
    writeFileSync(path, lockOf(RUNNING));

    const message = thrownMessage(() =>
      acquireBuildLock(path, { pid: THIS_BUILD, isRunning, sleep: noSleep }),
    );

    expect(message).toContain(`${path} is held by pid ${RUNNING}`);
    expect(message).toContain("stopped before changing anything in build/");
    expect(readFileSync(path, "utf8")).toBe(lockOf(RUNNING));
  });

  it("replaces a lock whose pid is not running, reporting the build that left it", () => {
    const path = lockPath();
    writeFileSync(path, lockOf(STOPPED));

    const lock = acquireBuildLock(path, { pid: THIS_BUILD, isRunning, sleep: noSleep });

    expect(lock.recoveredFrom).toEqual({ pid: STOPPED, startedAt: "2026-09-13T08:00:00.000Z" });
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(THIS_BUILD);
    // The removal mark goes with the stale lock.
    expect(readdirSync(join(path, ".."))).toEqual([".build.lock"]);
  });

  it("replaces a lock naming this process's own pid, left by an earlier build whose pid was reused", () => {
    const path = lockPath();
    writeFileSync(path, lockOf(THIS_BUILD));

    const lock = acquireBuildLock(path, { pid: THIS_BUILD, isRunning: () => true, sleep: noSleep });

    expect(lock.recoveredFrom?.pid).toBe(THIS_BUILD);
  });

  it("waits for a build that has created its lock but not yet written its pid", () => {
    const path = lockPath();
    writeFileSync(path, "");
    let sleeps = 0;
    const sleep = () => {
      sleeps++;
      if (sleeps === 3) writeFileSync(path, lockOf(RUNNING));
    };

    expect(() => acquireBuildLock(path, { pid: THIS_BUILD, isRunning, sleep })).toThrow(
      `is held by pid ${RUNNING}`,
    );
    expect(sleeps).toBe(3);
  });

  it("refuses a lock that stays empty for 2 seconds, naming it and leaving it in place", () => {
    const path = lockPath();
    writeFileSync(path, "");
    const slept: number[] = [];

    const message = thrownMessage(() =>
      acquireBuildLock(path, { pid: THIS_BUILD, isRunning, sleep: (ms) => slept.push(ms) }),
    );

    expect(message).toContain(`${path} names no build`);
    expect(slept.reduce((total, ms) => total + ms, 0)).toBe(2000);
    expect(existsSync(path)).toBe(true);
  });

  it("never deletes a lock another build took after removing the stale lock this build found", () => {
    const path = lockPath();
    writeFileSync(path, lockOf(STOPPED));
    // Between this build reading the stale lock and removing it, another build removes it and
    // takes the lock.
    const racingIsRunning = (pid: number) => {
      if (pid === STOPPED) {
        rmSync(path);
        writeFileSync(path, lockOf(RUNNING));
        return false;
      }
      return isRunning(pid);
    };

    expect(() =>
      acquireBuildLock(path, { pid: THIS_BUILD, isRunning: racingIsRunning, sleep: noSleep }),
    ).toThrow(`is held by pid ${RUNNING}`);
    expect(readFileSync(path, "utf8")).toBe(lockOf(RUNNING));
  });

  it("waits while another build removes the same stale lock, then refuses the lock that build took", () => {
    const path = lockPath();
    const stale = lockOf(STOPPED);
    writeFileSync(path, stale);
    const mark = removalMarkFor(path, stale);
    writeFileSync(mark, "");
    let sleeps = 0;
    const sleep = () => {
      sleeps++;
      if (sleeps === 2) {
        writeFileSync(path, lockOf(RUNNING));
        rmSync(mark);
      }
    };

    expect(() => acquireBuildLock(path, { pid: THIS_BUILD, isRunning, sleep })).toThrow(
      `is held by pid ${RUNNING}`,
    );
    expect(sleeps).toBe(2);
    expect(readFileSync(path, "utf8")).toBe(lockOf(RUNNING));
  });

  it("refuses when another build's removal of a stale lock never finishes, naming both files", () => {
    const path = lockPath();
    const stale = lockOf(STOPPED);
    writeFileSync(path, stale);
    const mark = removalMarkFor(path, stale);
    writeFileSync(mark, "");

    const message = thrownMessage(() =>
      acquireBuildLock(path, { pid: THIS_BUILD, isRunning, sleep: noSleep }),
    );

    expect(message).toContain(`${path} is held by pid ${STOPPED}, which is not running`);
    expect(message).toContain(mark);
    expect(readFileSync(path, "utf8")).toBe(stale);
  });

  it("gives each stale lock its own removal mark", () => {
    const path = lockPath();

    expect(removalMarkFor(path, lockOf(STOPPED))).not.toBe(removalMarkFor(path, lockOf(RUNNING)));
    expect(removalMarkFor(path, lockOf(STOPPED))).toMatch(/\.build\.lock\.removing-[0-9a-f]{16}$/);
  });
});

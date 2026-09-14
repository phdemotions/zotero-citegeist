import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import {
  promoteStaging,
  recoverInterruptedPromotion,
  renameWithRetry,
} from "../scripts/build-promotion.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

function layout() {
  const root = mkdtempSync(join(tmpdir(), "citegeist-promote-"));
  tempDirs.push(root);
  return {
    root,
    staging: join(root, ".addon-staging"),
    target: join(root, "addon"),
    previous: join(root, ".addon-previous"),
  };
}

function makeCopy(dir: string, marker: string): void {
  mkdirSync(dir);
  writeFileSync(join(dir, marker), marker);
}

function errorWithCode(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/** A rename that records each move by base name, and throws `failWith` for the sources given. */
function recordingRename(failWith: Map<string, Error> = new Map()) {
  const moves: string[] = [];
  const rename = (from: string, to: string) => {
    const failure = failWith.get(from);
    if (failure) throw failure;
    moves.push(`${basename(from)} -> ${basename(to)}`);
    renameSync(from, to);
  };
  return { moves, rename };
}

describe("promotion", () => {
  it("moves the old copy aside, moves staging in, and deletes the old copy only then", () => {
    const paths = layout();
    makeCopy(paths.target, "old.marker");
    makeCopy(paths.staging, "new.marker");
    const { moves, rename } = recordingRename();

    promoteStaging(paths, { rename });

    expect(moves).toEqual(["addon -> .addon-previous", ".addon-staging -> addon"]);
    expect(readdirSync(paths.root)).toEqual(["addon"]);
    expect(readdirSync(paths.target)).toEqual(["new.marker"]);
  });

  it("moves staging in when there is no copy yet", () => {
    const paths = layout();
    makeCopy(paths.staging, "new.marker");
    const { moves, rename } = recordingRename();

    promoteStaging(paths, { rename });

    expect(moves).toEqual([".addon-staging -> addon"]);
    expect(readdirSync(paths.root)).toEqual(["addon"]);
  });

  it("deletes a moved-aside copy an earlier build left beside the current copy, then swaps", () => {
    const paths = layout();
    makeCopy(paths.target, "current.marker");
    makeCopy(paths.previous, "older.marker");
    makeCopy(paths.staging, "new.marker");
    const { moves, rename } = recordingRename();

    promoteStaging(paths, { rename });

    expect(moves).toEqual(["addon -> .addon-previous", ".addon-staging -> addon"]);
    expect(readdirSync(paths.root)).toEqual(["addon"]);
    expect(readdirSync(paths.target)).toEqual(["new.marker"]);
  });

  it("moves back a copy an interrupted promotion left aside, then swaps", () => {
    const paths = layout();
    makeCopy(paths.previous, "older.marker");
    makeCopy(paths.staging, "new.marker");
    const { moves, rename } = recordingRename();

    promoteStaging(paths, { rename });

    expect(moves).toEqual([
      ".addon-previous -> addon",
      "addon -> .addon-previous",
      ".addon-staging -> addon",
    ]);
    expect(readdirSync(paths.root)).toEqual(["addon"]);
    expect(readdirSync(paths.target)).toEqual(["new.marker"]);
  });

  it("moves the old copy back and rethrows the original error when staging cannot move in", () => {
    const paths = layout();
    makeCopy(paths.target, "old.marker");
    makeCopy(paths.staging, "new.marker");
    const failure = errorWithCode("ENOSPC", "no space left on device");
    const { rename } = recordingRename(new Map([[paths.staging, failure]]));

    expect(thrown(() => promoteStaging(paths, { rename }))).toBe(failure);
    expect(readdirSync(paths.root).sort()).toEqual([".addon-staging", "addon"]);
    expect(readdirSync(paths.target)).toEqual(["old.marker"]);
  });

  it("keeps the old copy aside and reports both errors when it cannot move back either, and the next build restores it", () => {
    const paths = layout();
    makeCopy(paths.target, "old.marker");
    makeCopy(paths.staging, "new.marker");
    const stagingFailure = errorWithCode("ENOSPC", "staging stuck");
    const restoreFailure = errorWithCode("ENOSPC", "restore stuck");
    const { rename } = recordingRename(
      new Map([
        [paths.staging, stagingFailure],
        [paths.previous, restoreFailure],
      ]),
    );

    const error = thrown(() => promoteStaging(paths, { rename }));

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([stagingFailure, restoreFailure]);
    expect(existsSync(paths.target)).toBe(false);
    expect(readdirSync(paths.previous)).toEqual(["old.marker"]);

    recoverInterruptedPromotion(paths);

    expect(readdirSync(paths.target)).toEqual(["old.marker"]);
    expect(existsSync(paths.previous)).toBe(false);
  });

  it("deletes a moved-aside copy left beside a finished promotion, keeping the current copy", () => {
    const paths = layout();
    makeCopy(paths.target, "new.marker");
    makeCopy(paths.previous, "old.marker");

    recoverInterruptedPromotion(paths);

    expect(readdirSync(paths.root)).toEqual(["addon"]);
    expect(readdirSync(paths.target)).toEqual(["new.marker"]);
  });
});

/** A clock that moves only when the retry sleeps, recording each sleep. */
function fakeClock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

describe("renameWithRetry", () => {
  it.each(["EPERM", "EBUSY", "EACCES"])(
    "retries a rename locked with %s, waiting 10 ms and doubling each wait, and succeeds once the lock clears",
    (code) => {
      const clock = fakeClock();
      let calls = 0;
      const rename = () => {
        calls++;
        if (calls <= 4) throw errorWithCode(code);
      };

      renameWithRetry("from", "to", { rename, exists: () => false, ...clock });

      expect(calls).toBe(5);
      expect(clock.sleeps).toEqual([10, 20, 40, 80]);
    },
  );

  it("keeps retrying a lock an antivirus scan holds for 45 seconds, waiting at most 1 s at a time", () => {
    const clock = fakeClock();
    const rename = () => {
      if (clock.now() < 45_000) throw errorWithCode("EBUSY");
    };

    renameWithRetry("from", "to", { rename, exists: () => false, ...clock });

    expect(clock.now()).toBeGreaterThanOrEqual(45_000);
    expect(clock.now()).toBeLessThan(46_000);
    expect(clock.sleeps.slice(0, 8)).toEqual([10, 20, 40, 80, 160, 320, 640, 1000]);
    expect(Math.max(...clock.sleeps)).toBe(1000);
  });

  it("gives up 60 seconds after the first attempt, throwing the last attempt's error", () => {
    const clock = fakeClock();
    const errors: Error[] = [];
    const rename = () => {
      const error = errorWithCode("EBUSY", `locked at ${clock.now()} ms`);
      errors.push(error);
      throw error;
    };

    const error = thrown(() =>
      renameWithRetry("from", "to", { rename, exists: () => false, ...clock }),
    );

    expect(error).toBe(errors.at(-1));
    expect((error as Error).message).toBe("locked at 60000 ms");
    expect(clock.sleeps.reduce((total, ms) => total + ms, 0)).toBe(60_000);
    expect(errors).toHaveLength(clock.sleeps.length + 1);
  });

  it.each(["ENOENT", "ENOSPC", "EXDEV"])("throws %s at once, without waiting", (code) => {
    const clock = fakeClock();
    let calls = 0;
    const failure = errorWithCode(code);
    const rename = () => {
      calls++;
      throw failure;
    };

    expect(
      thrown(() => renameWithRetry("from", "to", { rename, exists: () => false, ...clock })),
    ).toBe(failure);
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("throws a lock code at once when the destination exists, since waiting does not move it", () => {
    const clock = fakeClock();
    let calls = 0;
    const failure = errorWithCode("EPERM");
    const rename = () => {
      calls++;
      throw failure;
    };

    expect(
      thrown(() => renameWithRetry("from", "to", { rename, exists: () => true, ...clock })),
    ).toBe(failure);
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });
});

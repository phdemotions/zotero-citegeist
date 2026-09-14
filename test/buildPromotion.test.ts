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

    promoteStaging(paths, { rename, delayMs: 0 });

    expect(moves).toEqual(["addon -> .addon-previous", ".addon-staging -> addon"]);
    expect(readdirSync(paths.root)).toEqual(["addon"]);
    expect(readdirSync(paths.target)).toEqual(["new.marker"]);
  });

  it("moves staging in when there is no copy yet", () => {
    const paths = layout();
    makeCopy(paths.staging, "new.marker");
    const { moves, rename } = recordingRename();

    promoteStaging(paths, { rename, delayMs: 0 });

    expect(moves).toEqual([".addon-staging -> addon"]);
    expect(readdirSync(paths.root)).toEqual(["addon"]);
  });

  it("deletes a moved-aside copy an earlier build left beside the current copy, then swaps", () => {
    const paths = layout();
    makeCopy(paths.target, "current.marker");
    makeCopy(paths.previous, "older.marker");
    makeCopy(paths.staging, "new.marker");
    const { moves, rename } = recordingRename();

    promoteStaging(paths, { rename, delayMs: 0 });

    expect(moves).toEqual(["addon -> .addon-previous", ".addon-staging -> addon"]);
    expect(readdirSync(paths.root)).toEqual(["addon"]);
    expect(readdirSync(paths.target)).toEqual(["new.marker"]);
  });

  it("moves back a copy an interrupted promotion left aside, then swaps", () => {
    const paths = layout();
    makeCopy(paths.previous, "older.marker");
    makeCopy(paths.staging, "new.marker");
    const { moves, rename } = recordingRename();

    promoteStaging(paths, { rename, delayMs: 0 });

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

    expect(thrown(() => promoteStaging(paths, { rename, delayMs: 0 }))).toBe(failure);
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

    const error = thrown(() => promoteStaging(paths, { rename, delayMs: 0 }));

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

  it.each(["EPERM", "EBUSY", "EACCES"])(
    "retries a rename locked with %s and succeeds once the lock clears",
    (code) => {
      let calls = 0;
      const rename = () => {
        calls++;
        if (calls < 3) throw errorWithCode(code);
      };

      renameWithRetry("from", "to", { rename, delayMs: 0 });

      expect(calls).toBe(3);
    },
  );

  it("gives up after the attempts allowed, throwing the last lock error", () => {
    let calls = 0;
    const errors: Error[] = [];
    const rename = () => {
      calls++;
      const error = errorWithCode("EBUSY", `locked ${calls}`);
      errors.push(error);
      throw error;
    };

    expect(thrown(() => renameWithRetry("from", "to", { rename, attempts: 4, delayMs: 0 }))).toBe(
      errors[3],
    );
    expect(calls).toBe(4);
  });

  it("does not retry an error that is not a lock", () => {
    let calls = 0;
    const failure = errorWithCode("ENOENT");
    const rename = () => {
      calls++;
      throw failure;
    };

    expect(thrown(() => renameWithRetry("from", "to", { rename, delayMs: 0 }))).toBe(failure);
    expect(calls).toBe(1);
  });
});

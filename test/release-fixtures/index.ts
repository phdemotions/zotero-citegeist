/**
 * Fixtures for the release script and workflow tests: throwaway directories, an environment that
 * takes nothing from the developer's shell but PATH, git and bash runners, a stand-in for the GitHub
 * CLI (gh-stub.mjs) and a local server for the update channel URL (channel-server.mjs).
 */
import { type ChildProcess, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GH_STUB = fileURLToPath(new URL("./gh-stub.mjs", import.meta.url));
const CHANNEL_SERVER = fileURLToPath(new URL("./channel-server.mjs", import.meta.url));

/** Tests that build git repositories or spawn many processes outlast vitest's 5 s default under a parallel run. */
export const PROCESS_TEST_TIMEOUT_MS = 120_000;

export const REPOSITORY = "phdemotions/zotero-citegeist";

export class TempDirs {
  private readonly dirs: string[] = [];

  make(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `citegeist-${label}-`));
    this.dirs.push(dir);
    return dir;
  }

  removeAll(): void {
    for (const dir of this.dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  }
}

/** The absolute path of an executable on the test process's PATH, or undefined. */
export function findExecutable(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return undefined;
}

const BASH = findExecutable("bash") ?? "/bin/bash";

/**
 * An environment with PATH (these directories first, then Node's, then the test process's), a
 * throwaway HOME, no git configuration but a fixed identity, and the given variables.
 */
export function isolatedEnv(
  home: string,
  variables: Record<string, string> = {},
  pathFirst: string[] = [],
): Record<string, string> {
  return {
    PATH: [...pathFirst, dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
    HOME: home,
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, "no-global-gitconfig"),
    GIT_AUTHOR_NAME: "Citegeist test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Citegeist test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    ...variables,
  };
}

/** Runs git and returns its trimmed stdout, throwing on a non-zero exit. */
export function git(cwd: string, env: Record<string, string>, ...args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args],
    { cwd, env, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Runs a bash script file the way GitHub runs `shell: bash`: `bash --noprofile --norc -eo pipefail {0}`. */
export function runBash(
  file: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
): SpawnSyncReturns<string> {
  return spawnSync(BASH, ["--noprofile", "--norc", "-eo", "pipefail", file, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
}

/** Writes a step's `run:` script to a file and runs it the way GitHub runs `shell: bash`. */
export function runScript(
  script: string,
  env: Record<string, string>,
  cwd: string,
): SpawnSyncReturns<string> {
  const file = join(mkdtempSync(join(tmpdir(), "citegeist-step-")), "step.sh");
  writeFileSync(file, script);
  try {
    return runBash(file, [], env, cwd);
  } finally {
    rmSync(dirname(file), { recursive: true, force: true });
  }
}

export interface StubRelease {
  isDraft: boolean;
  assets: Record<string, string>;
  downloads?: Record<string, number>;
  flags?: string[];
}

export interface GhState {
  releases?: Record<string, StubRelease>;
  pulls?: Record<string, unknown[]>;
  extraReleases?: unknown[];
  failRelease?: string;
  failApi?: string;
}

const WRITE_COMMANDS = new Set(["create", "edit", "delete", "upload"]);

/** gh-stub.mjs installed as `gh` in its own bin directory. */
export class GhStub {
  readonly bin: string;
  private readonly statePath: string;
  private readonly logPath: string;

  constructor(dir: string, state: GhState = {}) {
    this.bin = join(dir, "gh-bin");
    this.statePath = join(dir, "gh-state.json");
    this.logPath = join(dir, "gh-calls.log");
    mkdirSync(this.bin, { recursive: true });
    const wrapper = join(this.bin, "gh");
    writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${GH_STUB}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    this.reset(state);
  }

  /** Replaces the state and forgets earlier calls. */
  reset(state: GhState = {}): void {
    writeFileSync(this.statePath, JSON.stringify(state));
    writeFileSync(this.logPath, "");
  }

  state(): GhState {
    return JSON.parse(readFileSync(this.statePath, "utf8")) as GhState;
  }

  calls(): string[][] {
    return readFileSync(this.logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  }

  /** Every call that creates, edits, deletes or uploads to a release. */
  writes(): string[][] {
    return this.calls().filter((call) => call[0] === "release" && WRITE_COMMANDS.has(call[1]));
  }

  env(): Record<string, string> {
    return { GH_STUB_STATE: this.statePath, GH_STUB_LOG: this.logPath };
  }
}

/** channel-server.mjs in its own process. */
export class ChannelServer {
  url = "";
  private child: ChildProcess | undefined;
  private readonly routesPath: string;

  constructor(dir: string) {
    this.routesPath = join(dir, "channel-routes.json");
    this.reset();
  }

  async start(): Promise<void> {
    const child = spawn(process.execPath, [CHANNEL_SERVER, this.routesPath], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    this.child = child;
    const port = await new Promise<string>((resolve, reject) => {
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("\n")) resolve(output.split("\n")[0].trim());
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`channel server exited with ${code}`)));
    });
    this.url = `http://127.0.0.1:${port}`;
  }

  serve(path: string, status: number, body: string): void {
    const routes = JSON.parse(readFileSync(this.routesPath, "utf8")) as Record<string, unknown>;
    routes[path] = { status, body };
    writeFileSync(this.routesPath, JSON.stringify(routes));
  }

  reset(): void {
    writeFileSync(this.routesPath, "{}");
  }

  stop(): void {
    this.child?.kill();
  }
}

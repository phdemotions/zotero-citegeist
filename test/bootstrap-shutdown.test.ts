/**
 * addon/bootstrap.js shutdown contract. On APP_SHUTDOWN the plugin used to
 * return early, so onShutdown → closeCache never ran: citegeist.sqlite stayed
 * open and Firefox's Sqlite.sys.mjs shutdown blocker waited on it forever
 * ("citegeist.sqlite#0: waiting for shutdown", isCloseRequested: false) —
 * Zotero could not quit and had to be killed.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { runInNewContext } from "vm";

const APP_SHUTDOWN = 2;
const ADDON_DISABLE = 4;
const source = readFileSync(new URL("../addon/bootstrap.js", import.meta.url), "utf8");

function loadBootstrap() {
  let finishShutdown: () => void = () => {};
  const plugin = {
    shutdown: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishShutdown = resolve;
        }),
    ),
  };
  const chromeHandle = { destruct: vi.fn() };
  const scope: Record<string, unknown> = { APP_SHUTDOWN, ADDON_DISABLE };
  runInNewContext(source, scope);
  scope.citegeist = plugin;
  scope.chromeHandle = chromeHandle;
  const shutdown = scope.shutdown as (data: object, reason: number) => unknown;
  return { plugin, chromeHandle, shutdown, finish: () => finishShutdown() };
}

const data = { id: "citegeist@opusvita.org", version: "3.0.0", rootURI: "jar:x!/" };

describe("bootstrap shutdown", () => {
  it("runs the plugin shutdown on APP_SHUTDOWN so the cache DB gets closed", () => {
    const { plugin, shutdown } = loadBootstrap();
    shutdown(data, APP_SHUTDOWN);
    expect(plugin.shutdown).toHaveBeenCalledTimes(1);
  });

  it("returns a promise Zotero can await until the plugin shutdown finished", async () => {
    const { shutdown, finish } = loadBootstrap();
    let done = false;
    const result = shutdown(data, APP_SHUTDOWN) as Promise<void>;
    expect(typeof result?.then).toBe("function");
    void result.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    finish();
    await result;
    expect(done).toBe(true);
  });

  it("still tears down the chrome registration on disable, not on app shutdown", async () => {
    const quitting = loadBootstrap();
    const quit = quitting.shutdown(data, APP_SHUTDOWN);
    quitting.finish();
    await quit;
    expect(quitting.chromeHandle.destruct).not.toHaveBeenCalled();

    const disabling = loadBootstrap();
    const disable = disabling.shutdown(data, ADDON_DISABLE);
    disabling.finish();
    await disable;
    expect(disabling.chromeHandle.destruct).toHaveBeenCalledTimes(1);
  });
});

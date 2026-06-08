import { beforeEach, describe, expect, it, vi } from "vitest";

const hookMocks = vi.hoisted(() => ({
  onStartup: vi.fn(async () => {}),
  onShutdown: vi.fn(async () => {}),
  onMainWindowLoad: vi.fn(),
  onMainWindowUnload: vi.fn(),
}));

vi.mock("../src/hooks", () => hookMocks);

type CitegeistConstructor = new () => {
  startup(data: { id: string; version: string; rootURI: string; reason: number }): Promise<void>;
  shutdown(data: { id: string; version: string; rootURI: string; reason: number }): Promise<void>;
  onMainWindowLoad(win: Window): void;
  onMainWindowUnload(win: Window): void;
};

function globalWithPlugin(): typeof globalThis & { Citegeist?: CitegeistConstructor } {
  return globalThis as typeof globalThis & { Citegeist?: CitegeistConstructor };
}

describe("bootstrap entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete globalWithPlugin().Citegeist;
  });

  it("exports the global constructor bootstrap.js instantiates", async () => {
    await import("../src/index");
    expect(globalWithPlugin().Citegeist).toBeTypeOf("function");
  });

  it("delegates lifecycle calls to hooks", async () => {
    await import("../src/index");
    const Plugin = globalWithPlugin().Citegeist!;
    const plugin = new Plugin();
    const data = { id: "citegeist@opusvita.org", version: "2.0.0", rootURI: "root/", reason: 1 };
    const win = {} as Window;

    await plugin.startup(data);
    await plugin.shutdown(data);
    plugin.onMainWindowLoad(win);
    plugin.onMainWindowUnload(win);

    expect(hookMocks.onStartup).toHaveBeenCalledWith(data);
    expect(hookMocks.onShutdown).toHaveBeenCalledWith(data);
    expect(hookMocks.onMainWindowLoad).toHaveBeenCalledWith(win);
    expect(hookMocks.onMainWindowUnload).toHaveBeenCalledWith(win);
  });
});

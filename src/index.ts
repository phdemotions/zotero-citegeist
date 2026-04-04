/**
 * Citegeist — Citation intelligence for Zotero, powered by OpenAlex.
 *
 * This is the main entry point loaded by bootstrap.js.
 * It exposes the Citegeist class to the global scope.
 */

import { onStartup, onShutdown, onMainWindowLoad, onMainWindowUnload } from "./hooks";

class CitegeistPlugin {
  async startup(data: { id: string; version: string; rootURI: string; reason: number }) {
    await onStartup(data);
  }

  shutdown(data: { id: string; version: string; rootURI: string; reason: number }) {
    onShutdown(data);
  }

  onMainWindowLoad(win: Window) {
    onMainWindowLoad(win);
  }

  onMainWindowUnload(win: Window) {
    onMainWindowUnload(win);
  }
}

// Expose to global scope for bootstrap.js
(globalThis as any).Citegeist = CitegeistPlugin;

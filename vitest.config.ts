import { configDefaults, defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  // Build-time constant that esbuild injects in scripts/build.mjs. Without a
  // matching definition here, any module referencing it throws ReferenceError
  // under vitest.
  define: {
    __BUILD_ID__: JSON.stringify("test"),
  },
  test: {
    include: ["test/**/*.test.ts"],
    // Mocha specs and their harness that run INSIDE real Zotero via
    // `npm run test:zotero` (zotero-plugin-scaffold), never under vitest.
    exclude: [...configDefaults.exclude, "test/real-zotero/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});

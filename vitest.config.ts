import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  // Build-time constants that esbuild injects in scripts/build.mjs. Without a
  // matching definition here, any module referencing one throws ReferenceError
  // under vitest.
  define: {
    __DEV__: "true",
    __BUILD_ID__: JSON.stringify("test"),
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});

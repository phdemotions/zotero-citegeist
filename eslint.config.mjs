import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";

export default [
  // Global ignores
  {
    ignores: ["build/**", "node_modules/**", "scripts/**", "addon/**"],
  },

  // Base JS recommendations (non-TS files only)
  {
    ...js.configs.recommended,
    files: ["**/*.js", "**/*.mjs"],
  },

  // TypeScript source + tests
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2021,
        sourceType: "module",
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
        // Zotero globals — available in the privileged chrome context
        Zotero: "readonly",
        ZoteroPane: "readonly",
        Services: "readonly",
        _ZoteroTypes: "readonly",
        XULDocument: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // TypeScript compiler handles these; disable JS versions
      "no-unused-vars": "off",
      "no-undef": "off",
      // TypeScript-specific rules
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "warn",
      "@typescript-eslint/no-require-imports": "error",
      // General rules
      "no-console": "warn",
      eqeqeq: ["error", "smart"],
      "prefer-const": "warn",
    },
  },

  // Prettier must be last — turns off rules that conflict with formatting
  prettierConfig,
];

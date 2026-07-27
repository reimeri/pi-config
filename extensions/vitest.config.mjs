import { defineConfig } from "vitest/config";

// Deliberately .mjs, not .ts: Pi loads every top-level *.ts and *.js file in this directory as an
// extension, and `endsWith(".ts")` matches .mts too. A .mjs config is invisible to that scan.
export default defineConfig({
  test: {
    // base-lsp carries its own package.json, vitest config and dependencies, so it is run from
    // there rather than swept up here.
    include: ["*/**/*.test.ts"],
    exclude: ["base-lsp/**", "**/node_modules/**"],
    testTimeout: 20_000,
    restoreMocks: true,
  },
});

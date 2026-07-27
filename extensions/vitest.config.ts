import { defineConfig } from "vitest/config";

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

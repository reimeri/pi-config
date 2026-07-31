import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "vitest/config";

function findPiEntry() {
  const explicit = process.env.PI_CODING_AGENT_ENTRY;
  if (explicit && existsSync(explicit)) return explicit;
  try {
    return createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent");
  } catch {
    // Do not install a second Pi copy for global extensions.
  }
  let current = dirname(process.execPath);
  while (true) {
    for (const modules of [join(current, "node_modules"), join(current, "lib", "node_modules")]) {
      const entry = join(modules, "@earendil-works", "pi-coding-agent", "dist", "index.js");
      if (existsSync(entry)) return entry;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error("Could not locate the active Pi installation");
    current = parent;
  }
}

// Use .mjs because Pi scans top-level .ts/.js files as extensions.
export default defineConfig({
  resolve: {
    // Use the host-provided packages used by bare extensions at runtime.
    alias: { "@earendil-works/pi-coding-agent": findPiEntry() },
  },
  test: {
    // Run base-lsp separately because it has its own dependencies and config.
    include: ["*/**/*.test.ts"],
    exclude: ["base-lsp/**", "**/node_modules/**"],
    testTimeout: 20_000,
    restoreMocks: true,
  },
});

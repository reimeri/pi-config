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
    // Bare global-extension setups intentionally do not install a second Pi copy here.
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

// Deliberately .mjs, not .ts: Pi loads every top-level *.ts and *.js file in this directory as an
// extension, and `endsWith(".ts")` matches .mts too. A .mjs config is invisible to that scan.
export default defineConfig({
  resolve: {
    // Bare extensions use Pi's host-provided packages at runtime. Point tests at that same active
    // installation without adding a second Pi copy to this intentionally minimal test harness.
    alias: { "@earendil-works/pi-coding-agent": findPiEntry() },
  },
  test: {
    // base-lsp carries its own package.json, vitest config and dependencies, so it is run from
    // there rather than swept up here.
    include: ["*/**/*.test.ts"],
    exclude: ["base-lsp/**", "**/node_modules/**"],
    testTimeout: 20_000,
    restoreMocks: true,
  },
});

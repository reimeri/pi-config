import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_SERVERS } from "../../src/servers/catalog.js";
import { RootDetector } from "../../src/servers/roots.js";
import { routeFile } from "../../src/servers/routing.js";

const VERIFIED_COMMANDS: Record<string, string[]> = {
  typescript: ["typescript-language-server", "--stdio"], deno: ["deno", "lsp"], vue: ["vue-language-server", "--stdio"], svelte: ["svelteserver", "--stdio"],
  basedpyright: ["basedpyright-langserver", "--stdio"], pyright: ["pyright-langserver", "--stdio"], ruff: ["ruff", "server"], "rust-analyzer": ["rust-analyzer"], gopls: ["gopls"],
  jdtls: ["jdtls"], kotlin: ["kotlin-lsp"], "csharp-ls": ["csharp-ls"], fsautocomplete: ["fsautocomplete", "--adaptive-lsp-server-enabled"], "sourcekit-lsp": ["sourcekit-lsp"],
  "ruby-lsp": ["ruby-lsp"], intelephense: ["intelephense", "--stdio"], "lua-language-server": ["lua-language-server"], zls: ["zls"], dart: ["dart", "language-server"], ocamllsp: ["ocamllsp"],
  hls: ["haskell-language-server-wrapper", "--lsp"], "bash-language-server": ["bash-language-server", "start"], "clojure-lsp": ["clojure-lsp", "listen"], gleam: ["gleam", "lsp"], nixd: ["nixd"],
  "terraform-ls": ["terraform-ls", "serve"], yaml: ["yaml-language-server", "--stdio"], json: ["vscode-json-language-server", "--stdio"], html: ["vscode-html-language-server", "--stdio"], css: ["vscode-css-language-server", "--stdio"], prisma: ["prisma-language-server", "--stdio"],
};

describe("built-in server catalog", () => {
  it("keeps documentation-verified commands and complete routing metadata", () => {
    for (const [id, server] of Object.entries(BUILTIN_SERVERS)) {
      expect(server.id).toBe(id); expect(server.command.length).toBeGreaterThan(0); expect(server.extensions.length + (server.filenames?.length ?? 0)).toBeGreaterThan(0);
      expect(server.rootMarkers.length || server.rootFallback !== "none").toBeTruthy();
      for (const extension of server.extensions) expect(server.languageIds[extension], `${id} ${extension}`).toBeTruthy();
    }
    for (const [id, command] of Object.entries(VERIFIED_COMMANDS)) expect(BUILTIN_SERVERS[id]?.command).toEqual(command);
  });

  it("selects Deno over TypeScript only when the nearest Deno marker claims the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-deno-")); const file = join(root, "main.ts");
    await writeFile(join(root, "package.json"), "{}"); await writeFile(file, "export {}\n");
    const detector = new RootDetector(1);
    expect((await routeFile(file, root, [BUILTIN_SERVERS.typescript!, BUILTIN_SERVERS.deno!], detector)).primary?.server.id).toBe("typescript");
    await writeFile(join(root, "deno.json"), "{}"); detector.clear(2);
    expect((await routeFile(file, root, [BUILTIN_SERVERS.typescript!, BUILTIN_SERVERS.deno!], detector)).primary?.server.id).toBe("deno");
  });
});

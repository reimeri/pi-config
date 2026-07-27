import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNpmCmdShim } from "../../src/servers/command.js";

describe("Windows npm shim resolution", () => {
  it("accepts only a recognized npm-generated cmd shape and resolves its Node script", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-shim-"));
    const bin = join(root, "bin"); const pkg = join(root, "pkg"); await mkdir(bin); await mkdir(pkg);
    const script = join(pkg, "cli.mjs"); await writeFile(script, "process.exit(0);\n"); await chmod(script, 0o755);
    const shim = join(bin, "server.cmd");
    await writeFile(shim, "@ECHO off\r\nSETLOCAL\r\n\"%_prog%\"  \"%dp0%\\..\\pkg\\cli.mjs\" %*\r\n");
    expect(await resolveNpmCmdShim(shim)).toBe(script);
    const unknown = join(bin, "unknown.cmd"); await writeFile(unknown, "@ECHO off\r\necho unsafe %*\r\n");
    expect(await resolveNpmCmdShim(unknown)).toBeUndefined();
  });
});

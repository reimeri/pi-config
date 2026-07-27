import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverFiles } from "../../src/workspace/files.js";
import { fakeServer } from "../helpers/fake.js";

describe("bounded file discovery", () => {
  it("never exceeds the global entry budget even in a wide directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-discovery-"));
    await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(root, `${String(index).padStart(3, "0")}.ts`), "export {};\n")));
    const result = await discoverFiles(root, root, [fakeServer()], [], 10, 100, 1024 * 1024);
    expect(result.entries).toBeLessThanOrEqual(10);
    expect(result.files.length).toBeLessThanOrEqual(10);
    expect(result.capped).toBe(true);
  });
});

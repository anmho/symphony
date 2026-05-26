import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runShellCommand } from "../src/process.js";

describe("process helpers", () => {
  it("runs shell commands without login-shell PATH mutation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-process-"));
    const bin = path.join(dir, "symphony-node-probe");
    await writeFile(bin, "#!/usr/bin/env sh\necho custom-path\n");
    await chmod(bin, 0o755);

    const result = await runShellCommand("symphony-node-probe", {
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      timeoutMs: 30000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("custom-path");
  });
});

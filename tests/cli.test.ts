import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/process";

describe("cli", () => {
  it("prints help", async () => {
    const result = await runCommand("bun", ["run", "tsx", "src/index.ts", "--help"], {
      cwd: path.resolve(__dirname, ".."),
      timeoutMs: 30000
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("start");
    expect(result.stdout).toContain("stop");
    expect(result.stdout).toContain("validate-config");
  });

  it("validates workflow config", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-cli-"));
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---
tracker:
  api_key: lin_test
  project_slug: project
workspace:
  repo_path: .
---
Prompt
`
    );

    const result = await runCommand("bun", ["run", "tsx", "src/index.ts", "validate-config", "--workflow", workflowPath], {
      cwd: path.resolve(__dirname, ".."),
      timeoutMs: 30000
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("project=project");
  });
});

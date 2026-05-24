import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/process.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("cli", () => {
  it("prints help", async () => {
    const result = await runCommand("node", ["--import", "tsx", "src/index.ts", "--help"], {
      cwd: repoRoot,
      timeoutMs: 30000
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("start");
    expect(result.stdout).toContain("stop");
    expect(result.stdout).toContain("watch");
    expect(result.stdout).toContain("logs");
    expect(result.stdout).toContain("steer");
    expect(result.stdout).toContain("resume");
    expect(result.stdout).toContain("validate-config");
    expect(result.stdout).toContain("ticket");
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

    const result = await runCommand("node", ["--import", "tsx", "src/index.ts", "validate-config", "--workflow", workflowPath], {
      cwd: repoRoot,
      timeoutMs: 30000
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("project=project");
  });

  it("warns for configured repo routes without Linear labels", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-cli-"));
    const fetchMockPath = path.join(dir, "mock-fetch.mjs");
    await writeFile(
      fetchMockPath,
      `
globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      data: {
        issueLabels: {
          nodes: [{ name: "repo:symphony" }],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
`
    );

    const workflowPath = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---
tracker:
  api_key: lin_test
  endpoint: https://linear.example/graphql
  project_slug: project
workspace:
  repo_path: .
  repo_routes:
    symphony: ./symphony
    auth: ./auth
---
Prompt
`
    );

    const result = await runCommand(
      "node",
      ["--import", "tsx", "--import", fetchMockPath, "src/index.ts", "validate-config", "--workflow", workflowPath],
      {
        cwd: repoRoot,
        timeoutMs: 30000
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Warning: Missing Linear label for configured repo route: repo:auth");
  });
});

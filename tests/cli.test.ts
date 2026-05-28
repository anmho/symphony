import { mkdtemp, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/process.js";
import { startStatusServer } from "../src/status.js";
import type { OrchestratorSnapshot } from "../src/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("cli", () => {
  let server: Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server = null;
    });
  });

  it("prints help", async () => {
    const result = await runCommand("bun", ["src/index.ts", "--help"], {
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
    expect(result.stdout).toContain("concurrency");
    expect(result.stdout).toContain("validate-config");
    expect(result.stdout).toContain("github-app-token");
    expect(result.stdout).toContain("doctor");
    expect(result.stdout).toContain("ticket");
  });

  it("views and sets daemon concurrency from the CLI", async () => {
    let override: number | null = null;
    server = await startStatusServer(() => cliSnapshot(override), 0, {
      setMaxConcurrencyOverride: (maxConcurrentAgents) => {
        override = maxConcurrentAgents;
        return cliSnapshot(override).concurrency;
      }
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const getResult = await runCommand(
      "bun",
      ["src/index.ts", "--status-port", String(port), "concurrency"],
      {
        cwd: repoRoot,
        timeoutMs: 30000
      }
    );

    expect(getResult.exitCode).toBe(0);
    expect(getResult.stdout).toContain("running=1 configured=5 effective=5 source=workflow override=none");

    const setResult = await runCommand(
      "bun",
      ["src/index.ts", "--status-port", String(port), "concurrency", "set", "2"],
      {
        cwd: repoRoot,
        timeoutMs: 30000
      }
    );

    expect(setResult.exitCode).toBe(0);
    expect(setResult.stdout).toContain("running=1 configured=5 effective=2 source=override override=2");
    expect(override).toBe(2);
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

    const result = await runCommand("bun", ["src/index.ts", "validate-config", "--workflow", workflowPath], {
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
      "bun",
      ["--preload", fetchMockPath, "src/index.ts", "validate-config", "--workflow", workflowPath],
      {
        cwd: repoRoot,
        timeoutMs: 30000
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "Warning: Missing Linear label for configured repo route: repo:auth. Run `symphony labels sync --workflow WORKFLOW.md` to create missing route labels."
    );
  });

  it("creates missing configured repo route labels from the CLI", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-cli-"));
    const callsPath = path.join(dir, "calls.json");
    const fetchMockPath = path.join(dir, "mock-fetch.mjs");
    await writeFile(
      fetchMockPath,
      `
import { writeFileSync } from "node:fs";

const calls = [];
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init.body));
  calls.push(body);
  writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls, null, 2));

  if (body.query.includes("query SymphonyIssueLabels")) {
    return response({
      issueLabels: {
        nodes: [{ name: "repo:symphony" }],
        pageInfo: { hasNextPage: false, endCursor: null }
      }
    });
  }
  if (body.query.includes("query SymphonyTeam")) {
    return response({
      teams: {
        nodes: [{ id: "team-1", key: "ANM", name: "ANM" }]
      }
    });
  }
  if (body.query.includes("mutation SymphonyIssueLabelCreate")) {
    return response({
      issueLabelCreate: {
        success: true,
        issueLabel: { id: "label-auth", name: body.variables.input.name }
      }
    });
  }
  throw new Error("unexpected query: " + body.query);
};

function response(data) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
`
    );

    const workflowPath = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---
tracker:
  api_key: lin_test
  endpoint: https://linear.example/graphql
  team_key: ANM
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
      "bun",
      ["--preload", fetchMockPath, "src/index.ts", "labels", "sync", "--workflow", workflowPath],
      {
        cwd: repoRoot,
        timeoutMs: 30000
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Created Linear label repo:auth");
  });
});

function cliSnapshot(override: number | null): OrchestratorSnapshot {
  return {
    startedAtMs: 1000,
    workflowPath: "/tmp/WORKFLOW.md",
    running: [
      {
        issueId: "issue-1",
        identifier: "ANM-1",
        title: "Example",
        repoKey: null,
        workspacePath: "/tmp/workspaces/ANM-1",
        eventLogPath: "/tmp/.symphony/events/ANM-1.jsonl",
        latestEventCursor: null,
        queuedSteerCount: 0,
        threadId: null,
        turnId: null,
        codexAppServerPid: null,
        lastCodexEvent: null,
        lastCodexTimestamp: null,
        lastCodexMessage: null,
        currentWork: null,
        currentWorkKind: null,
        currentWorkUpdatedAtMs: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        goalStatus: null,
        goalObjective: null,
        goalUpdatedAtMs: null,
        turnCount: 0,
        startedAtMs: 1000
      }
    ],
    claimed: ["issue-1"],
    retryAttempts: [],
    handoff: [],
    handoffDetails: [],
    completed: [],
    completedDetails: [],
    codexTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      runtimeMs: 0
    },
    codexRateLimit: {
      resumeAfterMs: null,
      reason: null,
      updatedAtMs: null
    },
    concurrency: {
      running: 1,
      configuredMax: 5,
      effectiveMax: override ?? 5,
      source: override === null ? "workflow" : "override",
      overrideActive: override !== null,
      overrideMax: override,
      overrideUpdatedAtMs: override === null ? null : 2000
    },
    backend: {
      configured: "codex",
      effective: "codex",
      source: "workflow",
      overrideActive: false,
      overrideBackend: null,
      overrideUpdatedAtMs: null
    },
    lastTickAtMs: 1000,
    lastConfigError: null,
    paused: false,
    pausedAtMs: null
  };
}

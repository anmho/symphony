import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { goalObjectiveForIssue, runCodexTurn } from "../src/codexRpc.js";
import type { CodexRunInput, EffectiveWorkflowConfig, NormalizedIssue } from "../src/types.js";

describe("codex app-server RPC", () => {
  it("sets an active goal after starting a thread and before starting a turn", async () => {
    const { command, requestLogPath, workspacePath } = await createFakeAppServer();
    const issue = makeIssue("ANM-123", "Validate configured repo routes");

    await runCodexTurn(makeInput({ command, issue, threadId: null, workspacePath }));

    const requests = await readRequests(requestLogPath);
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "thread/start",
      "thread/goal/set",
      "turn/start"
    ]);
    expect(requests[2]?.params).toMatchObject({
      threadId: "thread-started",
      status: "active",
      tokenBudget: null,
      objective: "Complete Linear issue ANM-123: Validate configured repo routes. Satisfy the issue, commit, push, open or update a PR, and prepare a Linear handoff."
    });
  });

  it("sets an active goal after resuming a thread and before starting a turn", async () => {
    const { command, requestLogPath, workspacePath } = await createFakeAppServer();
    const issue = makeIssue("ANM-124", "Make arrow navigation deterministic");

    await runCodexTurn(makeInput({ command, issue, threadId: "thread-existing", workspacePath }));

    const requests = await readRequests(requestLogPath);
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "thread/resume",
      "thread/goal/set",
      "turn/start"
    ]);
    expect(requests[2]?.params).toMatchObject({
      threadId: "thread-existing",
      status: "active",
      objective: goalObjectiveForIssue({ issue })
    });
  });

  it("accepts turn completion notifications that only match the thread id", async () => {
    const { command, workspacePath } = await createFakeAppServer({ completedTurnId: "turn-notification" });
    const issue = makeIssue("ANM-125", "Stop stale running sessions");

    const result = await runCodexTurn(makeInput({ command, issue, threadId: null, workspacePath }));

    expect(result.status).toBe("completed");
    expect(result.turnId).toBe("turn-1");
  });
});

interface RecordedRequest {
  method: string;
  params: Record<string, unknown>;
}

async function createFakeAppServer(
  options: { completedTurnId?: string } = {}
): Promise<{ command: string; requestLogPath: string; workspacePath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-fake-app-server-"));
  const serverPath = path.join(dir, "server.mjs");
  const requestLogPath = path.join(dir, "requests.json");
  const workspacePath = path.join(dir, "workspace");
  await mkdir(workspacePath);
  await writeFile(serverPath, fakeAppServerSource(options));
  return {
    command: `SYMPHONY_FAKE_REQUEST_LOG=${shellQuote(requestLogPath)} node ${shellQuote(serverPath)}`,
    requestLogPath,
    workspacePath
  };
}

async function readRequests(requestLogPath: string): Promise<RecordedRequest[]> {
  return JSON.parse(await readFile(requestLogPath, "utf8")) as RecordedRequest[];
}

function fakeAppServerSource(options: { completedTurnId?: string }): string {
  const completedTurnId = JSON.stringify(options.completedTurnId ?? "turn-1");
  return `
import { writeFileSync } from "node:fs";
import readline from "node:readline";

const requestLogPath = process.env.SYMPHONY_FAKE_REQUEST_LOG;
if (!requestLogPath) {
  throw new Error("missing SYMPHONY_FAKE_REQUEST_LOG");
}
const requests = [];

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function record(message) {
  requests.push({ method: message.method, params: message.params ?? {} });
  writeFileSync(requestLogPath, JSON.stringify(requests, null, 2));
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  record(message);

  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-started" } } });
    return;
  }
  if (message.method === "thread/resume") {
    send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }
  if (message.method === "thread/goal/set") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        goal: {
          threadId: message.params.threadId,
          objective: message.params.objective,
          status: message.params.status,
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1
        }
      }
    });
    return;
  }
  if (message.method === "turn/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-1", status: "running" } } });
    setTimeout(() => send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: message.params.threadId, turn: { id: ${completedTurnId}, status: "completed" } }
    }), 5);
    return;
  }

  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } });
});
`;
}

function makeInput(input: { command: string; issue: NormalizedIssue; threadId: string | null; workspacePath: string }): CodexRunInput {
  return {
    config: makeConfig(input.command),
    issue: input.issue,
    workspacePath: input.workspacePath,
    prompt: "Do the work",
    threadId: input.threadId
  };
}

function makeConfig(command: string): EffectiveWorkflowConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    workflowDir: "/tmp",
    promptTemplate: "Prompt",
    tracker: {
      kind: "linear",
      endpoint: "https://linear.example/graphql",
      apiKey: "lin_test",
      projectSlug: "project",
      teamKey: null,
      requiredLabels: [],
      repoLabelPrefix: "repo:",
      activeStates: ["Todo"],
      terminalStates: ["Done"],
      handoffState: null,
      mergeState: null
    },
    polling: { intervalMs: 30000 },
    workspace: {
      root: "/tmp/workspaces",
      repoPath: "/tmp/repo",
      projectsRoot: null,
      repoRoutes: {},
      baseBranch: "main"
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60000
    },
    agent: {
      maxConcurrentAgents: 5,
      maxTurns: 20,
      maxRetryBackoffMs: 300000,
      rateLimitProbeIntervalMs: 300000,
      maxConcurrentAgentsByState: {}
    },
    codex: {
      command,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: null,
      turnTimeoutMs: 3600000,
      readTimeoutMs: 5000,
      stallTimeoutMs: 300000,
      model: null
    },
    github: {
      prIdentity: null
    },
    pullRequest: {
      backend: "github",
      graphiteFallback: "fail"
    },
    digest: {
      enabled: false,
      recipient: "andyminhtuanho@gmail.com",
      sender: "Symphony <agent@anmho.com>",
      intervalMs: 3600000,
      windowMs: 3600000,
      resendApiKey: null,
      resendEndpoint: "https://api.resend.com/emails"
    }
  };
}

function makeIssue(identifier: string, title: string): NormalizedIssue {
  return {
    id: identifier,
    identifier,
    title,
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    comments: [],
    attachments: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

import { describe, expect, it, vi } from "vitest";
import { Orchestrator, type OrchestratorDependencies } from "../src/orchestrator";
import type {
  CodexRunInput,
  CodexRunEvent,
  CodexTurnResult,
  EffectiveWorkflowConfig,
  NormalizedIssue,
  WorkspaceInfo
} from "../src/types";

describe("orchestrator", () => {
  it("dispatches up to configured concurrency", async () => {
    const issues = Array.from({ length: 6 }, (_, index) => makeIssue(`APP-${index + 1}`));
    const deps = makeDeps({
      fetchCandidateIssues: async () => issues,
      runCodexTurn: async () => new Promise<CodexTurnResult>(() => undefined)
    });
    const orchestrator = new Orchestrator({ workflowPath: "/tmp/WORKFLOW.md" }, deps);

    await orchestrator.tick();

    expect(orchestrator.snapshot().running).toHaveLength(5);
    expect(orchestrator.snapshot().claimed).toHaveLength(5);
  });

  it("continues active issues on the same worker loop", async () => {
    const issue = makeIssue("APP-1");
    let fetches = 0;
    let codexCalls = 0;
    const deps = makeDeps({
      fetchCandidateIssues: async () => [issue],
      fetchIssueById: async () => {
        fetches += 1;
        return fetches <= 2 ? issue : { ...issue, state: "Human Review" };
      },
      runCodexTurn: async () => {
        codexCalls += 1;
        return completedTurn(`thread-${codexCalls}`, `turn-${codexCalls}`);
      }
    });
    const orchestrator = new Orchestrator({ workflowPath: "/tmp/WORKFLOW.md" }, deps);

    await orchestrator.tick();
    await flushPromises();

    expect(codexCalls).toBe(2);
    expect(orchestrator.snapshot().running).toHaveLength(0);
  });

  it("schedules retry after failed worker", async () => {
    const issue = makeIssue("APP-1");
    const deps = makeDeps({
      fetchCandidateIssues: async () => [issue],
      runCodexTurn: async () => ({ ...completedTurn("thread", "turn"), status: "failed", error: "boom" })
    });
    const orchestrator = new Orchestrator({ workflowPath: "/tmp/WORKFLOW.md" }, deps);

    await orchestrator.tick();
    await flushPromises();

    expect(orchestrator.snapshot().retryAttempts).toMatchObject([
      { issueId: issue.id, identifier: issue.identifier, attempt: 1, error: "boom" }
    ]);
  });

  it("pauses new Codex launches while rate limited", async () => {
    const issue = makeIssue("APP-1");
    let now = 1000;
    let codexCalls = 0;
    const deps = makeDeps({
      now: () => now,
      fetchCandidateIssues: async () => [issue],
      runCodexTurn: async () => {
        codexCalls += 1;
        return {
          ...completedTurn("thread", "turn"),
          status: "rate_limited",
          rateLimitUntilMs: 100000,
          error: "codex_rate_limited"
        };
      }
    });
    const orchestrator = new Orchestrator({ workflowPath: "/tmp/WORKFLOW.md" }, deps);

    await orchestrator.tick();
    await flushPromises();
    now = 2000;
    await orchestrator.tick();

    expect(codexCalls).toBe(1);
    expect(orchestrator.snapshot().codexRateLimit.resumeAfterMs).toBe(100000);
  });

  it("keeps last known good config on invalid reload", async () => {
    const config = makeConfig();
    let loads = 0;
    const deps = makeDeps({
      loadWorkflowConfig: async () => {
        loads += 1;
        if (loads > 1) {
          throw new Error("bad config");
        }
        return config;
      },
      fetchCandidateIssues: async () => []
    });
    const orchestrator = new Orchestrator({ workflowPath: "/tmp/WORKFLOW.md" }, deps);

    await orchestrator.tick();
    await orchestrator.tick();

    expect(orchestrator.snapshot().lastConfigError).toBe("bad config");
  });
});

type TestDeps = Partial<OrchestratorDependencies>;

function makeDeps(overrides: TestDeps = {}): TestDeps {
  const config = makeConfig();
  return {
    loadWorkflowConfig: async () => config,
    fetchCandidateIssues: async () => [],
    fetchIssueById: async (_config, issueId) => makeIssue(issueId),
    fetchTerminalIssues: async () => [],
    writeRunnerComment: async () => undefined,
    prepareWorkspace: async (_config, issue) => makeWorkspace(issue),
    removeWorkspace: async () => undefined,
    workspaceInfoForIssue: (_config, issue) => makeWorkspace(issue),
    workspacePathExists: async () => true,
    runHook: async () => undefined,
    renderIssuePrompt: async (_config, issue) => `Prompt ${issue.identifier}`,
    runCodexTurn: async (_input: CodexRunInput, _options: { signal: AbortSignal; onEvent: (event: CodexRunEvent) => void }) =>
      completedTurn("thread", "turn"),
    now: () => 1000,
    sleep: async () => undefined,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    },
    ...overrides
  };
}

function makeConfig(): EffectiveWorkflowConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    workflowDir: "/tmp",
    promptTemplate: "Prompt {{ issue.identifier }}",
    tracker: {
      kind: "linear",
      endpoint: "https://linear.example/graphql",
      apiKey: "lin_test",
      projectSlug: "project",
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done", "Closed", "Canceled"]
    },
    polling: { intervalMs: 30000 },
    workspace: {
      root: "/tmp/workspaces",
      repoPath: "/tmp/repo",
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
      maxConcurrentAgentsByState: {}
    },
    codex: {
      command: "codex app-server --listen stdio://",
      approvalPolicy: "never",
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 3600000,
      readTimeoutMs: 5000,
      stallTimeoutMs: 300000,
      model: null
    }
  };
}

function makeIssue(identifier: string): NormalizedIssue {
  return {
    id: identifier,
    identifier,
    title: `Issue ${identifier}`,
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null
  };
}

function makeWorkspace(issue: NormalizedIssue): WorkspaceInfo {
  return {
    path: `/tmp/workspaces/${issue.identifier}`,
    workspaceKey: issue.identifier,
    branchName: `symphony/${issue.identifier}`,
    createdNow: false
  };
}

function completedTurn(threadId: string, turnId: string): CodexTurnResult {
  return {
    status: "completed",
    threadId,
    turnId,
    rateLimitUntilMs: null,
    lastMessage: null,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    error: null
  };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

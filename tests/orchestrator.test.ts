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

  it("skips issues without required label and repo route", async () => {
    const config = makeConfig({
      tracker: {
        requiredLabels: ["symphony"],
        repoLabelPrefix: "repo:"
      },
      workspace: {
        repoRoutes: {
          symphony: "/tmp/repo"
        }
      }
    });
    const deps = makeDeps({
      loadWorkflowConfig: async () => config,
      fetchCandidateIssues: async () => [
        makeIssue("APP-1", { labels: ["symphony"] }),
        makeIssue("APP-2", { labels: ["repo:symphony"] }),
        makeIssue("APP-3", { labels: ["symphony", "repo:symphony"] })
      ],
      runCodexTurn: async () => new Promise<CodexTurnResult>(() => undefined)
    });
    const orchestrator = new Orchestrator({ workflowPath: "/tmp/WORKFLOW.md" }, deps);

    await orchestrator.tick();

    expect(orchestrator.snapshot().running.map((session) => session.identifier)).toEqual(["APP-3"]);
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

function makeConfig(
  overrides: {
    tracker?: Partial<EffectiveWorkflowConfig["tracker"]>;
    workspace?: Partial<EffectiveWorkflowConfig["workspace"]>;
  } = {}
): EffectiveWorkflowConfig {
  const config: EffectiveWorkflowConfig = {
    workflowPath: "/tmp/WORKFLOW.md",
    workflowDir: "/tmp",
    promptTemplate: "Prompt {{ issue.identifier }}",
    tracker: {
      kind: "linear",
      endpoint: "https://linear.example/graphql",
      apiKey: "lin_test",
      projectSlug: "project",
      teamKey: null,
      requiredLabels: [],
      repoLabelPrefix: "repo:",
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done", "Closed", "Canceled"]
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
  return {
    ...config,
    tracker: {
      ...config.tracker,
      ...overrides.tracker
    },
    workspace: {
      ...config.workspace,
      ...overrides.workspace
    }
  };
}

function makeIssue(identifier: string, overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    id: overrides.id ?? identifier,
    identifier: overrides.identifier ?? identifier,
    title: overrides.title ?? `Issue ${identifier}`,
    description: overrides.description ?? null,
    priority: overrides.priority ?? null,
    state: overrides.state ?? "Todo",
    branchName: overrides.branchName ?? null,
    url: overrides.url ?? null,
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    createdAt: overrides.createdAt ?? null,
    updatedAt: overrides.updatedAt ?? null
  };
}

function makeWorkspace(issue: NormalizedIssue): WorkspaceInfo {
  return {
    path: `/tmp/workspaces/${issue.identifier}`,
    workspaceKey: issue.identifier,
    branchName: `symphony/${issue.identifier}`,
    repoKey: null,
    repoPath: "/tmp/repo",
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

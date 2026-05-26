import { describe, expect, it } from "vitest";
import { githubPullRequestUrlFromIssue, requestCodexReviewForIssue } from "../src/codexReviewRequest.js";
import type { EffectiveWorkflowConfig, NormalizedIssue } from "../src/types.js";

describe("Codex review request", () => {
  it("extracts a clean GitHub PR URL from Linear handoff text", () => {
    expect(githubPullRequestUrlFromIssue(makeIssue({
      description: "PR: https://github.com/anmho/symphony/pull/41](<https://github.com/anmho/symphony/pull/41>)"
    }))).toBe("https://github.com/anmho/symphony/pull/41");
  });

  it("posts @codex review and writes a Linear sync comment", async () => {
    const commands: string[][] = [];
    const comments: Array<{ issueId: string; body: string }> = [];

    const result = await requestCodexReviewForIssue(makeConfig(), "ANM-123", {
      fetchIssues: async () => [makeIssue()],
      runner: async (_command, args) => {
        commands.push(args);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      writeComment: async (_config, issueId, body) => {
        comments.push({ issueId, body });
      }
    });

    expect(result).toEqual({
      issue: "ANM-123",
      prUrl: "https://github.com/anmho/symphony/pull/41",
      dryRun: false,
      githubComment: "@codex review"
    });
    expect(commands[0]).toEqual(["pr", "comment", "https://github.com/anmho/symphony/pull/41", "--body", "@codex review"]);
    expect(comments[0]).toEqual({
      issueId: "issue-123",
      body: "Requested Codex AI review for https://github.com/anmho/symphony/pull/41.\n\nGitHub comment: `@codex review`"
    });
  });

  it("posts review requests with the configured GitHub PR identity", async () => {
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];

    await requestCodexReviewForIssue(makeConfig({ identity: true }), "ANM-123", {
      fetchIssues: async () => [makeIssue()],
      resolveIdentity: async () => ({
        login: "app/anmho-symphony",
        token: "token",
        env: {
          GH_TOKEN: "token",
          GITHUB_TOKEN: "token",
          GIT_AUTHOR_NAME: "anmho-symphony[bot]",
          GIT_AUTHOR_EMAIL: "3862765+anmho-symphony[bot]@users.noreply.github.com",
          GIT_COMMITTER_NAME: "anmho-symphony[bot]",
          GIT_COMMITTER_EMAIL: "3862765+anmho-symphony[bot]@users.noreply.github.com"
        }
      }),
      runner: async (_command, _args, options) => {
        envs.push(options?.env);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      writeComment: async () => undefined
    });

    expect(envs[0]?.GH_TOKEN).toBe("token");
    expect(envs[0]?.GIT_AUTHOR_EMAIL).toBe("3862765+anmho-symphony[bot]@users.noreply.github.com");
  });

  it("dry-runs without mutating GitHub or Linear", async () => {
    const result = await requestCodexReviewForIssue(makeConfig(), "issue-123", {
      dryRun: true,
      fetchIssues: async () => [makeIssue()],
      runner: async () => {
        throw new Error("should_not_run");
      },
      writeComment: async () => {
        throw new Error("should_not_write");
      }
    });

    expect(result.dryRun).toBe(true);
    expect(result.prUrl).toBe("https://github.com/anmho/symphony/pull/41");
  });

  it("can use an explicit PR URL before Linear handoff text contains one", async () => {
    const result = await requestCodexReviewForIssue(makeConfig(), "ANM-123", {
      prUrl: "https://github.com/anmho/symphony/pull/99",
      dryRun: true,
      fetchIssues: async () => [makeIssue({ description: null })]
    });

    expect(result.prUrl).toBe("https://github.com/anmho/symphony/pull/99");
  });
});

function makeIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    id: "issue-123",
    identifier: "ANM-123",
    title: "Review the PR",
    description: "Handoff PR: https://github.com/anmho/symphony/pull/41",
    priority: null,
    state: "In Review",
    branchName: null,
    url: "https://linear.app/anmho/issue/ANM-123/review-the-pr",
    labels: ["symphony", "repo:symphony"],
    comments: [],
    attachments: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides
  };
}

function makeConfig(options: { identity?: boolean } = {}): EffectiveWorkflowConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    workflowDir: "/tmp",
    promptTemplate: "Prompt",
    tracker: {
      kind: "linear",
      endpoint: "https://linear.example/graphql",
      apiKey: "lin_test",
      projectSlug: null,
      teamKey: "ANM",
      requiredLabels: ["symphony"],
      repoLabelPrefix: "repo:",
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done"],
      handoffState: "In Review",
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
      command: "codex app-server --listen stdio://",
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: null,
      turnTimeoutMs: 3600000,
      readTimeoutMs: 5000,
      stallTimeoutMs: 300000,
      model: null
    },
    github: {
      prIdentity: options.identity
        ? {
            kind: "github_app",
            appSlug: "anmho-symphony",
            tokenCommand: "symphony github-app-token --app-id 3862765 --installation-id 135623998 --private-key-command 'vault kv get -mount=secret -field=private_key prod/providers/github/symphony'",
            authorName: "anmho-symphony[bot]",
            authorEmail: "3862765+anmho-symphony[bot]@users.noreply.github.com",
            reviewerLogin: "anmho",
            reviewerLogins: ["anmho"]
          }
        : null
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

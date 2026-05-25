import { describe, expect, it } from "vitest";
import {
  branchNameForIssue,
  isIssueEligible,
  resolveIssueRepoRoute,
  sanitizeWorkspaceKey,
  sortIssuesForDispatch
} from "../src/policy.js";
import type { EffectiveWorkflowConfig, NormalizedIssue } from "../src/types.js";

const config = {
  tracker: {
    activeStates: ["Todo", "In Progress"],
    terminalStates: ["Done", "Canceled"],
    requiredLabels: [],
    repoLabelPrefix: "repo:"
  },
  workspace: {
    repoPath: "/tmp/repo",
    repoRoutes: {}
  }
} as unknown as EffectiveWorkflowConfig;

describe("policy", () => {
  it("sanitizes worktree and branch names", () => {
    expect(sanitizeWorkspaceKey("APP-123/fix auth")).toBe("APP-123_fix_auth");
    expect(branchNameForIssue("APP-123/fix auth")).toBe("symphony/APP-123_fix_auth");
  });

  it("does not dispatch Todo issues with open blockers", () => {
    const issue = makeIssue({
      state: "Todo",
      blockedBy: [{ id: "1", identifier: "APP-1", state: "In Progress", createdAt: null, updatedAt: null }]
    });

    expect(isIssueEligible(issue, config)).toBe(false);
  });

  it("dispatches active unblocked issues", () => {
    expect(isIssueEligible(makeIssue({ state: "In Progress" }), config)).toBe(true);
  });

  it("requires configured opt-in labels", () => {
    const gatedConfig = {
      ...config,
      tracker: {
        ...config.tracker,
        requiredLabels: ["symphony"]
      }
    } as unknown as EffectiveWorkflowConfig;

    expect(isIssueEligible(makeIssue({ labels: [] }), gatedConfig)).toBe(false);
    expect(isIssueEligible(makeIssue({ labels: ["Symphony"] }), gatedConfig)).toBe(true);
  });

  it("requires exactly one configured repo route label when routes are configured", () => {
    const routedConfig = {
      ...config,
      tracker: {
        ...config.tracker,
        repoLabelPrefix: "repo:"
      },
      workspace: {
        repoPath: "/tmp/fallback",
        repoRoutes: {
          symphony: "/tmp/symphony",
          auth: "/tmp/auth"
        }
      }
    } as unknown as EffectiveWorkflowConfig;

    expect(resolveIssueRepoRoute(makeIssue({ labels: ["repo:symphony"] }), routedConfig)).toEqual({
      repoKey: "symphony",
      repoPath: "/tmp/symphony"
    });
    expect(isIssueEligible(makeIssue({ labels: [] }), routedConfig)).toBe(false);
    expect(isIssueEligible(makeIssue({ labels: ["repo:missing"] }), routedConfig)).toBe(false);
    expect(isIssueEligible(makeIssue({ labels: ["repo:symphony", "repo:auth"] }), routedConfig)).toBe(false);
  });

  it("sorts by priority then creation time", () => {
    const sorted = sortIssuesForDispatch([
      makeIssue({ identifier: "APP-2", priority: 2, createdAt: "2026-01-02" }),
      makeIssue({ identifier: "APP-1", priority: 1, createdAt: "2026-01-03" }),
      makeIssue({ identifier: "APP-3", priority: 1, createdAt: "2026-01-01" })
    ]);

    expect(sorted.map((issue) => issue.identifier)).toEqual(["APP-3", "APP-1", "APP-2"]);
  });
});

function makeIssue(overrides: Partial<NormalizedIssue>): NormalizedIssue {
  return {
    id: overrides.id ?? overrides.identifier ?? "issue-id",
    identifier: overrides.identifier ?? "APP-1",
    title: overrides.title ?? "Test issue",
    description: overrides.description ?? null,
    priority: overrides.priority ?? null,
    state: overrides.state ?? "Todo",
    branchName: overrides.branchName ?? null,
    url: overrides.url ?? null,
    labels: overrides.labels ?? [],
    comments: overrides.comments ?? [],
    attachments: overrides.attachments ?? [],
    blockedBy: overrides.blockedBy ?? [],
    createdAt: overrides.createdAt ?? null,
    updatedAt: overrides.updatedAt ?? null
  };
}

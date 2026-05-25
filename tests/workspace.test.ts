import { describe, expect, it } from "vitest";
import { workspaceInfoForIssue } from "../src/workspace.js";
import type { EffectiveWorkflowConfig, NormalizedIssue } from "../src/types.js";

describe("workspace routing", () => {
  it("uses repo-key nested workspaces for routed issues", () => {
    const config = {
      workspace: {
        root: "/tmp/symphony/.symphony/workspaces",
        repoPath: "/tmp/symphony",
        repoRoutes: {
          symphony: "/Users/test/repos/symphony"
        }
      },
      tracker: {
        repoLabelPrefix: "repo:"
      }
    } as unknown as EffectiveWorkflowConfig;

    expect(workspaceInfoForIssue(config, makeIssue({ labels: ["symphony", "repo:symphony"] }))).toEqual({
      path: "/tmp/symphony/.symphony/workspaces/symphony/ANM-1",
      workspaceKey: "ANM-1",
      branchName: "symphony/ANM-1",
      repoKey: "symphony",
      repoPath: "/Users/test/repos/symphony",
      createdNow: false
    });
  });
});

function makeIssue(overrides: Partial<NormalizedIssue>): NormalizedIssue {
  return {
    id: overrides.id ?? overrides.identifier ?? "ANM-1",
    identifier: overrides.identifier ?? "ANM-1",
    title: overrides.title ?? "Test issue",
    description: overrides.description ?? null,
    priority: overrides.priority ?? null,
    state: overrides.state ?? "Todo",
    branchName: overrides.branchName ?? null,
    url: overrides.url ?? null,
    labels: overrides.labels ?? [],
    comments: overrides.comments ?? [],
    blockedBy: overrides.blockedBy ?? [],
    createdAt: overrides.createdAt ?? null,
    updatedAt: overrides.updatedAt ?? null
  };
}

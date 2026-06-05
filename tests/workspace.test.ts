import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/process.js";
import { ensureWorkspace, workspaceInfoForIssue } from "../src/workspace.js";
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

  it("prunes stale expected worktree registrations and recreates the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-workspace-"));
    const repoPath = path.join(root, "repo");
    const workspaceRoot = path.join(root, "workspaces");
    const issue = makeIssue({ labels: ["symphony"] });
    const config = {
      workspace: {
        root: workspaceRoot,
        repoPath,
        repoRoutes: {},
        baseBranch: "main"
      },
      tracker: {
        repoLabelPrefix: "repo:"
      }
    } as unknown as EffectiveWorkflowConfig;

    await runCommand("git", ["init", "--initial-branch=main", repoPath]);
    await writeFile(path.join(repoPath, "README.md"), "test\n");
    await runCommand("git", ["-C", repoPath, "add", "README.md"]);
    await runCommand("git", [
      "-C",
      repoPath,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "initial"
    ]);

    const first = await ensureWorkspace(config, issue);
    await rm(first.path, { recursive: true, force: true });

    const recreated = await ensureWorkspace(config, issue);

    expect(recreated.path).toBe(first.path);
    expect(recreated.createdNow).toBe(true);
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
    attachments: overrides.attachments ?? [],
    blockedBy: overrides.blockedBy ?? [],
    createdAt: overrides.createdAt ?? null,
    updatedAt: overrides.updatedAt ?? null
  };
}

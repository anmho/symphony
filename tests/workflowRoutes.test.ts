import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkflowMarkdown, resolveWorkflowConfig } from "../src/config.js";
import { resolveIssueRepoRoute } from "../src/policy.js";
import { validateConfiguredRepoRouteLabels } from "../src/validation.js";
import type { NormalizedIssue } from "../src/types.js";

const projectsRoot = "/Users/andrewho/repos/projects";
const routedRepos = ["better-auth-studio", "tab-organizer"] as const;

describe("WORKFLOW repo routes", () => {
  it("covers recently-active repos through config validation and dispatch routing", async () => {
    const workflowPath = path.join(process.cwd(), "WORKFLOW.md");
    const workflowBody = await readFile(workflowPath, "utf8");
    const config = resolveWorkflowConfig(workflowPath, parseWorkflowMarkdown(workflowBody), {
      workflow: null,
      env: {
        LINEAR_API_KEY: "lin_test",
        PROJECTS_ROOT: projectsRoot
      },
      secrets: {}
    });

    const expectedLabels = Object.keys(config.workspace.repoRoutes).map(
      (repoKey) => `${config.tracker.repoLabelPrefix}${repoKey}`
    );

    expect(config.workspace.repoRoutes["better-auth-studio"]).toBe(`${projectsRoot}/better-auth-studio`);
    expect(config.workspace.repoRoutes["tab-organizer"]).toBe(`${projectsRoot}/tab-organizer`);
    expect(expectedLabels).toEqual(expect.arrayContaining(["repo:better-auth-studio", "repo:tab-organizer"]));
    await expect(validateConfiguredRepoRouteLabels(config, async () => expectedLabels)).resolves.toEqual([]);

    for (const repoKey of routedRepos) {
      expect(resolveIssueRepoRoute(makeIssue({ labels: [`repo:${repoKey}`] }), config)).toEqual({
        repoKey,
        repoPath: `${projectsRoot}/${repoKey}`
      });
    }
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

import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseWorkflowMarkdown, resolveWorkflowConfig } from "../src/config";

describe("workflow config", () => {
  it("parses front matter and applies defaults", () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_test");
    const definition = parseWorkflowMarkdown(`---
tracker:
  project_slug: project-one
workspace:
  repo_path: .
---
Hello {{ issue.identifier }}
`);

    const config = resolveWorkflowConfig("/tmp/symphony/WORKFLOW.md", definition);

    expect(config.tracker.kind).toBe("linear");
    expect(config.tracker.apiKey).toBe("lin_test");
    expect(config.tracker.projectSlug).toBe("project-one");
    expect(config.tracker.teamKey).toBeNull();
    expect(config.agent.maxConcurrentAgents).toBe(5);
    expect(config.codex.command).toBe("codex app-server --listen stdio://");
    expect(config.codex.threadSandbox).toBe("workspace-write");
    expect(config.workspace.repoPath).toBe(path.resolve("/tmp/symphony"));
    expect(config.promptTemplate).toContain("Hello");
  });

  it("requires a Linear project slug or team key", () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_test");
    const definition = parseWorkflowMarkdown(`---
tracker:
  kind: linear
workspace:
  repo_path: .
---
Body
`);

    expect(() => resolveWorkflowConfig("/tmp/symphony/WORKFLOW.md", definition)).toThrow(
      "missing_tracker_project_slug_or_team_key"
    );
  });

  it("parses team label routing config with env-rooted repo routes", () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_test");
    vi.stubEnv("PROJECTS_ROOT", "/Users/test/repos");
    const definition = parseWorkflowMarkdown(`---
tracker:
  team_key: ANM
  required_labels:
    - symphony
  repo_label_prefix: "repo:"
workspace:
  root: ./.symphony/workspaces
  repo_path: .
  projects_root: $PROJECTS_ROOT
  repo_routes:
    symphony: symphony
    auth: auth
---
Prompt
`);

    const config = resolveWorkflowConfig("/tmp/symphony/WORKFLOW.md", definition);

    expect(config.tracker.projectSlug).toBeNull();
    expect(config.tracker.teamKey).toBe("ANM");
    expect(config.tracker.requiredLabels).toEqual(["symphony"]);
    expect(config.workspace.root).toBe(path.resolve("/tmp/symphony/.symphony/workspaces"));
    expect(config.workspace.projectsRoot).toBe("/Users/test/repos");
    expect(config.workspace.repoRoutes).toEqual({
      symphony: "/Users/test/repos/symphony",
      auth: "/Users/test/repos/auth"
    });
  });
});

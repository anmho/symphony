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
    expect(config.agent.maxConcurrentAgents).toBe(5);
    expect(config.codex.command).toBe("codex app-server --listen stdio://");
    expect(config.codex.threadSandbox).toBe("workspace-write");
    expect(config.workspace.repoPath).toBe(path.resolve("/tmp/symphony"));
    expect(config.promptTemplate).toContain("Hello");
  });

  it("requires Linear project slug", () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_test");
    const definition = parseWorkflowMarkdown(`---
tracker:
  kind: linear
workspace:
  repo_path: .
---
Body
`);

    expect(() => resolveWorkflowConfig("/tmp/symphony/WORKFLOW.md", definition)).toThrow("missing_tracker_project_slug");
  });
});

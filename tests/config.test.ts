import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadUserConfig, parseWorkflowMarkdown, resolveWorkflowConfig, resolveWorkflowPath } from "../src/config.js";

describe("workflow config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
    expect(config.github.prIdentity).toBeNull();
    expect(config.pullRequest).toEqual({ backend: "github", graphiteFallback: "fail" });
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
  handoff_state: Human Review
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
    expect(config.tracker.handoffState).toBe("Human Review");
    expect(config.tracker.requiredLabels).toEqual(["symphony"]);
    expect(config.workspace.root).toBe(path.resolve("/tmp/symphony/.symphony/workspaces"));
    expect(config.workspace.projectsRoot).toBe("/Users/test/repos");
    expect(config.workspace.repoRoutes).toEqual({
      symphony: "/Users/test/repos/symphony",
      auth: "/Users/test/repos/auth"
    });
  });

  it("resolves env placeholders from user config", () => {
    vi.stubEnv("LINEAR_API_KEY", "");
    vi.stubEnv("PROJECTS_ROOT", "");
    const definition = parseWorkflowMarkdown(`---
tracker:
  team_key: ANM
workspace:
  root: ./.symphony/workspaces
  repo_path: .
  projects_root: $PROJECTS_ROOT
  repo_routes:
    symphony: symphony
---
Prompt
`);

    const config = resolveWorkflowConfig("/tmp/symphony/WORKFLOW.md", definition, {
      workflow: null,
      env: {
        LINEAR_API_KEY: "lin_from_user_config",
        PROJECTS_ROOT: "/Users/test/repos"
      },
      secrets: {}
    });

    expect(config.tracker.apiKey).toBe("lin_from_user_config");
    expect(config.workspace.projectsRoot).toBe("/Users/test/repos");
    expect(config.workspace.repoRoutes.symphony).toBe("/Users/test/repos/symphony");
  });

  it("does not run secret commands when env config already resolves a placeholder", () => {
    vi.stubEnv("LINEAR_API_KEY", "");
    vi.stubEnv("PROJECTS_ROOT", "");
    const definition = parseWorkflowMarkdown(`---
tracker:
  team_key: ANM
workspace:
  projects_root: $PROJECTS_ROOT
---
Prompt
`);

    const config = resolveWorkflowConfig("/tmp/symphony/WORKFLOW.md", definition, {
      workflow: null,
      env: {
        LINEAR_API_KEY: "lin_from_user_config",
        PROJECTS_ROOT: "/Users/test/repos"
      },
      secrets: {
        LINEAR_API_KEY: {
          command: "exit 42"
        },
        PROJECTS_ROOT: {
          command: "exit 42"
        }
      }
    });

    expect(config.tracker.apiKey).toBe("lin_from_user_config");
    expect(config.workspace.projectsRoot).toBe("/Users/test/repos");
  });

  it("loads default workflow path from user config", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-user-config-"));
    const configPath = path.join(dir, "config.json");
    vi.stubEnv("SYMPHONY_CONFIG", configPath);
    await writeFile(
      configPath,
      JSON.stringify({
        workflow: "/tmp/custom/WORKFLOW.md",
        env: {
          PROJECTS_ROOT: "/tmp/repos"
        }
      })
    );

    await expect(loadUserConfig()).resolves.toMatchObject({
      workflow: "/tmp/custom/WORKFLOW.md",
      env: {
        PROJECTS_ROOT: "/tmp/repos"
      }
    });
    await expect(resolveWorkflowPath()).resolves.toBe("/tmp/custom/WORKFLOW.md");
  });

  it("parses Graphite PR backend config", () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_test");
    const definition = parseWorkflowMarkdown(`---
tracker:
  project_slug: project-one
pull_request:
  backend: graphite
  graphite:
    fallback: github
---
Prompt
`);

    const config = resolveWorkflowConfig("/tmp/symphony/WORKFLOW.md", definition);

    expect(config.pullRequest).toEqual({ backend: "graphite", graphiteFallback: "github" });
  });

  it("parses GitHub machine-user PR identity config", () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_test");
    const definition = parseWorkflowMarkdown(`---
tracker:
  project_slug: project-one
github:
  pr_identity:
    kind: machine_user
    token_command: vault kv get -mount=secret -field=token prod/providers/github/symphony
    author_name: Symphony
    author_email: anmho-symphony@users.noreply.github.com
---
Prompt
`);

    const config = resolveWorkflowConfig("/tmp/symphony/WORKFLOW.md", definition);

    expect(config.github.prIdentity).toEqual({
      kind: "machine_user",
      tokenCommand: "vault kv get -mount=secret -field=token prod/providers/github/symphony",
      authorName: "Symphony",
      authorEmail: "anmho-symphony@users.noreply.github.com"
    });
  });

  it("parses GitHub App PR identity config", () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_test");
    vi.stubEnv("SYMPHONY_GITHUB_APP_ID", "123");
    vi.stubEnv("SYMPHONY_GITHUB_APP_INSTALLATION_ID", "456");
    const definition = parseWorkflowMarkdown(`---
tracker:
  project_slug: project-one
github:
  pr_identity:
    kind: github_app
    app_id: $SYMPHONY_GITHUB_APP_ID
    installation_id: $SYMPHONY_GITHUB_APP_INSTALLATION_ID
    private_key_command: vault kv get -mount=secret -field=private_key prod/providers/github/symphony
    app_slug: symphony
    author_name: Symphony
    author_email: symphony[bot]@users.noreply.github.com
---
Prompt
`);

    const config = resolveWorkflowConfig("/tmp/symphony/WORKFLOW.md", definition);

    expect(config.github.prIdentity).toEqual({
      kind: "github_app",
      appId: "123",
      installationId: "456",
      privateKeyCommand: "vault kv get -mount=secret -field=private_key prod/providers/github/symphony",
      appSlug: "symphony",
      authorName: "Symphony",
      authorEmail: "symphony[bot]@users.noreply.github.com",
      apiBaseUrl: "https://api.github.com"
    });
  });

  it("rejects unresolved GitHub App PR identity placeholders", () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_test");
    const definition = parseWorkflowMarkdown(`---
tracker:
  project_slug: project-one
github:
  pr_identity:
    kind: github_app
    app_id: $SYMPHONY_GITHUB_APP_ID
    installation_id: $SYMPHONY_GITHUB_APP_INSTALLATION_ID
    private_key_command: vault kv get -mount=secret -field=private_key prod/providers/github/symphony
    author_name: Symphony
    author_email: symphony[bot]@users.noreply.github.com
---
Prompt
`);

    expect(() => resolveWorkflowConfig("/tmp/symphony/WORKFLOW.md", definition)).toThrow(
      "missing_github_pr_identity_app_id"
    );
  });

  it("rejects incomplete GitHub machine-user PR identity config", () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_test");
    const definition = parseWorkflowMarkdown(`---
tracker:
  project_slug: project-one
github:
  pr_identity:
    kind: machine_user
    token_command: vault kv get -mount=secret -field=token prod/providers/github/symphony
    author_name: Symphony
---
Prompt
`);

    expect(() => resolveWorkflowConfig("/tmp/symphony/WORKFLOW.md", definition)).toThrow();
  });
});

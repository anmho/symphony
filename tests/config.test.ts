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
    vi.stubEnv("RESEND_API_KEY", "");
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
    expect(config.digest).toMatchObject({
      enabled: false,
      recipient: "andyminhtuanho@gmail.com",
      sender: "Symphony <agent@anmho.com>",
      intervalMs: 3600000,
      windowMs: 3600000,
      resendApiKey: null,
      resendEndpoint: "https://api.resend.com/emails"
    });
    expect(config.workspace.repoPath).toBe(path.resolve("/tmp/symphony"));
    expect(config.promptTemplate).toContain("Hello");
  });

  it("parses agent.backend and cursor config", () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_test");
    vi.stubEnv("CURSOR_API_KEY", "cur_test");
    const definition = parseWorkflowMarkdown(`---
tracker:
  project_slug: project-one
agent:
  backend: cursor
cursor:
  api_key: $CURSOR_API_KEY
  model: composer-latest
---
Prompt
`);

    const config = resolveWorkflowConfig("/tmp/symphony/WORKFLOW.md", definition);

    expect(config.agent.backend).toBe("cursor");
    expect(config.cursor.apiKey).toBe("cur_test");
    expect(config.cursor.model).toBe("composer-latest");
  });

  it("does not load CURSOR_API_KEY from env when cursor.api_key is omitted", () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_test");
    vi.stubEnv("CURSOR_API_KEY", "cur_from_env");
    const definition = parseWorkflowMarkdown(`---
tracker:
  project_slug: project-one
agent:
  backend: cursor
---
Prompt
`);

    const config = resolveWorkflowConfig("/tmp/symphony/WORKFLOW.md", definition);

    expect(config.cursor.apiKey).toBeNull();
    expect(config.cursor.model).toBe("composer-latest");
  });

  it("resolves CURSOR_API_KEY from vault secret command in user config", () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_test");
    vi.stubEnv("CURSOR_API_KEY", "");
    const definition = parseWorkflowMarkdown(`---
tracker:
  project_slug: project-one
agent:
  backend: cursor
cursor:
  api_key: $CURSOR_API_KEY
---
Prompt
`);

    const config = resolveWorkflowConfig("/tmp/symphony/WORKFLOW.md", definition, {
      workflow: null,
      env: {
        LINEAR_API_KEY: "lin_test"
      },
      secrets: {
        CURSOR_API_KEY: {
          command: "echo cur_from_vault"
        }
      }
    });

    expect(config.cursor.apiKey).toBe("cur_from_vault");
  });

  it("defaults agent.backend to codex with a default cursor model", () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_test");
    vi.stubEnv("CURSOR_API_KEY", "");
    const definition = parseWorkflowMarkdown(`---
tracker:
  project_slug: project-one
---
Prompt
`);

    const config = resolveWorkflowConfig("/tmp/symphony/WORKFLOW.md", definition);

    expect(config.agent.backend).toBe("codex");
    expect(config.cursor.apiKey).toBeNull();
    expect(config.cursor.model).toBe("composer-latest");
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
  merge_state: Eligible for Merging
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
    expect(config.tracker.mergeState).toBe("Eligible for Merging");
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

  it("parses GitHub App PR identity config", () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_test");
    const definition = parseWorkflowMarkdown(`---
tracker:
  project_slug: project-one
github:
  pr_identity:
    kind: github_app
    app_slug: anmho-symphony
    token_command: symphony github-app-token --app-id 3862765 --installation-id 135623998 --private-key-command 'vault kv get -mount=secret -field=private_key prod/providers/github/symphony'
    author_name: anmho Symphony
    author_email: 3862765+anmho-symphony[bot]@users.noreply.github.com
---
Prompt
`);

    const config = resolveWorkflowConfig("/tmp/symphony/WORKFLOW.md", definition);

    expect(config.github.prIdentity).toEqual({
      kind: "github_app",
      appSlug: "anmho-symphony",
      tokenCommand:
        "symphony github-app-token --app-id 3862765 --installation-id 135623998 --private-key-command 'vault kv get -mount=secret -field=private_key prod/providers/github/symphony'",
      authorName: "anmho Symphony",
      authorEmail: "3862765+anmho-symphony[bot]@users.noreply.github.com",
      reviewerLogin: null,
      reviewerLogins: []
    });
  });

  it("keeps parsing legacy machine-user PR identity config", () => {
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

  it("parses GitHub App PR identity config with a required reviewer", () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_test");
    const definition = parseWorkflowMarkdown(`---
tracker:
  project_slug: project-one
github:
  pr_identity:
    kind: github_app
    app_slug: anmho-symphony
    token_command: symphony github-app-token --app-id 3862765 --installation-id 135623998 --private-key-command 'vault kv get -mount=secret -field=private_key prod/providers/github/symphony'
    author_name: anmho Symphony
    author_email: 3862765+anmho-symphony[bot]@users.noreply.github.com
    reviewer_logins:
      - anmho
---
Prompt
`);

    const config = resolveWorkflowConfig("/tmp/symphony/WORKFLOW.md", definition);

    expect(config.github.prIdentity).toEqual({
      kind: "github_app",
      appSlug: "anmho-symphony",
      tokenCommand:
        "symphony github-app-token --app-id 3862765 --installation-id 135623998 --private-key-command 'vault kv get -mount=secret -field=private_key prod/providers/github/symphony'",
      authorName: "anmho Symphony",
      authorEmail: "3862765+anmho-symphony[bot]@users.noreply.github.com",
      reviewerLogin: null,
      reviewerLogins: ["anmho"]
    });
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

  it("parses deterministic digest config and resolves the Resend key from user config", () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_test");
    vi.stubEnv("RESEND_API_KEY", "");
    const definition = parseWorkflowMarkdown(`---
tracker:
  project_slug: project-one
digest:
  enabled: true
  recipient: digest@example.com
  sender: Symphony <symphony@example.com>
  interval_ms: 600000
  window_ms: 300000
  resend_api_key: $RESEND_API_KEY
---
Prompt
`);

    const config = resolveWorkflowConfig("/tmp/symphony/WORKFLOW.md", definition, {
      workflow: null,
      env: {
        RESEND_API_KEY: "re_test"
      },
      secrets: {}
    });

    expect(config.digest).toEqual({
      enabled: true,
      recipient: "digest@example.com",
      sender: "Symphony <symphony@example.com>",
      intervalMs: 600000,
      windowMs: 300000,
      resendApiKey: "re_test",
      resendEndpoint: "https://api.resend.com/emails"
    });
  });

  it("rejects GitHub App PR identity config without a slug", () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_test");
    const definition = parseWorkflowMarkdown(`---
tracker:
  project_slug: project-one
github:
  pr_identity:
    kind: github_app
    token_command: symphony github-app-token --app-id 3862765 --installation-id 135623998 --private-key-command 'vault kv get -mount=secret -field=private_key prod/providers/github/symphony'
    author_name: anmho Symphony
    author_email: 3862765+anmho-symphony[bot]@users.noreply.github.com
---
Prompt
`);

    expect(() => resolveWorkflowConfig("/tmp/symphony/WORKFLOW.md", definition)).toThrow();
  });
});

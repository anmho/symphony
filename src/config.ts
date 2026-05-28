import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { EffectiveWorkflowConfig, JsonObject, WorkflowDefinition } from "./types.js";

const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];
const DEFAULT_DIGEST_RECIPIENT = "andyminhtuanho@gmail.com";
const DEFAULT_DIGEST_SENDER = "Symphony <agent@anmho.com>";
const DEFAULT_DIGEST_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface SymphonyUserConfig {
  workflow: string | null;
  env: Record<string, string>;
  secrets: Record<string, { command: string }>;
}

const UserConfigSchema = z
  .object({
    workflow: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    secrets: z
      .record(
        z.string(),
        z.object({
          command: z.string()
        })
      )
      .optional()
  })
  .passthrough();

const RawWorkflowConfigSchema = z
  .object({
    tracker: z
      .object({
        kind: z.literal("linear").optional(),
        endpoint: z.string().optional(),
        api_key: z.string().optional(),
        project_slug: z.string().optional(),
        team_key: z.string().optional(),
        required_labels: z.array(z.string()).optional(),
        repo_label_prefix: z.string().optional(),
        active_states: z.array(z.string()).optional(),
        terminal_states: z.array(z.string()).optional(),
        handoff_state: z.string().optional(),
        merge_state: z.string().optional()
      })
      .optional(),
    polling: z
      .object({
        interval_ms: z.number().int().positive().optional()
      })
      .optional(),
    workspace: z
      .object({
        root: z.string().optional(),
        repo_path: z.string().optional(),
        projects_root: z.string().optional(),
        repo_routes: z.record(z.string(), z.string()).optional(),
        base_branch: z.string().optional()
      })
      .optional(),
    hooks: z
      .object({
        after_create: z.string().nullable().optional(),
        before_run: z.string().nullable().optional(),
        after_run: z.string().nullable().optional(),
        before_remove: z.string().nullable().optional(),
        timeout_ms: z.number().int().positive().optional()
      })
      .optional(),
    agent: z
      .object({
        backend: z.enum(["codex", "cursor"]).optional(),
        max_concurrent_agents: z.number().int().positive().optional(),
        max_turns: z.number().int().positive().optional(),
        max_retry_backoff_ms: z.number().int().positive().optional(),
        rate_limit_probe_interval_ms: z.number().int().positive().optional(),
        max_concurrent_agents_by_state: z.record(z.string(), z.number().int().positive()).optional()
      })
      .optional(),
    cursor: z
      .object({
        command: z.string().optional(),
        model: z.string().nullable().optional(),
        api_key: z.string().optional(),
        turn_timeout_ms: z.number().int().positive().optional(),
        read_timeout_ms: z.number().int().positive().optional()
      })
      .optional(),
    codex: z
      .object({
        command: z.string().optional(),
        approval_policy: z.unknown().optional(),
        thread_sandbox: z.unknown().nullable().optional(),
        turn_sandbox_policy: z.unknown().nullable().optional(),
        turn_timeout_ms: z.number().int().positive().optional(),
        read_timeout_ms: z.number().int().positive().optional(),
        stall_timeout_ms: z.number().int().optional(),
        model: z.string().nullable().optional()
      })
      .optional(),
    github: z
      .object({
        pr_identity: z
          .discriminatedUnion("kind", [
            z.object({
              kind: z.literal("machine_user"),
              token_command: z.string().min(1),
              author_name: z.string().min(1),
              author_email: z.string().min(1)
            }),
            z.object({
              kind: z.literal("github_app"),
              app_slug: z.string().min(1),
              token_command: z.string().min(1),
              author_name: z.string().min(1),
              author_email: z.string().min(1),
              reviewer_login: z.string().min(1).optional(),
              reviewer_logins: z.array(z.string().min(1)).optional()
            })
          ])
          .optional()
      })
      .optional(),
    pull_request: z
      .object({
        backend: z.enum(["github", "graphite"]).optional(),
        graphite: z
          .object({
            fallback: z.enum(["fail", "github"]).optional()
          })
          .optional()
      })
      .optional(),
    digest: z
      .object({
        enabled: z.boolean().optional(),
        recipient: z.string().optional(),
        sender: z.string().optional(),
        interval_ms: z.number().int().positive().optional(),
        window_ms: z.number().int().positive().optional(),
        resend_api_key: z.string().optional(),
        resend_endpoint: z.string().url().optional()
      })
      .optional()
  })
  .passthrough();

export function parseWorkflowMarkdown(markdown: string): WorkflowDefinition {
  if (!markdown.startsWith("---")) {
    return {
      config: {},
      promptTemplate: markdown.trim()
    };
  }

  const lines = markdown.split(/\r?\n/);
  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      closingIndex = index;
      break;
    }
  }

  if (closingIndex === -1) {
    throw new Error("workflow_parse_error: front matter is missing closing ---");
  }

  const frontMatter = lines.slice(1, closingIndex).join("\n");
  const parsed = YAML.parse(frontMatter) ?? {};
  if (!isObject(parsed) || Array.isArray(parsed)) {
    throw new Error("workflow_front_matter_not_a_map");
  }

  return {
    config: parsed as JsonObject,
    promptTemplate: lines.slice(closingIndex + 1).join("\n").trim()
  };
}

export async function loadWorkflowConfig(workflowPath: string): Promise<EffectiveWorkflowConfig> {
  const userConfig = await loadUserConfig();
  const absoluteWorkflowPath = path.resolve(workflowPath);
  const body = await readFile(absoluteWorkflowPath, "utf8").catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`missing_workflow_file: ${message}`);
  });

  return resolveWorkflowConfig(absoluteWorkflowPath, parseWorkflowMarkdown(body), userConfig);
}

export async function resolveWorkflowPath(explicitWorkflowPath?: string): Promise<string> {
  if (explicitWorkflowPath) {
    return path.resolve(explicitWorkflowPath);
  }
  const userConfig = await loadUserConfig();
  return path.resolve(userConfig.workflow ?? "WORKFLOW.md");
}

export async function loadUserConfig(): Promise<SymphonyUserConfig> {
  const configPath = userConfigPath();
  const raw = await readFile(configPath, "utf8").catch((error: unknown) => {
    if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`user_config_read_error: ${message}`);
  });

  if (!raw) {
    return emptyUserConfig();
  }

  const parsed = UserConfigSchema.parse(JSON.parse(raw));
  return {
    workflow: parsed.workflow ?? null,
    env: parsed.env ?? {},
    secrets: parsed.secrets ?? {}
  };
}

export function userConfigPath(): string {
  return process.env.SYMPHONY_CONFIG
    ? path.resolve(process.env.SYMPHONY_CONFIG)
    : path.join(os.homedir(), ".config", "symphony", "config.json");
}

export function resolveWorkflowConfig(
  workflowPath: string,
  definition: WorkflowDefinition,
  userConfig: SymphonyUserConfig = emptyUserConfig()
): EffectiveWorkflowConfig {
  const workflowDir = path.dirname(path.resolve(workflowPath));
  const raw = RawWorkflowConfigSchema.parse(definition.config);

  const tracker = raw.tracker ?? {};
  const workspace = raw.workspace ?? {};
  const agent = raw.agent ?? {};
  const hooks = raw.hooks ?? {};
  const codex = raw.codex ?? {};
  const cursor = raw.cursor ?? {};
  const github = raw.github ?? {};
  const pullRequest = raw.pull_request ?? {};
  const digest = raw.digest ?? {};

  const apiKey = resolveEnvValue(tracker.api_key ?? "$LINEAR_API_KEY", userConfig);
  const projectSlug = normalizeOptionalString(tracker.project_slug);
  const teamKey = normalizeOptionalString(tracker.team_key);
  const repoPath = resolvePath(workspace.repo_path ?? workflowDir, workflowDir, userConfig);
  const projectsRoot = workspace.projects_root ? resolvePath(workspace.projects_root, workflowDir, userConfig) : null;

  if ((tracker.kind ?? "linear") !== "linear") {
    throw new Error("unsupported_tracker_kind");
  }
  if (!apiKey) {
    throw new Error("missing_tracker_api_key");
  }
  if (!projectSlug && !teamKey) {
    throw new Error("missing_tracker_project_slug_or_team_key");
  }
  if (!repoPath) {
    throw new Error("missing_workspace_repo_path");
  }
  return {
    workflowPath: path.resolve(workflowPath),
    workflowDir,
    promptTemplate: definition.promptTemplate,
    tracker: {
      kind: "linear",
      endpoint: tracker.endpoint ?? "https://api.linear.app/graphql",
      apiKey,
      projectSlug,
      teamKey,
      requiredLabels: normalizeLabels(tracker.required_labels ?? []),
      repoLabelPrefix: tracker.repo_label_prefix ?? "repo:",
      activeStates: tracker.active_states ?? DEFAULT_ACTIVE_STATES,
      terminalStates: tracker.terminal_states ?? DEFAULT_TERMINAL_STATES,
      handoffState: normalizeOptionalString(tracker.handoff_state),
      mergeState: normalizeOptionalString(tracker.merge_state)
    },
    polling: {
      intervalMs: raw.polling?.interval_ms ?? 30000
    },
    workspace: {
      root: resolvePath(workspace.root ?? "./symphony_workspaces", workflowDir, userConfig),
      repoPath,
      projectsRoot,
      repoRoutes: resolveRepoRoutes(workspace.repo_routes ?? {}, projectsRoot, workflowDir, userConfig),
      baseBranch: workspace.base_branch ?? "main"
    },
    hooks: {
      afterCreate: hooks.after_create ?? null,
      beforeRun: hooks.before_run ?? null,
      afterRun: hooks.after_run ?? null,
      beforeRemove: hooks.before_remove ?? null,
      timeoutMs: hooks.timeout_ms ?? 60000
    },
    agent: {
      backend: agent.backend ?? "codex",
      maxConcurrentAgents: agent.max_concurrent_agents ?? 5,
      maxTurns: agent.max_turns ?? 20,
      maxRetryBackoffMs: agent.max_retry_backoff_ms ?? 300000,
      rateLimitProbeIntervalMs: agent.rate_limit_probe_interval_ms ?? 15000,
      maxConcurrentAgentsByState: normalizeConcurrencyMap(agent.max_concurrent_agents_by_state ?? {})
    },
    codex: {
      command: codex.command ?? "codex app-server --listen stdio://",
      approvalPolicy: codex.approval_policy ?? "never",
      threadSandbox: codex.thread_sandbox ?? "workspace-write",
      turnSandboxPolicy: codex.turn_sandbox_policy ?? null,
      turnTimeoutMs: codex.turn_timeout_ms ?? 3600000,
      readTimeoutMs: codex.read_timeout_ms ?? 5000,
      stallTimeoutMs: codex.stall_timeout_ms ?? 300000,
      model: codex.model ?? null
    },
    cursor: {
      command: cursor.command ?? "agent acp",
      model: cursor.model ?? null,
      turnTimeoutMs: cursor.turn_timeout_ms ?? codex.turn_timeout_ms ?? 3600000,
      readTimeoutMs: cursor.read_timeout_ms ?? codex.read_timeout_ms ?? 5000,
      apiKey: cursor.api_key
        ? normalizeOptionalString(resolveEnvValue(cursor.api_key, userConfig))
        : null
    },
    github: {
      prIdentity: github.pr_identity
        ? github.pr_identity.kind === "github_app"
          ? {
              kind: github.pr_identity.kind,
              appSlug: github.pr_identity.app_slug,
              tokenCommand: github.pr_identity.token_command,
              authorName: github.pr_identity.author_name,
              authorEmail: github.pr_identity.author_email,
              reviewerLogin: github.pr_identity.reviewer_login ?? null,
              reviewerLogins: normalizeReviewerLogins(
                github.pr_identity.reviewer_login,
                github.pr_identity.reviewer_logins ?? []
              )
            }
          : {
              kind: github.pr_identity.kind,
              tokenCommand: github.pr_identity.token_command,
              authorName: github.pr_identity.author_name,
              authorEmail: github.pr_identity.author_email
            }
        : null
    },
    pullRequest: {
      backend: pullRequest.backend ?? "github",
      graphiteFallback: pullRequest.graphite?.fallback ?? "fail"
    },
    digest: {
      enabled: digest.enabled ?? false,
      recipient:
        normalizeOptionalString(
          digest.recipient ? resolveEnvValue(digest.recipient, userConfig) : undefined
        ) ??
        resolveConfiguredValue("NOTIFICATION_TO", userConfig) ??
        DEFAULT_DIGEST_RECIPIENT,
      sender:
        normalizeOptionalString(
          digest.sender ? resolveEnvValue(digest.sender, userConfig) : undefined
        ) ??
        resolveConfiguredValue("NOTIFICATION_FROM", userConfig) ??
        DEFAULT_DIGEST_SENDER,
      intervalMs: digest.interval_ms ?? DEFAULT_DIGEST_INTERVAL_MS,
      windowMs: digest.window_ms ?? digest.interval_ms ?? DEFAULT_DIGEST_INTERVAL_MS,
      resendApiKey: normalizeOptionalString(
        resolveEnvValue(digest.resend_api_key ?? "$RESEND_API_KEY", userConfig)
      ),
      resendEndpoint: digest.resend_endpoint ?? DEFAULT_RESEND_ENDPOINT
    }
  };
}

export function renderConfigSummary(config: EffectiveWorkflowConfig): string {
  return [
    `workflow=${config.workflowPath}`,
    `project=${config.tracker.projectSlug ?? ""}`,
    `team=${config.tracker.teamKey ?? ""}`,
    `workspaceRoot=${config.workspace.root}`,
    `repo=${config.workspace.repoPath}`,
    `concurrency=${config.agent.maxConcurrentAgents}`,
    `prBackend=${config.pullRequest.backend}`,
    `digest=${config.digest.enabled ? `${config.digest.intervalMs}ms` : "disabled"}`,
    `githubPrIdentity=${renderGithubPrIdentitySummary(config)}`,
    `taskCodex="${config.codex.command}"`
  ].join(" ");
}

function renderGithubPrIdentitySummary(config: EffectiveWorkflowConfig): string {
  const identity = config.github.prIdentity;
  if (!identity) {
    return "";
  }
  return identity.kind === "github_app" ? `${identity.kind}:${identity.appSlug}` : identity.kind;
}

function normalizeConcurrencyMap(input: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key.trim().toLowerCase(), value]));
}

function normalizeLabels(input: string[]): string[] {
  return input.map((label) => label.trim().toLowerCase()).filter(Boolean);
}

function normalizeReviewerLogins(
  legacyReviewer: string | undefined,
  reviewers: string[]
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of [legacyReviewer, ...reviewers]) {
    const reviewer = value?.trim();
    if (!reviewer || seen.has(reviewer.toLowerCase())) {
      continue;
    }
    seen.add(reviewer.toLowerCase());
    normalized.push(reviewer);
  }
  return normalized;
}

function normalizeOptionalString(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function resolveRepoRoutes(
  input: Record<string, string>,
  projectsRoot: string | null,
  workflowDir: string,
  userConfig: SymphonyUserConfig
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).map(([rawKey, rawValue]) => {
      const key = rawKey.trim().toLowerCase();
      const baseDir = projectsRoot && !path.isAbsolute(rawValue) && !rawValue.startsWith("~") && !rawValue.startsWith("$")
        ? projectsRoot
        : workflowDir;
      return [key, resolvePath(rawValue, baseDir, userConfig)];
    })
  );
}

function resolveEnvValue(value: string, userConfig: SymphonyUserConfig): string {
  if (value.startsWith("$") && value.length > 1) {
    const key = value.slice(1);
    return resolveConfiguredValue(key, userConfig) ?? "";
  }
  return value;
}

function resolvePath(value: string, baseDir: string, userConfig: SymphonyUserConfig): string {
  const envResolved = value.startsWith("$") ? resolveRequiredEnvValue(value, userConfig) : value;
  const homeResolved = envResolved.startsWith("~")
    ? path.join(os.homedir(), envResolved.slice(1))
    : envResolved;
  return path.isAbsolute(homeResolved) ? path.normalize(homeResolved) : path.resolve(baseDir, homeResolved);
}

function resolveRequiredEnvValue(value: string, userConfig: SymphonyUserConfig): string {
  const key = value.slice(1);
  const resolved = resolveConfiguredValue(key, userConfig) ?? "";
  if (!resolved) {
    throw new Error(`missing_env_var: ${key}`);
  }
  return resolved;
}

function resolveConfiguredValue(key: string, userConfig: SymphonyUserConfig): string | null {
  return firstNonEmpty(process.env[key], userConfig.env[key]) ?? resolveSecretCommand(key, userConfig);
}

function resolveSecretCommand(key: string, userConfig: SymphonyUserConfig): string | null {
  const command = userConfig.secrets[key]?.command;
  if (!command) {
    return null;
  }
  return execFileSync("bash", ["-lc", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function emptyUserConfig(): SymphonyUserConfig {
  return {
    workflow: null,
    env: {},
    secrets: {}
  };
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (value && value.length > 0) {
      return value;
    }
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

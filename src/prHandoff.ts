import { runCommand, type CommandResult } from "./process.js";
import type { EffectiveWorkflowConfig, NormalizedIssue, PullRequestConfig } from "./types.js";

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number }
) => Promise<CommandResult>;

export type PreparedPrBackend =
  | { backend: "github"; fallbackReason?: string }
  | { backend: "graphite"; version: string };

export interface VerifiedPullRequestMetadata {
  url: string;
  baseRefName: string;
  headRefName: string;
  body: string;
}

export async function preparePrHandoffBackend(
  config: Pick<EffectiveWorkflowConfig, "pullRequest">,
  cwd: string,
  runner: CommandRunner = runCommand
): Promise<PreparedPrBackend> {
  if (config.pullRequest.backend === "github") {
    return { backend: "github" };
  }

  const versionResult = await runBackendProbe("gt", ["--version"], cwd, runner);
  if (versionResult.exitCode !== 0) {
    return graphiteUnavailable(config.pullRequest, commandFailure("graphite_unavailable", "gt --version", versionResult));
  }

  const logResult = await runBackendProbe("gt", ["log", "--stack", "--no-interactive"], cwd, runner);
  if (logResult.exitCode !== 0) {
    return graphiteUnavailable(
      config.pullRequest,
      commandFailure("graphite_not_initialized", "gt log --stack --no-interactive", logResult)
    );
  }

  const dryRunResult = await runBackendProbe(
    "gt",
    ["submit", "--dry-run", "--stack", "--no-interactive", "--no-edit", "--no-ai"],
    cwd,
    runner
  );
  if (dryRunResult.exitCode !== 0) {
    return graphiteUnavailable(
      config.pullRequest,
      commandFailure(
        "graphite_not_authenticated_or_unready",
        "gt submit --dry-run --stack --no-interactive --no-edit --no-ai",
        dryRunResult
      )
    );
  }

  return {
    backend: "graphite",
    version: versionResult.stdout.trim()
  };
}

export async function submitGraphiteStack(
  cwd: string,
  runner: CommandRunner = runCommand
): Promise<void> {
  const result = await runner("gt", ["submit", "--stack", "--no-interactive", "--no-edit", "--no-ai"], {
    cwd,
    timeoutMs: 120000
  });
  if (result.exitCode !== 0) {
    throw new Error(commandFailure("graphite_submit_failed", "gt submit --stack --no-interactive --no-edit --no-ai", result));
  }
}

export async function submitGraphiteStackAndVerify(input: {
  cwd: string;
  branch: string;
  expectedBaseBranch: string;
  linearTicketUrl: string;
  runner?: CommandRunner;
}): Promise<VerifiedPullRequestMetadata> {
  const runner = input.runner ?? runCommand;
  await submitGraphiteStack(input.cwd, runner);
  return verifyPullRequestMetadata({ ...input, runner });
}

export async function verifyPullRequestMetadata(input: {
  cwd: string;
  branch: string;
  expectedBaseBranch: string;
  linearTicketUrl: string;
  runner?: CommandRunner;
}): Promise<VerifiedPullRequestMetadata> {
  const runner = input.runner ?? runCommand;
  const result = await runner("gh", ["pr", "view", input.branch, "--json", "url,baseRefName,headRefName,body"], {
    cwd: input.cwd,
    timeoutMs: 60000
  });
  if (result.exitCode !== 0) {
    throw new Error(commandFailure("github_pr_metadata_unavailable", `gh pr view ${input.branch}`, result));
  }

  const metadata = parsePullRequestMetadata(result.stdout);
  if (metadata.headRefName !== input.branch) {
    throw new Error(`github_pr_head_mismatch: expected ${input.branch}, got ${metadata.headRefName}`);
  }
  if (metadata.baseRefName !== input.expectedBaseBranch) {
    throw new Error(`github_pr_base_mismatch: expected ${input.expectedBaseBranch}, got ${metadata.baseRefName}`);
  }
  if (!metadata.body.includes(input.linearTicketUrl)) {
    throw new Error("github_pr_body_missing_linear_ticket_link");
  }

  return metadata;
}

export function buildPrHandoffInstructions(
  config: Pick<EffectiveWorkflowConfig, "pullRequest">,
  issue: Pick<NormalizedIssue, "url">
): string {
  if (config.pullRequest.backend === "github") {
    return [
      "## PR Handoff Backend",
      "",
      "Use the default GitHub PR flow for handoff. Push the current branch, open or update the PR with GitHub tooling, keep the Linear Ticket link in the PR body, and verify the PR head/base with `gh pr view --json url,baseRefName,headRefName,body` before leaving the handoff."
    ].join("\n");
  }

  const fallbackSentence =
    config.pullRequest.graphiteFallback === "github"
      ? "If Graphite is unavailable or this repository is not initialized for Graphite, fall back to the GitHub PR flow and say that fallback was used in the Linear handoff."
      : "If Graphite is unavailable or this repository is not initialized for Graphite, stop early, leave a clear Linear blocker, and do not guess with manual PR base edits.";

  return [
    "## PR Handoff Backend",
    "",
    "This workflow is configured for Graphite stacked PR handoff.",
    "Before submitting, verify Graphite is usable with `gt --version`, `gt log --stack --no-interactive`, and `gt submit --dry-run --stack --no-interactive --no-edit --no-ai`.",
    fallbackSentence,
    "Submit the stack with `gt submit --stack --no-interactive --no-edit --no-ai`.",
    "After submit, verify the resulting GitHub PR metadata with `gh pr view --json url,baseRefName,headRefName,body`.",
    "The PR head must match the current branch, the PR base must match the expected parent stack branch, and the PR body must include the Linear Ticket link.",
    issue.url ? `Linear Ticket: ${issue.url}` : "Linear Ticket: use the issue URL from this prompt."
  ].join("\n");
}

function graphiteUnavailable(config: PullRequestConfig, reason: string): PreparedPrBackend {
  if (config.graphiteFallback === "github") {
    return { backend: "github", fallbackReason: reason };
  }
  throw new Error(reason);
}

async function runBackendProbe(
  command: string,
  args: string[],
  cwd: string,
  runner: CommandRunner
): Promise<CommandResult> {
  try {
    return await runner(command, args, { cwd, timeoutMs: 30000 });
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error)
    };
  }
}

function parsePullRequestMetadata(raw: string): VerifiedPullRequestMetadata {
  const parsed = JSON.parse(raw) as Partial<VerifiedPullRequestMetadata>;
  const url = typeof parsed.url === "string" ? parsed.url : "";
  const baseRefName = typeof parsed.baseRefName === "string" ? parsed.baseRefName : "";
  const headRefName = typeof parsed.headRefName === "string" ? parsed.headRefName : "";
  const body = typeof parsed.body === "string" ? parsed.body : "";
  if (!url || !baseRefName || !headRefName) {
    throw new Error("github_pr_metadata_incomplete");
  }
  return { url, baseRefName, headRefName, body };
}

function commandFailure(code: string, command: string, result: CommandResult): string {
  const detail = (result.stderr || result.stdout).trim();
  return detail ? `${code}: ${command} failed: ${detail}` : `${code}: ${command} failed`;
}

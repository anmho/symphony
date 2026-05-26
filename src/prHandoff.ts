import { runCommand, type CommandResult } from "./process.js";
import type { EffectiveWorkflowConfig, GithubPrIdentityConfig, NormalizedIssue, PullRequestConfig } from "./types.js";

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
) => Promise<CommandResult>;

export type PreparedPrBackend =
  | { backend: "github"; fallbackReason?: string }
  | { backend: "graphite"; version: string };

export interface VerifiedPullRequestMetadata {
  url: string;
  baseRefName: string;
  headRefName: string;
  body: string;
  authorLogin: string | null;
  reviewRequestLogins: string[];
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
  expectedAuthorLogin?: string | null;
  expectedReviewerLogin?: string | null;
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
  graphitePrUrl?: string | null;
  expectedAuthorLogin?: string | null;
  expectedReviewerLogin?: string | null;
  runner?: CommandRunner;
}): Promise<VerifiedPullRequestMetadata> {
  const runner = input.runner ?? runCommand;
  const result = await runner("gh", ["pr", "view", input.branch, "--json", "url,author,baseRefName,headRefName,body,reviewRequests"], {
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
  if (input.graphitePrUrl && !metadata.body.includes(input.graphitePrUrl)) {
    throw new Error("github_pr_body_missing_graphite_link");
  }
  if (input.expectedAuthorLogin && metadata.authorLogin !== input.expectedAuthorLogin) {
    throw new Error(`github_pr_author_mismatch: expected ${input.expectedAuthorLogin}, got ${metadata.authorLogin ?? ""}`);
  }
  if (input.expectedReviewerLogin && !metadata.reviewRequestLogins.includes(input.expectedReviewerLogin)) {
    throw new Error(`github_pr_reviewer_missing: expected ${input.expectedReviewerLogin}`);
  }

  return metadata;
}

export function buildPrHandoffInstructions(
  config: Pick<EffectiveWorkflowConfig, "github" | "pullRequest">,
  issue: Pick<NormalizedIssue, "url">
): string {
  const identityInstructions = buildIdentityInstructions(config.github.prIdentity);
  if (config.pullRequest.backend === "github") {
    return [
      "## PR Handoff Backend",
      "",
      "Use the default GitHub PR flow for handoff.",
      identityInstructions,
      "Push the current branch, open or update the PR with GitHub tooling, keep the Linear and Graphite links in the PR body, request any configured reviewer, and verify the PR author/head/base/body/review requests with `gh pr view --json url,author,baseRefName,headRefName,body,reviewRequests` before leaving the handoff.",
      issue.url ? `Linear: ${issue.url}` : "Linear: use the issue URL from this prompt.",
      "Graphite: after the PR exists, add `https://app.graphite.com/github/pr/<owner>/<repo>/<number>` to the PR body."
    ].join("\n");
  }

  if (config.github.prIdentity) {
    return [
      "## PR Handoff Backend",
      "",
      "This workflow is configured for Graphite stacked PR handoff, but a GitHub PR identity is also configured.",
      identityInstructions,
      "Use Graphite only for stack inspection before handoff: `gt --version`, `gt log --stack --no-interactive`, and `gt submit --dry-run --stack --no-interactive --no-edit --no-ai`.",
      "Do not run mutating `gt submit` while a GitHub PR identity is configured because it may create or update GitHub PRs as the local Graphite/GitHub user.",
      "Push the current branch, open or update the PR with GitHub tooling under the configured identity, keep the Linear and Graphite links in the PR body, request any configured reviewer, and verify the PR author/head/base/body/review requests with `gh pr view --json url,author,baseRefName,headRefName,body,reviewRequests` before leaving the handoff.",
      "Set the PR base to the expected parent stack branch from Graphite stack inspection.",
      issue.url ? `Linear: ${issue.url}` : "Linear: use the issue URL from this prompt.",
      "Graphite: after the PR exists, add `https://app.graphite.com/github/pr/<owner>/<repo>/<number>` to the PR body."
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
    identityInstructions,
    "Before submitting, verify Graphite is usable with `gt --version`, `gt log --stack --no-interactive`, and `gt submit --dry-run --stack --no-interactive --no-edit --no-ai`.",
    config.github.prIdentity
      ? "Warning: a GitHub PR identity is configured, but Graphite submit may still use the local Graphite/GitHub identity. If the submitted PR author is not the configured identity, leave a clear Linear blocker."
      : "",
    fallbackSentence,
    "Submit the stack with `gt submit --stack --no-interactive --no-edit --no-ai`.",
    "After submit, verify the resulting GitHub PR metadata with `gh pr view --json url,author,baseRefName,headRefName,body,reviewRequests`.",
    "The PR head must match the current branch, the PR base must match the expected parent stack branch, the PR body must include the Linear and Graphite links, and any configured reviewer must be requested.",
    issue.url ? `Linear: ${issue.url}` : "Linear: use the issue URL from this prompt.",
    "Graphite: add `https://app.graphite.com/github/pr/<owner>/<repo>/<number>` to the PR body."
  ].filter(Boolean).join("\n");
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
  const parsed = JSON.parse(raw) as Partial<VerifiedPullRequestMetadata> & {
    author?: { login?: string | null } | null;
    reviewRequests?: Array<{ login?: string | null }> | null;
  };
  const url = typeof parsed.url === "string" ? parsed.url : "";
  const baseRefName = typeof parsed.baseRefName === "string" ? parsed.baseRefName : "";
  const headRefName = typeof parsed.headRefName === "string" ? parsed.headRefName : "";
  const body = typeof parsed.body === "string" ? parsed.body : "";
  const authorLogin = typeof parsed.author?.login === "string" ? parsed.author.login : null;
  const reviewRequestLogins = (parsed.reviewRequests ?? [])
    .map((request) => request?.login)
    .filter((login): login is string => Boolean(login));
  if (!url || !baseRefName || !headRefName) {
    throw new Error("github_pr_metadata_incomplete");
  }
  return { url, baseRefName, headRefName, body, authorLogin, reviewRequestLogins };
}

function commandFailure(code: string, command: string, result: CommandResult): string {
  const detail = (result.stderr || result.stdout).trim();
  return detail ? `${code}: ${command} failed: ${detail}` : `${code}: ${command} failed`;
}

function buildIdentityInstructions(identity: GithubPrIdentityConfig | null): string {
  if (!identity) {
    return "Use the currently authenticated local GitHub identity.";
  }
  const identityName =
    identity.kind === "github_app"
      ? `GitHub App PR identity (${identity.appSlug})`
      : "GitHub machine-user PR identity";
  const expectedAuthor =
    identity.kind === "github_app"
      ? `Expected GitHub PR author login: app/${identity.appSlug}.`
      : "";
  const reviewRequest =
    identity.kind === "github_app" && identity.reviewerLogins.length > 0
      ? `Request review from ${identity.reviewerLogins.join(", ")} before moving Linear to review. Symphony will also request any missing configured reviewers during the handoff gate.`
      : "";
  return [
    `Use the configured ${identityName} for handoff commands, not the default local GitHub user.`,
    `Symphony injects the configured token into worker turns; if \`GH_TOKEN\` or \`GITHUB_TOKEN\` is missing, resolve it with: \`${identity.tokenCommand}\`.`,
    "Use that token only in-process as `GH_TOKEN` and `GITHUB_TOKEN` for every GitHub operation: pushing, opening PRs, editing PR bodies, requesting reviewers, replying to review comments, posting PR comments, and closing or reopening superseded PRs.",
    "Do not use the default local GitHub user for PR edits or comments, and do not write the token to git config, PR bodies, Linear comments, logs, or files.",
    expectedAuthor,
    reviewRequest,
    `Use Git author and committer identity: ${identity.authorName} <${identity.authorEmail}>.`
  ].filter(Boolean).join("\n");
}

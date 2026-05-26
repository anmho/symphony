import type { CommandResult } from "./process.js";
import { runCommand } from "./process.js";
import type { EffectiveWorkflowConfig, NormalizedIssue } from "./types.js";
import { fetchRelevantIssues, writeRunnerComment } from "./linear.js";
import { resolvePrIdentity, type ResolvedPrIdentity } from "./prIdentity.js";

const DEFAULT_CODEX_REVIEW_COMMENT = "@codex review";
const GITHUB_PULL_REQUEST_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/;

export type ReviewRequestRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
) => Promise<CommandResult>;

export interface CodexReviewRequestResult {
  issue: string;
  prUrl: string;
  dryRun: boolean;
  githubComment: string;
}

export async function requestCodexReviewForIssue(
  config: EffectiveWorkflowConfig,
  issueReference: string,
  options: {
    prUrl?: string | null;
    githubComment?: string;
    dryRun?: boolean;
    runner?: ReviewRequestRunner;
    resolveIdentity?: (config: Pick<EffectiveWorkflowConfig, "github">) => Promise<ResolvedPrIdentity | null>;
    fetchIssues?: (config: EffectiveWorkflowConfig) => Promise<NormalizedIssue[]>;
    writeComment?: (config: EffectiveWorkflowConfig, issueId: string, body: string) => Promise<void>;
  } = {}
): Promise<CodexReviewRequestResult> {
  const fetchIssues = options.fetchIssues ?? fetchRelevantIssues;
  const issues = await fetchIssues(config);
  const issue = findIssueByReference(issues, issueReference);
  if (!issue) {
    throw new Error(`codex_review_issue_not_found: ${issueReference}`);
  }

  const prUrl = options.prUrl ?? githubPullRequestUrlFromIssue(issue);
  if (!prUrl) {
    throw new Error(`codex_review_pr_url_not_found: ${issue.identifier}`);
  }

  const githubComment = options.githubComment ?? DEFAULT_CODEX_REVIEW_COMMENT;
  if (!options.dryRun) {
    const runner = options.runner ?? runCommand;
    const resolveIdentity = options.resolveIdentity ?? resolvePrIdentity;
    const identity = await resolveIdentity(config);
    const commandOptions: { env?: NodeJS.ProcessEnv; timeoutMs: number } = { timeoutMs: 60000 };
    if (identity?.env) {
      commandOptions.env = identity.env;
    }
    const result = await runner("gh", ["pr", "comment", prUrl, "--body", githubComment], commandOptions);
    if (result.exitCode !== 0) {
      throw new Error(`codex_review_github_comment_failed: ${result.stderr || result.stdout || result.exitCode}`);
    }

    const writeComment = options.writeComment ?? writeRunnerComment;
    await writeComment(
      config,
      issue.id,
      [
        `Requested Codex AI review for ${prUrl}.`,
        "",
        `GitHub comment: \`${githubComment}\``
      ].join("\n")
    );
  }

  return {
    issue: issue.identifier,
    prUrl,
    dryRun: options.dryRun === true,
    githubComment
  };
}

export function githubPullRequestUrlFromIssue(issue: Pick<NormalizedIssue, "description" | "comments">): string | null {
  const haystack = [issue.description ?? "", ...issue.comments].join("\n");
  return haystack.match(GITHUB_PULL_REQUEST_URL)?.[0] ?? null;
}

function findIssueByReference(issues: NormalizedIssue[], reference: string): NormalizedIssue | null {
  const normalized = reference.trim().toLowerCase();
  return issues.find((issue) => issue.id.toLowerCase() === normalized || issue.identifier.toLowerCase() === normalized) ?? null;
}

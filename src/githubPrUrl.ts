import type { NormalizedIssue } from "./types.js";

const GITHUB_PULL_REQUEST_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/;

export function githubPullRequestUrlFromText(value: string): string | null {
  return value.match(GITHUB_PULL_REQUEST_URL)?.[0] ?? null;
}

export function githubPullRequestUrlFromIssue(issue: Pick<NormalizedIssue, "description" | "comments">): string | null {
  return githubPullRequestUrlFromText([issue.description ?? "", ...issue.comments].join("\n"));
}

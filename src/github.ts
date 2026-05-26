import type {
  PullRequestMetadata,
  PullRequestMergeReadiness,
  PullRequestReviewComment,
  PullRequestReviewFeedback,
  PullRequestStatus,
} from './types.js';
import { runCommand, type CommandResult } from './process.js';

type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<CommandResult>;

export function parseGithubPullRequestUrl(
  url: string,
): { owner: string; repo: string; number: number } | null {
  const match = url.match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/,
  );
  if (!match) {
    return null;
  }
  return {
    owner: match[1]!,
    repo: match[2]!,
    number: Number(match[3]!),
  };
}

export async function fetchPullRequestStatus(
  url: string,
  runner: CommandRunner = runCommand,
): Promise<PullRequestStatus | null> {
  const parsed = parseGithubPullRequestUrl(url);
  if (!parsed) {
    return null;
  }

  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': '@anmho/symphony',
    'x-github-api-version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetch(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`,
    { headers },
  );
  if (response.status === 404) {
    return fetchPullRequestStatusWithGh(url, parsed, runner);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      const ghStatus = await fetchPullRequestStatusWithGh(url, parsed, runner);
      if (ghStatus) {
        return ghStatus;
      }
    }
    throw new Error(
      `github_pr_status_http_error: ${response.status} ${await response.text()}`,
    );
  }

  const payload = (await response.json()) as {
    html_url?: string;
    state?: string;
    merged_at?: string | null;
    merged?: boolean;
  };
  const state = payload.merged || payload.merged_at
    ? 'merged'
    : payload.state === 'closed'
      ? 'closed'
      : 'open';

  return {
    url: payload.html_url ?? url,
    ...parsed,
    state,
    mergedAt: payload.merged_at ?? null,
  };
}

export async function fetchPullRequestMetadata(
  url: string,
  cwd?: string,
  runner: CommandRunner = runCommand,
): Promise<PullRequestMetadata> {
  const options: { cwd?: string; timeoutMs: number } = { timeoutMs: 60000 };
  if (cwd) {
    options.cwd = cwd;
  }
  const result = await runner(
    'gh',
    [
      'pr',
      'view',
      url,
      '--json',
      'author,url,headRefName,baseRefName,body,reviewRequests',
    ],
    options,
  );
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      detail
        ? `github_pr_metadata_unavailable: gh pr view ${url} failed: ${detail}`
        : `github_pr_metadata_unavailable: gh pr view ${url} failed`,
    );
  }
  return parsePullRequestMetadata(result.stdout);
}

export function parsePullRequestMetadata(raw: string): PullRequestMetadata {
  const parsed = JSON.parse(raw) as Partial<PullRequestMetadata> & {
    author?: { login?: string | null } | null;
    reviewRequests?: Array<{ login?: string | null }> | null;
  };
  const url = typeof parsed.url === 'string' ? parsed.url : '';
  const baseRefName = typeof parsed.baseRefName === 'string' ? parsed.baseRefName : '';
  const headRefName = typeof parsed.headRefName === 'string' ? parsed.headRefName : '';
  const body = typeof parsed.body === 'string' ? parsed.body : '';
  const authorLogin = typeof parsed.author?.login === 'string' ? parsed.author.login : null;
  const reviewRequestLogins = (parsed.reviewRequests ?? [])
    .map((request) => request?.login)
    .filter((login): login is string => Boolean(login));
  if (!url || !baseRefName || !headRefName) {
    throw new Error('github_pr_metadata_incomplete');
  }
  return { url, baseRefName, headRefName, body, authorLogin, reviewRequestLogins };
}

export async function fetchPullRequestMergeReadiness(
  url: string,
  cwd?: string,
  runner: CommandRunner = runCommand,
): Promise<PullRequestMergeReadiness> {
  const options: { cwd?: string; timeoutMs: number } = { timeoutMs: 60000 };
  if (cwd) {
    options.cwd = cwd;
  }
  const result = await runner(
    'gh',
    [
      'pr',
      'view',
      url,
      '--json',
      'url,state,isDraft,reviewDecision,latestReviews,mergeStateStatus,mergeable,headRefOid',
    ],
    options,
  );
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      detail
        ? `github_pr_merge_readiness_unavailable: gh pr view ${url} failed: ${detail}`
        : `github_pr_merge_readiness_unavailable: gh pr view ${url} failed`,
    );
  }
  return parsePullRequestMergeReadiness(result.stdout);
}

export function parsePullRequestMergeReadiness(raw: string): PullRequestMergeReadiness {
  const parsed = JSON.parse(raw) as Partial<PullRequestMergeReadiness> & {
    latestReviews?: Array<{ state?: string | null; author?: GithubAuthor | null }> | null;
  };
  const url = typeof parsed.url === 'string' ? parsed.url : '';
  if (!url) {
    throw new Error('github_pr_merge_readiness_incomplete');
  }
  const rawState = typeof parsed.state === 'string' ? parsed.state.toLowerCase() : 'open';
  const state = rawState === 'merged' || rawState === 'closed' ? rawState : 'open';
  const latestHumanReview = [...(parsed.latestReviews ?? [])]
    .reverse()
    .find((review) => !isAutomationAuthor(review?.author) && typeof review?.state === 'string');
  const reviewDecision =
    typeof parsed.reviewDecision === 'string' && parsed.reviewDecision.trim()
      ? parsed.reviewDecision
      : null;
  const latestReviewDecision =
    typeof latestHumanReview?.state === 'string' && latestHumanReview.state.trim()
      ? latestHumanReview.state
      : null;
  return {
    url,
    state,
    isDraft: parsed.isDraft === true,
    reviewDecision,
    latestReviewDecision,
    mergeStateStatus: typeof parsed.mergeStateStatus === 'string' ? parsed.mergeStateStatus : null,
    mergeable: typeof parsed.mergeable === 'string' ? parsed.mergeable : null,
    headRefOid: typeof parsed.headRefOid === 'string' ? parsed.headRefOid : null,
  };
}

export async function mergePullRequest(
  url: string,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  runner: CommandRunner = runCommand,
): Promise<void> {
  const options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number } = {
    timeoutMs: 120000,
  };
  if (cwd) {
    options.cwd = cwd;
  }
  if (env) {
    options.env = env;
  }
  const result = await runner(
    'gh',
    ['pr', 'merge', url, '--squash', '--delete-branch'],
    options,
  );
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      detail
        ? `github_pr_merge_failed: gh pr merge ${url} --squash --delete-branch failed: ${detail}`
        : `github_pr_merge_failed: gh pr merge ${url} --squash --delete-branch failed`,
    );
  }
}

export async function requestPullRequestReviewers(
  url: string,
  reviewers: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  runner: CommandRunner = runCommand,
): Promise<void> {
  const uniqueReviewers = uniqueReviewerLogins(reviewers);
  const options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number } = {
    timeoutMs: 60000,
  };
  if (cwd) {
    options.cwd = cwd;
  }
  if (env) {
    options.env = env;
  }

  if (uniqueReviewers.length > 0) {
    const args = ['pr', 'edit', url];
    for (const reviewer of uniqueReviewers) {
      args.push('--add-reviewer', reviewer);
    }
    const result = await runner('gh', args, options);
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(
        detail
          ? `github_pr_reviewer_request_failed: gh ${args.join(' ')} failed: ${detail}`
          : `github_pr_reviewer_request_failed: gh ${args.join(' ')} failed`,
      );
    }
  }
}

export async function removePullRequestReviewers(
  url: string,
  reviewers: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  runner: CommandRunner = runCommand,
): Promise<void> {
  const uniqueReviewers = uniqueReviewerLogins(reviewers);
  const parsed = parseGithubPullRequestUrl(url);
  if (!parsed || uniqueReviewers.length === 0) {
    return;
  }
  const options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number } = {
    timeoutMs: 60000,
  };
  if (cwd) {
    options.cwd = cwd;
  }
  if (env) {
    options.env = env;
  }

  const args = ['pr', 'edit', url];
  for (const reviewer of uniqueReviewers) {
    args.push('--remove-reviewer', reviewer);
  }
  const result = await runner('gh', args, options);
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      detail
        ? `github_pr_reviewer_removal_failed: gh ${args.join(' ')} failed: ${detail}`
        : `github_pr_reviewer_removal_failed: gh ${args.join(' ')} failed`,
    );
  }
}

export async function fetchPullRequestReviewFeedback(
  url: string,
  runner: CommandRunner = runCommand,
): Promise<PullRequestReviewFeedback | null> {
  const parsed = parseGithubPullRequestUrl(url);
  if (!parsed) {
    return null;
  }

  const query = `
    query PullRequestReviewThreads($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          url
          reviewThreads(first: 100) {
            nodes {
              isResolved
              path
              line
              comments(first: 20) {
                nodes {
                  author { login __typename }
                  body
                  url
                  createdAt
                }
              }
            }
          }
          reviews(first: 50) {
            nodes {
              author { login __typename }
              body
              url
              submittedAt
              state
            }
          }
          comments(first: 50) {
            nodes {
              author { login __typename }
              body
              url
              createdAt
            }
          }
        }
      }
    }
  `;
  const variables = {
    owner: parsed.owner,
    repo: parsed.repo,
    number: parsed.number,
  };

  const payload = await fetchGraphql<{ repository?: GithubReviewRepository | null }>(
    query,
    variables,
    runner,
  );
  const pullRequest = payload?.repository?.pullRequest;
  if (!pullRequest) {
    return null;
  }

  const unresolvedComments: PullRequestReviewComment[] = [];
  let latestBotActivityAt = '';
  // GitHub App authors can appear as either `app-name[bot]` or just the app slug
  // depending on the API surface. `__typename` is the stable Bot/User discriminator.
  for (const thread of pullRequest.reviewThreads?.nodes ?? []) {
    for (const comment of thread?.comments?.nodes ?? []) {
      if (isAutomationAuthor(comment?.author) && comment?.createdAt && comment.createdAt > latestBotActivityAt) {
        latestBotActivityAt = comment.createdAt;
      }
    }
  }
  for (const review of pullRequest.reviews?.nodes ?? []) {
    if (isAutomationAuthor(review?.author) && review?.submittedAt && review.submittedAt > latestBotActivityAt) {
      latestBotActivityAt = review.submittedAt;
    }
  }
  for (const comment of pullRequest.comments?.nodes ?? []) {
    if (isAutomationAuthor(comment?.author) && comment?.createdAt && comment.createdAt > latestBotActivityAt) {
      latestBotActivityAt = comment.createdAt;
    }
  }

  for (const thread of pullRequest.reviewThreads?.nodes ?? []) {
    if (!thread || thread.isResolved) {
      continue;
    }
    const comments = (thread.comments?.nodes ?? []).filter((comment) =>
      comment?.body?.trim(),
    );
    const latestReviewerComment = [...comments].reverse()[0];
    if (!latestReviewerComment?.body?.trim()) {
      continue;
    }
    if (isAutomationAuthor(latestReviewerComment.author)) {
      continue;
    }
    unresolvedComments.push({
      author: latestReviewerComment.author?.login ?? null,
      body: latestReviewerComment.body.trim(),
      path: thread.path ?? null,
      line: typeof thread.line === 'number' ? thread.line : null,
      url: latestReviewerComment.url ?? null,
      createdAt: latestReviewerComment.createdAt ?? null,
    });
  }
  for (const review of pullRequest.reviews?.nodes ?? []) {
    if (!review || isAutomationAuthor(review.author)) {
      continue;
    }
    const state = review.state ?? null;
    if (state !== 'CHANGES_REQUESTED' && state !== 'COMMENTED') {
      continue;
    }
    if (review.submittedAt && latestBotActivityAt && review.submittedAt <= latestBotActivityAt) {
      continue;
    }
    const body = review.body?.trim() || `Review state: ${state}.`;
    unresolvedComments.push({
      author: review.author?.login ?? null,
      body,
      path: null,
      line: null,
      url: review.url ?? null,
      createdAt: review.submittedAt ?? null,
    });
  }
  for (const comment of pullRequest.comments?.nodes ?? []) {
    if (!comment?.body?.trim() || isAutomationAuthor(comment.author)) {
      continue;
    }
    if (comment.createdAt && latestBotActivityAt && comment.createdAt <= latestBotActivityAt) {
      continue;
    }
    unresolvedComments.push({
      author: comment.author?.login ?? null,
      body: comment.body.trim(),
      path: null,
      line: null,
      url: comment.url ?? null,
      createdAt: comment.createdAt ?? null,
    });
  }

  return {
    url: pullRequest.url ?? url,
    ...parsed,
    unresolvedComments,
  };
}

interface GithubReviewRepository {
  pullRequest?: {
    url?: string | null;
    reviewThreads?: {
      nodes?: Array<{
        isResolved?: boolean | null;
        path?: string | null;
        line?: number | null;
        comments?: {
          nodes?: Array<{
            author?: GithubAuthor | null;
            body?: string | null;
            url?: string | null;
            createdAt?: string | null;
          } | null> | null;
        } | null;
      } | null> | null;
    } | null;
    reviews?: {
      nodes?: Array<{
        author?: GithubAuthor | null;
        body?: string | null;
        url?: string | null;
        submittedAt?: string | null;
        state?: string | null;
      } | null> | null;
    } | null;
    comments?: {
      nodes?: Array<{
        author?: GithubAuthor | null;
        body?: string | null;
        url?: string | null;
        createdAt?: string | null;
      } | null> | null;
    } | null;
  } | null;
}

interface GithubAuthor {
  login?: string | null;
  __typename?: string | null;
}

function isAutomationAuthor(author: GithubAuthor | null | undefined): boolean {
  return author?.__typename === 'Bot' || Boolean(author?.login?.endsWith('[bot]'));
}

function uniqueReviewerLogins(reviewers: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of reviewers) {
    const reviewer = value.trim();
    const key = reviewer.toLowerCase();
    if (!reviewer || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(reviewer);
  }
  return unique;
}

async function fetchGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
  runner: CommandRunner,
): Promise<T | null> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': '@anmho/symphony',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (response.ok) {
      const payload = (await response.json()) as { data?: T; errors?: unknown };
      if (payload.errors) {
        throw new Error(`github_graphql_error: ${JSON.stringify(payload.errors)}`);
      }
      return payload.data ?? null;
    }
    if (response.status !== 401 && response.status !== 403) {
      throw new Error(
        `github_graphql_http_error: ${response.status} ${await response.text()}`,
      );
    }
  }

  const result = await runner(
    'gh',
    [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-F',
      `owner=${variables.owner}`,
      '-F',
      `repo=${variables.repo}`,
      '-F',
      `number=${variables.number}`,
    ],
    { timeoutMs: 30000 },
  );
  if (result.exitCode !== 0) {
    return null;
  }
  const payload = JSON.parse(result.stdout) as { data?: T; errors?: unknown };
  if (payload.errors) {
    throw new Error(`github_graphql_error: ${JSON.stringify(payload.errors)}`);
  }
  return payload.data ?? null;
}

async function fetchPullRequestStatusWithGh(
  url: string,
  parsed: { owner: string; repo: string; number: number },
  runner: CommandRunner,
): Promise<PullRequestStatus | null> {
  const result = await runner(
    'gh',
    ['pr', 'view', url, '--json', 'url,state,mergedAt,number,headRepository'],
    { timeoutMs: 30000 },
  );
  if (result.exitCode !== 0) {
    return null;
  }

  const payload = JSON.parse(result.stdout) as {
    url?: string;
    state?: string;
    mergedAt?: string | null;
    number?: number;
    headRepository?: { nameWithOwner?: string; name?: string } | null;
  };
  const nameWithOwner =
    payload.headRepository?.nameWithOwner ??
    `${parsed.owner}/${payload.headRepository?.name ?? parsed.repo}`;
  const [owner = parsed.owner, repo = parsed.repo] = nameWithOwner.split('/');
  const state = payload.state === 'MERGED'
    ? 'merged'
    : payload.state === 'CLOSED'
      ? 'closed'
      : 'open';

  return {
    url: payload.url ?? url,
    owner,
    repo,
    number: payload.number ?? parsed.number,
    state,
    mergedAt: payload.mergedAt ?? null,
  };
}

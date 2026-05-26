import type {
  PullRequestMetadata,
  PullRequestReviewComment,
  PullRequestReviewFeedback,
  PullRequestStatus,
} from './types.js';
import { runCommand, type CommandResult } from './process.js';

type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number },
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
    ['pr', 'view', url, '--json', 'author,url,headRefName,baseRefName,body'],
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
  };
  const url = typeof parsed.url === 'string' ? parsed.url : '';
  const baseRefName = typeof parsed.baseRefName === 'string' ? parsed.baseRefName : '';
  const headRefName = typeof parsed.headRefName === 'string' ? parsed.headRefName : '';
  const body = typeof parsed.body === 'string' ? parsed.body : '';
  const authorLogin = typeof parsed.author?.login === 'string' ? parsed.author.login : null;
  if (!url || !baseRefName || !headRefName) {
    throw new Error('github_pr_metadata_incomplete');
  }
  return { url, baseRefName, headRefName, body, authorLogin };
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
                  author { login }
                  body
                  url
                  createdAt
                }
              }
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
  for (const thread of pullRequest.reviewThreads?.nodes ?? []) {
    if (!thread || thread.isResolved) {
      continue;
    }
    const comments = (thread.comments?.nodes ?? []).filter((comment) =>
      comment?.body?.trim(),
    );
    const latestReviewerComment =
      [...comments]
        .reverse()
        .find((comment) => !comment?.author?.login?.endsWith('[bot]')) ??
      [...comments].reverse()[0];
    if (!latestReviewerComment?.body?.trim()) {
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
            author?: { login?: string | null } | null;
            body?: string | null;
            url?: string | null;
            createdAt?: string | null;
          } | null> | null;
        } | null;
      } | null> | null;
    } | null;
  } | null;
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

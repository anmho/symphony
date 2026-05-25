import type { PullRequestStatus } from './types.js';
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

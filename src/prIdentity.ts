import { runShellCommand, type CommandResult } from './process.js';
import { createSign } from 'node:crypto';
import type { EffectiveWorkflowConfig, GithubPrIdentityConfig } from './types.js';

export type IdentityCommandRunner = (
  command: string,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<CommandResult>;

export interface ResolvedPrIdentity {
  login: string | null;
  token: string;
  expiresAt: string | null;
  env: NodeJS.ProcessEnv;
}

export type IdentityFetch = typeof fetch;

export function hasPrIdentity(config: Pick<EffectiveWorkflowConfig, 'github'>): boolean {
  return config.github.prIdentity !== null;
}

export async function resolvePrIdentity(
  config: Pick<EffectiveWorkflowConfig, 'github'>,
  runner: IdentityCommandRunner = runShellCommand,
  fetcher: IdentityFetch = fetch,
): Promise<ResolvedPrIdentity | null> {
  const identity = config.github.prIdentity;
  if (!identity) {
    return null;
  }
  if (identity.kind === 'github_app') {
    return resolveGithubAppIdentity(identity, runner, fetcher);
  }
  const result = await runner(identity.tokenCommand, { timeoutMs: 30000 });
  if (result.exitCode !== 0) {
    throw new Error(
      `github_pr_identity_token_command_failed: ${redactSecretLikeText(result.stderr || result.stdout)}`,
    );
  }
  const token = result.stdout.trim();
  if (!token) {
    throw new Error('github_pr_identity_token_empty');
  }
  return {
    login: null,
    token,
    expiresAt: null,
    env: prIdentityEnv(identity, token),
  };
}

export async function diagnosePrIdentity(
  config: Pick<EffectiveWorkflowConfig, 'github' | 'workspace'>,
  runner: IdentityCommandRunner = runShellCommand,
  fetcher: IdentityFetch = fetch,
): Promise<string[]> {
  if (!config.github.prIdentity) {
    return ['GitHub PR identity is not configured.'];
  }
  const resolved = await resolvePrIdentity(config, runner, fetcher);
  if (!resolved) {
    return ['GitHub PR identity is not configured.'];
  }
  const identity = config.github.prIdentity;
  const authProbe =
    identity?.kind === 'github_app'
      ? 'gh api installation/repositories --jq .total_count'
      : 'gh api user --jq .login';
  const user = await runner(authProbe, {
    env: resolved.env,
    timeoutMs: 30000,
  });
  if (user.exitCode !== 0) {
    throw new Error(
      `github_pr_identity_auth_failed: ${redactSecretLikeText(user.stderr || user.stdout)}`,
    );
  }
  const login = identity?.kind === 'github_app'
    ? (identity.appSlug ? `${identity.appSlug}[bot]` : 'configured GitHub App installation')
    : user.stdout.trim();
  const lines = identity?.kind === 'github_app'
    ? [`GitHub PR identity authenticated as ${login}; installation repositories visible: ${user.stdout.trim()}.`]
    : [`GitHub PR identity authenticated as ${login}.`];
  for (const repoPath of Object.values(config.workspace.repoRoutes)) {
    const repo = await gitHubRepoFromRemote(repoPath, runner, resolved.env);
    if (!repo) {
      continue;
    }
    if (identity?.kind === 'github_app') {
      const visibility = await runner(`gh api repos/${repo} --jq .full_name`, {
        env: resolved.env,
        timeoutMs: 30000,
      });
      if (visibility.exitCode !== 0) {
        throw new Error(
          `github_pr_identity_repo_access_failed: ${repo}: ${redactSecretLikeText(visibility.stderr || visibility.stdout)}`,
        );
      }
      lines.push(`Repo ${repo} installation access: ${visibility.stdout.trim() === repo}.`);
      continue;
    }
    const access = await runner(`gh api repos/${repo} --jq .permissions.push`, {
      env: resolved.env,
      timeoutMs: 30000,
    });
    if (access.exitCode !== 0) {
      throw new Error(
        `github_pr_identity_repo_access_failed: ${repo}: ${redactSecretLikeText(access.stderr || access.stdout)}`,
      );
    }
    lines.push(`Repo ${repo} push access: ${access.stdout.trim()}.`);
  }
  return lines;
}

export function prIdentityEnv(
  identity: GithubPrIdentityConfig,
  token: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  expiresAt: string | null = null,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    ...(expiresAt ? { SYMPHONY_GITHUB_TOKEN_EXPIRES_AT: expiresAt } : {}),
    GIT_AUTHOR_NAME: identity.authorName,
    GIT_AUTHOR_EMAIL: identity.authorEmail,
    GIT_COMMITTER_NAME: identity.authorName,
    GIT_COMMITTER_EMAIL: identity.authorEmail,
  };
}

async function resolveGithubAppIdentity(
  identity: Extract<GithubPrIdentityConfig, { kind: 'github_app' }>,
  runner: IdentityCommandRunner,
  fetcher: IdentityFetch,
): Promise<ResolvedPrIdentity> {
  const result = await runner(identity.privateKeyCommand, { timeoutMs: 30000 });
  if (result.exitCode !== 0) {
    throw new Error(
      `github_pr_identity_private_key_command_failed: ${redactSecretLikeText(result.stderr || result.stdout)}`,
    );
  }
  const privateKey = normalizePrivateKey(result.stdout);
  if (!privateKey) {
    throw new Error('github_pr_identity_private_key_empty');
  }
  const jwt = createGithubAppJwt(identity.appId, privateKey);
  const response = await fetcher(
    `${identity.apiBaseUrl.replace(/\/$/, '')}/app/installations/${identity.installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${jwt}`,
        'x-github-api-version': '2022-11-28',
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `github_pr_identity_installation_token_failed: ${response.status} ${redactSecretLikeText(await response.text())}`,
    );
  }
  const parsed = await response.json() as { token?: unknown; expires_at?: unknown };
  const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
  if (!token) {
    throw new Error('github_pr_identity_installation_token_empty');
  }
  const expiresAt = typeof parsed.expires_at === 'string' && parsed.expires_at.trim()
    ? parsed.expires_at.trim()
    : null;
  return {
    login: identity.appSlug ? `${identity.appSlug}[bot]` : null,
    token,
    expiresAt,
    env: prIdentityEnv(identity, token, process.env, expiresAt),
  };
}

function createGithubAppJwt(appId: string, privateKey: string, nowMs = Date.now()): string {
  const issuedAt = Math.floor(nowMs / 1000) - 60;
  const expiresAt = issuedAt + 540;
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({ iat: issuedAt, exp: expiresAt, iss: appId }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKey);
  return `${unsigned}.${base64Url(signature)}`;
}

function normalizePrivateKey(value: string): string {
  return value.trim().replace(/\\n/g, '\n');
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

export function githubTokenRemoteUrl(input: {
  owner: string;
  repo: string;
  token: string;
}): string {
  return `https://x-access-token:${encodeURIComponent(input.token)}@github.com/${input.owner}/${input.repo}.git`;
}

export function redactSecretLikeText(value: string): string {
  return value
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/x-access-token:[^@\\s]+/g, 'x-access-token:[redacted]');
}

async function gitHubRepoFromRemote(
  cwd: string,
  runner: IdentityCommandRunner,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const result = await runner('git remote get-url origin', {
    cwd,
    env,
    timeoutMs: 30000,
  });
  if (result.exitCode !== 0) {
    return null;
  }
  return parseGitHubRemote(result.stdout.trim());
}

function parseGitHubRemote(remote: string): string | null {
  const httpsMatch = remote.match(/github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  return httpsMatch?.[1] ?? null;
}

import { runShellCommand, type CommandResult } from './process.js';
import type { EffectiveWorkflowConfig, GithubPrIdentityConfig } from './types.js';

export type IdentityCommandRunner = (
  command: string,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<CommandResult>;

export interface ResolvedPrIdentity {
  login: string | null;
  token: string;
  env: NodeJS.ProcessEnv;
}

export function hasPrIdentity(config: Pick<EffectiveWorkflowConfig, 'github'>): boolean {
  return config.github.prIdentity !== null;
}

export async function resolvePrIdentity(
  config: Pick<EffectiveWorkflowConfig, 'github'>,
  runner: IdentityCommandRunner = runShellCommand,
): Promise<ResolvedPrIdentity | null> {
  const identity = config.github.prIdentity;
  if (!identity) {
    return null;
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
    login: identity.kind === 'github_app' ? `app/${identity.appSlug}` : null,
    token,
    env: prIdentityEnv(identity, token),
  };
}

export async function diagnosePrIdentity(
  config: Pick<EffectiveWorkflowConfig, 'github' | 'workspace'>,
  runner: IdentityCommandRunner = runShellCommand,
): Promise<string[]> {
  if (!config.github.prIdentity) {
    return ['GitHub PR identity is not configured.'];
  }
  const resolved = await resolvePrIdentity(config, runner);
  if (!resolved) {
    return ['GitHub PR identity is not configured.'];
  }
  if (config.github.prIdentity.kind === 'github_app') {
    const repos = await runner('gh api /installation/repositories --jq .total_count', {
      env: resolved.env,
      timeoutMs: 30000,
    });
    if (repos.exitCode !== 0) {
      throw new Error(
        `github_pr_identity_auth_failed: ${redactSecretLikeText(repos.stderr || repos.stdout)}`,
      );
    }
    const lines = [
      `GitHub PR identity configured for ${resolved.login}.`,
      `GitHub App installation token can list ${repos.stdout.trim()} repositories.`,
    ];
    for (const repoPath of Object.values(config.workspace.repoRoutes)) {
      const repo = await gitHubRepoFromRemote(repoPath, runner, resolved.env);
      if (!repo) {
        continue;
      }
      const access = await runner(`gh api repos/${repo} --jq .full_name`, {
        env: resolved.env,
        timeoutMs: 30000,
      });
      if (access.exitCode !== 0) {
        throw new Error(
          `github_pr_identity_repo_access_failed: ${repo}: ${redactSecretLikeText(access.stderr || access.stdout)}`,
        );
      }
      lines.push(`Repo ${access.stdout.trim()} is accessible to the installation token.`);
    }
    return lines;
  }
  const user = await runner('gh api user --jq .login', {
    env: resolved.env,
    timeoutMs: 30000,
  });
  if (user.exitCode !== 0) {
    throw new Error(
      `github_pr_identity_auth_failed: ${redactSecretLikeText(user.stderr || user.stdout)}`,
    );
  }
  const login = user.stdout.trim();
  const lines = [`GitHub PR identity authenticated as ${login}.`];
  for (const repoPath of Object.values(config.workspace.repoRoutes)) {
    const repo = await gitHubRepoFromRemote(repoPath, runner, resolved.env);
    if (!repo) {
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
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_AUTHOR_NAME: identity.authorName,
    GIT_AUTHOR_EMAIL: identity.authorEmail,
    GIT_COMMITTER_NAME: identity.authorName,
    GIT_COMMITTER_EMAIL: identity.authorEmail,
  };
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

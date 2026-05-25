import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  diagnosePrIdentity,
  githubTokenRemoteUrl,
  prIdentityEnv,
  redactSecretLikeText,
  resolvePrIdentity,
} from '../src/prIdentity.js';
import type { EffectiveWorkflowConfig, GithubPrIdentityConfig } from '../src/types.js';

describe('GitHub PR identity', () => {
  it('resolves token command output and exposes handoff env', async () => {
    const config = makeConfig();
    const identity = await resolvePrIdentity(config, async () => ({
      exitCode: 0,
      stdout: 'ghp_testtoken\n',
      stderr: '',
    }));

    expect(identity?.token).toBe('ghp_testtoken');
    expect(identity?.expiresAt).toBeNull();
    expect(identity?.env.GH_TOKEN).toBe('ghp_testtoken');
    expect(identity?.env.GITHUB_TOKEN).toBe('ghp_testtoken');
    expect(identity?.env.GIT_AUTHOR_NAME).toBe('Symphony');
    expect(identity?.env.GIT_AUTHOR_EMAIL).toBe('anmho-symphony@users.noreply.github.com');
    expect(identity?.env.GIT_COMMITTER_NAME).toBe('Symphony');
    expect(identity?.env.GIT_COMMITTER_EMAIL).toBe('anmho-symphony@users.noreply.github.com');
  });

  it('redacts token-like command failure output', async () => {
    const config = makeConfig();
    await expect(
      resolvePrIdentity(config, async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'bad ghp_secretvalue',
      })),
    ).rejects.toThrow('bad [redacted]');
  });

  it('mints a GitHub App installation token from a private key command', async () => {
    const privateKey = testPrivateKey();
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const identity = await resolvePrIdentity(
      makeGithubAppConfig(),
      async (command) => {
        expect(command).toBe('vault private-key');
        return { exitCode: 0, stdout: privateKey, stderr: '' };
      },
      async (url, init) => {
        requests.push({
          url: String(url),
          authorization: new Headers(init?.headers).get('authorization'),
        });
        return new Response(JSON.stringify({ token: 'ghs_installation_token\n', expires_at: '2026-05-26T02:00:00Z' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      },
    );

    expect(identity?.login).toBe('symphony[bot]');
    expect(identity?.token).toBe('ghs_installation_token');
    expect(identity?.expiresAt).toBe('2026-05-26T02:00:00Z');
    expect(identity?.env.GH_TOKEN).toBe('ghs_installation_token');
    expect(identity?.env.GITHUB_TOKEN).toBe('ghs_installation_token');
    expect(identity?.env.SYMPHONY_GITHUB_TOKEN_EXPIRES_AT).toBe('2026-05-26T02:00:00Z');
    expect(requests[0]?.url).toBe('https://api.github.test/app/installations/456/access_tokens');
    expect(requests[0]?.authorization).toMatch(/^Bearer .+\..+\..+$/);
  });

  it('builds token-backed GitHub remote URLs in memory', () => {
    expect(
      githubTokenRemoteUrl({
        owner: 'anmho',
        repo: 'symphony',
        token: 'ghp_test/token',
      }),
    ).toBe('https://x-access-token:ghp_test%2Ftoken@github.com/anmho/symphony.git');
  });

  it('diagnoses gh identity and repo push access', async () => {
    const calls: string[] = [];
    const output = await diagnosePrIdentity(makeConfig(), async (command, options) => {
      calls.push(`${options?.cwd ?? ''}:${command}`);
      if (command === 'vault token') {
        return { exitCode: 0, stdout: 'ghp_testtoken\n', stderr: '' };
      }
      if (command === 'gh api user --jq .login') {
        return { exitCode: 0, stdout: 'anmho-symphony\n', stderr: '' };
      }
      if (command === 'git remote get-url origin') {
        return { exitCode: 0, stdout: 'git@github.com:anmho/symphony.git\n', stderr: '' };
      }
      if (command === 'gh api repos/anmho/symphony --jq .permissions.push') {
        return { exitCode: 0, stdout: 'true\n', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: `unexpected ${command}` };
    });

    expect(output).toEqual([
      'GitHub PR identity authenticated as anmho-symphony.',
      'Repo anmho/symphony push access: true.',
    ]);
    expect(calls).toContain('/repo/symphony:git remote get-url origin');
  });

  it('diagnoses GitHub App installation access without calling the user endpoint', async () => {
    const calls: string[] = [];
    const output = await diagnosePrIdentity(
      makeGithubAppConfig(),
      async (command, options) => {
        calls.push(command);
        if (command === 'vault private-key') {
          return { exitCode: 0, stdout: testPrivateKey(), stderr: '' };
        }
        if (command === 'gh api installation/repositories --jq .total_count') {
          return { exitCode: 0, stdout: '1\n', stderr: '' };
        }
        if (command === 'git remote get-url origin') {
          return { exitCode: 0, stdout: 'git@github.com:anmho/symphony.git\n', stderr: '' };
        }
        if (command === 'gh api repos/anmho/symphony --jq .full_name') {
          return { exitCode: 0, stdout: 'anmho/symphony\n', stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: `unexpected ${command} ${options?.cwd ?? ''}` };
      },
      async () => new Response(JSON.stringify({ token: 'ghs_installation_token' }), { status: 201 }),
    );

    expect(output[0]).toBe('GitHub PR identity authenticated as symphony[bot]; installation repositories visible: 1.');
    expect(output[1]).toBe('Repo anmho/symphony installation access: true.');
    expect(calls).not.toContain('gh api user --jq .login');
  });

  it('redacts tokens from arbitrary text', () => {
    expect(redactSecretLikeText('x-access-token:ghp_secret@github.com ghp_secret')).toBe(
      'x-access-token:[redacted]@github.com [redacted]',
    );
  });
});

function makeConfig(): Pick<EffectiveWorkflowConfig, 'github' | 'workspace'> {
  return {
    github: {
      prIdentity: makeIdentity(),
    },
    workspace: {
      root: '/tmp/workspaces',
      repoPath: '/repo/symphony',
      projectsRoot: null,
      repoRoutes: {
        symphony: '/repo/symphony',
      },
      baseBranch: 'main',
    },
  };
}

function makeGithubAppConfig(): Pick<EffectiveWorkflowConfig, 'github' | 'workspace'> {
  return {
    ...makeConfig(),
    github: {
      prIdentity: {
        kind: 'github_app',
        appId: '123',
        installationId: '456',
        privateKeyCommand: 'vault private-key',
        appSlug: 'symphony',
        authorName: 'Symphony',
        authorEmail: 'symphony[bot]@users.noreply.github.com',
        apiBaseUrl: 'https://api.github.test',
      },
    },
  };
}

function makeIdentity(): GithubPrIdentityConfig {
  return {
    kind: 'machine_user',
    tokenCommand: 'vault token',
    authorName: 'Symphony',
    authorEmail: 'anmho-symphony@users.noreply.github.com',
  };
}

function testPrivateKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
}

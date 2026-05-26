import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  diagnosePrIdentity,
  githubTokenRemoteUrl,
  parseGithubAppTokenCommand,
  prIdentityEnv,
  redactSecretLikeText,
  resolvePrIdentity,
} from '../src/prIdentity.js';
import type {
  EffectiveWorkflowConfig,
  GithubPrIdentityConfig,
} from '../src/types.js';

describe('GitHub PR identity', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves token command output and exposes handoff env', async () => {
    const config = makeConfig();
    const identity = await resolvePrIdentity(config, async () => ({
      exitCode: 0,
      stdout: 'ghp_testtoken\n',
      stderr: '',
    }));

    expect(identity?.token).toBe('ghp_testtoken');
    expect(identity?.login).toBeNull();
    expect(identity?.env.GH_TOKEN).toBe('ghp_testtoken');
    expect(identity?.env.GITHUB_TOKEN).toBe('ghp_testtoken');
    expect(identity?.env.GIT_AUTHOR_NAME).toBe('Symphony');
    expect(identity?.env.GIT_AUTHOR_EMAIL).toBe(
      'anmho-symphony@users.noreply.github.com',
    );
    expect(identity?.env.GIT_COMMITTER_NAME).toBe('Symphony');
    expect(identity?.env.GIT_COMMITTER_EMAIL).toBe(
      'anmho-symphony@users.noreply.github.com',
    );
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

  it('builds token-backed GitHub remote URLs in memory', () => {
    expect(
      githubTokenRemoteUrl({
        owner: 'anmho',
        repo: 'symphony',
        token: 'ghp_test/token',
      }),
    ).toBe(
      'https://x-access-token:ghp_test%2Ftoken@github.com/anmho/symphony.git',
    );
  });

  it('diagnoses gh identity and repo push access', async () => {
    const calls: string[] = [];
    const output = await diagnosePrIdentity(
      makeConfig(),
      async (command, options) => {
        calls.push(`${options?.cwd ?? ''}:${command}`);
        if (command === 'vault token') {
          return { exitCode: 0, stdout: 'ghp_testtoken\n', stderr: '' };
        }
        if (command === 'gh api user --jq .login') {
          return { exitCode: 0, stdout: 'anmho-symphony\n', stderr: '' };
        }
        if (command === 'git remote get-url origin') {
          return {
            exitCode: 0,
            stdout: 'git@github.com:anmho/symphony.git\n',
            stderr: '',
          };
        }
        if (command === 'gh api repos/anmho/symphony --jq .permissions.push') {
          return { exitCode: 0, stdout: 'true\n', stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: `unexpected ${command}` };
      },
    );

    expect(output).toEqual([
      'GitHub PR identity authenticated as anmho-symphony.',
      'Repo anmho/symphony push access: true.',
    ]);
    expect(calls).toContain('/repo/symphony:git remote get-url origin');
  });

  it('diagnoses GitHub App installation identity', async () => {
    const calls: string[] = [];
    const output = await diagnosePrIdentity(
      makeConfig({ githubApp: true }),
      async (command, options) => {
        calls.push(`${options?.cwd ?? ''}:${command}`);
        if (command === 'vault token') {
          return { exitCode: 0, stdout: 'ghs_installationtoken\n', stderr: '' };
        }
        if (command === 'gh api /installation/repositories --jq .total_count') {
          return { exitCode: 0, stdout: '169\n', stderr: '' };
        }
        if (command === 'git remote get-url origin') {
          return {
            exitCode: 0,
            stdout: 'git@github.com:anmho/symphony.git\n',
            stderr: '',
          };
        }
        if (command === 'gh api repos/anmho/symphony --jq .full_name') {
          return { exitCode: 0, stdout: 'anmho/symphony\n', stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: `unexpected ${command}` };
      },
    );

    expect(output).toEqual([
      'GitHub PR identity configured for app/anmho-symphony.',
      'GitHub App installation token can list 169 repositories.',
      'Repo anmho/symphony is accessible to the installation token.',
    ]);
    expect(calls).toContain('/repo/symphony:git remote get-url origin');
  });

  it('redacts tokens from arbitrary text', () => {
    expect(
      redactSecretLikeText('x-access-token:ghp_secret@github.com ghp_secret'),
    ).toBe('x-access-token:[redacted]@github.com [redacted]');
  });

  it('parses symphony github-app-token commands', () => {
    expect(
      parseGithubAppTokenCommand(
        "symphony github-app-token --app-id 3862765 --installation-id 135623998 --private-key-command 'vault kv get -field=key secret/github'",
      ),
    ).toEqual({
      appId: '3862765',
      installationId: '135623998',
      privateKeyCommand: 'vault kv get -field=key secret/github',
    });
  });

  it('mints GitHub App tokens in-process for configured symphony commands', async () => {
    const privateKey = testPrivateKey();
    let shellCommand = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              token: 'ghs_testinstallation',
              expires_at: '2099-01-01T00:00:00Z',
            }),
            { status: 200 },
          ),
      ),
    );
    const config = makeConfig({
      githubApp: true,
      tokenCommand:
        "symphony github-app-token --app-id 3862765 --installation-id 135623998 --private-key-command 'vault kv get -field=key secret/github'",
    });
    const identity = await resolvePrIdentity(config, async (command) => {
      shellCommand = command;
      return { exitCode: 0, stdout: `${privateKey}\n`, stderr: '' };
    });

    expect(shellCommand).toBe('vault kv get -field=key secret/github');
    expect(identity?.token).toBe('ghs_testinstallation');
    expect(identity?.login).toBe('app/anmho-symphony');
  });
});

function testPrivateKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return privateKey;
}

function makeConfig(
  options: { githubApp?: boolean; tokenCommand?: string } = {},
): Pick<EffectiveWorkflowConfig, 'github' | 'workspace'> {
  return {
    github: {
      prIdentity: options.githubApp
        ? {
            kind: 'github_app',
            appSlug: 'anmho-symphony',
            tokenCommand: options.tokenCommand ?? 'vault token',
            authorName: 'anmho Symphony',
            authorEmail: '3862765+anmho-symphony[bot]@users.noreply.github.com',
            reviewerLogin: null,
            reviewerLogins: [],
          }
        : makeIdentity(),
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

function makeIdentity(): GithubPrIdentityConfig {
  return {
    kind: 'machine_user',
    tokenCommand: 'vault token',
    authorName: 'Symphony',
    authorEmail: 'anmho-symphony@users.noreply.github.com',
  };
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPullRequestMetadata,
  fetchPullRequestReviewFeedback,
  fetchPullRequestStatus,
  parsePullRequestMetadata,
  parsePullRequestMergeReadiness,
  parseGithubPullRequestUrl,
  pullRequestUrlFromText,
  mergePullRequest,
  removePullRequestReviewers,
  requestPullRequestReviewers,
} from '../src/github.js';

describe('github client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses GitHub pull request URLs', () => {
    expect(
      parseGithubPullRequestUrl('https://github.com/anmho/agent/pull/9'),
    ).toEqual({
      owner: 'anmho',
      repo: 'agent',
      number: 9,
    });
  });

  it('resolves Graphite PR links to GitHub pull request URLs', () => {
    expect(
      pullRequestUrlFromText(
        'Graphite: https://app.graphite.com/github/pr/anmho/website/13',
      ),
    ).toBe('https://github.com/anmho/website/pull/13');
  });

  it('normalizes merged pull request status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            json: async () => ({
              html_url: 'https://github.com/anmho/agent/pull/9',
              state: 'closed',
              merged: true,
              merged_at: '2026-05-08T10:19:30Z',
            }),
          }) as Response,
      ),
    );

    await expect(
      fetchPullRequestStatus('https://github.com/anmho/agent/pull/9'),
    ).resolves.toEqual({
      url: 'https://github.com/anmho/agent/pull/9',
      owner: 'anmho',
      repo: 'agent',
      number: 9,
      state: 'merged',
      mergedAt: '2026-05-08T10:19:30Z',
    });
  });

  it('falls back to gh for private repository pull requests', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 404,
          }) as Response,
      ),
    );
    const runner = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        url: 'https://github.com/anmho/agent/pull/9',
        state: 'MERGED',
        mergedAt: '2026-05-08T10:19:30Z',
        number: 9,
        headRepository: { nameWithOwner: 'anmho/agent' },
      }),
      stderr: '',
    }));

    await expect(
      fetchPullRequestStatus('https://github.com/anmho/agent/pull/9', runner),
    ).resolves.toMatchObject({
      url: 'https://github.com/anmho/agent/pull/9',
      owner: 'anmho',
      repo: 'agent',
      number: 9,
      state: 'merged',
    });
    expect(runner).toHaveBeenCalledWith(
      'gh',
      [
        'pr',
        'view',
        'https://github.com/anmho/agent/pull/9',
        '--json',
        'url,state,mergedAt,number,headRepository',
      ],
      { timeoutMs: 30000 },
    );
  });

  it('fetches PR metadata including requested reviewers', async () => {
    const runner = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        url: 'https://github.com/anmho/symphony/pull/41',
        author: { login: 'app/anmho-symphony' },
        baseRefName: 'main',
        headRefName: 'symphony/APP-1',
        body: 'Linear: https://linear.app/anmho/issue/APP-1/x',
        reviewRequests: [{ login: 'anmho' }],
      }),
      stderr: '',
    }));

    await expect(
      fetchPullRequestMetadata(
        'https://github.com/anmho/symphony/pull/41',
        '/repo',
        runner,
      ),
    ).resolves.toEqual({
      url: 'https://github.com/anmho/symphony/pull/41',
      baseRefName: 'main',
      headRefName: 'symphony/APP-1',
      body: 'Linear: https://linear.app/anmho/issue/APP-1/x',
      authorLogin: 'app/anmho-symphony',
      reviewRequestLogins: ['anmho'],
    });
    expect(runner).toHaveBeenCalledWith(
      'gh',
      [
        'pr',
        'view',
        'https://github.com/anmho/symphony/pull/41',
        '--json',
        'author,url,headRefName,baseRefName,body,reviewRequests',
      ],
      { cwd: '/repo', timeoutMs: 60000 },
    );
  });

  it('requests GitHub reviewers for a pull request', async () => {
    const calls: Array<{
      command: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];
    const runner = vi.fn(async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const env = { ...process.env, GH_TOKEN: 'ghs_test' };

    await requestPullRequestReviewers(
      'https://github.com/anmho/symphony/pull/54',
      ['anmho'],
      '/repo',
      env,
      runner,
    );

    expect(calls).toEqual([
      {
        command: 'gh',
        args: [
          'pr',
          'edit',
          'https://github.com/anmho/symphony/pull/54',
          '--add-reviewer',
          'anmho',
        ],
        env,
      },
    ]);
  });

  it('removes stale GitHub reviewer requests for a pull request', async () => {
    const calls: Array<{
      command: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];
    const runner = vi.fn(async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const env = { ...process.env, GH_TOKEN: 'ghs_test' };

    await removePullRequestReviewers(
      'https://github.com/anmho/symphony/pull/54',
      ['anmho'],
      '/repo',
      env,
      runner,
    );

    expect(calls).toEqual([
      {
        command: 'gh',
        args: [
          'pr',
          'edit',
          'https://github.com/anmho/symphony/pull/54',
          '--remove-reviewer',
          'anmho',
        ],
        env,
      },
    ]);
  });

  it('merges Graphite-linked pull requests through Graphite', async () => {
    const calls: Array<{
      command: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];
    const env = { ...process.env, GH_TOKEN: 'ghs_test' };
    const runner = vi.fn(async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            url: 'https://github.com/anmho/website/pull/13',
            author: { login: 'app/anmho-symphony' },
            baseRefName: 'main',
            headRefName: 'symphony/ANM-394',
            body: 'Graphite: https://app.graphite.com/github/pr/anmho/website/13',
            reviewRequests: [],
          }),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await mergePullRequest(
      'https://github.com/anmho/website/pull/13',
      '/repo',
      env,
      runner,
    );

    expect(calls).toEqual([
      {
        command: 'gh',
        args: [
          'pr',
          'view',
          'https://github.com/anmho/website/pull/13',
          '--json',
          'author,url,headRefName,baseRefName,body,reviewRequests',
        ],
        env: undefined,
      },
      {
        command: 'gh',
        args: ['pr', 'checkout', 'https://github.com/anmho/website/pull/13'],
        env,
      },
      {
        command: 'gt',
        args: ['merge', '--no-interactive'],
        env: undefined,
      },
    ]);
  });

  it('merges non-Graphite pull requests through GitHub', async () => {
    const calls: Array<{
      command: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];
    const env = { ...process.env, GH_TOKEN: 'ghs_test' };
    const runner = vi.fn(async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            url: 'https://github.com/anmho/website/pull/13',
            author: { login: 'app/anmho-symphony' },
            baseRefName: 'main',
            headRefName: 'symphony/ANM-394',
            body: 'Linear: https://linear.app/anmho/issue/ANM-394/x',
            reviewRequests: [],
          }),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await mergePullRequest(
      'https://github.com/anmho/website/pull/13',
      '/repo',
      env,
      runner,
    );

    expect(calls.at(-1)).toEqual({
      command: 'gh',
      args: [
        'pr',
        'merge',
        'https://github.com/anmho/website/pull/13',
        '--squash',
        '--delete-branch',
      ],
      env,
    });
  });

  it('defaults missing PR review requests to an empty list', () => {
    expect(
      parsePullRequestMetadata(
        JSON.stringify({
          url: 'https://github.com/anmho/symphony/pull/41',
          author: { login: 'app/anmho-symphony' },
          baseRefName: 'main',
          headRefName: 'symphony/APP-1',
          body: 'Linear: https://linear.app/anmho/issue/APP-1/x',
        }),
      ),
    ).toMatchObject({
      authorLogin: 'app/anmho-symphony',
      reviewRequestLogins: [],
    });
  });

  it('falls back to the latest human review when aggregate review decision is empty', () => {
    expect(
      parsePullRequestMergeReadiness(
        JSON.stringify({
          url: 'https://github.com/anmho/symphony/pull/55',
          state: 'OPEN',
          isDraft: false,
          reviewDecision: '',
          latestReviews: [
            {
              state: 'COMMENTED',
              author: { login: 'anmho-symphony', __typename: 'Bot' },
            },
            {
              state: 'APPROVED',
              author: { login: 'anmho', __typename: 'User' },
            },
          ],
          mergeStateStatus: 'CLEAN',
          mergeable: 'MERGEABLE',
          headRefOid: 'sha',
        }),
      ),
    ).toMatchObject({
      reviewDecision: null,
      latestReviewDecision: 'APPROVED',
    });
  });

  it('ignores unresolved review threads after the bot has replied', async () => {
    const runner = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              url: 'https://github.com/anmho/symphony/pull/49',
              reviewThreads: {
                nodes: [
                  {
                    id: 'thread-1',
                    isResolved: false,
                    path: 'package.json',
                    line: null,
                    comments: {
                      nodes: [
                        {
                          author: { login: 'anmho' },
                          body: 'Why did we need `assets`',
                          url: 'https://github.com/anmho/symphony/pull/49#discussion_r1',
                          createdAt: '2026-05-26T02:29:45Z',
                        },
                        {
                          author: { login: 'anmho-symphony[bot]' },
                          body: 'Removed it.',
                          url: 'https://github.com/anmho/symphony/pull/49#discussion_r2',
                          createdAt: '2026-05-26T02:48:00Z',
                        },
                      ],
                    },
                  },
                ],
              },
              reviews: { nodes: [] },
              comments: { nodes: [] },
            },
          },
        },
      }),
      stderr: '',
    }));

    await expect(
      fetchPullRequestReviewFeedback(
        'https://github.com/anmho/symphony/pull/49',
        runner,
      ),
    ).resolves.toMatchObject({
      url: 'https://github.com/anmho/symphony/pull/49',
      unresolvedComments: [],
    });
  });

  it('ignores GitHub App comments even when GitHub reports the app slug instead of a bot login', async () => {
    const runner = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              url: 'https://github.com/anmho/symphony/pull/54',
              reviewThreads: {
                nodes: [
                  {
                    isResolved: false,
                    path: 'src/github.ts',
                    line: 12,
                    comments: {
                      nodes: [
                        {
                          author: {
                            login: 'anmho-symphony',
                            __typename: 'Bot',
                          },
                          body: 'Superseded by app-authored replacement PR.',
                          url: 'https://github.com/anmho/symphony/pull/54#discussion_r1',
                          createdAt: '2026-05-26T05:06:49Z',
                        },
                      ],
                    },
                  },
                ],
              },
              reviews: {
                nodes: [
                  {
                    author: { login: 'anmho-symphony', __typename: 'Bot' },
                    body: 'Addressed feedback.',
                    url: 'https://github.com/anmho/symphony/pull/54#pullrequestreview-1',
                    submittedAt: '2026-05-26T05:07:00Z',
                    state: 'COMMENTED',
                  },
                ],
              },
              comments: {
                nodes: [
                  {
                    author: { login: 'anmho-symphony', __typename: 'Bot' },
                    body: '@codex review',
                    url: 'https://github.com/anmho/symphony/pull/54#issuecomment-1',
                    createdAt: '2026-05-26T05:08:00Z',
                  },
                ],
              },
            },
          },
        },
      }),
      stderr: '',
    }));

    await expect(
      fetchPullRequestReviewFeedback(
        'https://github.com/anmho/symphony/pull/54',
        runner,
      ),
    ).resolves.toMatchObject({
      unresolvedComments: [],
    });
  });

  it('returns new human review feedback from threads, reviews, and top-level comments', async () => {
    const runner = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              url: 'https://github.com/anmho/symphony/pull/49',
              reviewThreads: {
                nodes: [
                  {
                    isResolved: false,
                    path: 'src/config.ts',
                    line: 12,
                    comments: {
                      nodes: [
                        {
                          author: { login: 'anmho' },
                          body: 'Please simplify this.',
                          url: 'https://github.com/anmho/symphony/pull/49#discussion_r1',
                          createdAt: '2026-05-26T02:50:00Z',
                        },
                      ],
                    },
                  },
                ],
              },
              reviews: {
                nodes: [
                  {
                    author: { login: 'anmho' },
                    body: '',
                    url: 'https://github.com/anmho/symphony/pull/49#pullrequestreview-1',
                    submittedAt: '2026-05-26T02:51:00Z',
                    state: 'CHANGES_REQUESTED',
                  },
                ],
              },
              comments: {
                nodes: [
                  {
                    author: { login: 'anmho' },
                    body: 'Can you also update the docs?',
                    url: 'https://github.com/anmho/symphony/pull/49#issuecomment-1',
                    createdAt: '2026-05-26T02:52:00Z',
                  },
                ],
              },
            },
          },
        },
      }),
      stderr: '',
    }));

    await expect(
      fetchPullRequestReviewFeedback(
        'https://github.com/anmho/symphony/pull/49',
        runner,
      ),
    ).resolves.toMatchObject({
      unresolvedComments: [
        {
          author: 'anmho',
          body: 'Please simplify this.',
          path: 'src/config.ts',
          url: 'https://github.com/anmho/symphony/pull/49#discussion_r1',
        },
        {
          author: 'anmho',
          body: 'Review state: CHANGES_REQUESTED.',
          path: null,
          url: 'https://github.com/anmho/symphony/pull/49#pullrequestreview-1',
        },
        {
          author: 'anmho',
          body: 'Can you also update the docs?',
          path: null,
          url: 'https://github.com/anmho/symphony/pull/49#issuecomment-1',
        },
      ],
    });
  });
});

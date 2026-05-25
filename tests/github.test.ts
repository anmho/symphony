import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPullRequestStatus,
  parseGithubPullRequestUrl,
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

  it('normalizes merged pull request status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
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
      vi.fn(async () =>
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
      fetchPullRequestStatus(
        'https://github.com/anmho/agent/pull/9',
        runner,
      ),
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
});

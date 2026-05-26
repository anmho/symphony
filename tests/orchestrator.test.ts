import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentWorkEventStore } from '../src/events.js';
import type { DigestState, DigestStateStore } from '../src/digest.js';
import {
  Orchestrator,
  type OrchestratorDependencies,
} from '../src/orchestrator.js';
import type {
  CodexRunInput,
  CodexRunEvent,
  CodexTurnResult,
  EffectiveWorkflowConfig,
  NormalizedIssue,
  WorkspaceInfo,
} from '../src/types.js';

describe('orchestrator', () => {
  it('dispatches up to configured concurrency', async () => {
    const issues = Array.from({ length: 6 }, (_, index) =>
      makeIssue(`APP-${index + 1}`),
    );
    const deps = makeDeps({
      fetchCandidateIssues: async () => issues,
      runCodexTurn: async () => new Promise<CodexTurnResult>(() => undefined),
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();

    expect(orchestrator.snapshot().running).toHaveLength(5);
    expect(orchestrator.snapshot().claimed).toHaveLength(5);
    expect(orchestrator.snapshot().concurrency).toMatchObject({
      running: 5,
      configuredMax: 5,
      effectiveMax: 5,
      source: 'workflow',
      overrideActive: false,
    });
  });

  it('honors max concurrency override on subsequent ticks without restart', async () => {
    const issues = Array.from({ length: 3 }, (_, index) =>
      makeIssue(`APP-${index + 1}`),
    );
    const config = makeConfig({
      agent: {
        maxConcurrentAgents: 1,
      },
    });
    const deps = makeDeps({
      loadWorkflowConfig: async () => config,
      fetchCandidateIssues: async () => issues,
      runCodexTurn: async () => new Promise<CodexTurnResult>(() => undefined),
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();
    expect(orchestrator.snapshot().running).toHaveLength(1);

    const concurrency = orchestrator.setMaxConcurrencyOverride(3);
    await orchestrator.tick();

    expect(concurrency).toMatchObject({
      configuredMax: 1,
      effectiveMax: 3,
      source: 'override',
      overrideActive: true,
    });
    expect(orchestrator.snapshot().running).toHaveLength(3);
  });

  it('persists max concurrency override across daemon restarts', async () => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), 'symphony-orchestrator-concurrency-'),
    );
    const workflowPath = path.join(dir, 'WORKFLOW.md');
    await writeFile(workflowPath, 'Prompt');
    const config = makeConfig({
      agent: {
        maxConcurrentAgents: 1,
      },
    });
    const first = new Orchestrator(
      { workflowPath },
      makeDeps({
        loadWorkflowConfig: async () => config,
        fetchCandidateIssues: async () => [],
      }),
    );

    first.setMaxConcurrencyOverride(2);

    const issues = [makeIssue('APP-1'), makeIssue('APP-2')];
    const restarted = new Orchestrator(
      { workflowPath },
      makeDeps({
        loadWorkflowConfig: async () => config,
        fetchCandidateIssues: async () => issues,
        runCodexTurn: async () => new Promise<CodexTurnResult>(() => undefined),
      }),
    );

    await restarted.tick();

    expect(restarted.snapshot().concurrency).toMatchObject({
      configuredMax: 1,
      effectiveMax: 2,
      source: 'override',
      overrideActive: true,
    });
    expect(restarted.snapshot().running).toHaveLength(2);
  });

  it('skips issues without required label and repo route', async () => {
    const config = makeConfig({
      tracker: {
        requiredLabels: ['symphony'],
        repoLabelPrefix: 'repo:',
      },
      workspace: {
        repoRoutes: {
          symphony: '/tmp/repo',
        },
      },
    });
    const deps = makeDeps({
      loadWorkflowConfig: async () => config,
      fetchCandidateIssues: async () => [
        makeIssue('APP-1', { labels: ['symphony'] }),
        makeIssue('APP-2', { labels: ['repo:symphony'] }),
        makeIssue('APP-3', { labels: ['symphony', 'repo:symphony'] }),
      ],
      runCodexTurn: async () => new Promise<CodexTurnResult>(() => undefined),
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();

    expect(
      orchestrator.snapshot().running.map((session) => session.identifier),
    ).toEqual(['APP-3']);
  });

  it('continues active issues on the same worker loop', async () => {
    const issue = makeIssue('APP-1');
    let fetches = 0;
    let codexCalls = 0;
    const deps = makeDeps({
      fetchCandidateIssues: async () => [issue],
      fetchIssueById: async () => {
        fetches += 1;
        return fetches <= 2 ? issue : { ...issue, state: 'Human Review' };
      },
      runCodexTurn: async () => {
        codexCalls += 1;
        return completedTurn(`thread-${codexCalls}`, `turn-${codexCalls}`);
      },
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();
    await flushPromises();

    expect(codexCalls).toBe(2);
    expect(orchestrator.snapshot().running).toHaveLength(0);
  });

  it('schedules retry after failed worker', async () => {
    const issue = makeIssue('APP-1');
    const deps = makeDeps({
      fetchCandidateIssues: async () => [issue],
      runCodexTurn: async () => ({
        ...completedTurn('thread', 'turn'),
        status: 'failed',
        error: 'boom',
      }),
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();
    await flushPromises();

    expect(orchestrator.snapshot().retryAttempts).toMatchObject([
      {
        issueId: issue.id,
        identifier: issue.identifier,
        attempt: 1,
        error: 'boom',
      },
    ]);
  });

  it('pauses new Codex launches while rate limited', async () => {
    const issue = makeIssue('APP-1');
    let now = 1000;
    let codexCalls = 0;
    const deps = makeDeps({
      now: () => now,
      fetchCandidateIssues: async () => [issue],
      runCodexTurn: async () => {
        codexCalls += 1;
        return {
          ...completedTurn('thread', 'turn'),
          status: 'rate_limited',
          rateLimitUntilMs: 100000,
          error: 'codex_rate_limited',
        };
      },
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();
    await flushPromises();
    now = 2000;
    await orchestrator.tick();

    expect(codexCalls).toBe(1);
    expect(orchestrator.snapshot().codexRateLimit.resumeAfterMs).toBe(100000);
  });

  it('probes rate limits at a fixed jittered interval before the reported reset', async () => {
    const issue = makeIssue('APP-1');
    const config = makeConfig();
    config.agent.rateLimitProbeIntervalMs = 1000;
    let now = 1000;
    let codexCalls = 0;
    const deps = makeDeps({
      loadWorkflowConfig: async () => config,
      now: () => now,
      fetchCandidateIssues: async () => [issue],
      runCodexTurn: async () => {
        codexCalls += 1;
        return {
          ...completedTurn('thread', 'turn'),
          status: 'rate_limited',
          rateLimitUntilMs: 100000,
          error: 'codex_rate_limited',
        };
      },
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();
    await flushPromises();
    now = 2500;
    await orchestrator.tick();
    await flushPromises();

    expect(codexCalls).toBe(2);
    expect(orchestrator.snapshot().retryAttempts[0]?.dueAtMs).toBeGreaterThan(
      now,
    );
  });

  it('keeps last known good config on invalid reload', async () => {
    const config = makeConfig();
    let loads = 0;
    const deps = makeDeps({
      loadWorkflowConfig: async () => {
        loads += 1;
        if (loads > 1) {
          throw new Error('bad config');
        }
        return config;
      },
      fetchCandidateIssues: async () => [],
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();
    await orchestrator.tick();

    expect(orchestrator.snapshot().lastConfigError).toBe('bad config');
  });

  it('captures Codex work events for status and logs', async () => {
    const issue = makeIssue('APP-1');
    const dir = await mkdtemp(
      path.join(os.tmpdir(), 'symphony-orchestrator-events-'),
    );
    const eventStore = new AgentWorkEventStore(
      path.join(dir, 'WORKFLOW.md'),
      () => 2000,
    );
    let fetches = 0;
    const deps = makeDeps({
      eventStore,
      fetchCandidateIssues: async () => [issue],
      fetchIssueById: async () => {
        fetches += 1;
        return fetches === 1 ? issue : { ...issue, state: 'Human Review' };
      },
      runCodexTurn: async (_input, options) => {
        options.onEvent({ type: 'thread_started', threadId: 'thread-1' });
        options.onEvent({
          type: 'notification',
          method: 'item/agentMessage/delta',
          params: { delta: 'Working on it' },
        });
        return completedTurn('thread-1', 'turn-1');
      },
    });
    const orchestrator = new Orchestrator(
      { workflowPath: path.join(dir, 'WORKFLOW.md') },
      deps,
    );

    await orchestrator.tick();
    await flushPromises();

    expect(
      orchestrator.events('APP-1', 0, 20).map((event) => event.type),
    ).toContain('assistant_delta');
    expect(orchestrator.snapshot().running).toHaveLength(0);
  });

  it('records Codex goal updates in live session status', async () => {
    const issue = makeIssue('APP-1');
    const dir = await mkdtemp(
      path.join(os.tmpdir(), 'symphony-orchestrator-goal-'),
    );
    const eventStore = new AgentWorkEventStore(
      path.join(dir, 'WORKFLOW.md'),
      () => 2000,
    );
    const deps = makeDeps({
      eventStore,
      fetchCandidateIssues: async () => [issue],
      runCodexTurn: async (_input, options) => {
        options.onEvent({
          type: 'notification',
          method: 'thread/goal/updated',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            goal: {
              threadId: 'thread-1',
              objective: 'Complete Linear issue APP-1',
              status: 'complete',
              tokenBudget: null,
              tokensUsed: 100,
              timeUsedSeconds: 10,
              createdAt: 1,
              updatedAt: 2,
            },
          },
        });
        return new Promise<CodexTurnResult>(() => undefined);
      },
    });
    const orchestrator = new Orchestrator(
      { workflowPath: path.join(dir, 'WORKFLOW.md') },
      deps,
    );

    await orchestrator.tick();
    await flushPromises();

    expect(orchestrator.snapshot().running[0]).toMatchObject({
      identifier: 'APP-1',
      goalStatus: 'complete',
      goalObjective: 'Complete Linear issue APP-1',
      goalUpdatedAtMs: 1000,
    });
    expect(orchestrator.events('APP-1', 0, 20).map((event) => event.type)).toContain('goal');
  });

  it('moves completed Codex goals to the configured handoff state', async () => {
    const issue = makeIssue('APP-1');
    const config = makeConfig({
      tracker: {
        handoffState: 'Human Review',
      },
    });
    const moved = vi.fn(
      async (
        _config: EffectiveWorkflowConfig,
        _issueId: string,
        _state: string,
      ) => undefined,
    );
    const deps = makeDeps({
      loadWorkflowConfig: async () => config,
      fetchCandidateIssues: async () => [issue],
      fetchIssueById: async () => issue,
      moveIssueToState: moved,
      runCodexTurn: async (_input, options) => {
        options.onEvent({
          type: 'notification',
          method: 'thread/goal/updated',
          params: {
            goal: {
              objective: 'Complete Linear issue APP-1',
              status: 'complete',
            },
          },
        });
        return completedTurn('thread-1', 'turn-1');
      },
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();
    await flushPromises();

    expect(moved).toHaveBeenCalledWith(config, issue.id, 'Human Review');
    expect(orchestrator.snapshot().running).toHaveLength(0);
    expect(orchestrator.snapshot().claimed).toHaveLength(0);
    expect(orchestrator.events('APP-1', 0, 20).map((event) => event.summary)).toContain(
      'issue moved to handoff state',
    );
  });

  it('moves blocked Codex goals to the configured handoff state', async () => {
    const issue = makeIssue('APP-1');
    const config = makeConfig({
      tracker: {
        handoffState: 'Human Review',
      },
    });
    const moved = vi.fn(async () => undefined);
    const deps = makeDeps({
      loadWorkflowConfig: async () => config,
      fetchCandidateIssues: async () => [issue],
      fetchIssueById: async () => issue,
      moveIssueToState: moved,
      runCodexTurn: async (_input, options) => {
        options.onEvent({
          type: 'notification',
          method: 'thread/goal/updated',
          params: {
            goal: {
              objective: 'Complete Linear issue APP-1',
              status: 'blocked',
            },
          },
        });
        return completedTurn('thread-1', 'turn-1');
      },
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();
    await flushPromises();

    expect(moved).toHaveBeenCalledWith(config, issue.id, 'Human Review');
    expect(orchestrator.snapshot().running).toHaveLength(0);
    expect(orchestrator.snapshot().claimed).toHaveLength(0);
  });

  it('attaches queued steering to the next prompt', async () => {
    const issue = makeIssue('APP-1');
    const dir = await mkdtemp(
      path.join(os.tmpdir(), 'symphony-orchestrator-steer-'),
    );
    let prompt = '';
    let fetches = 0;
    const deps = makeDeps({
      eventStore: new AgentWorkEventStore(
        path.join(dir, 'WORKFLOW.md'),
        () => 2000,
      ),
      fetchCandidateIssues: async () => [issue],
      fetchIssueById: async () => {
        fetches += 1;
        return fetches === 1 ? issue : { ...issue, state: 'Human Review' };
      },
      runCodexTurn: async (input) => {
        prompt = input.prompt;
        return completedTurn('thread-1', 'turn-1');
      },
    });
    const orchestrator = new Orchestrator(
      { workflowPath: path.join(dir, 'WORKFLOW.md') },
      deps,
    );

    orchestrator.queueSteer('APP-1', 'prioritize the keyboard regression');
    await orchestrator.tick();
    await flushPromises();

    expect(prompt).toContain('## Operator Guidance');
    expect(prompt).toContain('prioritize the keyboard regression');
  });

  it('aborts running agents and blocks new dispatch while paused', async () => {
    const runningIssue = makeIssue('APP-1');
    const queuedIssue = makeIssue('APP-2');
    let codexCalls = 0;
    const deps = makeDeps({
      fetchCandidateIssues: async () => [runningIssue, queuedIssue],
      runCodexTurn: async (_input, options) => {
        codexCalls += 1;
        return abortableTurn(options.signal);
      },
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();
    await flushPromises();
    expect(orchestrator.snapshot().running).toHaveLength(2);
    expect(codexCalls).toBe(2);

    orchestrator.pause();
    expect(orchestrator.snapshot().paused).toBe(true);
    expect(orchestrator.snapshot().pausedAtMs).toBe(1000);
    await flushPromises();
    expect(orchestrator.snapshot().running).toHaveLength(0);

    await orchestrator.tick();
    await flushPromises();
    expect(codexCalls).toBe(2);
  });

  it('records externally terminal running issues as completed identifiers', async () => {
    const issue = makeIssue('APP-1');
    let terminal = false;
    const deps = makeDeps({
      fetchCandidateIssues: async () => [issue],
      fetchIssueById: async () =>
        terminal ? { ...issue, state: 'Done' } : issue,
      runCodexTurn: async (_input, options) => abortableTurn(options.signal),
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();
    await flushPromises();
    expect(orchestrator.snapshot().running).toHaveLength(1);

    terminal = true;
    await orchestrator.tick();
    await flushPromises();

    expect(orchestrator.snapshot().running).toHaveLength(0);
    expect(orchestrator.snapshot().completed).toEqual(['APP-1']);
  });

  it('hydrates completed issues from terminal Linear state on tick', async () => {
    const deps = makeDeps({
      fetchTerminalIssues: async () => [
        makeIssue('ANM-283', {
          id: 'issue-283',
          title: 'Make Symphony npm publishing fully workflow-driven',
          state: 'Done',
          labels: ['symphony'],
        }),
      ],
      fetchCandidateIssues: async () => [],
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();

    expect(orchestrator.snapshot().completed).toEqual(['ANM-283']);
    expect(orchestrator.snapshot().completedDetails).toEqual([
      {
        identifier: 'ANM-283',
        title: 'Make Symphony npm publishing fully workflow-driven',
        repoKey: null,
        state: 'Done',
        reviewKind: 'completed',
        prUrl: null,
      },
    ]);
  });

  it('hydrates handoff issues from configured Linear handoff state on tick', async () => {
    const config = makeConfig({
      tracker: {
        handoffState: 'In Review',
      },
    });
    const deps = makeDeps({
      loadWorkflowConfig: async () => config,
      fetchHandoffIssues: async () => [
        makeIssue('ANM-284', {
          id: 'issue-284',
          title: 'Ready for human review',
          state: 'In Review',
          labels: ['symphony'],
          comments: ['GitHub PR opened: https://github.com/anmho/symphony/pull/37'],
        }),
      ],
      fetchCandidateIssues: async () => [],
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();

    expect(orchestrator.snapshot().handoff).toEqual(['ANM-284']);
    expect(orchestrator.snapshot().handoffDetails).toEqual([
      {
        identifier: 'ANM-284',
        title: 'Ready for human review',
        repoKey: null,
        state: 'In Review',
        reviewKind: 'pr_review',
        prUrl: 'https://github.com/anmho/symphony/pull/37',
      },
    ]);
    expect(orchestrator.snapshot().completed).toEqual([]);
  });

  it('moves handoff issues with merged GitHub PRs to terminal Linear state', async () => {
    const issue = makeIssue('ANM-324', {
      id: 'issue-324',
      title: 'agent: add concrete MCP auth checks for optional connectors',
      state: 'In Review',
      labels: ['symphony', 'repo:agent'],
      attachments: ['https://github.com/anmho/agent/pull/9'],
    });
    const config = makeConfig({
      tracker: {
        handoffState: 'In Review',
        terminalStates: ['Done'],
      },
    });
    const moved = vi.fn(async () => undefined);
    const comments: string[] = [];
    const deps = makeDeps({
      loadWorkflowConfig: async () => config,
      fetchHandoffIssues: async () => [issue],
      fetchCandidateIssues: async () => [],
      fetchPullRequestStatus: async () => ({
        url: 'https://github.com/anmho/agent/pull/9',
        owner: 'anmho',
        repo: 'agent',
        number: 9,
        state: 'merged',
        mergedAt: '2026-05-08T10:19:30Z',
      }),
      moveIssueToState: moved,
      writeRunnerComment: async (_config, _issueId, body) => {
        comments.push(body);
      },
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();

    expect(moved).toHaveBeenCalledWith(config, issue.id, 'Done');
    expect(comments[0]).toContain('https://github.com/anmho/agent/pull/9');
    expect(orchestrator.snapshot().handoff).toEqual([]);
    expect(orchestrator.snapshot().completed).toEqual(['ANM-324']);
    expect(orchestrator.snapshot().completedDetails).toMatchObject([
      {
        identifier: 'ANM-324',
        state: 'Done',
        reviewKind: 'completed',
        prUrl: 'https://github.com/anmho/agent/pull/9',
      },
    ]);
  });

  it('moves handoff issues with unresolved PR review comments back to active work', async () => {
    const issue = makeIssue('ANM-379', {
      id: 'issue-379',
      title: 'symphony: rename GitHub App identity',
      state: 'In Review',
      labels: ['symphony', 'repo:symphony'],
      comments: ['GitHub PR opened: https://github.com/anmho/symphony/pull/49'],
    });
    const config = makeConfig({
      tracker: {
        activeStates: ['Todo', 'In Progress'],
        handoffState: 'In Review',
      },
    });
    const moved = vi.fn(async () => undefined);
    const comments: string[] = [];
    const deps = makeDeps({
      loadWorkflowConfig: async () => config,
      fetchHandoffIssues: async () => [issue],
      fetchCandidateIssues: async () => [],
      fetchPullRequestReviewFeedback: async () => ({
        url: 'https://github.com/anmho/symphony/pull/49',
        owner: 'anmho',
        repo: 'symphony',
        number: 49,
        unresolvedComments: [
          {
            author: 'anmho',
            body: 'Why did we need `assets`',
            path: 'package.json',
            line: 23,
            url: 'https://github.com/anmho/symphony/pull/49#discussion_r3300841166',
            createdAt: '2026-05-26T02:29:45Z',
          },
        ],
      }),
      moveIssueToState: moved,
      writeRunnerComment: async (_config, _issueId, body) => {
        comments.push(body);
      },
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();

    expect(comments[0]).toContain('Unresolved GitHub PR review comments were found.');
    expect(comments[0]).toContain('package.json:23 by @anmho');
    expect(comments[0]).toContain('Why did we need `assets`');
    expect(moved).toHaveBeenCalledWith(config, issue.id, 'In Progress');
    expect(orchestrator.snapshot().handoff).toEqual([]);
  });

  it('moves externally handed-off running issues into the handoff snapshot', async () => {
    const issue = makeIssue('APP-1');
    const config = makeConfig({
      tracker: {
        handoffState: 'In Review',
      },
    });
    let handoff = false;
    const deps = makeDeps({
      loadWorkflowConfig: async () => config,
      fetchCandidateIssues: async () => [issue],
      fetchIssueById: async () =>
        handoff ? { ...issue, state: 'In Review' } : issue,
      runCodexTurn: async (_input, options) => abortableTurn(options.signal),
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();
    await flushPromises();
    expect(orchestrator.snapshot().running).toHaveLength(1);

    handoff = true;
    await orchestrator.tick();
    await flushPromises();

    expect(orchestrator.snapshot().running).toHaveLength(0);
    expect(orchestrator.snapshot().handoff).toEqual(['APP-1']);
  });

  it('moves active PR-linked running issues into the handoff state', async () => {
    const issue = makeIssue('APP-1');
    const config = makeConfig({
      tracker: {
        handoffState: 'In Review',
      },
    });
    const moved = vi.fn(async () => undefined);
    let fetches = 0;
    const deps = makeDeps({
      loadWorkflowConfig: async () => config,
      fetchCandidateIssues: async () => [issue],
      fetchIssueById: async () => {
        fetches += 1;
        return fetches === 1
          ? issue
          : {
              ...issue,
              attachments: ['https://github.com/anmho/symphony/pull/41'],
            };
      },
      moveIssueToState: moved,
      runCodexTurn: async (_input, options) => abortableTurn(options.signal),
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();
    await flushPromises();
    expect(orchestrator.snapshot().running).toHaveLength(1);

    await orchestrator.tick();
    await flushPromises();

    expect(moved).toHaveBeenCalledWith(config, issue.id, 'In Review');
    expect(orchestrator.snapshot().running).toHaveLength(0);
    expect(orchestrator.snapshot().handoff).toEqual(['APP-1']);
    expect(orchestrator.snapshot().handoffDetails).toMatchObject([
      {
        identifier: 'APP-1',
        state: 'In Review',
        prUrl: 'https://github.com/anmho/symphony/pull/41',
      },
    ]);
  });

  it('blocks PR-linked handoff when the configured PR identity author does not match', async () => {
    const issue = makeIssue('APP-1', {
      attachments: ['https://github.com/anmho/symphony/pull/41'],
    });
    const config = makeConfig({
      tracker: {
        handoffState: 'In Review',
      },
      github: {
        prIdentity: {
          kind: 'github_app',
          appSlug: 'anmho-symphony',
          tokenCommand: 'symphony github-app-token',
          authorName: 'anmho Symphony',
          authorEmail: '3862765+anmho-symphony[bot]@users.noreply.github.com',
        },
      },
    });
    const comments: string[] = [];
    const moved = vi.fn(async () => undefined);
    const runCodexTurn = vi.fn(async () => completedTurn('thread', 'turn'));
    const deps = makeDeps({
      loadWorkflowConfig: async () => config,
      fetchCandidateIssues: async () => [issue],
      moveIssueToState: moved,
      writeRunnerComment: async (_config, _issueId, body) => {
        comments.push(body);
      },
      fetchPullRequestMetadata: async (url) => ({
        url,
        baseRefName: 'main',
        headRefName: 'symphony/APP-1',
        body: 'Linear: https://linear.app/anmho/issue/APP-1/x',
        authorLogin: 'anmho',
      }),
      runCodexTurn,
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();
    await flushPromises();

    expect(moved).not.toHaveBeenCalled();
    expect(comments[0]).toContain('Expected PR author: app/anmho-symphony');
    expect(comments[0]).toContain('Actual PR author: anmho');
    expect(runCodexTurn).toHaveBeenCalled();
    expect(orchestrator.snapshot().handoff).toEqual([]);
  });

  it('does not dispatch active PR-linked candidate issues', async () => {
    const issue = makeIssue('APP-1', {
      attachments: ['GitHub PR https://github.com/anmho/symphony/pull/41'],
    });
    const config = makeConfig({
      tracker: {
        handoffState: 'In Review',
      },
    });
    const moved = vi.fn(async () => undefined);
    const runCodexTurn = vi.fn(async () => completedTurn('thread', 'turn'));
    const deps = makeDeps({
      loadWorkflowConfig: async () => config,
      fetchCandidateIssues: async () => [issue],
      moveIssueToState: moved,
      runCodexTurn,
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();

    expect(moved).toHaveBeenCalledWith(config, issue.id, 'In Review');
    expect(runCodexTurn).not.toHaveBeenCalled();
    expect(orchestrator.snapshot().running).toHaveLength(0);
    expect(orchestrator.snapshot().handoff).toEqual(['APP-1']);
  });

  it('moves active candidate issues with already-merged PRs directly to terminal state', async () => {
    const issue = makeIssue('APP-1', {
      attachments: ['GitHub PR https://github.com/anmho/symphony/pull/41'],
    });
    const config = makeConfig({
      tracker: {
        handoffState: 'In Review',
        terminalStates: ['Done'],
      },
    });
    const moved = vi.fn(async () => undefined);
    const runCodexTurn = vi.fn(async () => completedTurn('thread', 'turn'));
    const deps = makeDeps({
      loadWorkflowConfig: async () => config,
      fetchCandidateIssues: async () => [issue],
      fetchPullRequestStatus: async () => ({
        url: 'https://github.com/anmho/symphony/pull/41',
        owner: 'anmho',
        repo: 'symphony',
        number: 41,
        state: 'merged',
        mergedAt: '2026-05-24T01:00:00Z',
      }),
      moveIssueToState: moved,
      runCodexTurn,
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();

    expect(moved).toHaveBeenCalledWith(config, issue.id, 'Done');
    expect(runCodexTurn).not.toHaveBeenCalled();
    expect(orchestrator.snapshot().running).toHaveLength(0);
    expect(orchestrator.snapshot().handoff).toEqual([]);
    expect(orchestrator.snapshot().completed).toEqual(['APP-1']);
  });

  it('holds retries while paused and resumes dispatch after unpause', async () => {
    const issue = makeIssue('APP-1');
    let now = 1000;
    let codexCalls = 0;
    const deps = makeDeps({
      now: () => now,
      fetchCandidateIssues: async () => [issue],
      runCodexTurn: async () => {
        codexCalls += 1;
        return {
          ...completedTurn('thread', 'turn'),
          status: 'failed',
          error: 'boom',
        };
      },
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();
    await flushPromises();
    expect(orchestrator.snapshot().retryAttempts).toHaveLength(1);

    orchestrator.pause();
    now = 5000;
    await orchestrator.tick();
    await flushPromises();
    expect(codexCalls).toBe(1);

    now = 12000;
    orchestrator.resume();
    await flushPromises();
    expect(orchestrator.snapshot().paused).toBe(false);
    expect(codexCalls).toBeGreaterThan(1);
  });

  it('moves reviewed issues back to In Progress with feedback', async () => {
    const issue = makeIssue('APP-1', {
      state: 'In Review',
      attachments: ['https://github.com/anmho/example/pull/1'],
    });
    const comments: string[] = [];
    const moved = vi.fn(
      async (
        _config: EffectiveWorkflowConfig,
        _issueId: string,
        _state: string,
      ) => undefined,
    );
    let currentIssue = issue;
    let codexCalls = 0;
    const config = makeConfig({
      tracker: {
        activeStates: ['Todo', 'In Progress'],
        handoffState: 'In Review',
      },
    });
    const deps = makeDeps({
      loadWorkflowConfig: async () => config,
      fetchIssueById: async () => currentIssue,
      fetchCandidateIssues: async () =>
        currentIssue.state === 'In Progress' ? [currentIssue] : [],
      writeRunnerComment: async (_config, _issueId, body) => {
        comments.push(body);
      },
      moveIssueToState: async (moveConfig, issueId, state) => {
        moved(moveConfig, issueId, state);
        currentIssue = { ...currentIssue, state };
      },
      runCodexTurn: async (_input, options) => {
        codexCalls += 1;
        return abortableTurn(options.signal);
      },
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    const result = await orchestrator.requestChanges('APP-1', 'Please simplify the implementation.');

    expect(result).toEqual({ issue: 'APP-1', state: 'In Progress' });
    expect(comments[0]).toContain('Please simplify the implementation.');
    expect(moved).toHaveBeenCalledWith(config, issue.id, 'In Progress');
    await flushPromises();
    expect(codexCalls).toBe(1);
    expect(orchestrator.snapshot().running).toHaveLength(1);
    expect(orchestrator.snapshot().handoff).toEqual([]);
  });

  it('does not send digests when digest config is disabled', async () => {
    const sendDigest = vi.fn(async () => undefined);
    const deps = makeDeps({
      fetchHandoffIssues: async () => [
        makeIssue('APP-1', {
          state: 'In Review',
          comments: ['https://github.com/anmho/symphony/pull/1'],
        }),
      ],
      sendDigestEmail: sendDigest,
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();

    expect(sendDigest).not.toHaveBeenCalled();
  });

  it('sends at most one digest per window and persists the event checkpoint', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-digest-'));
    const eventStore = new AgentWorkEventStore(
      path.join(dir, 'WORKFLOW.md'),
      () => 9000,
    );
    eventStore.append({
      issueId: 'APP-1',
      identifier: 'APP-1',
      repoKey: 'symphony',
      workspacePath: null,
      threadId: null,
      turnId: null,
      type: 'runner',
      summary: 'failed checks need review',
      timestampMs: 9000,
    });
    const stateStore = new MemoryDigestStateStore();
    const config = makeConfig({
      tracker: { handoffState: 'In Review' },
      digest: { enabled: true, intervalMs: 1000, windowMs: 10000 },
    });
    let now = 10000;
    const sentTexts: string[] = [];
    const sendDigest: OrchestratorDependencies['sendDigestEmail'] = vi.fn(
      async (_config, email) => {
        sentTexts.push(email.text);
      },
    );
    const deps = makeDeps({
      loadWorkflowConfig: async () => config,
      now: () => now,
      eventStore,
      digestStateStore: stateStore,
      fetchHandoffIssues: async () => [
        makeIssue('APP-1', {
          state: 'In Review',
          comments: ['https://github.com/anmho/symphony/pull/1'],
        }),
      ],
      sendDigestEmail: sendDigest,
    });
    const orchestrator = new Orchestrator(
      { workflowPath: path.join(dir, 'WORKFLOW.md') },
      deps,
    );

    await orchestrator.tick();
    expect(sendDigest).toHaveBeenCalledTimes(1);
    expect(sentTexts[0]).toContain('failed checks need review');
    expect(stateStore.state).toEqual({
      lastSentAtMs: 10000,
      lastProcessedCursor: 1,
    });

    now = 10500;
    const restarted = new Orchestrator(
      { workflowPath: path.join(dir, 'WORKFLOW.md') },
      deps,
    );
    await restarted.tick();

    expect(sendDigest).toHaveBeenCalledTimes(1);
  });

  it('does not advance digest checkpoint when sending fails', async () => {
    const stateStore = new MemoryDigestStateStore();
    const config = makeConfig({
      tracker: { handoffState: 'In Review' },
      digest: { enabled: true, intervalMs: 1000, windowMs: 10000 },
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const sendDigest = vi.fn(async () => {
      throw new Error('resend_http_error: 500');
    });
    const deps = makeDeps({
      loadWorkflowConfig: async () => config,
      logger,
      digestStateStore: stateStore,
      fetchHandoffIssues: async () => [
        makeIssue('APP-1', {
          state: 'In Review',
          comments: ['https://github.com/anmho/symphony/pull/1'],
        }),
      ],
      sendDigestEmail: sendDigest,
    });
    const orchestrator = new Orchestrator(
      { workflowPath: '/tmp/WORKFLOW.md' },
      deps,
    );

    await orchestrator.tick();
    await orchestrator.tick();

    expect(sendDigest).toHaveBeenCalledTimes(2);
    expect(stateStore.state).toEqual({
      lastSentAtMs: null,
      lastProcessedCursor: 0,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { error: 'resend_http_error: 500' },
      'failed to send Symphony digest email',
    );
  });
});

type TestDeps = Partial<OrchestratorDependencies>;

class MemoryDigestStateStore implements DigestStateStore {
  state: DigestState = {
    lastSentAtMs: null,
    lastProcessedCursor: 0,
  };

  read(): DigestState {
    return { ...this.state };
  }

  write(state: DigestState): void {
    this.state = { ...state };
  }
}

function makeDeps(overrides: TestDeps = {}): TestDeps {
  const config = makeConfig();
  return {
    loadWorkflowConfig: async () => config,
    fetchCandidateIssues: async () => [],
    fetchIssueById: async (_config, issueId) => makeIssue(issueId),
    fetchTerminalIssues: async () => [],
    fetchHandoffIssues: async () => [],
    writeRunnerComment: async () => undefined,
    moveIssueToState: async () => undefined,
    fetchPullRequestStatus: async () => null,
    fetchPullRequestMetadata: async (url) => ({
      url,
      baseRefName: 'main',
      headRefName: 'symphony/APP-1',
      body: '',
      authorLogin: null,
    }),
    fetchPullRequestReviewFeedback: async () => null,
    prepareWorkspace: async (_config, issue) => makeWorkspace(issue),
    removeWorkspace: async () => undefined,
    workspaceInfoForIssue: (_config, issue) => makeWorkspace(issue),
    workspacePathExists: async () => true,
    runHook: async () => undefined,
    renderIssuePrompt: async (_config, issue) => `Prompt ${issue.identifier}`,
    runCodexTurn: async (
      _input: CodexRunInput,
      _options: {
        signal: AbortSignal;
        onEvent: (event: CodexRunEvent) => void;
      },
    ) => completedTurn('thread', 'turn'),
    now: () => 1000,
    sleep: async () => undefined,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ...overrides,
  };
}

function makeConfig(
  overrides: {
    tracker?: Partial<EffectiveWorkflowConfig['tracker']>;
    workspace?: Partial<EffectiveWorkflowConfig['workspace']>;
    digest?: Partial<EffectiveWorkflowConfig['digest']>;
    agent?: Partial<EffectiveWorkflowConfig['agent']>;
    github?: Partial<EffectiveWorkflowConfig['github']>;
  } = {},
): EffectiveWorkflowConfig {
  const config: EffectiveWorkflowConfig = {
    workflowPath: '/tmp/WORKFLOW.md',
    workflowDir: '/tmp',
    promptTemplate: 'Prompt {{ issue.identifier }}',
    tracker: {
      kind: 'linear',
      endpoint: 'https://linear.example/graphql',
      apiKey: 'lin_test',
      projectSlug: 'project',
      teamKey: null,
      requiredLabels: [],
      repoLabelPrefix: 'repo:',
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Done', 'Closed', 'Canceled'],
      handoffState: null,
    },
    polling: { intervalMs: 30000 },
    workspace: {
      root: '/tmp/workspaces',
      repoPath: '/tmp/repo',
      projectsRoot: null,
      repoRoutes: {},
      baseBranch: 'main',
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60000,
    },
    agent: {
      maxConcurrentAgents: 5,
      maxTurns: 20,
      maxRetryBackoffMs: 300000,
      rateLimitProbeIntervalMs: 300000,
      maxConcurrentAgentsByState: {},
    },
    codex: {
      command: 'codex app-server --listen stdio://',
      approvalPolicy: 'never',
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 3600000,
      readTimeoutMs: 5000,
      stallTimeoutMs: 300000,
      model: null,
    },
    github: {
      prIdentity: null,
    },
    pullRequest: {
      backend: 'github',
      graphiteFallback: 'fail',
    },
    digest: {
      enabled: false,
      recipient: 'andyminhtuanho@gmail.com',
      sender: 'Symphony <agent@anmho.com>',
      intervalMs: 3600000,
      windowMs: 3600000,
      resendApiKey: null,
      resendEndpoint: 'https://api.resend.com/emails',
    },
  };
  return {
    ...config,
    tracker: {
      ...config.tracker,
      ...overrides.tracker,
    },
    workspace: {
      ...config.workspace,
      ...overrides.workspace,
    },
    agent: {
      ...config.agent,
      ...overrides.agent,
    },
    digest: {
      ...config.digest,
      ...overrides.digest,
    },
    github: {
      ...config.github,
      ...overrides.github,
    },
  };
}

function makeIssue(
  identifier: string,
  overrides: Partial<NormalizedIssue> = {},
): NormalizedIssue {
  return {
    id: overrides.id ?? identifier,
    identifier: overrides.identifier ?? identifier,
    title: overrides.title ?? `Issue ${identifier}`,
    description: overrides.description ?? null,
    priority: overrides.priority ?? null,
    state: overrides.state ?? 'Todo',
    branchName: overrides.branchName ?? null,
    url: overrides.url ?? null,
    labels: overrides.labels ?? [],
    comments: overrides.comments ?? [],
    attachments: overrides.attachments ?? [],
    blockedBy: overrides.blockedBy ?? [],
    createdAt: overrides.createdAt ?? null,
    updatedAt: overrides.updatedAt ?? null,
  };
}

function makeWorkspace(issue: NormalizedIssue): WorkspaceInfo {
  return {
    path: `/tmp/workspaces/${issue.identifier}`,
    workspaceKey: issue.identifier,
    branchName: `symphony/${issue.identifier}`,
    repoKey: null,
    repoPath: '/tmp/repo',
    createdNow: false,
  };
}

function abortableTurn(signal: AbortSignal): Promise<CodexTurnResult> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

function completedTurn(threadId: string, turnId: string): CodexTurnResult {
  return {
    status: 'completed',
    threadId,
    turnId,
    rateLimitUntilMs: null,
    lastMessage: null,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    error: null,
  };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

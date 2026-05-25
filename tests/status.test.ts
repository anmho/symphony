import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import {
  fetchDaemonEvents,
  latestVisibleWorkEvents,
  queueSteer,
  requestChanges,
  resumeIssue,
  startStatusServer,
} from '../src/status.js';
import type { OrchestratorSnapshot } from '../src/types.js';

describe('status server', () => {
  let server: Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server = null;
    });
  });

  it('serves work events and selected-agent controls', async () => {
    server = await startStatusServer(() => snapshot(), 0, {
      getEvents: () => [
        {
          cursor: 1,
          timestampMs: 1000,
          issueId: 'issue-1',
          identifier: 'ANM-1',
          repoKey: null,
          workspacePath: null,
          threadId: null,
          turnId: null,
          type: 'runner',
          level: 'info',
          summary: 'started',
          payload: null,
        },
      ],
      queueSteer: (issue) => ({ queued: true, issue }),
      resumeIssue: (issue) => ({ resumed: true, issue }),
      requestChanges: (issue) => ({ issue, state: 'In Progress' }),
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    await expect(
      fetchDaemonEvents(port, { issue: 'ANM-1' }),
    ).resolves.toMatchObject([{ identifier: 'ANM-1', summary: 'started' }]);
    await expect(queueSteer(port, 'ANM-1', 'try tests')).resolves.toMatchObject(
      { queued: true, issue: 'ANM-1' },
    );
    await expect(resumeIssue(port, 'ANM-1')).resolves.toMatchObject({
      resumed: true,
      issue: 'ANM-1',
    });
    await expect(
      requestChanges(port, 'ANM-1', 'Fix the failing test'),
    ).resolves.toMatchObject({
      issue: 'ANM-1',
      state: 'In Progress',
    });
  });

  it('can select latest visible events from a noisy raw tail', () => {
    const events = latestVisibleWorkEvents(
      [
        event(1, 'assistant_message', 'completed work'),
        event(2, 'notification', 'skills/changed'),
        event(3, 'notification', 'skills/changed'),
      ],
      10,
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toBe('completed work');
  });
});

function event(
  cursor: number,
  type: 'assistant_message' | 'notification',
  summary: string,
) {
  return {
    cursor,
    timestampMs: 1000,
    issueId: 'issue-1',
    identifier: 'ANM-1',
    repoKey: null,
    workspacePath: null,
    threadId: null,
    turnId: null,
    type,
    level: 'info',
    summary,
    payload: null,
  } as const;
}

function snapshot(): OrchestratorSnapshot {
  return {
    startedAtMs: 1000,
    workflowPath: '/tmp/WORKFLOW.md',
    running: [],
    claimed: [],
    retryAttempts: [],
    handoff: [],
    handoffDetails: [],
    completed: [],
    completedDetails: [],
    codexTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      runtimeMs: 0,
    },
    codexRateLimit: {
      resumeAfterMs: null,
      reason: null,
      updatedAtMs: null,
    },
    lastTickAtMs: null,
    lastConfigError: null,
    paused: false,
    pausedAtMs: null,
  };
}

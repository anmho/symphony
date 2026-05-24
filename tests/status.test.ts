import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import {
  fetchDaemonEvents,
  queueSteer,
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
  });
});

function snapshot(): OrchestratorSnapshot {
  return {
    startedAtMs: 1000,
    workflowPath: '/tmp/WORKFLOW.md',
    running: [],
    claimed: [],
    retryAttempts: [],
    completed: [],
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

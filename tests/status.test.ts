import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import {
  fetchDaemonEvents,
  latestVisibleWorkEvents,
  queueSteer,
  requestChanges,
  resumeIssue,
  setDaemonAgentRuntime,
  setDaemonBackend,
  setDaemonMaxConcurrency,
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
    let maxConcurrencyOverride: number | null = null;
    let backendOverride: 'codex' | 'cursor' | null = null;
    let modelOverride: string | null = null;
    const runtimeBackendSnapshot = () => ({
      configured: 'codex' as const,
      effective: backendOverride ?? 'codex',
      source: backendOverride === null ? ('workflow' as const) : ('override' as const),
      overrideActive: backendOverride !== null,
      overrideBackend: backendOverride,
      overrideUpdatedAtMs: backendOverride === null ? null : 2000,
      configuredModel: null,
      effectiveModel: modelOverride,
      modelSource: modelOverride === null ? ('workflow' as const) : ('override' as const),
      modelOverrideActive: modelOverride !== null,
      modelOverride,
      modelOverrideUpdatedAtMs: modelOverride === null ? null : 2000,
    });
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
      setMaxConcurrencyOverride: (maxConcurrentAgents) => {
        maxConcurrencyOverride = maxConcurrentAgents;
        return {
          running: 0,
          configuredMax: 5,
          effectiveMax: maxConcurrentAgents ?? 5,
          source: maxConcurrentAgents === null ? 'workflow' : 'override',
          overrideActive: maxConcurrentAgents !== null,
          overrideMax: maxConcurrentAgents,
          overrideUpdatedAtMs: maxConcurrentAgents === null ? null : 2000,
        };
      },
      setBackendOverride: (backend) => {
        backendOverride = backend;
        if (backend === null) {
          modelOverride = null;
        }
        return runtimeBackendSnapshot();
      },
      setAgentRuntimeOverride: (patch) => {
        if ('backend' in patch) {
          backendOverride = patch.backend ?? null;
          if (backendOverride === null) {
            modelOverride = null;
          }
        }
        if ('model' in patch) {
          modelOverride =
            patch.model === null || patch.model === undefined
              ? null
              : patch.model;
        }
        return runtimeBackendSnapshot();
      },
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
    await expect(setDaemonMaxConcurrency(port, 2)).resolves.toMatchObject({
      concurrency: {
        effectiveMax: 2,
        source: 'override',
        overrideActive: true,
      },
    });
    expect(maxConcurrencyOverride).toBe(2);
    await expect(setDaemonMaxConcurrency(port, null)).resolves.toMatchObject({
      concurrency: {
        effectiveMax: 5,
        source: 'workflow',
        overrideActive: false,
      },
    });
    await expect(setDaemonBackend(port, 'cursor')).resolves.toMatchObject({
      backend: {
        effective: 'cursor',
        source: 'override',
        overrideActive: true,
      },
    });
    expect(backendOverride).toBe('cursor');
    await expect(setDaemonBackend(port, null)).resolves.toMatchObject({
      backend: {
        effective: 'codex',
        source: 'workflow',
        overrideActive: false,
      },
    });
    await expect(
      setDaemonAgentRuntime(port, { model: 'composer-2.5' }),
    ).resolves.toMatchObject({
      backend: {
        effectiveModel: 'composer-2.5',
        modelOverrideActive: true,
      },
    });
    expect(modelOverride).toBe('composer-2.5');
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
    concurrency: {
      running: 0,
      configuredMax: 5,
      effectiveMax: 5,
      source: 'workflow',
      overrideActive: false,
      overrideMax: null,
      overrideUpdatedAtMs: null,
    },
    backend: {
      configured: 'codex',
      effective: 'codex',
      source: 'workflow',
      overrideActive: false,
      overrideBackend: null,
      overrideUpdatedAtMs: null,
      configuredModel: null,
      effectiveModel: null,
      modelSource: 'workflow',
      modelOverrideActive: false,
      modelOverride: null,
      modelOverrideUpdatedAtMs: null,
    },
    lastTickAtMs: null,
    lastConfigError: null,
    paused: false,
    pausedAtMs: null,
  };
}

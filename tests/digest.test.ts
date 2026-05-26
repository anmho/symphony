import { describe, expect, it } from 'vitest';
import { buildDigestEmail } from '../src/digest.js';
import type { AgentWorkEvent, IssueSummary, LiveSession } from '../src/types.js';

describe('digest construction', () => {
  it('builds a deterministic compact summary with grouped action sections', () => {
    const email = buildDigestEmail({
      running: [
        session('ANM-1', 'daemon work', 'checking failed CI'),
      ],
      needsReview: [
        issue('ANM-2', 'review PR', 'https://github.com/anmho/symphony/pull/2'),
        issue('ANM-3', 'review second PR', 'https://github.com/anmho/symphony/pull/3'),
      ],
      needsRework: [issue('ANM-4', 'requested changes')],
      blockedOrRetry: [
        {
          issueId: 'issue-5',
          identifier: 'ANM-5',
          title: 'retry build',
          attempt: 2,
          dueAtMs: 2000,
          error: 'failed checks',
        },
      ],
      completed: [issue('ANM-6', 'completed work')],
      events: [event(7, 'ANM-5', 'failed checks on PR')],
      generatedAtMs: 5000,
      windowMs: 5000,
    });

    expect(email?.subject).toBe(
      'Symphony digest: 2 PRs need review, 1 agent running, 1 requested-changes item needs rework, 1 blocked/retry item, 1 completed item',
    );
    expect(email?.text).toContain('Summary: 2 PRs need review');
    expect(email?.text).toContain('Running');
    expect(email?.text).toContain('- ANM-1 [symphony] - daemon work - checking failed CI');
    expect(email?.text).toContain('Needs Review');
    expect(email?.text).toContain('Needs Rework / Requested Changes');
    expect(email?.text).toContain('Blocked / Retry');
    expect(email?.text).toContain('Completed');
    expect(email?.text).toContain('Recent Signals');
    expect(email?.lastProcessedCursor).toBe(7);
  });

  it('returns a checkpoint-only digest for non-actionable events', () => {
    const email = buildDigestEmail({
      running: [],
      needsReview: [],
      needsRework: [],
      blockedOrRetry: [],
      completed: [],
      events: [event(10, 'ANM-1', 'skills/changed')],
      generatedAtMs: 5000,
      windowMs: 5000,
    });

    expect(email).toEqual({
      subject: '',
      text: '',
      lastProcessedCursor: 10,
    });
  });
});

function issue(
  identifier: string,
  title: string,
  prUrl: string | null = null,
): IssueSummary {
  return {
    identifier,
    title,
    repoKey: 'symphony',
    state: 'In Review',
    reviewKind: prUrl ? 'pr_review' : 'completed',
    prUrl,
  };
}

function session(
  identifier: string,
  title: string,
  currentWork: string,
): LiveSession {
  return {
    issueId: identifier,
    identifier,
    title,
    repoKey: 'symphony',
    workspacePath: `/tmp/${identifier}`,
    eventLogPath: null,
    latestEventCursor: null,
    queuedSteerCount: 0,
    threadId: null,
    turnId: null,
    codexAppServerPid: null,
    lastCodexEvent: null,
    lastCodexTimestamp: null,
    lastCodexMessage: null,
    currentWork,
    currentWorkKind: 'command',
    currentWorkUpdatedAtMs: 1000,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    goalStatus: null,
    goalObjective: null,
    goalUpdatedAtMs: null,
    turnCount: 1,
    startedAtMs: 1000,
  };
}

function event(
  cursor: number,
  identifier: string,
  summary: string,
): AgentWorkEvent {
  return {
    cursor,
    timestampMs: 4000,
    issueId: identifier,
    identifier,
    repoKey: 'symphony',
    workspacePath: null,
    threadId: null,
    turnId: null,
    type: 'runner',
    level: 'info',
    summary,
    payload: null,
  };
}

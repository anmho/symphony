import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  AgentWorkEvent,
  DigestConfig,
  IssueSummary,
  LiveSession,
  RunAttempt,
} from './types.js';

export interface DigestState {
  lastSentAtMs: number | null;
  lastProcessedCursor: number;
}

export interface DigestStateStore {
  read(): DigestState;
  write(state: DigestState): void;
}

export interface DigestEmail {
  subject: string;
  text: string;
  lastProcessedCursor: number;
}

export interface DigestFacts {
  running: LiveSession[];
  needsReview: IssueSummary[];
  needsRework: IssueSummary[];
  blockedOrRetry: RunAttempt[];
  completed: IssueSummary[];
  events: AgentWorkEvent[];
  generatedAtMs: number;
  windowMs: number;
}

const DEFAULT_STATE: DigestState = {
  lastSentAtMs: null,
  lastProcessedCursor: 0,
};

export class FileDigestStateStore implements DigestStateStore {
  private readonly statePath: string;

  constructor(workflowPath: string) {
    this.statePath = path.join(
      path.dirname(path.resolve(workflowPath)),
      '.symphony',
      'state',
      'digest.json',
    );
  }

  read(): DigestState {
    if (!existsSync(this.statePath)) {
      return { ...DEFAULT_STATE };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as {
        lastSentAtMs?: unknown;
        lastProcessedCursor?: unknown;
      };
      return {
        lastSentAtMs:
          typeof parsed.lastSentAtMs === 'number' &&
          Number.isFinite(parsed.lastSentAtMs)
            ? parsed.lastSentAtMs
            : null,
        lastProcessedCursor:
          typeof parsed.lastProcessedCursor === 'number' &&
          Number.isInteger(parsed.lastProcessedCursor) &&
          parsed.lastProcessedCursor >= 0
            ? parsed.lastProcessedCursor
            : 0,
      };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  write(state: DigestState): void {
    mkdirSync(path.dirname(this.statePath), { recursive: true });
    writeFileSync(
      this.statePath,
      `${JSON.stringify(
        {
          lastSentAtMs: state.lastSentAtMs,
          lastProcessedCursor: state.lastProcessedCursor,
        },
        null,
        2,
      )}\n`,
    );
  }
}

export function buildDigestEmail(facts: DigestFacts): DigestEmail | null {
  const events = facts.events
    .filter((event) => event.timestampMs >= facts.generatedAtMs - facts.windowMs)
    .sort((left, right) => left.cursor - right.cursor);
  const actionableEvents = events.filter(isActionableEvent).slice(-10);
  const maxCursor = facts.events.reduce(
    (cursor, event) => Math.max(cursor, event.cursor),
    0,
  );
  const completed = facts.completed.slice(0, 8);
  const hasContent =
    facts.running.length > 0 ||
    facts.needsReview.length > 0 ||
    facts.needsRework.length > 0 ||
    facts.blockedOrRetry.length > 0 ||
    completed.length > 0 ||
    actionableEvents.length > 0;

  if (!hasContent) {
    return maxCursor > 0
      ? {
          subject: '',
          text: '',
          lastProcessedCursor: maxCursor,
        }
      : null;
  }

  const summary = summaryLine({
    running: facts.running.length,
    needsReview: facts.needsReview.length,
    needsRework: facts.needsRework.length,
    blockedOrRetry: facts.blockedOrRetry.length,
    completed: completed.length,
  });
  const lines = [
    'Symphony digest',
    '',
    `Summary: ${summary}`,
    `Window: ${formatTime(facts.generatedAtMs - facts.windowMs)} - ${formatTime(facts.generatedAtMs)}`,
  ];

  appendSection(
    lines,
    'Running',
    facts.running.map(
      (session) =>
        `${issueLabel(session.identifier, session.title, session.repoKey)}${
          session.currentWork ? ` - ${session.currentWork}` : ''
        }`,
    ),
  );
  appendSection(
    lines,
    'Needs Review',
    facts.needsReview.map(
      (issue) =>
        `${issueLabel(issue.identifier, issue.title, issue.repoKey)}${
          issue.prUrl ? ` - ${issue.prUrl}` : ''
        }`,
    ),
  );
  appendSection(
    lines,
    'Needs Rework / Requested Changes',
    facts.needsRework.map((issue) =>
      issueLabel(issue.identifier, issue.title, issue.repoKey),
    ),
  );
  appendSection(
    lines,
    'Blocked / Retry',
    facts.blockedOrRetry.map((attempt) => {
      const due = formatTime(attempt.dueAtMs);
      const error = attempt.error ? ` - ${attempt.error}` : '';
      return `${attempt.identifier}${
        attempt.title ? ` - ${attempt.title}` : ''
      } (attempt ${attempt.attempt}, due ${due})${error}`;
    }),
  );
  appendSection(
    lines,
    'Completed',
    completed.map(
      (issue) =>
        `${issueLabel(issue.identifier, issue.title, issue.repoKey)}${
          issue.prUrl ? ` - ${issue.prUrl}` : ''
        }`,
    ),
  );
  appendSection(
    lines,
    'Recent Signals',
    actionableEvents.map(
      (event) => `${event.identifier}: ${event.summary} (#${event.cursor})`,
    ),
  );

  return {
    subject: `Symphony digest: ${summary}`,
    text: lines.join('\n').trimEnd(),
    lastProcessedCursor: maxCursor,
  };
}

export async function sendDigestEmail(
  config: DigestConfig,
  email: DigestEmail,
): Promise<void> {
  if (!config.resendApiKey) {
    throw new Error('missing_resend_api_key');
  }
  const response = await fetch(config.resendEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.sender,
      to: config.recipient,
      subject: email.subject,
      text: email.text,
    }),
  });
  if (!response.ok) {
    throw new Error(`resend_http_error: ${response.status}`);
  }
}

function appendSection(lines: string[], title: string, items: string[]): void {
  if (items.length === 0) {
    return;
  }
  lines.push('', title);
  for (const item of items) {
    lines.push(`- ${compact(item)}`);
  }
}

function summaryLine(counts: {
  running: number;
  needsReview: number;
  needsRework: number;
  blockedOrRetry: number;
  completed: number;
}): string {
  const parts = [
    countPhrase(counts.needsReview, 'PR needs review', 'PRs need review'),
    countPhrase(counts.running, 'agent running', 'agents running'),
    countPhrase(
      counts.needsRework,
      'requested-changes item needs rework',
      'requested-changes items need rework',
    ),
    countPhrase(
      counts.blockedOrRetry,
      'blocked/retry item',
      'blocked/retry items',
    ),
    countPhrase(counts.completed, 'completed item', 'completed items'),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'no active Symphony work';
}

function countPhrase(
  count: number,
  singular: string,
  plural: string,
): string | null {
  if (count === 0) {
    return null;
  }
  return `${count} ${count === 1 ? singular : plural}`;
}

function issueLabel(
  identifier: string,
  title: string | null,
  repoKey: string | null,
): string {
  return `${identifier}${repoKey ? ` [${repoKey}]` : ''}${
    title ? ` - ${title}` : ''
  }`;
}

function isActionableEvent(event: AgentWorkEvent): boolean {
  if (event.level === 'error') {
    return true;
  }
  return /block|fail|error|rate limit|request|review|complete|handoff|retry|pr/i.test(
    event.summary,
  );
}

function formatTime(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500);
}

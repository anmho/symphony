import http, { type Server } from 'node:http';
import type { AgentWorkEvent, OrchestratorSnapshot } from './types.js';
import { compactAgentWorkEvents } from './eventDisplay.js';

export const DEFAULT_STATUS_PORT = 3979;

export interface StatusServerControls {
  resumeRateLimitedRuns?: () =>
    | Promise<{ resumed: number }>
    | { resumed: number };
  pauseDispatch?: () => { paused: boolean };
  resumeDispatch?: () => { paused: boolean };
  getEvents?: (query: {
    issue: string | null;
    cursor: number | null;
    limit: number | null;
    visible: boolean;
  }) => AgentWorkEvent[];
  queueSteer?: (
    issue: string,
    text: string,
  ) => { queued: boolean; issue: string };
  resumeIssue?: (issue: string) => { resumed: boolean; issue: string };
  requestChanges?: (
    issue: string,
    feedback: string,
  ) => Promise<{ issue: string; state: string }> | { issue: string; state: string };
}

export function startStatusServer(
  getSnapshot: () => OrchestratorSnapshot,
  port = DEFAULT_STATUS_PORT,
  controls: StatusServerControls = {},
): Promise<Server> {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/status' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(getSnapshot(), null, 2));
      return;
    }

    if (
      url.pathname === '/events' &&
      request.method === 'GET' &&
      controls.getEvents
    ) {
      const events = controls.getEvents({
        issue: url.searchParams.get('issue'),
        cursor: parseNullableNumber(url.searchParams.get('cursor')),
        limit: parseNullableNumber(url.searchParams.get('limit')),
        visible: isTruthyQueryParam(url.searchParams.get('visible')),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ events }, null, 2));
      return;
    }

    if (
      url.pathname === '/control/steer' &&
      request.method === 'POST' &&
      controls.queueSteer
    ) {
      const body = await readJsonBody(request);
      const issue = typeof body.issue === 'string' ? body.issue : '';
      const text = typeof body.text === 'string' ? body.text : '';
      if (!issue || !text.trim()) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'issue_and_text_required' }));
        return;
      }
      const result = controls.queueSteer(issue, text);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ ...result, snapshot: getSnapshot() }, null, 2),
      );
      return;
    }

    if (
      url.pathname === '/control/resume-issue' &&
      request.method === 'POST' &&
      controls.resumeIssue
    ) {
      const body = await readJsonBody(request);
      const issue = typeof body.issue === 'string' ? body.issue : '';
      if (!issue) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'issue_required' }));
        return;
      }
      const result = controls.resumeIssue(issue);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ ...result, snapshot: getSnapshot() }, null, 2),
      );
      return;
    }

    if (
      url.pathname === '/control/request-changes' &&
      request.method === 'POST' &&
      controls.requestChanges
    ) {
      const body = await readJsonBody(request);
      const issue = typeof body.issue === 'string' ? body.issue : '';
      const feedback = typeof body.feedback === 'string' ? body.feedback : '';
      if (!issue || !feedback.trim()) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'issue_and_feedback_required' }));
        return;
      }
      const result = await controls.requestChanges(issue, feedback);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ ...result, snapshot: getSnapshot() }, null, 2),
      );
      return;
    }

    if (
      url.pathname === '/control/resume-rate-limited' &&
      request.method === 'POST' &&
      controls.resumeRateLimitedRuns
    ) {
      const result = await controls.resumeRateLimitedRuns();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ ...result, snapshot: getSnapshot() }, null, 2),
      );
      return;
    }

    if (
      url.pathname === '/control/pause' &&
      request.method === 'POST' &&
      controls.pauseDispatch
    ) {
      const result = controls.pauseDispatch();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ ...result, snapshot: getSnapshot() }, null, 2),
      );
      return;
    }

    if (
      url.pathname === '/control/resume' &&
      request.method === 'POST' &&
      controls.resumeDispatch
    ) {
      const result = controls.resumeDispatch();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ ...result, snapshot: getSnapshot() }, null, 2),
      );
      return;
    }

    if (url.pathname.startsWith('/control/') && request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

export async function resumeRateLimitedRuns(
  port = DEFAULT_STATUS_PORT,
): Promise<{ resumed: number } | null> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/control/resume-rate-limited`,
      { method: 'POST' },
    );
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as { resumed: number };
  } catch {
    return null;
  }
}

export async function pauseOrchestrator(
  port = DEFAULT_STATUS_PORT,
): Promise<{ paused: boolean } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/control/pause`, {
      method: 'POST',
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as { paused: boolean };
  } catch {
    return null;
  }
}

export async function resumeOrchestrator(
  port = DEFAULT_STATUS_PORT,
): Promise<{ paused: boolean } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/control/resume`, {
      method: 'POST',
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as { paused: boolean };
  } catch {
    return null;
  }
}

export async function fetchDaemonEvents(
  port = DEFAULT_STATUS_PORT,
  query: {
    issue?: string | null;
    cursor?: number | null;
    limit?: number | null;
    visible?: boolean;
  } = {},
): Promise<AgentWorkEvent[] | null> {
  try {
    const url = new URL(`http://127.0.0.1:${port}/events`);
    if (query.issue) {
      url.searchParams.set('issue', query.issue);
    }
    if (query.cursor !== undefined && query.cursor !== null) {
      url.searchParams.set('cursor', String(query.cursor));
    }
    if (query.limit !== undefined && query.limit !== null) {
      url.searchParams.set('limit', String(query.limit));
    }
    if (query.visible) {
      url.searchParams.set('visible', '1');
    }
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { events?: AgentWorkEvent[] };
    return payload.events ?? [];
  } catch {
    return null;
  }
}

export function latestVisibleWorkEvents(
  events: AgentWorkEvent[],
  limit: number | null,
): AgentWorkEvent[] {
  const requested = limit && Number.isInteger(limit) && limit > 0 ? limit : 100;
  const visibleTarget = Math.min(requested, 1000);
  const visible: AgentWorkEvent[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) {
      continue;
    }
    if (compactAgentWorkEvents([event]).length === 0) {
      continue;
    }
    visible.push(event);
    if (visible.length >= visibleTarget) {
      break;
    }
  }
  return visible.reverse();
}

function isTruthyQueryParam(value: string | null): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

export async function queueSteer(
  port = DEFAULT_STATUS_PORT,
  issue: string,
  text: string,
): Promise<{ queued: boolean; issue: string } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/control/steer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ issue, text }),
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as { queued: boolean; issue: string };
  } catch {
    return null;
  }
}

export async function resumeIssue(
  port = DEFAULT_STATUS_PORT,
  issue: string,
): Promise<{ resumed: boolean; issue: string } | null> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/control/resume-issue`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issue }),
      },
    );
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as { resumed: boolean; issue: string };
  } catch {
    return null;
  }
}

export async function requestChanges(
  port = DEFAULT_STATUS_PORT,
  issue: string,
  feedback: string,
): Promise<{ issue: string; state: string } | null> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/control/request-changes`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issue, feedback }),
      },
    );
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as { issue: string; state: string };
  } catch {
    return null;
  }
}

export async function fetchDaemonStatus(
  port = DEFAULT_STATUS_PORT,
): Promise<OrchestratorSnapshot | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`);
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as OrchestratorSnapshot;
  } catch {
    return null;
  }
}

function parseNullableNumber(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readJsonBody(
  request: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

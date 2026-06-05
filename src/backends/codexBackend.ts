import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentBackend, AgentRunOptions } from '../agentBackend.js';
import { rateLimitUntilFromSnapshot } from '../rateLimit.js';
import type { AgentRunEvent, AgentRunInput, AgentTurnResult } from '../types.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: '2.0';
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc?: '2.0';
  method: string;
  params?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

const MAX_FULL_JSON_NOTIFICATION_BYTES = 256 * 1024;
const CRITICAL_NOTIFICATION_METHODS = new Set([
  'account/rateLimits/updated',
  'error',
  'turn/completed',
]);

export async function runAgentTurn(
  input: AgentRunInput,
  options: AgentRunOptions = {},
): Promise<AgentTurnResult> {
  const client = await CodexJsonRpcClient.start(
    input.config.codex.command,
    input.workspacePath,
    input.env,
    options,
  );
  try {
    await client.initialize();
    const threadId = input.threadId
      ? await client.resumeThread(input.threadId, input)
      : await client.startThread(input);

    await client.setGoal(threadId, input);
    const turn = await client.startTurn(threadId, input);
    const completion = await client.waitForTurnCompletion(
      threadId,
      turn.turnId,
      input.config.codex.turnTimeoutMs,
      input.config.codex.stallTimeoutMs,
    );

    return {
      status: completion.status,
      threadId,
      turnId: turn.turnId,
      rateLimitUntilMs: completion.rateLimitUntilMs,
      lastMessage: completion.lastMessage,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      error: completion.error,
    };
  } finally {
    await client.close();
  }
}

export const codexBackend: AgentBackend = {
  kind: 'codex',
  runTurn: runAgentTurn,
};

class CodexJsonRpcClient {
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications: JsonRpcNotification[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private stderrTail = '';
  private closed = false;

  private readonly onEvent: ((event: AgentRunEvent) => void) | undefined;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    options: AgentRunOptions,
  ) {
    this.child = child;
    this.onEvent = options.onEvent;
    this.onEvent?.({ type: 'process_started', pid: child.pid ?? null });
    child.stdout.on('data', (chunk: Buffer) => this.handleData(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-4000);
      this.onEvent?.({ type: 'stderr', bytes: chunk.length });
    });
    child.stdin.on('error', (error: Error) => this.handleStdinError(error));
    options.signal?.addEventListener('abort', () => {
      void this.close();
    });
    child.on('close', () => {
      this.closed = true;
      for (const [id, pending] of this.pending) {
        this.pending.delete(id);
        const stderr = this.stderrTail.trim();
        pending.reject(
          new Error(
            `codex_app_server_closed: ${pending.method}${stderr ? `: ${stderr}` : ''}`,
          ),
        );
      }
    });
  }

  static async start(
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv | undefined,
    options: AgentRunOptions,
  ): Promise<CodexJsonRpcClient> {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd,
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    return new CodexJsonRpcClient(child, options);
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: 'symphony',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  }

  async startThread(input: AgentRunInput): Promise<string> {
    const result = (await this.request('thread/start', {
      cwd: input.workspacePath,
      approvalPolicy: input.config.codex.approvalPolicy,
      sandbox: input.config.codex.threadSandbox,
      model: input.config.codex.model,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      serviceName: 'symphony',
      threadSource: 'user',
    })) as { thread?: { id?: string } };

    const threadId = result.thread?.id;
    if (!threadId) {
      throw new Error('codex_thread_start_missing_thread_id');
    }
    this.onEvent?.({ type: 'thread_started', threadId });
    return threadId;
  }

  async resumeThread(threadId: string, input: AgentRunInput): Promise<string> {
    const result = (await this.request('thread/resume', {
      threadId,
      cwd: input.workspacePath,
      approvalPolicy: input.config.codex.approvalPolicy,
      sandbox: input.config.codex.threadSandbox,
      model: input.config.codex.model,
      excludeTurns: true,
      persistExtendedHistory: false,
    })) as { thread?: { id?: string } };

    const resumedThreadId = result.thread?.id ?? threadId;
    this.onEvent?.({ type: 'thread_resumed', threadId: resumedThreadId });
    return resumedThreadId;
  }

  async setGoal(threadId: string, input: AgentRunInput): Promise<void> {
    await this.request('thread/goal/set', {
      threadId,
      objective: goalObjectiveForIssue(input),
      status: 'active',
      tokenBudget: null,
    });
  }

  async startTurn(
    threadId: string,
    input: AgentRunInput,
  ): Promise<{ turnId: string | null }> {
    const result = (await this.request('turn/start', {
      threadId,
      cwd: input.workspacePath,
      input: [{ type: 'text', text: input.prompt, text_elements: [] }],
      approvalPolicy: input.config.codex.approvalPolicy,
      sandboxPolicy: input.config.codex.turnSandboxPolicy,
      model: input.config.codex.model,
    })) as { turn?: { id?: string; status?: string } };

    const turnId = result.turn?.id ?? null;
    this.onEvent?.({ type: 'turn_started', turnId });
    return { turnId };
  }

  async waitForTurnCompletion(
    threadId: string,
    turnId: string | null,
    turnTimeoutMs: number,
    readTimeoutMs: number,
  ): Promise<{
    status: 'completed' | 'failed' | 'rate_limited';
    rateLimitUntilMs: number | null;
    lastMessage: string | null;
    error: string | null;
  }> {
    const startedAt = Date.now();
    let lastActivityAt = startedAt;

    while (!this.closed) {
      const notification = this.notifications.shift();
      if (!notification) {
        const now = Date.now();
        if (readTimeoutMs > 0 && now - lastActivityAt > readTimeoutMs) {
          throw new Error('codex_read_timeout');
        }
        if (turnTimeoutMs > 0 && now - startedAt > turnTimeoutMs) {
          throw new Error('codex_turn_timeout');
        }
        await delay(250);
        continue;
      }
      lastActivityAt = Date.now();

      const rateLimitUntilMs = extractRateLimitUntil(notification);
      if (rateLimitUntilMs) {
        this.onEvent?.({
          type: 'rate_limited',
          resumeAfterMs: rateLimitUntilMs,
          reason: 'codex_rate_limited',
        });
        return {
          status: 'rate_limited',
          rateLimitUntilMs,
          lastMessage: null,
          error: 'codex_rate_limited',
        };
      }

      if (notification.method === 'turn/completed') {
        const params = notification.params as {
          threadId?: string;
          turn?: { id?: string; status?: string; error?: unknown };
        };
        if (params.threadId === threadId) {
          const status = params.turn?.status === 'failed' ? 'failed' : 'completed';
          const turnError = params.turn?.error
            ? JSON.stringify(params.turn.error)
            : null;
          const errorRateLimit =
            turnError && /usageLimitExceeded|rate[_ ]?limit/i.test(turnError);
          if (errorRateLimit) {
            this.onEvent?.({
              type: 'rate_limited',
              resumeAfterMs: null,
              reason: turnError,
            });
          }
          return {
            status: errorRateLimit ? 'rate_limited' : status,
            rateLimitUntilMs: null,
            lastMessage: null,
            error: turnError,
          };
        }
      }

      this.onEvent?.({
        type: 'notification',
        method: notification.method,
        params: notification.params,
      });

      if (turnTimeoutMs > 0 && Date.now() - startedAt > turnTimeoutMs) {
        throw new Error('codex_turn_timeout');
      }
    }

    throw new Error('codex_app_server_closed_before_turn_completed');
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.killProcessGroup('SIGTERM');
    await delay(250);
    if (!this.closed) {
      this.killProcessGroup('SIGKILL');
    }
  }

  private killProcessGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (!pid) {
      this.child.kill(signal);
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      this.child.kill(signal);
    }
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('codex_app_server_closed'));
    }

    const id = this.nextId++;
    const message: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
    this.safeWrite(`${JSON.stringify(message)}\n`);
    return promise;
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }

      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length === 0) {
        continue;
      }

      this.handleMessage(this.parseMessageLine(line));
    }
  }

  private parseMessageLine(
    line: string,
  ): JsonRpcResponse | JsonRpcNotification | JsonRpcRequest {
    const byteLength = Buffer.byteLength(line, 'utf8');
    if (byteLength > MAX_FULL_JSON_NOTIFICATION_BYTES) {
      const compact = compactLargeNotificationLine(line, byteLength);
      if (compact) {
        return compact;
      }
    }
    return JSON.parse(line) as JsonRpcResponse | JsonRpcNotification | JsonRpcRequest;
  }

  private handleMessage(
    message: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest,
  ): void {
    if ('id' in message && 'method' in message) {
      this.safeWrite(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32601,
            message: `unsupported server request: ${message.method}`,
          },
        })}\n`,
      );
      return;
    }

    if ('id' in message) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(`${pending.method}_failed: ${message.error.message ?? 'unknown'}`),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.onEvent?.({
      type: 'notification',
      method: message.method,
      params: message.params,
    });
    this.notifications.push(message);
  }

  private safeWrite(payload: string): boolean {
    if (this.closed || this.child.stdin.destroyed) {
      return false;
    }
    try {
      return this.child.stdin.write(payload);
    } catch (error) {
      this.handleStdinError(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  private handleStdinError(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(new Error(`codex_app_server_stdin_error: ${pending.method}: ${error.message}`));
    }
    this.killProcessGroup('SIGTERM');
  }
}

function compactLargeNotificationLine(
  line: string,
  byteLength: number,
): JsonRpcNotification | null {
  if (/"id"\s*:/.test(line)) {
    return null;
  }
  const method = jsonStringProperty(line, 'method');
  if (!method || CRITICAL_NOTIFICATION_METHODS.has(method)) {
    return null;
  }
  return {
    method,
    params: {
      truncated: true,
      bytes: byteLength,
    },
  };
}

function jsonStringProperty(line: string, property: string): string | null {
  const match = line.match(new RegExp(`"${property}"\\s*:\\s*"([^"]+)"`));
  return match?.[1] ?? null;
}

function extractRateLimitUntil(notification: JsonRpcNotification): number | null {
  if (notification.method === 'account/rateLimits/updated') {
    const params = notification.params as { rateLimits?: unknown };
    return rateLimitUntilFromSnapshot(
      params.rateLimits as Parameters<typeof rateLimitUntilFromSnapshot>[0],
    );
  }

  if (notification.method === 'error') {
    const message = JSON.stringify(notification.params ?? {});
    if (/usageLimitExceeded|rate[_ ]?limit/i.test(message)) {
      return null;
    }
  }

  return null;
}

export function goalObjectiveForIssue(
  input: Pick<AgentRunInput, 'issue'>,
): string {
  return `Complete Linear issue ${input.issue.identifier}: ${input.issue.title}. Satisfy the issue, commit, push, open or update a PR, and prepare a Linear handoff.`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

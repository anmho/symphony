import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentBackend, AgentRunOptions } from '../agentBackend.js';
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

export async function runAgentTurn(
  input: AgentRunInput,
  options: AgentRunOptions = {},
): Promise<AgentTurnResult> {
  const client = await CursorAcpJsonRpcClient.start(
    input.config.cursor.command,
    input.workspacePath,
    input.env,
    input.config.cursor.apiKey,
    options,
  );
  try {
    await client.initialize();
    const sessionId = input.threadId
      ? await client.resumeSession(input.threadId, input)
      : await client.startSession(input);

    if (input.config.cursor.model) {
      await client.setModel(sessionId, input.config.cursor.model);
    }

    const turnId = await client.runPrompt(sessionId, input);
    const completion = await client.waitForPromptResult(
      turnId,
      input.config.cursor.turnTimeoutMs,
      input.config.cursor.readTimeoutMs,
    );

    return {
      status: completion.status,
      threadId: sessionId,
      turnId,
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

export const cursorBackend: AgentBackend = {
  kind: 'cursor',
  runTurn: runAgentTurn,
};

class CursorAcpJsonRpcClient {
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications: JsonRpcNotification[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private stderrTail = '';
  private closed = false;
  private lastAssistantText = '';
  private promptCompleted = false;
  private promptError: string | null = null;
  private promptStopReason: string | null = null;
  private rateLimited = false;

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
            `cursor_acp_closed: ${pending.method}${stderr ? `: ${stderr}` : ''}`,
          ),
        );
      }
    });
  }

  static async start(
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv | undefined,
    apiKey: string | null,
    options: AgentRunOptions,
  ): Promise<CursorAcpJsonRpcClient> {
    const childEnv = { ...(env ?? process.env) };
    if (apiKey) {
      childEnv.CURSOR_API_KEY = apiKey;
    }
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new CursorAcpJsonRpcClient(child, options);
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: 'symphony',
        version: '0.1.0',
      },
    });
  }

  async startSession(input: AgentRunInput): Promise<string> {
    const result = (await this.request('session/new', {
      cwd: input.workspacePath,
      mcpServers: [],
    })) as { sessionId?: string };

    const sessionId = result.sessionId;
    if (!sessionId) {
      throw new Error('cursor_session_new_missing_session_id');
    }
    this.onEvent?.({ type: 'thread_started', threadId: sessionId });
    return sessionId;
  }

  async resumeSession(sessionId: string, input: AgentRunInput): Promise<string> {
    await this.request('session/load', {
      sessionId,
      cwd: input.workspacePath,
      mcpServers: [],
    });
    this.onEvent?.({ type: 'thread_resumed', threadId: sessionId });
    return sessionId;
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const modelId = resolveCursorModelId(model);
    if (!modelId) {
      return;
    }
    await this.request('session/set_config_option', {
      sessionId,
      configId: 'model',
      value: modelId,
    });
  }

  async runPrompt(sessionId: string, input: AgentRunInput): Promise<string> {
    const turnId = `${sessionId}:${this.nextId}`;
    this.promptCompleted = false;
    this.promptError = null;
    this.promptStopReason = null;
    this.rateLimited = false;
    this.lastAssistantText = '';

    this.onEvent?.({ type: 'turn_started', turnId });

    void this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: input.prompt }],
    })
      .then((result) => {
        const payload = result as { stopReason?: string };
        this.promptStopReason = payload.stopReason ?? null;
        this.promptCompleted = true;
      })
      .catch((error: unknown) => {
        this.promptError =
          error instanceof Error ? error.message : String(error);
        this.promptCompleted = true;
      });

    return turnId;
  }

  async waitForPromptResult(
    turnId: string,
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
      if (this.promptCompleted) {
        if (this.rateLimited) {
          return {
            status: 'rate_limited',
            rateLimitUntilMs: null,
            lastMessage: this.lastAssistantText || null,
            error: this.promptError ?? 'cursor_rate_limited',
          };
        }
        if (this.promptError) {
          return {
            status: 'failed',
            rateLimitUntilMs: null,
            lastMessage: this.lastAssistantText || null,
            error: this.promptError,
          };
        }
        const failed = this.promptStopReason === 'error';
        return {
          status: failed ? 'failed' : 'completed',
          rateLimitUntilMs: null,
          lastMessage: this.lastAssistantText || null,
          error: failed ? this.promptStopReason : null,
        };
      }

      const notification = this.notifications.shift();
      if (notification) {
        lastActivityAt = Date.now();
        if (extractRateLimited(notification)) {
          this.rateLimited = true;
          this.onEvent?.({
            type: 'rate_limited',
            resumeAfterMs: null,
            reason: 'cursor_rate_limited',
          });
        }
        this.onEvent?.({
          type: 'notification',
          method: notification.method,
          params: notification.params,
        });
        appendAssistantChunk(notification, (chunk) => {
          this.lastAssistantText = `${this.lastAssistantText}${chunk}`.slice(-4000);
        });
        continue;
      }

      const now = Date.now();
      if (readTimeoutMs > 0 && now - lastActivityAt > readTimeoutMs) {
        throw new Error('cursor_read_timeout');
      }
      if (turnTimeoutMs > 0 && now - startedAt > turnTimeoutMs) {
        throw new Error('cursor_turn_timeout');
      }
      await delay(250);
    }

    throw new Error(
      `cursor_acp_closed_before_prompt_completed: ${turnId}`,
    );
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.child.kill('SIGTERM');
    await delay(250);
    if (!this.closed) {
      this.child.kill('SIGKILL');
    }
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('cursor_acp_closed'));
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
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
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

      this.handleMessage(
        JSON.parse(line) as JsonRpcResponse | JsonRpcNotification | JsonRpcRequest,
      );
    }
  }

  private handleMessage(
    message: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest,
  ): void {
    if ('id' in message && 'method' in message) {
      if (message.method === 'session/request_permission') {
        this.child.stdin.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              outcome: {
                outcome: 'selected',
                optionId: 'allow',
              },
            },
          })}\n`,
        );
        return;
      }

      this.child.stdin.write(
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

    this.notifications.push(message);
  }
}

export function resolveCursorModelId(model: string): string {
  if (model.includes('[')) {
    return model;
  }
  if (model === 'composer-latest' || model === 'default') {
    return 'default[]';
  }
  if (/^composer-/i.test(model)) {
    return `${model}[fast=true]`;
  }
  return model;
}

function extractRateLimited(notification: JsonRpcNotification): boolean {
  const payload = JSON.stringify(notification.params ?? {});
  return /usageLimitExceeded|rate[_ ]?limit/i.test(payload);
}

function appendAssistantChunk(
  notification: JsonRpcNotification,
  onText: (text: string) => void,
): void {
  if (notification.method !== 'session/update') {
    return;
  }
  const params = notification.params as {
    update?: {
      sessionUpdate?: string;
      content?: { type?: string; text?: string };
    };
  };
  if (
    params.update?.sessionUpdate === 'agent_message_chunk' &&
    params.update.content?.type === 'text' &&
    typeof params.update.content.text === 'string'
  ) {
    onText(params.update.content.text);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

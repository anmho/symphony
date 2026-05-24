import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rateLimitUntilFromSnapshot } from "./rateLimit.js";
import type { CodexRunEvent, CodexRunInput, CodexTurnResult } from "./types.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

export interface CodexRunOptions {
  signal?: AbortSignal;
  onEvent?: (event: CodexRunEvent) => void;
}

export async function runCodexTurn(input: CodexRunInput, options: CodexRunOptions = {}): Promise<CodexTurnResult> {
  const client = await CodexJsonRpcClient.start(input.config.codex.command, input.workspacePath, options);
  try {
    await client.initialize();
    const threadId = input.threadId
      ? await client.resumeThread(input.threadId, input)
      : await client.startThread(input);

    await client.setGoal(threadId, input);
    const turn = await client.startTurn(threadId, input);
    const completion = await client.waitForTurnCompletion(threadId, turn.turnId);

    return {
      status: completion.status,
      threadId,
      turnId: turn.turnId,
      rateLimitUntilMs: completion.rateLimitUntilMs,
      lastMessage: completion.lastMessage,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      error: completion.error
    };
  } finally {
    await client.close();
  }
}

class CodexJsonRpcClient {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications: JsonRpcNotification[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private closed = false;

  private readonly onEvent: ((event: CodexRunEvent) => void) | undefined;

  private constructor(child: ChildProcessWithoutNullStreams, options: CodexRunOptions) {
    this.child = child;
    this.onEvent = options.onEvent;
    this.onEvent?.({ type: "process_started", pid: child.pid ?? null });
    child.stdout.on("data", (chunk: Buffer) => this.handleData(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.onEvent?.({ type: "stderr", bytes: chunk.length });
    });
    options.signal?.addEventListener("abort", () => {
      void this.close();
    });
    child.on("close", () => {
      this.closed = true;
      for (const [id, pending] of this.pending) {
        this.pending.delete(id);
        pending.reject(new Error(`codex_app_server_closed: ${pending.method}`));
      }
    });
  }

  static async start(command: string, cwd: string, options: CodexRunOptions): Promise<CodexJsonRpcClient> {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    return new CodexJsonRpcClient(child, options);
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "symphony",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
  }

  async startThread(input: CodexRunInput): Promise<string> {
    const result = (await this.request("thread/start", {
      cwd: input.workspacePath,
      approvalPolicy: input.config.codex.approvalPolicy,
      sandbox: input.config.codex.threadSandbox,
      model: input.config.codex.model,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      serviceName: "symphony",
      threadSource: "user"
    })) as { thread?: { id?: string } };

    const threadId = result.thread?.id;
    if (!threadId) {
      throw new Error("codex_thread_start_missing_thread_id");
    }
    this.onEvent?.({ type: "thread_started", threadId });
    return threadId;
  }

  async resumeThread(threadId: string, input: CodexRunInput): Promise<string> {
    const result = (await this.request("thread/resume", {
      threadId,
      cwd: input.workspacePath,
      approvalPolicy: input.config.codex.approvalPolicy,
      sandbox: input.config.codex.threadSandbox,
      model: input.config.codex.model,
      excludeTurns: true,
      persistExtendedHistory: false
    })) as { thread?: { id?: string } };

    const resumedThreadId = result.thread?.id ?? threadId;
    this.onEvent?.({ type: "thread_resumed", threadId: resumedThreadId });
    return resumedThreadId;
  }

  async setGoal(threadId: string, input: CodexRunInput): Promise<void> {
    await this.request("thread/goal/set", {
      threadId,
      objective: goalObjectiveForIssue(input),
      status: "active",
      tokenBudget: null
    });
  }

  async startTurn(threadId: string, input: CodexRunInput): Promise<{ turnId: string | null }> {
    const result = (await this.request("turn/start", {
      threadId,
      cwd: input.workspacePath,
      input: [{ type: "text", text: input.prompt, text_elements: [] }],
      approvalPolicy: input.config.codex.approvalPolicy,
      sandboxPolicy: input.config.codex.turnSandboxPolicy,
      model: input.config.codex.model
    })) as { turn?: { id?: string; status?: string } };

    const turnId = result.turn?.id ?? null;
    this.onEvent?.({ type: "turn_started", turnId });
    return { turnId };
  }

  async waitForTurnCompletion(
    threadId: string,
    turnId: string | null
  ): Promise<{
    status: "completed" | "failed" | "rate_limited";
    rateLimitUntilMs: number | null;
    lastMessage: string | null;
    error: string | null;
  }> {
    const startedAt = Date.now();

    while (!this.closed) {
      const notification = this.notifications.shift();
      if (!notification) {
        await delay(250);
        continue;
      }

      const rateLimitUntilMs = extractRateLimitUntil(notification);
      if (rateLimitUntilMs) {
        this.onEvent?.({ type: "rate_limited", resumeAfterMs: rateLimitUntilMs, reason: "codex_rate_limited" });
        return {
          status: "rate_limited",
          rateLimitUntilMs,
          lastMessage: null,
          error: "codex_rate_limited"
        };
      }

      if (notification.method === "turn/completed") {
        const params = notification.params as { threadId?: string; turn?: { id?: string; status?: string; error?: unknown } };
        if (params.threadId === threadId) {
          const status = params.turn?.status === "failed" ? "failed" : "completed";
          const turnError = params.turn?.error ? JSON.stringify(params.turn.error) : null;
          const errorRateLimit = turnError && /usageLimitExceeded|rate[_ ]?limit/i.test(turnError);
          if (errorRateLimit) {
            this.onEvent?.({ type: "rate_limited", resumeAfterMs: null, reason: turnError });
          }
          return {
            status: errorRateLimit ? "rate_limited" : status,
            rateLimitUntilMs: null,
            lastMessage: null,
            error: turnError
          };
        }
      }

      this.onEvent?.({ type: "notification", method: notification.method, params: notification.params });

      if (Date.now() - startedAt > 24 * 60 * 60 * 1000) {
        throw new Error("codex_turn_timeout");
      }
    }

    throw new Error("codex_app_server_closed_before_turn_completed");
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.child.kill("SIGTERM");
    await delay(250);
    if (!this.closed) {
      this.child.kill("SIGKILL");
    }
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("codex_app_server_closed"));
    }

    const id = this.nextId++;
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return promise;
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length === 0) {
        continue;
      }

      this.handleMessage(JSON.parse(line) as JsonRpcResponse | JsonRpcNotification | JsonRpcRequest);
    }
  }

  private handleMessage(message: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest): void {
    if ("id" in message && "method" in message) {
      this.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `unsupported server request: ${message.method}` }
        })}\n`
      );
      return;
    }

    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}_failed: ${message.error.message ?? "unknown"}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.onEvent?.({ type: "notification", method: message.method, params: message.params });
    this.notifications.push(message);
  }
}

function extractRateLimitUntil(notification: JsonRpcNotification): number | null {
  if (notification.method === "account/rateLimits/updated") {
    const params = notification.params as { rateLimits?: unknown };
    return rateLimitUntilFromSnapshot(params.rateLimits as Parameters<typeof rateLimitUntilFromSnapshot>[0]);
  }

  if (notification.method === "error") {
    const message = JSON.stringify(notification.params ?? {});
    if (/usageLimitExceeded|rate[_ ]?limit/i.test(message)) {
      return null;
    }
  }

  return null;
}

export function goalObjectiveForIssue(input: Pick<CodexRunInput, "issue">): string {
  return `Complete Linear issue ${input.issue.identifier}: ${input.issue.title}. Satisfy the issue, commit, push, open or update a PR, and prepare a Linear handoff.`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

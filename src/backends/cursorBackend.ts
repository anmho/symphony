import { Agent, RateLimitError, type Run, type SDKMessage } from '@cursor/sdk';
import type { AgentBackend, AgentRunOptions } from '../agentBackend.js';
import type { AgentRunInput, AgentTurnResult } from '../types.js';

export async function runAgentTurn(
  input: AgentRunInput,
  options: AgentRunOptions = {},
): Promise<AgentTurnResult> {
  // Local agents use the Cursor install's session (same as `agent login` / IDE auth).
  // Pass apiKey only when WORKFLOW.md sets cursor.api_key (CI or explicit override).
  const agentOptions = {
    ...(input.config.cursor.apiKey ? { apiKey: input.config.cursor.apiKey } : {}),
    model: { id: input.config.cursor.model },
    local: {
      cwd: input.workspacePath,
    },
  };

  const agent = input.threadId
    ? await Agent.resume(input.threadId, agentOptions)
    : await Agent.create(agentOptions);

  try {
    options.onEvent?.({ type: 'process_started', pid: null });
    if (input.threadId) {
      options.onEvent?.({ type: 'thread_resumed', threadId: agent.agentId });
    } else {
      options.onEvent?.({ type: 'thread_started', threadId: agent.agentId });
    }

    const run = await agent.send(input.prompt);
    options.onEvent?.({ type: 'turn_started', turnId: run.id });

    const streamDone = consumeRunStream(run, options).catch(() => undefined);
    const abortPromise = waitForAbort(options.signal, run);
    let runResult;
    try {
      runResult = await Promise.race([run.wait(), abortPromise]);
    } catch (error) {
      if (error instanceof RateLimitError) {
        options.onEvent?.({
          type: 'rate_limited',
          resumeAfterMs: null,
          reason: error.message,
        });
        return {
          status: 'rate_limited',
          threadId: agent.agentId,
          turnId: run.id,
          rateLimitUntilMs: null,
          lastMessage: null,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          error: error.message,
        };
      }
      throw error;
    } finally {
      await streamDone;
    }

    const lastMessage = extractLastAssistantText(runResult.result ?? null);
    const failed = runResult.status === 'error' || runResult.status === 'cancelled';
    return {
      status: failed ? 'failed' : 'completed',
      threadId: agent.agentId,
      turnId: run.id,
      rateLimitUntilMs: null,
      lastMessage,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      error: failed ? runResult.result ?? runResult.status : null,
    };
  } finally {
    agent.close();
  }
}

async function consumeRunStream(run: Run, options: AgentRunOptions): Promise<void> {
  for await (const message of run.stream()) {
    emitCursorMessage(options, message);
  }
}

function emitCursorMessage(options: AgentRunOptions, message: SDKMessage): void {
  options.onEvent?.({
    type: 'notification',
    method: `cursor/${message.type}`,
    params: message,
  });
}

async function waitForAbort(
  signal: AbortSignal | undefined,
  run: Run,
): Promise<never> {
  if (!signal) {
    return new Promise(() => undefined);
  }
  if (signal.aborted) {
    await cancelRun(run);
    throw new Error('cursor_run_aborted');
  }
  return new Promise((_, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      void cancelRun(run).finally(() => {
        reject(new Error('cursor_run_aborted'));
      });
    };
    signal.addEventListener('abort', onAbort);
  });
}

async function cancelRun(run: Run): Promise<void> {
  if (run.supports('cancel')) {
    await run.cancel();
  }
}

function extractLastAssistantText(result: string | null): string | null {
  if (!result?.trim()) {
    return null;
  }
  return result.trim().slice(0, 4000);
}

export const cursorBackend: AgentBackend = {
  kind: 'cursor',
  runTurn: runAgentTurn,
};

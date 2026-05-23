import { loadWorkflowConfig } from "./config";
import { fetchCandidateIssues, fetchIssueById, fetchTerminalIssues, writeRunnerComment } from "./linear";
import { logger as defaultLogger } from "./logger";
import {
  continuationPrompt,
  isActiveState,
  isIssueEligible,
  isTerminalState,
  millisUntil,
  nextFailureBackoffMs,
  sortIssuesForDispatch
} from "./policy";
import { renderIssuePrompt } from "./prompt";
import { isGateParked } from "./rateLimit";
import { runCodexTurn } from "./codexRpc";
import { runHook, type HookName } from "./hooks";
import { ensureWorkspace, removeWorkspace, workspaceInfoForIssue, workspacePathExists } from "./workspace";
import type {
  CodexRunEvent,
  CodexRunInput,
  CodexTurnResult,
  CodexUsageTotals,
  EffectiveWorkflowConfig,
  LiveSession,
  NormalizedIssue,
  OrchestratorSnapshot,
  RunAttempt,
  WorkspaceInfo
} from "./types";

export interface OrchestratorDependencies {
  loadWorkflowConfig: (workflowPath: string) => Promise<EffectiveWorkflowConfig>;
  fetchCandidateIssues: (config: EffectiveWorkflowConfig) => Promise<NormalizedIssue[]>;
  fetchIssueById: (config: EffectiveWorkflowConfig, issueId: string) => Promise<NormalizedIssue | null>;
  fetchTerminalIssues: (config: EffectiveWorkflowConfig) => Promise<NormalizedIssue[]>;
  writeRunnerComment: (config: EffectiveWorkflowConfig, issueId: string, body: string) => Promise<void>;
  prepareWorkspace: (config: EffectiveWorkflowConfig, issue: NormalizedIssue) => Promise<WorkspaceInfo>;
  removeWorkspace: (config: EffectiveWorkflowConfig, workspace: WorkspaceInfo) => Promise<void>;
  workspaceInfoForIssue: (config: EffectiveWorkflowConfig, issue: NormalizedIssue) => WorkspaceInfo;
  workspacePathExists: (workspacePath: string) => Promise<boolean>;
  runHook: (
    config: EffectiveWorkflowConfig,
    hookName: HookName,
    issue: NormalizedIssue,
    workspace: WorkspaceInfo
  ) => Promise<void>;
  renderIssuePrompt: (
    config: EffectiveWorkflowConfig,
    issue: NormalizedIssue,
    attempt: number | null
  ) => Promise<string>;
  runCodexTurn: (input: CodexRunInput, options: { signal: AbortSignal; onEvent: (event: CodexRunEvent) => void }) => Promise<CodexTurnResult>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  logger: Pick<typeof defaultLogger, "info" | "warn" | "error" | "debug">;
}

export interface OrchestratorOptions {
  workflowPath: string;
  pollOnce?: boolean;
}

interface RunningEntry {
  issue: NormalizedIssue;
  session: LiveSession;
  abortController: AbortController;
  promise: Promise<void>;
  cancelReason: string | null;
}

export class Orchestrator {
  private readonly deps: OrchestratorDependencies;
  private readonly workflowPath: string;
  private readonly startedAtMs: number;
  private lastKnownGoodConfig: EffectiveWorkflowConfig | null = null;
  private lastTickAtMs: number | null = null;
  private lastConfigError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private startupCleanupDone = false;
  private tickInFlight: Promise<void> | null = null;

  private readonly running = new Map<string, RunningEntry>();
  private readonly claimed = new Set<string>();
  private readonly retryAttempts = new Map<string, RunAttempt>();
  private readonly completed = new Set<string>();
  private readonly codexTotals: CodexUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    runtimeMs: 0
  };
  private codexRateLimit = {
    resumeAfterMs: null as number | null,
    reason: null as string | null,
    updatedAtMs: null as number | null
  };

  constructor(options: OrchestratorOptions, deps: Partial<OrchestratorDependencies> = {}) {
    this.workflowPath = options.workflowPath;
    this.startedAtMs = (deps.now ?? Date.now)();
    this.deps = {
      loadWorkflowConfig,
      fetchCandidateIssues,
      fetchIssueById,
      fetchTerminalIssues,
      writeRunnerComment,
      prepareWorkspace: ensureWorkspace,
      removeWorkspace,
      workspaceInfoForIssue,
      workspacePathExists,
      runHook,
      renderIssuePrompt,
      runCodexTurn,
      now: Date.now,
      sleep,
      logger: defaultLogger,
      ...deps
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    const config = await this.reloadConfig(true);
    await this.cleanupTerminalWorkspaces(config);
    await this.tick();
    this.scheduleNextTick(config.polling.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const entry of this.running.values()) {
      entry.cancelReason = "daemon_stopped";
      entry.abortController.abort();
    }
    await Promise.allSettled([...this.running.values()].map((entry) => entry.promise));
  }

  async tick(): Promise<void> {
    if (this.tickInFlight) {
      return this.tickInFlight;
    }

    this.tickInFlight = this.runTick().finally(() => {
      this.tickInFlight = null;
    });
    return this.tickInFlight;
  }

  snapshot(): OrchestratorSnapshot {
    return {
      startedAtMs: this.startedAtMs,
      workflowPath: this.workflowPath,
      running: [...this.running.values()].map((entry) => ({ ...entry.session })),
      claimed: [...this.claimed],
      retryAttempts: [...this.retryAttempts.values()].map((attempt) => ({ ...attempt })),
      completed: [...this.completed],
      codexTotals: { ...this.codexTotals },
      codexRateLimit: { ...this.codexRateLimit },
      lastTickAtMs: this.lastTickAtMs,
      lastConfigError: this.lastConfigError
    };
  }

  private async runTick(): Promise<void> {
    const config = await this.reloadConfig(false);
    this.lastTickAtMs = this.deps.now();

    if (!this.startupCleanupDone) {
      await this.cleanupTerminalWorkspaces(config);
    }

    await this.reconcileRunning(config);
    await this.dispatchDueRetries(config);

    if (isGateParked(this.codexRateLimit, this.deps.now())) {
      this.deps.logger.info({ codexRateLimit: this.codexRateLimit }, "codex launches paused by rate limit");
      return;
    }

    const candidates = sortIssuesForDispatch(await this.deps.fetchCandidateIssues(config)).filter((issue) =>
      isIssueEligible(issue, config)
    );

    for (const issue of candidates) {
      if (this.running.size >= config.agent.maxConcurrentAgents) {
        break;
      }
      if (this.claimed.has(issue.id)) {
        continue;
      }
      this.dispatchIssue(config, issue, 0);
    }
  }

  private async reloadConfig(requireValid: boolean): Promise<EffectiveWorkflowConfig> {
    try {
      const config = await this.deps.loadWorkflowConfig(this.workflowPath);
      this.lastKnownGoodConfig = config;
      this.lastConfigError = null;
      return config;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastConfigError = message;
      if (this.lastKnownGoodConfig && !requireValid) {
        this.deps.logger.error({ error: message }, "workflow reload failed; keeping last known good config");
        return this.lastKnownGoodConfig;
      }
      throw error;
    }
  }

  private async cleanupTerminalWorkspaces(config: EffectiveWorkflowConfig): Promise<void> {
    this.startupCleanupDone = true;
    const terminalIssues = await this.deps.fetchTerminalIssues(config);
    for (const issue of terminalIssues) {
      let workspace: WorkspaceInfo;
      try {
        workspace = this.deps.workspaceInfoForIssue(config, issue);
      } catch (error) {
        this.deps.logger.debug({ error, issue: issue.identifier }, "terminal issue has no configured workspace route");
        continue;
      }
      if (!(await this.deps.workspacePathExists(workspace.path))) {
        continue;
      }
      await this.runHookIgnoringFailure(config, "beforeRemove", issue, workspace);
      await this.deps.removeWorkspace(config, workspace);
      this.deps.logger.info({ issue: issue.identifier, workspace: workspace.path }, "removed terminal issue workspace");
    }
  }

  private async reconcileRunning(config: EffectiveWorkflowConfig): Promise<void> {
    for (const entry of this.running.values()) {
      const latestIssue = await this.deps.fetchIssueById(config, entry.issue.id).catch((error: unknown) => {
        this.deps.logger.warn({ error, issue: entry.issue.identifier }, "failed to reconcile running issue");
        return null;
      });

      if (!latestIssue || isTerminalState(latestIssue.state, config) || !isActiveState(latestIssue.state, config)) {
        entry.cancelReason = latestIssue ? `state_${latestIssue.state}` : "issue_not_found";
        entry.abortController.abort();
      }
    }
  }

  private async dispatchDueRetries(config: EffectiveWorkflowConfig): Promise<void> {
    const now = this.deps.now();
    const dueAttempts = [...this.retryAttempts.values()].filter((attempt) => attempt.dueAtMs <= now);
    for (const attempt of dueAttempts) {
      if (this.running.size >= config.agent.maxConcurrentAgents) {
        return;
      }
      if (this.running.has(attempt.issueId)) {
        continue;
      }

      const issue = await this.deps.fetchIssueById(config, attempt.issueId);
      if (!issue || !isIssueEligible(issue, config)) {
        this.retryAttempts.delete(attempt.issueId);
        this.claimed.delete(attempt.issueId);
        continue;
      }

      this.retryAttempts.delete(attempt.issueId);
      this.dispatchIssue(config, issue, attempt.attempt);
    }
  }

  private dispatchIssue(config: EffectiveWorkflowConfig, issue: NormalizedIssue, attempt: number): void {
    this.claimed.add(issue.id);
    const abortController = new AbortController();
    const session: LiveSession = {
      issueId: issue.id,
      identifier: issue.identifier,
      workspacePath: null,
      threadId: null,
      turnId: null,
      codexAppServerPid: null,
      lastCodexEvent: null,
      lastCodexTimestamp: null,
      lastCodexMessage: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      turnCount: 0,
      startedAtMs: this.deps.now()
    };

    const entry: RunningEntry = {
      issue,
      session,
      abortController,
      promise: Promise.resolve(),
      cancelReason: null
    };

    entry.promise = this.runIssue(config, issue, attempt, entry).catch(async (error: unknown) => {
      if (entry.cancelReason) {
        this.deps.logger.info({ issue: issue.identifier, reason: entry.cancelReason }, "issue run canceled");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.error({ issue: issue.identifier, error: message }, "issue run failed");
      this.scheduleRetry(config, issue, attempt + 1, message);
    }).finally(() => {
      this.codexTotals.runtimeMs += Math.max(this.deps.now() - session.startedAtMs, 0);
      this.running.delete(issue.id);
      if (!this.retryAttempts.has(issue.id)) {
        this.claimed.delete(issue.id);
      }
    });

    this.running.set(issue.id, entry);
  }

  private async runIssue(
    initialConfig: EffectiveWorkflowConfig,
    initialIssue: NormalizedIssue,
    attempt: number,
    entry: RunningEntry
  ): Promise<void> {
    let config = initialConfig;
    let issue = initialIssue;
    let threadId: string | null = null;

    for (let turnIndex = 0; turnIndex < config.agent.maxTurns; turnIndex += 1) {
      if (entry.abortController.signal.aborted) {
        return;
      }

      config = await this.reloadConfig(false);
      const gateDelay = millisUntil(this.codexRateLimit.resumeAfterMs ?? 0, this.deps.now());
      if (gateDelay > 0) {
        this.scheduleRetry(config, issue, attempt + 1, this.codexRateLimit.reason ?? "codex_rate_limited", this.codexRateLimit.resumeAfterMs ?? undefined);
        return;
      }

      const latestIssue = await this.deps.fetchIssueById(config, issue.id);
      if (!latestIssue) {
        this.releaseIssue(issue.id);
        return;
      }
      issue = latestIssue;
      if (isTerminalState(issue.state, config)) {
        await this.cleanupIssueWorkspace(config, issue);
        this.completed.add(issue.id);
        this.releaseIssue(issue.id);
        return;
      }
      if (!isActiveState(issue.state, config)) {
        this.releaseIssue(issue.id);
        return;
      }

      const workspace = await this.deps.prepareWorkspace(config, issue);
      entry.session.workspacePath = workspace.path;
      if (workspace.createdNow) {
        await this.deps.runHook(config, "afterCreate", issue, workspace);
      }

      await this.deps.runHook(config, "beforeRun", issue, workspace);
      await this.deps.writeRunnerComment(
        config,
        issue.id,
        turnIndex === 0
          ? `Symphony started work in ${workspace.path} on ${workspace.branchName}.`
          : `Symphony continuing work, turn ${turnIndex + 1}.`
      );

      const prompt = turnIndex === 0 ? await this.deps.renderIssuePrompt(config, issue, attempt || null) : continuationPrompt(issue);
      const result = await this.deps.runCodexTurn(
        {
          config,
          issue,
          workspacePath: workspace.path,
          prompt,
          threadId
        },
        {
          signal: entry.abortController.signal,
          onEvent: (event) => this.recordCodexEvent(entry, event)
        }
      );

      threadId = result.threadId;
      entry.session.threadId = result.threadId;
      entry.session.turnId = result.turnId;
      entry.session.turnCount += 1;
      entry.session.inputTokens += result.inputTokens;
      entry.session.outputTokens += result.outputTokens;
      entry.session.totalTokens += result.totalTokens;
      this.codexTotals.inputTokens += result.inputTokens;
      this.codexTotals.outputTokens += result.outputTokens;
      this.codexTotals.totalTokens += result.totalTokens;

      await this.runHookIgnoringFailure(config, "afterRun", issue, workspace);

      if (result.status === "rate_limited") {
        const resumeAfterMs = result.rateLimitUntilMs ?? this.deps.now() + 5 * 60 * 60 * 1000;
        this.codexRateLimit = {
          resumeAfterMs,
          reason: result.error ?? "codex_rate_limited",
          updatedAtMs: this.deps.now()
        };
        await this.deps.writeRunnerComment(
          config,
          issue.id,
          `Symphony parked Codex work until ${new Date(resumeAfterMs).toISOString()} because Codex reported a rate limit.`
        );
        this.scheduleRetry(config, issue, attempt + 1, this.codexRateLimit.reason, resumeAfterMs);
        return;
      }

      if (result.status === "failed") {
        throw new Error(result.error ?? "codex_failed");
      }
    }

    const latestIssue = await this.deps.fetchIssueById(config, issue.id);
    if (latestIssue && isActiveState(latestIssue.state, config)) {
      this.scheduleRetry(config, latestIssue, 1, "continuation_after_max_turns", this.deps.now() + 1000);
    } else {
      this.releaseIssue(issue.id);
    }
  }

  private scheduleRetry(
    config: EffectiveWorkflowConfig,
    issue: NormalizedIssue,
    attempt: number,
    error: string | null,
    dueAtMs?: number
  ): void {
    const resolvedDueAtMs = dueAtMs ?? this.deps.now() + nextFailureBackoffMs(attempt, config.agent.maxRetryBackoffMs);
    this.retryAttempts.set(issue.id, {
      issueId: issue.id,
      identifier: issue.identifier,
      attempt,
      dueAtMs: resolvedDueAtMs,
      error
    });
    this.claimed.add(issue.id);
  }

  private releaseIssue(issueId: string): void {
    this.retryAttempts.delete(issueId);
    this.claimed.delete(issueId);
  }

  private async cleanupIssueWorkspace(config: EffectiveWorkflowConfig, issue: NormalizedIssue): Promise<void> {
    const workspace = this.deps.workspaceInfoForIssue(config, issue);
    if (!(await this.deps.workspacePathExists(workspace.path))) {
      return;
    }
    await this.runHookIgnoringFailure(config, "beforeRemove", issue, workspace);
    await this.deps.removeWorkspace(config, workspace);
  }

  private async runHookIgnoringFailure(
    config: EffectiveWorkflowConfig,
    hookName: HookName,
    issue: NormalizedIssue,
    workspace: WorkspaceInfo
  ): Promise<void> {
    try {
      await this.deps.runHook(config, hookName, issue, workspace);
    } catch (error) {
      this.deps.logger.warn({ error, hookName, issue: issue.identifier }, "hook failed and was ignored");
    }
  }

  private recordCodexEvent(entry: RunningEntry, event: CodexRunEvent): void {
    entry.session.lastCodexEvent = event.type;
    entry.session.lastCodexTimestamp = this.deps.now();
    entry.session.lastCodexMessage = JSON.stringify(event).slice(0, 1000);
    if (event.type === "process_started") {
      entry.session.codexAppServerPid = event.pid;
    } else if (event.type === "thread_started" || event.type === "thread_resumed") {
      entry.session.threadId = event.threadId;
    } else if (event.type === "turn_started") {
      entry.session.turnId = event.turnId;
    } else if (event.type === "rate_limited") {
      this.codexRateLimit = {
        resumeAfterMs: event.resumeAfterMs,
        reason: event.reason,
        updatedAtMs: this.deps.now()
      };
    }
  }

  private scheduleNextTick(intervalMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.tick()
        .catch((error: unknown) => {
          this.deps.logger.error({ error }, "poll tick failed");
        })
        .finally(() => {
          const nextInterval = this.lastKnownGoodConfig?.polling.intervalMs ?? intervalMs;
          this.scheduleNextTick(nextInterval);
        });
    }, intervalMs);
  }
}

export function createDefaultOrchestrator(workflowPath: string): Orchestrator {
  return new Orchestrator({ workflowPath });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

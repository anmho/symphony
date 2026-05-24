import { loadWorkflowConfig } from './config.js';
import {
  fetchCandidateIssues,
  fetchIssueById,
  fetchTerminalIssues,
  moveIssueToState,
  writeRunnerComment,
} from './linear.js';
import { logger as defaultLogger } from './logger.js';
import {
  continuationPrompt,
  isActiveState,
  isIssueEligible,
  isTerminalState,
  millisUntil,
  nextFailureBackoffMs,
  sortIssuesForDispatch,
} from './policy.js';
import { renderIssuePrompt } from './prompt.js';
import { isGateParked } from './rateLimit.js';
import { runCodexTurn } from './codexRpc.js';
import { AgentWorkEventStore, workEventFromCodexEvent } from './events.js';
import { latestVisibleWorkEvents } from './status.js';
import { runHook, type HookName } from './hooks.js';
import {
  ensureWorkspace,
  removeWorkspace,
  workspaceInfoForIssue,
  workspacePathExists,
} from './workspace.js';
import type {
  CodexRunEvent,
  CodexRunInput,
  CodexTurnResult,
  CodexUsageTotals,
  EffectiveWorkflowConfig,
  AgentWorkEvent,
  LiveSession,
  NormalizedIssue,
  OrchestratorSnapshot,
  RunAttempt,
  WorkspaceInfo,
} from './types.js';

export interface OrchestratorDependencies {
  loadWorkflowConfig: (
    workflowPath: string,
  ) => Promise<EffectiveWorkflowConfig>;
  fetchCandidateIssues: (
    config: EffectiveWorkflowConfig,
  ) => Promise<NormalizedIssue[]>;
  fetchIssueById: (
    config: EffectiveWorkflowConfig,
    issueId: string,
  ) => Promise<NormalizedIssue | null>;
  fetchTerminalIssues: (
    config: EffectiveWorkflowConfig,
  ) => Promise<NormalizedIssue[]>;
  writeRunnerComment: (
    config: EffectiveWorkflowConfig,
    issueId: string,
    body: string,
  ) => Promise<void>;
  moveIssueToState: (
    config: EffectiveWorkflowConfig,
    issueId: string,
    stateName: string,
  ) => Promise<void>;
  prepareWorkspace: (
    config: EffectiveWorkflowConfig,
    issue: NormalizedIssue,
  ) => Promise<WorkspaceInfo>;
  removeWorkspace: (
    config: EffectiveWorkflowConfig,
    workspace: WorkspaceInfo,
  ) => Promise<void>;
  workspaceInfoForIssue: (
    config: EffectiveWorkflowConfig,
    issue: NormalizedIssue,
  ) => WorkspaceInfo;
  workspacePathExists: (workspacePath: string) => Promise<boolean>;
  runHook: (
    config: EffectiveWorkflowConfig,
    hookName: HookName,
    issue: NormalizedIssue,
    workspace: WorkspaceInfo,
  ) => Promise<void>;
  renderIssuePrompt: (
    config: EffectiveWorkflowConfig,
    issue: NormalizedIssue,
    attempt: number | null,
  ) => Promise<string>;
  runCodexTurn: (
    input: CodexRunInput,
    options: { signal: AbortSignal; onEvent: (event: CodexRunEvent) => void },
  ) => Promise<CodexTurnResult>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  logger: Pick<typeof defaultLogger, 'info' | 'warn' | 'error' | 'debug'>;
  eventStore: AgentWorkEventStore;
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
  bypassRateLimitGate: boolean;
}

export class Orchestrator {
  private readonly deps: OrchestratorDependencies;
  private readonly eventStore: AgentWorkEventStore;
  private readonly workflowPath: string;
  private readonly startedAtMs: number;
  private lastKnownGoodConfig: EffectiveWorkflowConfig | null = null;
  private lastTickAtMs: number | null = null;
  private lastConfigError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private operatorPaused = false;
  private pausedAtMs: number | null = null;
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
    runtimeMs: 0,
  };
  private codexRateLimit = {
    resumeAfterMs: null as number | null,
    reason: null as string | null,
    updatedAtMs: null as number | null,
  };

  constructor(
    options: OrchestratorOptions,
    deps: Partial<OrchestratorDependencies> = {},
  ) {
    this.workflowPath = options.workflowPath;
    this.startedAtMs = (deps.now ?? Date.now)();
    const now = deps.now ?? Date.now;
    this.deps = {
      loadWorkflowConfig,
      fetchCandidateIssues,
      fetchIssueById,
      fetchTerminalIssues,
      writeRunnerComment,
      moveIssueToState,
      prepareWorkspace: ensureWorkspace,
      removeWorkspace,
      workspaceInfoForIssue,
      workspacePathExists,
      runHook,
      renderIssuePrompt,
      runCodexTurn,
      now,
      sleep,
      logger: defaultLogger,
      eventStore:
        deps.eventStore ?? new AgentWorkEventStore(this.workflowPath, now),
      ...deps,
    };
    this.eventStore = this.deps.eventStore;
  }

  async start(): Promise<void> {
    this.stopped = false;
    const config = await this.reloadConfig(true);
    await this.tick();
    this.scheduleNextTick(config.polling.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.operatorPaused = false;
    this.pausedAtMs = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const entry of this.running.values()) {
      entry.cancelReason = 'daemon_stopped';
      entry.abortController.abort();
    }
    await Promise.allSettled(
      [...this.running.values()].map((entry) => entry.promise),
    );
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
      running: [...this.running.values()].map((entry) => ({
        ...entry.session,
      })),
      claimed: [...this.claimed],
      retryAttempts: [...this.retryAttempts.values()].map((attempt) => ({
        ...attempt,
      })),
      completed: [...this.completed],
      codexTotals: { ...this.codexTotals },
      codexRateLimit: { ...this.codexRateLimit },
      lastTickAtMs: this.lastTickAtMs,
      lastConfigError: this.lastConfigError,
      paused: this.operatorPaused,
      pausedAtMs: this.pausedAtMs,
    };
  }

  pause(): { paused: boolean } {
    if (this.operatorPaused) {
      return { paused: true };
    }
    this.operatorPaused = true;
    this.pausedAtMs = this.deps.now();
    for (const entry of this.running.values()) {
      entry.cancelReason = 'operator_paused';
      this.appendRunnerEvent(entry, 'operator paused Symphony');
      entry.abortController.abort();
    }
    this.deps.logger.info('operator paused Symphony');
    return { paused: true };
  }

  resume(): { paused: boolean } {
    if (!this.operatorPaused) {
      return { paused: false };
    }
    this.operatorPaused = false;
    this.pausedAtMs = null;
    this.deps.logger.info('operator resumed Symphony');
    void this.tick();
    return { paused: false };
  }

  events(
    issue: string | null,
    cursor: number | null,
    limit: number | null,
    visible = false,
  ): AgentWorkEvent[] {
    const events = this.eventStore.query({
      issue,
      cursor,
      limit: visible ? 1000 : limit,
    });
    return visible ? latestVisibleWorkEvents(events, limit) : events;
  }

  queueSteer(issue: string, text: string): { queued: boolean; issue: string } {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error('empty_steer_instruction');
    }
    this.eventStore.queueSteer(issue, trimmed);
    const runningEntry = [...this.running.values()].find(
      (entry) => entry.issue.identifier === issue || entry.issue.id === issue,
    );
    if (runningEntry) {
      runningEntry.session.queuedSteerCount = this.eventStore.queuedSteerCount(
        runningEntry.issue.identifier,
      );
      this.appendRunnerEvent(runningEntry, 'operator guidance queued');
    }
    return { queued: true, issue };
  }

  resumeIssue(issue: string): { resumed: boolean; issue: string } {
    const now = this.deps.now();
    for (const attempt of this.retryAttempts.values()) {
      if (attempt.identifier === issue || attempt.issueId === issue) {
        attempt.dueAtMs = now;
        return { resumed: true, issue: attempt.identifier };
      }
    }
    return { resumed: false, issue };
  }

  resumeParkedRateLimitedRuns(): number {
    const now = this.deps.now();
    let resumed = 0;
    this.codexRateLimit = {
      resumeAfterMs: null,
      reason: null,
      updatedAtMs: null,
    };

    for (const attempt of this.retryAttempts.values()) {
      if (attempt.error === 'codex_rate_limited') {
        attempt.dueAtMs = now;
        resumed += 1;
      }
    }

    return resumed;
  }

  private async runTick(): Promise<void> {
    const config = await this.reloadConfig(false);
    this.lastTickAtMs = this.deps.now();
    const terminalIssues = await this.refreshCompletedFromLinear(config);

    if (!this.startupCleanupDone) {
      await this.cleanupTerminalWorkspaces(config, terminalIssues);
    }

    await this.reconcileRunning(config);

    if (this.operatorPaused) {
      this.deps.logger.debug('operator pause active; skipping dispatch');
      return;
    }

    await this.dispatchDueRetries(config);

    if (isGateParked(this.codexRateLimit, this.deps.now())) {
      this.deps.logger.info(
        { codexRateLimit: this.codexRateLimit },
        'codex launches paused by rate limit',
      );
      return;
    }

    const candidates = sortIssuesForDispatch(
      await this.deps.fetchCandidateIssues(config),
    ).filter((issue) => isIssueEligible(issue, config));

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

  private async reloadConfig(
    requireValid: boolean,
  ): Promise<EffectiveWorkflowConfig> {
    try {
      const config = await this.deps.loadWorkflowConfig(this.workflowPath);
      this.lastKnownGoodConfig = config;
      this.lastConfigError = null;
      return config;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastConfigError = message;
      if (this.lastKnownGoodConfig && !requireValid) {
        this.deps.logger.error(
          { error: message },
          'workflow reload failed; keeping last known good config',
        );
        return this.lastKnownGoodConfig;
      }
      throw error;
    }
  }

  private async cleanupTerminalWorkspaces(
    config: EffectiveWorkflowConfig,
    terminalIssues: NormalizedIssue[] | null = null,
  ): Promise<void> {
    this.startupCleanupDone = true;
    const issues = terminalIssues ?? (await this.deps.fetchTerminalIssues(config));
    for (const issue of issues) {
      let workspace: WorkspaceInfo;
      try {
        workspace = this.deps.workspaceInfoForIssue(config, issue);
      } catch (error) {
        this.deps.logger.debug(
          { error, issue: issue.identifier },
          'terminal issue has no configured workspace route',
        );
        continue;
      }
      if (!(await this.deps.workspacePathExists(workspace.path))) {
        continue;
      }
      await this.runHookIgnoringFailure(
        config,
        'beforeRemove',
        issue,
        workspace,
      );
      await this.deps.removeWorkspace(config, workspace);
      this.deps.logger.info(
        { issue: issue.identifier, workspace: workspace.path },
        'removed terminal issue workspace',
      );
    }
  }

  private async refreshCompletedFromLinear(
    config: EffectiveWorkflowConfig,
  ): Promise<NormalizedIssue[]> {
    const terminalIssues = await this.deps.fetchTerminalIssues(config);
    for (const issue of terminalIssues) {
      this.completed.add(issue.identifier);
      this.retryAttempts.delete(issue.id);
      this.claimed.delete(issue.id);
    }
    return terminalIssues;
  }

  private async reconcileRunning(
    config: EffectiveWorkflowConfig,
  ): Promise<void> {
    for (const entry of this.running.values()) {
      const latestIssue = await this.deps
        .fetchIssueById(config, entry.issue.id)
        .catch((error: unknown) => {
          this.deps.logger.warn(
            { error, issue: entry.issue.identifier },
            'failed to reconcile running issue',
          );
          return null;
        });

      if (latestIssue && isTerminalState(latestIssue.state, config)) {
        this.completed.add(latestIssue.identifier);
        entry.cancelReason = `state_${latestIssue.state}`;
        entry.abortController.abort();
        continue;
      }

      if (!latestIssue || !isActiveState(latestIssue.state, config)) {
        entry.cancelReason = latestIssue
          ? `state_${latestIssue.state}`
          : 'issue_not_found';
        entry.abortController.abort();
      }
    }
  }

  private async dispatchDueRetries(
    config: EffectiveWorkflowConfig,
  ): Promise<void> {
    const now = this.deps.now();
    const dueAttempts = [...this.retryAttempts.values()].filter(
      (attempt) => attempt.dueAtMs <= now,
    );
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
      this.dispatchIssue(
        config,
        issue,
        attempt.attempt,
        attempt.error === 'codex_rate_limited',
      );
    }
  }

  private dispatchIssue(
    config: EffectiveWorkflowConfig,
    issue: NormalizedIssue,
    attempt: number,
    bypassRateLimitGate = false,
  ): void {
    this.claimed.add(issue.id);
    const abortController = new AbortController();
    const session: LiveSession = {
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      repoKey: null,
      workspacePath: null,
      eventLogPath: this.eventStore.logPathForIssue(issue.identifier),
      latestEventCursor: this.eventStore.latestCursorForIssue(issue.identifier),
      queuedSteerCount: this.eventStore.queuedSteerCount(issue.identifier),
      threadId: null,
      turnId: null,
      codexAppServerPid: null,
      lastCodexEvent: null,
      lastCodexTimestamp: null,
      lastCodexMessage: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      goalStatus: null,
      goalObjective: null,
      goalUpdatedAtMs: null,
      turnCount: 0,
      startedAtMs: this.deps.now(),
    };

    const entry: RunningEntry = {
      issue,
      session,
      abortController,
      promise: Promise.resolve(),
      cancelReason: null,
      bypassRateLimitGate,
    };

    entry.promise = this.runIssue(config, issue, attempt, entry)
      .catch(async (error: unknown) => {
        if (entry.cancelReason) {
          this.deps.logger.info(
            { issue: issue.identifier, reason: entry.cancelReason },
            'issue run canceled',
          );
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.deps.logger.error(
          { issue: issue.identifier, error: message },
          'issue run failed',
        );
        this.appendRunnerEvent(entry, message, null, 'error');
        this.scheduleRetry(config, issue, attempt + 1, message);
      })
      .finally(() => {
        this.codexTotals.runtimeMs += Math.max(
          this.deps.now() - session.startedAtMs,
          0,
        );
        this.running.delete(issue.id);
        if (!this.retryAttempts.has(issue.id)) {
          this.claimed.delete(issue.id);
        }
      });

    this.running.set(issue.id, entry);
    this.appendRunnerEvent(entry, 'issue claimed by Symphony');
  }

  private async runIssue(
    initialConfig: EffectiveWorkflowConfig,
    initialIssue: NormalizedIssue,
    attempt: number,
    entry: RunningEntry,
  ): Promise<void> {
    let config = initialConfig;
    let issue = initialIssue;
    let threadId: string | null = null;

    for (let turnIndex = 0; turnIndex < config.agent.maxTurns; turnIndex += 1) {
      if (entry.abortController.signal.aborted) {
        return;
      }

      config = await this.reloadConfig(false);
      const gateDelay = millisUntil(
        this.codexRateLimit.resumeAfterMs ?? 0,
        this.deps.now(),
      );
      if (gateDelay > 0 && !entry.bypassRateLimitGate) {
        this.scheduleRateLimitProbe(
          config,
          issue,
          attempt + 1,
          this.codexRateLimit.reason ?? 'codex_rate_limited',
          this.codexRateLimit.resumeAfterMs,
        );
        return;
      }
      entry.bypassRateLimitGate = false;

      const latestIssue = await this.deps.fetchIssueById(config, issue.id);
      if (!latestIssue) {
        this.releaseIssue(issue.id);
        return;
      }
      issue = latestIssue;
      entry.session.title = issue.title;
      if (isTerminalState(issue.state, config)) {
        await this.cleanupIssueWorkspace(config, issue);
        this.completed.add(issue.identifier);
        this.releaseIssue(issue.id);
        return;
      }
      if (!isActiveState(issue.state, config)) {
        this.releaseIssue(issue.id);
        return;
      }

      const workspace = await this.deps.prepareWorkspace(config, issue);
      entry.session.repoKey = workspace.repoKey;
      entry.session.workspacePath = workspace.path;
      entry.session.eventLogPath = this.eventStore.logPathForIssue(
        issue.identifier,
      );
      if (workspace.createdNow) {
        await this.deps.runHook(config, 'afterCreate', issue, workspace);
      }

      await this.deps.runHook(config, 'beforeRun', issue, workspace);
      await this.deps.writeRunnerComment(
        config,
        issue.id,
        turnIndex === 0
          ? `Symphony started work in ${workspace.path} on ${workspace.branchName}.`
          : `Symphony continuing work, turn ${turnIndex + 1}.`,
      );

      const queuedSteer = this.eventStore.consumeSteer(issue.identifier);
      entry.session.queuedSteerCount = this.eventStore.queuedSteerCount(
        issue.identifier,
      );
      if (queuedSteer) {
        this.appendRunnerEvent(
          entry,
          'operator guidance attached to next turn',
          {
            queuedAtMs: queuedSteer.queuedAtMs,
          },
        );
      }
      const basePrompt =
        turnIndex === 0
          ? await this.deps.renderIssuePrompt(config, issue, attempt || null)
          : continuationPrompt(issue);
      const prompt = queuedSteer
        ? `${basePrompt}\n\n## Operator Guidance\n\n${queuedSteer.text}`
        : basePrompt;
      const result = await this.deps.runCodexTurn(
        {
          config,
          issue,
          workspacePath: workspace.path,
          prompt,
          threadId,
        },
        {
          signal: entry.abortController.signal,
          onEvent: (event) => this.recordCodexEvent(entry, event),
        },
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

      await this.runHookIgnoringFailure(config, 'afterRun', issue, workspace);

      if (result.status === 'rate_limited') {
        const resumeAfterMs =
          result.rateLimitUntilMs ?? this.deps.now() + 5 * 60 * 60 * 1000;
        this.codexRateLimit = {
          resumeAfterMs,
          reason: result.error ?? 'codex_rate_limited',
          updatedAtMs: this.deps.now(),
        };
        await this.deps.writeRunnerComment(
          config,
          issue.id,
          `Symphony parked Codex work until ${new Date(resumeAfterMs).toISOString()} because Codex reported a rate limit.`,
        );
        this.scheduleRateLimitProbe(
          config,
          issue,
          attempt + 1,
          this.codexRateLimit.reason,
          resumeAfterMs,
        );
        return;
      }

      if (result.status === 'failed') {
        this.appendRunnerEvent(
          entry,
          result.error ?? 'codex_failed',
          null,
          'error',
        );
        throw new Error(result.error ?? 'codex_failed');
      }

      if (this.shouldMoveToHandoff(config, entry)) {
        await this.deps.moveIssueToState(
          config,
          issue.id,
          config.tracker.handoffState!,
        );
        this.appendRunnerEvent(entry, 'issue moved to handoff state', {
          state: config.tracker.handoffState,
          reason: `codex_goal_${entry.session.goalStatus ?? 'done'}`,
        });
        this.releaseIssue(issue.id);
        return;
      }
    }

    const latestIssue = await this.deps.fetchIssueById(config, issue.id);
    if (latestIssue && isActiveState(latestIssue.state, config)) {
      this.scheduleRetry(
        config,
        latestIssue,
        1,
        'continuation_after_max_turns',
        this.deps.now() + 1000,
      );
    } else {
      this.releaseIssue(issue.id);
    }
  }

  private scheduleRetry(
    config: EffectiveWorkflowConfig,
    issue: NormalizedIssue,
    attempt: number,
    error: string | null,
    dueAtMs?: number,
  ): void {
    const resolvedDueAtMs =
      dueAtMs ??
      this.deps.now() +
        nextFailureBackoffMs(attempt, config.agent.maxRetryBackoffMs);
    this.retryAttempts.set(issue.id, {
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      attempt,
      dueAtMs: resolvedDueAtMs,
      error,
    });
    this.claimed.add(issue.id);
  }

  private shouldMoveToHandoff(
    config: EffectiveWorkflowConfig,
    entry: RunningEntry,
  ): boolean {
    const handoffState = config.tracker.handoffState;
    if (!handoffState) {
      return false;
    }
    if (isActiveState(handoffState, config)) {
      return false;
    }
    const status = entry.session.goalStatus?.toLowerCase();
    return status === 'complete' || status === 'completed' || status === 'blocked';
  }

  private scheduleRateLimitProbe(
    config: EffectiveWorkflowConfig,
    issue: NormalizedIssue,
    attempt: number,
    error: string | null,
    resumeAfterMs: number | null,
  ): void {
    const now = this.deps.now();
    const probeDueAtMs =
      now +
      rateLimitProbeDelayMs(config.agent.rateLimitProbeIntervalMs, issue.id);
    const dueAtMs = resumeAfterMs
      ? Math.min(resumeAfterMs, probeDueAtMs)
      : probeDueAtMs;
    this.scheduleRetry(config, issue, attempt, error, dueAtMs);
  }

  private releaseIssue(issueId: string): void {
    this.retryAttempts.delete(issueId);
    this.claimed.delete(issueId);
  }

  private async cleanupIssueWorkspace(
    config: EffectiveWorkflowConfig,
    issue: NormalizedIssue,
  ): Promise<void> {
    const workspace = this.deps.workspaceInfoForIssue(config, issue);
    if (!(await this.deps.workspacePathExists(workspace.path))) {
      return;
    }
    await this.runHookIgnoringFailure(config, 'beforeRemove', issue, workspace);
    await this.deps.removeWorkspace(config, workspace);
  }

  private async runHookIgnoringFailure(
    config: EffectiveWorkflowConfig,
    hookName: HookName,
    issue: NormalizedIssue,
    workspace: WorkspaceInfo,
  ): Promise<void> {
    try {
      await this.deps.runHook(config, hookName, issue, workspace);
    } catch (error) {
      this.deps.logger.warn(
        { error, hookName, issue: issue.identifier },
        'hook failed and was ignored',
      );
    }
  }

  private recordCodexEvent(entry: RunningEntry, event: CodexRunEvent): void {
    const timestampMs = this.deps.now();
    entry.session.lastCodexEvent = event.type;
    entry.session.lastCodexTimestamp = timestampMs;
    entry.session.lastCodexMessage = JSON.stringify(event).slice(0, 1000);
    if (event.type === 'process_started') {
      entry.session.codexAppServerPid = event.pid;
    } else if (
      event.type === 'thread_started' ||
      event.type === 'thread_resumed'
    ) {
      entry.session.threadId = event.threadId;
    } else if (event.type === 'turn_started') {
      entry.session.turnId = event.turnId;
    } else if (event.type === 'rate_limited') {
      this.codexRateLimit = {
        resumeAfterMs: event.resumeAfterMs,
        reason: event.reason,
        updatedAtMs: this.deps.now(),
      };
    } else if (event.type === 'notification' && event.method === 'thread/goal/updated') {
      const goal = goalFromNotification(event.params);
      if (goal) {
        entry.session.goalStatus = goal.status;
        entry.session.goalObjective = goal.objective;
        entry.session.goalUpdatedAtMs = timestampMs;
      }
    }
    const normalized = workEventFromCodexEvent(
      {
        issueId: entry.issue.id,
        identifier: entry.issue.identifier,
        repoKey: entry.session.repoKey,
        workspacePath: entry.session.workspacePath,
        threadId: entry.session.threadId,
        turnId: entry.session.turnId,
      },
      event,
    );
    const workEvent = this.eventStore.append({
      issueId: entry.issue.id,
      identifier: entry.issue.identifier,
      repoKey: entry.session.repoKey,
      workspacePath: entry.session.workspacePath,
      threadId: entry.session.threadId,
      turnId: entry.session.turnId,
      ...normalized,
      timestampMs,
    });
    entry.session.latestEventCursor = workEvent.cursor;
  }

  private appendRunnerEvent(
    entry: RunningEntry,
    summary: string,
    payload: Record<string, unknown> | null = null,
    level: AgentWorkEvent['level'] = 'info',
  ): void {
    const event = this.eventStore.append({
      issueId: entry.issue.id,
      identifier: entry.issue.identifier,
      repoKey: entry.session.repoKey,
      workspacePath: entry.session.workspacePath,
      threadId: entry.session.threadId,
      turnId: entry.session.turnId,
      type: level === 'error' ? 'error' : 'runner',
      level,
      summary,
      payload,
    });
    entry.session.lastCodexEvent = event.type;
    entry.session.lastCodexTimestamp = event.timestampMs;
    entry.session.lastCodexMessage = event.summary;
    entry.session.latestEventCursor = event.cursor;
  }

  private scheduleNextTick(intervalMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.tick()
        .catch((error: unknown) => {
          this.deps.logger.error({ error }, 'poll tick failed');
        })
        .finally(() => {
          const nextInterval =
            this.lastKnownGoodConfig?.polling.intervalMs ?? intervalMs;
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

function rateLimitProbeDelayMs(intervalMs: number, seed: string): number {
  const jitterWindowMs = Math.max(Math.floor(intervalMs * 0.2), 1);
  return intervalMs + (hashString(seed) % jitterWindowMs);
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function goalFromNotification(params: unknown): { status: string | null; objective: string | null } | null {
  if (!params || typeof params !== 'object') {
    return null;
  }
  const goal = (params as { goal?: unknown }).goal;
  if (!goal || typeof goal !== 'object') {
    return null;
  }
  const record = goal as { status?: unknown; objective?: unknown };
  return {
    status: typeof record.status === 'string' ? record.status : null,
    objective: typeof record.objective === 'string' ? record.objective : null,
  };
}

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { loadWorkflowConfig } from './config.js';
import {
  fetchCandidateIssues,
  fetchHandoffIssues,
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
import { isGateParked, isRateLimitError } from './rateLimit.js';
import { runCodexTurn } from './codexRpc.js';
import { AgentWorkEventStore, workEventFromCodexEvent } from './events.js';
import { summarizeCurrentWork } from './eventDisplay.js';
import { fetchPullRequestStatus } from './github.js';
import { latestVisibleWorkEvents } from './status.js';
import { runHook, type HookName } from './hooks.js';
import {
  ensureWorkspace,
  removeWorkspace,
  workspaceInfoForIssue,
  workspacePathExists,
} from './workspace.js';
import {
  buildDigestEmail,
  FileDigestStateStore,
  sendDigestEmail,
  type DigestEmail,
  type DigestStateStore,
} from './digest.js';
import type {
  CodexRunEvent,
  CodexRunInput,
  CodexTurnResult,
  CodexUsageTotals,
  EffectiveWorkflowConfig,
  AgentWorkEvent,
  ConcurrencySnapshot,
  IssueSummary,
  LiveSession,
  NormalizedIssue,
  OrchestratorSnapshot,
  PullRequestStatus,
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
  fetchHandoffIssues: (
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
  fetchPullRequestStatus: (
    url: string,
  ) => Promise<PullRequestStatus | null>;
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
  digestStateStore: DigestStateStore;
  sendDigestEmail: (
    config: EffectiveWorkflowConfig,
    email: DigestEmail,
  ) => Promise<void>;
}

function isHandoffState(
  state: string,
  config: EffectiveWorkflowConfig,
): boolean {
  return Boolean(
    config.tracker.handoffState &&
      state.toLowerCase() === config.tracker.handoffState.toLowerCase(),
  );
}

function issueSummary(
  config: EffectiveWorkflowConfig,
  issue: NormalizedIssue,
): IssueSummary {
  return {
    identifier: issue.identifier,
    title: issue.title,
    repoKey: repoKeyFromIssue(config, issue),
    state: issue.state,
    reviewKind: reviewKindFromIssue(config, issue),
    prUrl: githubPullRequestUrlFromIssue(issue),
  };
}

function reviewKindFromIssue(
  config: EffectiveWorkflowConfig,
  issue: NormalizedIssue,
): IssueSummary['reviewKind'] {
  if (isTerminalState(issue.state, config)) {
    return 'completed';
  }
  if (issue.state.toLowerCase().includes('block')) {
    return 'blocked';
  }
  return 'pr_review';
}

function githubPullRequestUrlFromIssue(issue: NormalizedIssue): string | null {
  const haystack = [
    issue.description ?? '',
    ...issue.comments,
    ...issue.attachments,
  ].join('\n');
  return (
    haystack.match(
      /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/,
    )?.[0] ?? null
  );
}

function repoKeyFromIssue(
  config: EffectiveWorkflowConfig,
  issue: NormalizedIssue,
): string | null {
  const prefix = config.tracker.repoLabelPrefix.toLowerCase();
  for (const label of issue.labels) {
    const normalized = label.toLowerCase();
    if (normalized.startsWith(prefix)) {
      const repoKey = normalized.slice(prefix.length).trim();
      return repoKey || null;
    }
  }
  return null;
}

function preferredTerminalState(
  config: EffectiveWorkflowConfig,
): string | null {
  return (
    config.tracker.terminalStates.find(
      (state) => state.toLowerCase() === 'done',
    ) ??
    config.tracker.terminalStates[0] ??
    null
  );
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
  private readonly digestStateStore: DigestStateStore;
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
  private maxConcurrencyOverride: number | null = null;
  private maxConcurrencyOverrideUpdatedAtMs: number | null = null;

  private readonly running = new Map<string, RunningEntry>();
  private readonly claimed = new Set<string>();
  private readonly retryAttempts = new Map<string, RunAttempt>();
  private readonly handoff = new Map<string, IssueSummary>();
  private readonly completed = new Map<string, IssueSummary>();
  private readonly rework = new Map<string, IssueSummary>();
  private readonly reworkIssues = new Set<string>();
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
      fetchHandoffIssues,
      fetchIssueById,
      fetchTerminalIssues,
      writeRunnerComment,
      moveIssueToState,
      fetchPullRequestStatus,
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
      digestStateStore:
        deps.digestStateStore ?? new FileDigestStateStore(this.workflowPath),
      sendDigestEmail: (config, email) =>
        sendDigestEmail(config.digest, email),
      ...deps,
    };
    this.eventStore = this.deps.eventStore;
    this.digestStateStore = this.deps.digestStateStore;
    this.loadMaxConcurrencyOverride();
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
      handoff: [...this.handoff.keys()],
      handoffDetails: [...this.handoff.values()],
      completed: [...this.completed.keys()],
      completedDetails: [...this.completed.values()],
      codexTotals: { ...this.codexTotals },
      codexRateLimit: { ...this.codexRateLimit },
      concurrency: this.concurrencySnapshot(this.lastKnownGoodConfig),
      lastTickAtMs: this.lastTickAtMs,
      lastConfigError: this.lastConfigError,
      paused: this.operatorPaused,
      pausedAtMs: this.pausedAtMs,
    };
  }

  setMaxConcurrencyOverride(maxConcurrentAgents: number | null): ConcurrencySnapshot {
    if (
      maxConcurrentAgents !== null &&
      (!Number.isInteger(maxConcurrentAgents) || maxConcurrentAgents <= 0)
    ) {
      throw new Error(`invalid_max_concurrent_agents: ${maxConcurrentAgents}`);
    }
    this.maxConcurrencyOverride = maxConcurrentAgents;
    this.maxConcurrencyOverrideUpdatedAtMs =
      maxConcurrentAgents === null ? null : this.deps.now();
    this.persistMaxConcurrencyOverride();
    this.deps.logger.info(
      {
        maxConcurrentAgents,
        source: maxConcurrentAgents === null ? 'workflow' : 'override',
      },
      'updated max concurrency override',
    );
    void this.tick();
    return this.concurrencySnapshot(this.lastKnownGoodConfig);
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

  async requestChanges(
    issueReference: string,
    feedback: string,
  ): Promise<{ issue: string; state: string }> {
    const trimmed = feedback.trim();
    if (!trimmed) {
      throw new Error('feedback_required');
    }
    const config = await this.reloadConfig(false);
    const issue = await this.deps.fetchIssueById(config, issueReference);
    if (!issue) {
      throw new Error(`issue_not_found: ${issueReference}`);
    }
    const targetState =
      config.tracker.activeStates.find(
        (state) => state.toLowerCase() === 'in progress',
      ) ?? config.tracker.activeStates[0];
    if (!targetState) {
      throw new Error('no_active_state_configured');
    }

    await this.deps.writeRunnerComment(
      config,
      issue.id,
      [
        'Changes requested by human reviewer.',
        '',
        trimmed,
        '',
        `Symphony moved this issue back to ${targetState} for agent rework.`,
      ].join('\n'),
    );
    await this.deps.moveIssueToState(config, issue.id, targetState);
    this.reworkIssues.add(issue.id);
    this.rework.set(
      issue.identifier,
      issueSummary(config, { ...issue, state: targetState }),
    );
    this.handoff.delete(issue.identifier);
    this.completed.delete(issue.identifier);
    this.retryAttempts.delete(issue.id);
    this.claimed.delete(issue.id);
    await this.tick();
    return { issue: issue.identifier, state: targetState };
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
      if (isRateLimitError(attempt.error)) {
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
    await this.refreshHandoffFromLinear(config);

    if (!this.startupCleanupDone) {
      await this.cleanupTerminalWorkspaces(config, terminalIssues);
    }

    await this.reconcileRunning(config);
    await this.maybeSendDigest(config);

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
      if (this.running.size >= this.effectiveMaxConcurrentAgents(config)) {
        break;
      }
      if (this.claimed.has(issue.id)) {
        continue;
      }
      if (await this.syncPrLinkedIssueToHandoff(config, issue)) {
        continue;
      }
      this.dispatchIssue(config, issue, 0);
    }
  }

  private async maybeSendDigest(config: EffectiveWorkflowConfig): Promise<void> {
    if (!config.digest.enabled) {
      return;
    }

    const state = this.digestStateStore.read();
    const now = this.deps.now();
    if (
      state.lastSentAtMs !== null &&
      now - state.lastSentAtMs < config.digest.intervalMs
    ) {
      return;
    }

    const events = this.eventStore.query({
      cursor: state.lastProcessedCursor,
      limit: 1000,
    });
    const email = buildDigestEmail({
      running: [...this.running.values()].map((entry) => ({
        ...entry.session,
      })),
      needsReview: [...this.handoff.values()],
      needsRework: [...this.rework.values()],
      blockedOrRetry: [...this.retryAttempts.values()],
      completed: [...this.completed.values()],
      events,
      generatedAtMs: now,
      windowMs: config.digest.windowMs,
    });

    if (!email) {
      return;
    }

    const nextProcessedCursor = Math.max(
      state.lastProcessedCursor,
      email.lastProcessedCursor,
    );
    if (!email.text) {
      this.digestStateStore.write({
        lastSentAtMs: state.lastSentAtMs,
        lastProcessedCursor: nextProcessedCursor,
      });
      return;
    }

    try {
      await this.deps.sendDigestEmail(config, email);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn(
        { error: message },
        'failed to send Symphony digest email',
      );
      return;
    }

    this.digestStateStore.write({
      lastSentAtMs: now,
      lastProcessedCursor: nextProcessedCursor,
    });
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
      this.completed.set(issue.identifier, issueSummary(config, issue));
      this.handoff.delete(issue.identifier);
      this.retryAttempts.delete(issue.id);
      this.claimed.delete(issue.id);
      this.rework.delete(issue.identifier);
    }
    return terminalIssues;
  }

  private async refreshHandoffFromLinear(
    config: EffectiveWorkflowConfig,
  ): Promise<NormalizedIssue[]> {
    const handoffIssues = await this.deps.fetchHandoffIssues(config);
    this.handoff.clear();
    for (const issue of handoffIssues) {
      if (this.completed.has(issue.identifier)) {
        continue;
      }
      if (await this.syncMergedPrLinkedIssueToTerminal(config, issue)) {
        continue;
      }
      this.handoff.set(issue.identifier, issueSummary(config, issue));
      this.rework.delete(issue.identifier);
      this.retryAttempts.delete(issue.id);
      this.claimed.delete(issue.id);
    }
    return handoffIssues;
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
        this.completed.set(latestIssue.identifier, issueSummary(config, latestIssue));
        this.rework.delete(latestIssue.identifier);
        this.reworkIssues.delete(latestIssue.id);
        entry.cancelReason = `state_${latestIssue.state}`;
        entry.abortController.abort();
        continue;
      }

      if (latestIssue && await this.syncPrLinkedIssueToHandoff(config, latestIssue, entry)) {
        continue;
      }

      if (!latestIssue || !isActiveState(latestIssue.state, config)) {
        if (latestIssue && isHandoffState(latestIssue.state, config)) {
          this.handoff.set(latestIssue.identifier, issueSummary(config, latestIssue));
          this.rework.delete(latestIssue.identifier);
          this.reworkIssues.delete(latestIssue.id);
        }
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
      if (this.running.size >= this.effectiveMaxConcurrentAgents(config)) {
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

      if (await this.syncPrLinkedIssueToHandoff(config, issue)) {
        this.retryAttempts.delete(attempt.issueId);
        this.claimed.delete(attempt.issueId);
        continue;
      }

      this.retryAttempts.delete(attempt.issueId);
      this.dispatchIssue(
        config,
        issue,
        attempt.attempt,
        isRateLimitError(attempt.error),
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
      currentWork: null,
      currentWorkKind: null,
      currentWorkUpdatedAtMs: null,
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

  private effectiveMaxConcurrentAgents(config: EffectiveWorkflowConfig): number {
    return this.maxConcurrencyOverride ?? config.agent.maxConcurrentAgents;
  }

  private concurrencySnapshot(
    config: EffectiveWorkflowConfig | null,
  ): ConcurrencySnapshot {
    const configuredMax = config?.agent.maxConcurrentAgents ?? null;
    const effectiveMax =
      this.maxConcurrencyOverride ?? configuredMax;
    const overrideActive = this.maxConcurrencyOverride !== null;
    return {
      running: this.running.size,
      configuredMax,
      effectiveMax,
      source: overrideActive ? 'override' : configuredMax === null ? 'unknown' : 'workflow',
      overrideActive,
      overrideMax: this.maxConcurrencyOverride,
      overrideUpdatedAtMs: this.maxConcurrencyOverrideUpdatedAtMs,
    };
  }

  private maxConcurrencyOverridePath(): string {
    return path.join(
      path.dirname(path.resolve(this.workflowPath)),
      '.symphony',
      'state',
      'concurrency.json',
    );
  }

  private loadMaxConcurrencyOverride(): void {
    const overridePath = this.maxConcurrencyOverridePath();
    if (!existsSync(this.workflowPath) || !existsSync(overridePath)) {
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(overridePath, 'utf8')) as {
        maxConcurrentAgents?: unknown;
        updatedAtMs?: unknown;
      };
      const value = parsed.maxConcurrentAgents;
      if (Number.isInteger(value) && Number(value) > 0) {
        this.maxConcurrencyOverride = Number(value);
        this.maxConcurrencyOverrideUpdatedAtMs =
          typeof parsed.updatedAtMs === 'number' ? parsed.updatedAtMs : null;
      }
    } catch {
      this.maxConcurrencyOverride = null;
      this.maxConcurrencyOverrideUpdatedAtMs = null;
    }
  }

  private persistMaxConcurrencyOverride(): void {
    const overridePath = this.maxConcurrencyOverridePath();
    if (this.maxConcurrencyOverride === null) {
      rmSync(overridePath, { force: true });
      return;
    }
    mkdirSync(path.dirname(overridePath), { recursive: true });
    writeFileSync(
      overridePath,
      `${JSON.stringify(
        {
          maxConcurrentAgents: this.maxConcurrencyOverride,
          updatedAtMs: this.maxConcurrencyOverrideUpdatedAtMs,
        },
        null,
        2,
      )}\n`,
    );
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
        this.completed.set(issue.identifier, issueSummary(config, issue));
        this.rework.delete(issue.identifier);
        this.reworkIssues.delete(issue.id);
        this.releaseIssue(issue.id);
        return;
      }
      if (await this.syncPrLinkedIssueToHandoff(config, issue, entry)) {
        this.releaseIssue(issue.id);
        return;
      }
      if (!isActiveState(issue.state, config)) {
        if (isHandoffState(issue.state, config)) {
          this.handoff.set(issue.identifier, issueSummary(config, issue));
          this.rework.delete(issue.identifier);
          this.reworkIssues.delete(issue.id);
        }
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
        this.handoff.set(issue.identifier, issueSummary(config, issue));
        this.rework.delete(issue.identifier);
        this.reworkIssues.delete(issue.id);
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

  private async syncPrLinkedIssueToHandoff(
    config: EffectiveWorkflowConfig,
    issue: NormalizedIssue,
    entry: RunningEntry | null = null,
  ): Promise<boolean> {
    const handoffState = config.tracker.handoffState;
    if (!handoffState || isActiveState(handoffState, config)) {
      return false;
    }
    if (!isActiveState(issue.state, config)) {
      return false;
    }
    if (this.reworkIssues.has(issue.id)) {
      return false;
    }
    const prUrl = githubPullRequestUrlFromIssue(issue);
    if (!prUrl) {
      return false;
    }
    if (await this.syncMergedPrLinkedIssueToTerminal(config, issue, entry)) {
      return true;
    }

    await this.deps.moveIssueToState(config, issue.id, handoffState);
    const handedOffIssue = { ...issue, state: handoffState };
    this.handoff.set(issue.identifier, issueSummary(config, handedOffIssue));
    this.rework.delete(issue.identifier);
    this.retryAttempts.delete(issue.id);
    this.claimed.delete(issue.id);
    if (entry) {
      this.appendRunnerEvent(entry, 'issue moved to handoff state from linked PR', {
        state: handoffState,
        prUrl,
      });
      entry.cancelReason = `state_${handoffState}`;
      entry.abortController.abort();
    }
    this.deps.logger.info(
      { issue: issue.identifier, prUrl, state: handoffState },
      'moved PR-linked issue to handoff state',
    );
    return true;
  }

  private async syncMergedPrLinkedIssueToTerminal(
    config: EffectiveWorkflowConfig,
    issue: NormalizedIssue,
    entry: RunningEntry | null = null,
  ): Promise<boolean> {
    const prUrl = githubPullRequestUrlFromIssue(issue);
    if (!prUrl) {
      return false;
    }

    let prStatus: PullRequestStatus | null;
    try {
      prStatus = await this.deps.fetchPullRequestStatus(prUrl);
    } catch (error) {
      this.deps.logger.warn(
        { error, issue: issue.identifier, prUrl },
        'failed to fetch linked GitHub PR status',
      );
      return false;
    }
    if (prStatus?.state !== 'merged') {
      return false;
    }

    const terminalState = preferredTerminalState(config);
    if (!terminalState) {
      this.deps.logger.warn(
        { issue: issue.identifier, prUrl },
        'merged PR found but no terminal state is configured',
      );
      return false;
    }

    await this.deps.moveIssueToState(config, issue.id, terminalState);
    await this.deps.writeRunnerComment(
      config,
      issue.id,
      [
        `Symphony observed merged GitHub PR: ${prStatus.url}.`,
        '',
        `Moved this issue to ${terminalState}.`,
      ].join('\n'),
    );

    const completedIssue = { ...issue, state: terminalState };
    this.completed.set(issue.identifier, issueSummary(config, completedIssue));
    this.handoff.delete(issue.identifier);
    this.rework.delete(issue.identifier);
    this.retryAttempts.delete(issue.id);
    this.claimed.delete(issue.id);
    this.reworkIssues.delete(issue.id);

    if (entry) {
      this.appendRunnerEvent(entry, 'issue moved to terminal state from merged PR', {
        state: terminalState,
        prUrl: prStatus.url,
      });
      entry.cancelReason = `state_${terminalState}`;
      entry.abortController.abort();
    }
    this.deps.logger.info(
      { issue: issue.identifier, prUrl: prStatus.url, state: terminalState },
      'moved merged-PR issue to terminal state',
    );
    return true;
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
    this.refreshCurrentWork(entry);
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
    this.refreshCurrentWork(entry);
  }

  private refreshCurrentWork(entry: RunningEntry): void {
    const summary = summarizeCurrentWork(
      this.eventStore.query({
        issue: entry.issue.identifier,
        cursor: 0,
        limit: 80,
      }),
    );
    if (!summary) {
      return;
    }
    entry.session.currentWork = summary.text;
    entry.session.currentWorkKind = summary.kind;
    entry.session.currentWorkUpdatedAtMs = summary.updatedAtMs;
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

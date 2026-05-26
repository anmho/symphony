export type JsonObject = Record<string, unknown>;

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface NormalizedIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  comments: string[];
  attachments: string[];
  attachmentDetails?: NormalizedIssueAttachment[];
  blockedBy: BlockerRef[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface NormalizedIssueAttachment {
  url: string | null;
  title: string | null;
  metadata: JsonObject | null;
}

export interface WorkflowDefinition {
  config: JsonObject;
  promptTemplate: string;
}

export interface TrackerConfig {
  kind: 'linear';
  endpoint: string;
  apiKey: string;
  projectSlug: string | null;
  teamKey: string | null;
  requiredLabels: string[];
  repoLabelPrefix: string;
  activeStates: string[];
  terminalStates: string[];
  handoffState: string | null;
  mergeState: string | null;
}

export interface PollingConfig {
  intervalMs: number;
}

export interface WorkspaceConfig {
  root: string;
  repoPath: string;
  projectsRoot: string | null;
  repoRoutes: Record<string, string>;
  baseBranch: string;
}

export interface HooksConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface AgentConfig {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  rateLimitProbeIntervalMs: number;
  maxConcurrentAgentsByState: Record<string, number>;
}

export interface CodexConfig {
  command: string;
  approvalPolicy: unknown;
  threadSandbox: unknown | null;
  turnSandboxPolicy: unknown | null;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
  model: string | null;
}

export type PullRequestBackend = 'github' | 'graphite';
export type GraphiteFallback = 'fail' | 'github';

export interface PullRequestConfig {
  backend: PullRequestBackend;
  graphiteFallback: GraphiteFallback;
}

export interface DigestConfig {
  enabled: boolean;
  recipient: string;
  sender: string;
  intervalMs: number;
  windowMs: number;
  resendApiKey: string | null;
  resendEndpoint: string;
}

export interface GithubMachineUserPrIdentityConfig {
  kind: 'machine_user';
  tokenCommand: string;
  authorName: string;
  authorEmail: string;
}

export interface GithubAppPrIdentityConfig {
  kind: 'github_app';
  appSlug: string;
  tokenCommand: string;
  authorName: string;
  authorEmail: string;
  reviewerLogin: string | null;
  reviewerLogins: string[];
}

export type GithubPrIdentityConfig = GithubMachineUserPrIdentityConfig | GithubAppPrIdentityConfig;

export interface GithubConfig {
  prIdentity: GithubPrIdentityConfig | null;
}

export interface PullRequestMetadata {
  url: string;
  baseRefName: string;
  headRefName: string;
  body: string;
  authorLogin: string | null;
  reviewRequestLogins: string[];
}

export interface EffectiveWorkflowConfig {
  workflowPath: string;
  workflowDir: string;
  promptTemplate: string;
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  codex: CodexConfig;
  github: GithubConfig;
  pullRequest: PullRequestConfig;
  digest: DigestConfig;
}

export interface WorkspaceInfo {
  path: string;
  workspaceKey: string;
  branchName: string;
  repoKey: string | null;
  repoPath: string;
  createdNow: boolean;
}

export interface RateLimitGateState {
  resumeAfterMs: number | null;
  reason: string | null;
  updatedAtMs: number | null;
}

export interface CodexRateLimitSnapshot {
  resumeAfterMs: number | null;
  reason: string | null;
  updatedAtMs: number | null;
}

export interface CodexUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  runtimeMs: number;
}

export interface ConcurrencySnapshot {
  running: number;
  configuredMax: number | null;
  effectiveMax: number | null;
  source: 'workflow' | 'override' | 'unknown';
  overrideActive: boolean;
  overrideMax: number | null;
  overrideUpdatedAtMs: number | null;
}

export interface CodexTurnResult {
  status: 'completed' | 'failed' | 'rate_limited';
  threadId: string;
  turnId: string | null;
  rateLimitUntilMs: number | null;
  lastMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  error: string | null;
}

export interface RunAttempt {
  issueId: string;
  identifier: string;
  title: string | null;
  attempt: number;
  dueAtMs: number;
  error: string | null;
}

export interface IssueSummary {
  identifier: string;
  title: string | null;
  repoKey: string | null;
  state: string | null;
  reviewKind: 'pr_review' | 'blocked' | 'completed';
  prUrl: string | null;
}

export interface PullRequestStatus {
  url: string;
  owner: string;
  repo: string;
  number: number;
  state: 'open' | 'closed' | 'merged';
  mergedAt: string | null;
}

export interface PullRequestReviewComment {
  author: string | null;
  body: string;
  path: string | null;
  line: number | null;
  url: string | null;
  createdAt: string | null;
}

export interface PullRequestReviewFeedback {
  url: string;
  owner: string;
  repo: string;
  number: number;
  unresolvedComments: PullRequestReviewComment[];
}

export interface PullRequestMergeReadiness {
  url: string;
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  reviewDecision: string | null;
  latestReviewDecision: string | null;
  mergeStateStatus: string | null;
  mergeable: string | null;
  headRefOid: string | null;
}

export interface LiveSession {
  issueId: string;
  identifier: string;
  title: string | null;
  repoKey: string | null;
  workspacePath: string | null;
  eventLogPath: string | null;
  latestEventCursor: number | null;
  queuedSteerCount: number;
  threadId: string | null;
  turnId: string | null;
  codexAppServerPid: number | null;
  lastCodexEvent: string | null;
  lastCodexTimestamp: number | null;
  lastCodexMessage: string | null;
  currentWork: string | null;
  currentWorkKind: string | null;
  currentWorkUpdatedAtMs: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  goalStatus: string | null;
  goalObjective: string | null;
  goalUpdatedAtMs: number | null;
  turnCount: number;
  startedAtMs: number;
}

export interface OrchestratorSnapshot {
  startedAtMs: number;
  workflowPath: string;
  running: LiveSession[];
  claimed: string[];
  retryAttempts: RunAttempt[];
  handoff: string[];
  handoffDetails: IssueSummary[];
  completed: string[];
  completedDetails: IssueSummary[];
  codexTotals: CodexUsageTotals;
  codexRateLimit: CodexRateLimitSnapshot;
  concurrency: ConcurrencySnapshot;
  lastTickAtMs: number | null;
  lastConfigError: string | null;
  paused: boolean;
  pausedAtMs: number | null;
}

export type AgentWorkEventType =
  | 'runner'
  | 'process'
  | 'stderr'
  | 'thread'
  | 'turn'
  | 'assistant_delta'
  | 'assistant_message'
  | 'command'
  | 'tool'
  | 'diff'
  | 'goal'
  | 'reasoning_summary'
  | 'rate_limited'
  | 'error'
  | 'notification';

export interface AgentWorkEvent {
  cursor: number;
  timestampMs: number;
  issueId: string;
  identifier: string;
  repoKey: string | null;
  workspacePath: string | null;
  threadId: string | null;
  turnId: string | null;
  type: AgentWorkEventType;
  level: 'info' | 'warn' | 'error';
  summary: string;
  payload: JsonObject | null;
}

export interface QueuedSteer {
  issue: string;
  text: string;
  queuedAtMs: number;
}

export interface CodexRunInput {
  config: EffectiveWorkflowConfig;
  issue: NormalizedIssue;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  env?: NodeJS.ProcessEnv;
}

export type CodexRunEvent =
  | { type: 'process_started'; pid: number | null }
  | { type: 'stderr'; bytes: number }
  | { type: 'thread_started'; threadId: string }
  | { type: 'thread_resumed'; threadId: string }
  | { type: 'turn_started'; turnId: string | null }
  | { type: 'notification'; method: string; params: unknown }
  | { type: 'rate_limited'; resumeAfterMs: number | null; reason: string };

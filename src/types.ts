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
  blockedBy: BlockerRef[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface WorkflowDefinition {
  config: JsonObject;
  promptTemplate: string;
}

export interface TrackerConfig {
  kind: "linear";
  endpoint: string;
  apiKey: string;
  projectSlug: string | null;
  teamKey: string | null;
  requiredLabels: string[];
  repoLabelPrefix: string;
  activeStates: string[];
  terminalStates: string[];
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

export interface CodexTurnResult {
  status: "completed" | "failed" | "rate_limited";
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
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turnCount: number;
  startedAtMs: number;
}

export interface OrchestratorSnapshot {
  startedAtMs: number;
  workflowPath: string;
  running: LiveSession[];
  claimed: string[];
  retryAttempts: RunAttempt[];
  completed: string[];
  codexTotals: CodexUsageTotals;
  codexRateLimit: CodexRateLimitSnapshot;
  lastTickAtMs: number | null;
  lastConfigError: string | null;
}

export type AgentWorkEventType =
  | "runner"
  | "process"
  | "stderr"
  | "thread"
  | "turn"
  | "assistant_delta"
  | "assistant_message"
  | "command"
  | "tool"
  | "diff"
  | "goal"
  | "reasoning_summary"
  | "rate_limited"
  | "error"
  | "notification";

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
  level: "info" | "warn" | "error";
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
}

export type CodexRunEvent =
  | { type: "process_started"; pid: number | null }
  | { type: "stderr"; bytes: number }
  | { type: "thread_started"; threadId: string }
  | { type: "thread_resumed"; threadId: string }
  | { type: "turn_started"; turnId: string | null }
  | { type: "notification"; method: string; params: unknown }
  | { type: "rate_limited"; resumeAfterMs: number | null; reason: string };

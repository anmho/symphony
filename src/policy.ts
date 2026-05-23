import type { EffectiveWorkflowConfig, NormalizedIssue } from "./types";

export function normalizeState(value: string): string {
  return value.trim().toLowerCase();
}

export function sanitizeWorkspaceKey(identifier: string): string {
  const sanitized = identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "issue";
}

export function branchNameForIssue(identifier: string): string {
  return `symphony/${sanitizeWorkspaceKey(identifier)}`;
}

export function isTerminalState(state: string, config: EffectiveWorkflowConfig): boolean {
  const normalized = normalizeState(state);
  return config.tracker.terminalStates.map(normalizeState).includes(normalized);
}

export function isActiveState(state: string, config: EffectiveWorkflowConfig): boolean {
  const normalized = normalizeState(state);
  return config.tracker.activeStates.map(normalizeState).includes(normalized);
}

export function hasOpenTodoBlocker(issue: NormalizedIssue, config: EffectiveWorkflowConfig): boolean {
  if (normalizeState(issue.state) !== "todo") {
    return false;
  }

  return issue.blockedBy.some((blocker) => {
    if (!blocker.state) {
      return true;
    }
    return !isTerminalState(blocker.state, config);
  });
}

export function isIssueEligible(issue: NormalizedIssue, config: EffectiveWorkflowConfig): boolean {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
    return false;
  }
  if (!isActiveState(issue.state, config) || isTerminalState(issue.state, config)) {
    return false;
  }
  return !hasOpenTodoBlocker(issue, config);
}

export function sortIssuesForDispatch(issues: NormalizedIssue[]): NormalizedIssue[] {
  return [...issues].sort((left, right) => {
    const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    const leftCreated = left.createdAt ?? "";
    const rightCreated = right.createdAt ?? "";
    if (leftCreated !== rightCreated) {
      return leftCreated.localeCompare(rightCreated);
    }

    return left.identifier.localeCompare(right.identifier);
  });
}

export function continuationPrompt(issue: NormalizedIssue): string {
  return [
    `Continue working on Linear issue ${issue.identifier}: ${issue.title}.`,
    "Use the existing thread context and workspace state.",
    "Re-check the repository, continue the implementation, and leave clear proof of work or handoff state."
  ].join("\n");
}

export function nextFailureBackoffMs(attempt: number, maxRetryBackoffMs: number): number {
  const base = 10000;
  return Math.min(base * 2 ** Math.max(attempt - 1, 0), maxRetryBackoffMs);
}

export function millisUntil(timestampMs: number, nowMs = Date.now()): number {
  return Math.max(timestampMs - nowMs, 0);
}

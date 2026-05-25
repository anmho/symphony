import type {
  CodexRateLimitSnapshot,
  EffectiveWorkflowConfig,
  NormalizedIssue,
} from './types.js';
import {
  hasOpenTodoBlocker,
  isActiveState,
  isTerminalState,
  normalizeState,
  sortIssuesForDispatch,
} from './policy.js';
import { isGateParked } from './rateLimit.js';

export type DispatchSkipReasonCode =
  | 'missing_required_label'
  | 'missing_repo_label'
  | 'unknown_route'
  | 'inactive_state'
  | 'terminal_state'
  | 'blocker'
  | 'rate_limit_gate'
  | 'concurrency_cap';

export interface DispatchSkipReason {
  code: DispatchSkipReasonCode;
  message: string;
}

export interface DispatchIssueDiagnostic {
  issueId: string;
  identifier: string;
  title: string;
  state: string;
  labels: string[];
  reasons: DispatchSkipReason[];
}

export interface DispatchDoctorContext {
  nowMs?: number;
  codexRateLimit?: CodexRateLimitSnapshot | null;
  runningCount?: number;
  runningIssueIds?: ReadonlySet<string>;
}

export function diagnoseDispatchIssues(
  issues: NormalizedIssue[],
  config: EffectiveWorkflowConfig,
  context: DispatchDoctorContext = {},
): DispatchIssueDiagnostic[] {
  const nowMs = context.nowMs ?? Date.now();
  const diagnostics: DispatchIssueDiagnostic[] = [];
  const dispatchable: NormalizedIssue[] = [];

  for (const issue of sortIssuesForDispatch(issues)) {
    const reasons = baseSkipReasons(issue, config);
    if (reasons.length > 0) {
      diagnostics.push(diagnosticForIssue(issue, reasons));
      continue;
    }
    if (!context.runningIssueIds?.has(issue.id)) {
      dispatchable.push(issue);
    }
  }

  const availableSlots = Math.max(
    config.agent.maxConcurrentAgents - (context.runningCount ?? 0),
    0,
  );
  const rateLimitParked = isGateParked(
    context.codexRateLimit ?? {
      resumeAfterMs: null,
      reason: null,
      updatedAtMs: null,
    },
    nowMs,
  );

  dispatchable.forEach((issue, index) => {
    const reasons: DispatchSkipReason[] = [];
    if (rateLimitParked) {
      reasons.push({
        code: 'rate_limit_gate',
        message: rateLimitMessage(context.codexRateLimit),
      });
    }
    if (index >= availableSlots) {
      reasons.push({
        code: 'concurrency_cap',
        message:
          `running agents are at the configured concurrency cap of ${config.agent.maxConcurrentAgents}`,
      });
    }
    if (reasons.length > 0) {
      diagnostics.push(diagnosticForIssue(issue, reasons));
    }
  });

  return diagnostics;
}

export function renderDispatchDoctorReport(
  diagnostics: DispatchIssueDiagnostic[],
): string {
  if (diagnostics.length === 0) {
    return 'No skipped Symphony issues found.';
  }

  return [
    'Skipped Symphony issues:',
    ...diagnostics.map((diagnostic) => {
      const labels =
        diagnostic.labels.length > 0 ? diagnostic.labels.join(',') : '-';
      const reasons = diagnostic.reasons
        .map((reason) => `${reason.code}: ${reason.message}`)
        .join('; ');
      return [
        `- ${diagnostic.identifier} "${diagnostic.title}"`,
        `state=${diagnostic.state}`,
        `labels=${labels}`,
        `reasons=${reasons}`,
      ].join(' ');
    }),
  ].join('\n');
}

function baseSkipReasons(
  issue: NormalizedIssue,
  config: EffectiveWorkflowConfig,
): DispatchSkipReason[] {
  const reasons: DispatchSkipReason[] = [];

  if (!hasRequiredLabels(issue, config)) {
    reasons.push({
      code: 'missing_required_label',
      message: `missing required label(s): ${missingRequiredLabels(issue, config).join(', ')}`,
    });
  }

  const routeReason = repoRouteSkipReason(issue, config);
  if (routeReason) {
    reasons.push(routeReason);
  }

  if (isTerminalState(issue.state, config)) {
    reasons.push({
      code: 'terminal_state',
      message: `state "${issue.state}" is configured as terminal`,
    });
  } else if (!isActiveState(issue.state, config)) {
    reasons.push({
      code: 'inactive_state',
      message: `state "${issue.state}" is not configured as active`,
    });
  }

  if (hasOpenTodoBlocker(issue, config)) {
    const blockers = issue.blockedBy
      .map((blocker) => blocker.identifier ?? blocker.id)
      .filter(Boolean)
      .join(', ');
    reasons.push({
      code: 'blocker',
      message: blockers
        ? `open blocker(s): ${blockers}`
        : 'issue has at least one open blocker',
    });
  }

  return reasons;
}

function repoRouteSkipReason(
  issue: NormalizedIssue,
  config: EffectiveWorkflowConfig,
): DispatchSkipReason | null {
  const routeKeys = Object.keys(config.workspace.repoRoutes);
  if (routeKeys.length === 0) {
    return null;
  }

  const prefix = normalizeState(config.tracker.repoLabelPrefix);
  const repoLabels = issue.labels
    .map(normalizeState)
    .filter((label) => label.startsWith(prefix));

  if (repoLabels.length === 0) {
    return {
      code: 'missing_repo_label',
      message:
        `no ${config.tracker.repoLabelPrefix} label matches configured repo routes`,
    };
  }

  const configuredRoutes = new Set(routeKeys.map(normalizeState));
  const matchingRoutes = repoLabels
    .map((label) => label.slice(prefix.length).trim())
    .filter((key) => configuredRoutes.has(key));
  const uniqueRoutes = [...new Set(matchingRoutes)];
  if (uniqueRoutes.length !== 1) {
    return {
      code: 'unknown_route',
      message:
        `repo route label(s) ${repoLabels.join(', ')} do not resolve to exactly one configured route`,
    };
  }

  return null;
}

function hasRequiredLabels(
  issue: NormalizedIssue,
  config: EffectiveWorkflowConfig,
): boolean {
  return missingRequiredLabels(issue, config).length === 0;
}

function missingRequiredLabels(
  issue: NormalizedIssue,
  config: EffectiveWorkflowConfig,
): string[] {
  const issueLabels = new Set(issue.labels.map(normalizeState));
  return config.tracker.requiredLabels.filter(
    (label) => !issueLabels.has(normalizeState(label)),
  );
}

function diagnosticForIssue(
  issue: NormalizedIssue,
  reasons: DispatchSkipReason[],
): DispatchIssueDiagnostic {
  return {
    issueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    state: issue.state,
    labels: issue.labels,
    reasons,
  };
}

function rateLimitMessage(
  gate: CodexRateLimitSnapshot | null | undefined,
): string {
  const reset = gate?.resumeAfterMs
    ? ` until ${new Date(gate.resumeAfterMs).toISOString()}`
    : '';
  const reason = gate?.reason ? ` (${gate.reason})` : '';
  return `Codex rate-limit gate is parked${reset}${reason}`;
}

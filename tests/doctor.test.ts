import { describe, expect, it } from 'vitest';
import {
  diagnoseDispatchIssues,
  renderDispatchDoctorReport,
} from '../src/doctor.js';
import type { EffectiveWorkflowConfig, NormalizedIssue } from '../src/types.js';

describe('dispatch doctor', () => {
  it('reports every concrete skip reason with issue context', () => {
    const config = makeConfig({
      tracker: {
        requiredLabels: ['symphony'],
      },
      workspace: {
        repoRoutes: {
          symphony: '/tmp/symphony',
        },
      },
    });
    const issues = [
      makeIssue('APP-1', {
        title: 'Missing route label',
        labels: ['symphony'],
      }),
      makeIssue('APP-2', {
        title: 'Unknown route',
        labels: ['symphony', 'repo:missing'],
      }),
      makeIssue('APP-3', {
        title: 'Inactive state',
        state: 'Backlog',
        labels: ['symphony', 'repo:symphony'],
      }),
      makeIssue('APP-4', {
        title: 'Terminal state',
        state: 'Done',
        labels: ['symphony', 'repo:symphony'],
      }),
      makeIssue('APP-5', {
        title: 'Blocked issue',
        labels: ['symphony', 'repo:symphony'],
        blockedBy: [
          {
            id: 'blocker-1',
            identifier: 'APP-99',
            state: 'In Progress',
            createdAt: null,
            updatedAt: null,
          },
        ],
      }),
      makeIssue('APP-6', {
        title: 'Rate limited',
        labels: ['symphony', 'repo:symphony'],
      }),
      makeIssue('APP-7', {
        title: 'Concurrency capped',
        labels: ['symphony', 'repo:symphony'],
      }),
    ];

    const diagnostics = diagnoseDispatchIssues(issues, config, {
      nowMs: 1000,
      codexRateLimit: {
        resumeAfterMs: 5000,
        reason: 'codex_rate_limited',
        updatedAtMs: 900,
      },
      runningCount: 4,
    });

    expect(
      diagnostics.map((diagnostic) => ({
        identifier: diagnostic.identifier,
        title: diagnostic.title,
        state: diagnostic.state,
        labels: diagnostic.labels,
        reasons: diagnostic.reasons.map((reason) => reason.code),
      })),
    ).toEqual([
      {
        identifier: 'APP-1',
        title: 'Missing route label',
        state: 'Todo',
        labels: ['symphony'],
        reasons: ['missing_repo_label'],
      },
      {
        identifier: 'APP-2',
        title: 'Unknown route',
        state: 'Todo',
        labels: ['symphony', 'repo:missing'],
        reasons: ['unknown_route'],
      },
      {
        identifier: 'APP-3',
        title: 'Inactive state',
        state: 'Backlog',
        labels: ['symphony', 'repo:symphony'],
        reasons: ['inactive_state'],
      },
      {
        identifier: 'APP-4',
        title: 'Terminal state',
        state: 'Done',
        labels: ['symphony', 'repo:symphony'],
        reasons: ['terminal_state'],
      },
      {
        identifier: 'APP-5',
        title: 'Blocked issue',
        state: 'Todo',
        labels: ['symphony', 'repo:symphony'],
        reasons: ['blocker'],
      },
      {
        identifier: 'APP-6',
        title: 'Rate limited',
        state: 'Todo',
        labels: ['symphony', 'repo:symphony'],
        reasons: ['rate_limit_gate'],
      },
      {
        identifier: 'APP-7',
        title: 'Concurrency capped',
        state: 'Todo',
        labels: ['symphony', 'repo:symphony'],
        reasons: ['rate_limit_gate', 'concurrency_cap'],
      },
    ]);
  });

  it('renders skipped issues with identifier, title, state, labels, and reasons', () => {
    const output = renderDispatchDoctorReport([
      {
        issueId: 'issue-1',
        identifier: 'APP-1',
        title: 'Missing route label',
        state: 'Todo',
        labels: ['symphony'],
        reasons: [
          {
            code: 'missing_repo_label',
            message: 'no repo: label matches configured repo routes',
          },
        ],
      },
    ]);

    expect(output).toContain('APP-1');
    expect(output).toContain('Missing route label');
    expect(output).toContain('state=Todo');
    expect(output).toContain('labels=symphony');
    expect(output).toContain('missing_repo_label');
    expect(output).toContain('no repo: label matches configured repo routes');
  });
});

function makeConfig(
  overrides: {
    tracker?: Partial<EffectiveWorkflowConfig['tracker']>;
    workspace?: Partial<EffectiveWorkflowConfig['workspace']>;
  } = {},
): EffectiveWorkflowConfig {
  const config: EffectiveWorkflowConfig = {
    workflowPath: '/tmp/WORKFLOW.md',
    workflowDir: '/tmp',
    promptTemplate: 'Prompt {{ issue.identifier }}',
    tracker: {
      kind: 'linear',
      endpoint: 'https://linear.example/graphql',
      apiKey: 'lin_test',
      projectSlug: 'project',
      teamKey: null,
      requiredLabels: [],
      repoLabelPrefix: 'repo:',
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Done', 'Closed', 'Canceled'],
      handoffState: null,
      mergeState: null,
    },
    polling: { intervalMs: 30000 },
    workspace: {
      root: '/tmp/workspaces',
      repoPath: '/tmp/repo',
      projectsRoot: null,
      repoRoutes: {},
      baseBranch: 'main',
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60000,
    },
    agent: {
      backend: 'codex',
      maxConcurrentAgents: 5,
      maxTurns: 20,
      maxRetryBackoffMs: 300000,
      rateLimitProbeIntervalMs: 300000,
      maxConcurrentAgentsByState: {},
    },
    cursor: {
      apiKey: null,
      model: 'composer-2.5',
    },
    codex: {
      command: 'codex app-server --listen stdio://',
      approvalPolicy: 'never',
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 3600000,
      readTimeoutMs: 5000,
      stallTimeoutMs: 300000,
      model: null,
    },
    github: {
      prIdentity: null,
    },
    pullRequest: {
      backend: 'github',
      graphiteFallback: 'fail',
    },
    digest: {
      enabled: false,
      recipient: 'andyminhtuanho@gmail.com',
      sender: 'Symphony <agent@anmho.com>',
      intervalMs: 3600000,
      windowMs: 3600000,
      resendApiKey: null,
      resendEndpoint: 'https://api.resend.com/emails',
    },
  };
  return {
    ...config,
    tracker: {
      ...config.tracker,
      ...overrides.tracker,
    },
    workspace: {
      ...config.workspace,
      ...overrides.workspace,
    },
  };
}

function makeIssue(
  identifier: string,
  overrides: Partial<NormalizedIssue> = {},
): NormalizedIssue {
  return {
    id: overrides.id ?? identifier,
    identifier: overrides.identifier ?? identifier,
    title: overrides.title ?? `Issue ${identifier}`,
    description: overrides.description ?? null,
    priority: overrides.priority ?? null,
    state: overrides.state ?? 'Todo',
    branchName: overrides.branchName ?? null,
    url: overrides.url ?? null,
    labels: overrides.labels ?? [],
    comments: overrides.comments ?? [],
    attachments: overrides.attachments ?? [],
    blockedBy: overrides.blockedBy ?? [],
    createdAt: overrides.createdAt ?? null,
    updatedAt: overrides.updatedAt ?? null,
  };
}

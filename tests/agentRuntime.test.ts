import { describe, expect, it } from 'vitest';
import {
  configuredModelForBackend,
  withAgentRuntimeOverrides,
} from '../src/agentBackends.js';
import type { EffectiveWorkflowConfig } from '../src/types.js';

function minimalConfig(): EffectiveWorkflowConfig {
  return {
    workflowPath: '/tmp/WORKFLOW.md',
    workflowDir: '/tmp',
    promptTemplate: 'Prompt',
    tracker: {
      kind: 'linear',
      endpoint: 'https://linear.example/graphql',
      apiKey: 'lin_test',
      projectSlug: 'project',
      teamKey: null,
      requiredLabels: [],
      repoLabelPrefix: 'repo:',
      activeStates: ['Todo'],
      terminalStates: ['Done'],
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
      backend: 'cursor',
      maxConcurrentAgents: 1,
      maxTurns: 1,
      maxRetryBackoffMs: 300000,
      rateLimitProbeIntervalMs: 300000,
      maxConcurrentAgentsByState: {},
    },
    cursor: {
      command: 'agent acp',
      model: 'composer-2.5',
      turnTimeoutMs: 3600000,
      readTimeoutMs: 5000,
      apiKey: null,
    },
    codex: {
      command: 'codex app-server --listen stdio://',
      approvalPolicy: 'never',
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 3600000,
      readTimeoutMs: 5000,
      stallTimeoutMs: 300000,
      model: 'gpt-5',
    },
    github: { prIdentity: null },
    pullRequest: { backend: 'github', graphiteFallback: 'fail' },
    digest: {
      enabled: false,
      recipient: 'test@example.com',
      sender: 'Symphony <agent@example.com>',
      intervalMs: 3600000,
      windowMs: 3600000,
      resendApiKey: null,
      resendEndpoint: 'https://api.resend.com/emails',
    },
  };
}

describe('agent runtime overrides', () => {
  it('configuredModelForBackend reads per-backend workflow model', () => {
    const config = minimalConfig();
    expect(configuredModelForBackend(config, 'cursor')).toBe('composer-2.5');
    expect(configuredModelForBackend(config, 'codex')).toBe('gpt-5');
  });

  it('withAgentRuntimeOverrides applies model override to effective backend', () => {
    const config = minimalConfig();
    const runtime = withAgentRuntimeOverrides(config, null, 'composer-2');
    expect(runtime.cursor.model).toBe('composer-2');
    const codexRuntime = withAgentRuntimeOverrides(
      { ...config, agent: { ...config.agent, backend: 'codex' } },
      null,
      'o3',
    );
    expect(codexRuntime.codex.model).toBe('o3');
  });
});

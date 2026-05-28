import { describe, expect, it } from 'vitest';
import {
  assertAgentBackendReady,
  createAgentBackend,
  effectiveAgentBackendKind,
  parseAgentBackendKind,
} from '../src/agentBackends.js';
import { codexBackend } from '../src/backends/codexBackend.js';
import { cursorBackend } from '../src/backends/cursorBackend.js';
import type { EffectiveWorkflowConfig } from '../src/types.js';

function minimalConfig(backend: 'codex' | 'cursor'): EffectiveWorkflowConfig {
  return {
    workflowPath: '/tmp/WORKFLOW.md',
    workflowDir: '/tmp',
    promptTemplate: 'test',
    tracker: {
      kind: 'linear',
      endpoint: 'https://api.linear.app/graphql',
      apiKey: 'test',
      projectSlug: 'test',
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
      backend,
      maxConcurrentAgents: 5,
      maxTurns: 20,
      maxRetryBackoffMs: 300000,
      rateLimitProbeIntervalMs: 15000,
      maxConcurrentAgentsByState: {},
    },
    codex: {
      command: 'codex app-server',
      approvalPolicy: 'never',
      threadSandbox: 'workspace-write',
      turnSandboxPolicy: null,
      turnTimeoutMs: 3600000,
      readTimeoutMs: 5000,
      stallTimeoutMs: 300000,
      model: null,
    },
    cursor: {
      apiKey: null,
      model: 'composer-2.5',
    },
    github: { prIdentity: null },
    pullRequest: { backend: 'github', graphiteFallback: 'fail' },
    digest: {
      enabled: false,
      recipient: 'test@example.com',
      sender: 'Symphony <test@example.com>',
      intervalMs: 60000,
      windowMs: 60000,
      resendApiKey: null,
      resendEndpoint: 'https://api.resend.com/emails',
    },
  };
}

describe('agentBackends', () => {
  it('createAgentBackend returns codex backend for codex kind', () => {
    const backend = createAgentBackend('codex');
    expect(backend.kind).toBe('codex');
    expect(backend).toBe(codexBackend);
  });

  it('createAgentBackend returns cursor backend for cursor kind', () => {
    const backend = createAgentBackend('cursor');
    expect(backend.kind).toBe('cursor');
    expect(backend).toBe(cursorBackend);
  });

  it('assertAgentBackendReady does not require cursor api key', () => {
    expect(() => assertAgentBackendReady(minimalConfig('cursor'), 'cursor')).not.toThrow();
  });

  it('effectiveAgentBackendKind prefers override over workflow config', () => {
    const config = minimalConfig('codex');
    expect(effectiveAgentBackendKind(config, 'cursor')).toBe('cursor');
    expect(effectiveAgentBackendKind(config, null)).toBe('codex');
  });

  it('parseAgentBackendKind normalizes valid kinds', () => {
    expect(parseAgentBackendKind('Codex')).toBe('codex');
    expect(parseAgentBackendKind('CURSOR')).toBe('cursor');
  });

  it('parseAgentBackendKind rejects unknown kinds', () => {
    expect(() => parseAgentBackendKind('openai')).toThrow('invalid_agent_backend');
  });
});

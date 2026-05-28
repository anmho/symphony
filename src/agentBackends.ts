import type { AgentBackend } from './agentBackend.js';
import { codexBackend } from './backends/codexBackend.js';
import { cursorBackend } from './backends/cursorBackend.js';
import type { AgentBackendKind, EffectiveWorkflowConfig } from './types.js';

export function createAgentBackend(kind: AgentBackendKind): AgentBackend {
  switch (kind) {
    case 'codex':
      return codexBackend;
    case 'cursor':
      return cursorBackend;
  }
}

export function assertAgentBackendReady(
  config: EffectiveWorkflowConfig,
  backend: AgentBackendKind,
): void {
  if (backend === 'codex' && !config.codex.command.trim()) {
    throw new Error('codex_command_missing');
  }
}

export function effectiveAgentBackendKind(
  config: EffectiveWorkflowConfig,
  override: AgentBackendKind | null,
): AgentBackendKind {
  return override ?? config.agent.backend;
}

export function runAgentTurnForConfig(
  config: EffectiveWorkflowConfig,
  override: AgentBackendKind | null,
  input: Parameters<AgentBackend['runTurn']>[0],
  options?: Parameters<AgentBackend['runTurn']>[1],
): ReturnType<AgentBackend['runTurn']> {
  const kind = effectiveAgentBackendKind(config, override);
  assertAgentBackendReady(config, kind);
  return createAgentBackend(kind).runTurn(input, options);
}

export function parseAgentBackendKind(value: string): AgentBackendKind {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'cursor') {
    return normalized;
  }
  throw new Error(`invalid_agent_backend: ${value}`);
}

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
  if (backend === 'cursor' && !config.cursor.command.trim()) {
    throw new Error('cursor_command_missing');
  }
}

export function effectiveAgentBackendKind(
  config: EffectiveWorkflowConfig,
  override: AgentBackendKind | null,
): AgentBackendKind {
  return override ?? config.agent.backend;
}

export function configuredModelForBackend(
  config: EffectiveWorkflowConfig,
  backend: AgentBackendKind,
): string | null {
  return backend === 'cursor' ? config.cursor.model : config.codex.model;
}

export function withAgentRuntimeOverrides(
  config: EffectiveWorkflowConfig,
  backendOverride: AgentBackendKind | null,
  modelOverride: string | null,
): EffectiveWorkflowConfig {
  const backend = effectiveAgentBackendKind(config, backendOverride);
  const effectiveModel =
    modelOverride ?? configuredModelForBackend(config, backend);
  if (
    backendOverride === null &&
    modelOverride === null
  ) {
    return config;
  }
  if (backend === 'cursor') {
    if (effectiveModel === config.cursor.model) {
      return config;
    }
    return {
      ...config,
      cursor: { ...config.cursor, model: effectiveModel },
    };
  }
  if (effectiveModel === config.codex.model) {
    return config;
  }
  return {
    ...config,
    codex: { ...config.codex, model: effectiveModel },
  };
}

export function runAgentTurnForConfig(
  config: EffectiveWorkflowConfig,
  backendOverride: AgentBackendKind | null,
  modelOverride: string | null,
  input: Parameters<AgentBackend['runTurn']>[0],
  options?: Parameters<AgentBackend['runTurn']>[1],
): ReturnType<AgentBackend['runTurn']> {
  const runtimeConfig = withAgentRuntimeOverrides(
    config,
    backendOverride,
    modelOverride,
  );
  const kind = effectiveAgentBackendKind(runtimeConfig, backendOverride);
  assertAgentBackendReady(runtimeConfig, kind);
  return createAgentBackend(kind).runTurn(
    { ...input, config: runtimeConfig },
    options,
  );
}

export function parseAgentBackendKind(value: string): AgentBackendKind {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'cursor') {
    return normalized;
  }
  throw new Error(`invalid_agent_backend: ${value}`);
}

import type {
  AgentBackendKind,
  AgentRunEvent,
  AgentRunInput,
  AgentTurnResult,
} from './types.js';

export interface AgentRunOptions {
  signal?: AbortSignal;
  onEvent?: (event: AgentRunEvent) => void;
}

export interface AgentBackend {
  readonly kind: AgentBackendKind;
  runTurn(
    input: AgentRunInput,
    options?: AgentRunOptions,
  ): Promise<AgentTurnResult>;
}

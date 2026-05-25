import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCodexTurn } from "./codexRpc.js";
import { workEventFromCodexEvent } from "./events.js";
import type {
  CodexRunInput,
  EffectiveWorkflowConfig,
  NormalizedIssue
} from "./types.js";

export const DEFAULT_CODEX_APP_SERVER_COMMAND = "codex app-server --listen stdio://";
export const CODEX_APP_SERVER_SMOKE_FILE = "symphony-app-server-smoke.txt";
export const CODEX_APP_SERVER_SMOKE_CONTENT = "symphony codex app-server smoke ok\n";

export interface CodexAppServerSmokeOptions {
  command?: string;
  keepTemp?: boolean;
  tempRoot?: string;
  timeoutMs?: number;
  removeTempWorkspace?: (workspacePath: string) => Promise<void>;
}

export interface CodexAppServerSmokeResult {
  workspacePath: string;
  cleanedUp: boolean;
  commandEventCount: number;
  toolEventCount: number;
  commandOrToolEventCount: number;
}

export async function runCodexAppServerSmoke(
  options: CodexAppServerSmokeOptions = {}
): Promise<CodexAppServerSmokeResult> {
  const workspacePath = await mkdtemp(
    path.join(options.tempRoot ?? os.tmpdir(), "symphony-codex-app-server-smoke-")
  );
  let commandEventCount = 0;
  let toolEventCount = 0;
  let operationError: unknown = null;

  try {
    const timeoutMs = options.timeoutMs ?? 120000;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      const result = await runCodexTurn(makeSmokeInput(options.command ?? DEFAULT_CODEX_APP_SERVER_COMMAND, workspacePath), {
        signal: abortController.signal,
        onEvent: (event) => {
          if (event.type !== "notification") {
            return;
          }
          const normalized = workEventFromCodexEvent(smokeEventContext(workspacePath), event);
          if (normalized.type === "command") {
            commandEventCount += 1;
          }
          if (normalized.type === "tool") {
            toolEventCount += 1;
          }
        }
      });
      if (result.status !== "completed") {
        throw new Error(
          `codex_app_server_smoke_missing_tool_execution: turn finished with ${result.status}${result.error ? ` (${result.error})` : ""}`
        );
      }
      const commandOrToolEventCount = commandEventCount + toolEventCount;
      if (commandOrToolEventCount === 0) {
        throw new Error(
          "codex_app_server_smoke_absent_command_tool_events: expected at least one command or tool event from the smoke turn"
        );
      }
      await verifySmokeFile(workspacePath);
    } catch (error) {
      throw classifySmokeError(error);
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    operationError = error;
  }

  if (options.keepTemp) {
    if (operationError) {
      throw operationError;
    }
    return {
      workspacePath,
      cleanedUp: false,
      commandEventCount,
      toolEventCount,
      commandOrToolEventCount: commandEventCount + toolEventCount
    };
  }

  try {
    await (options.removeTempWorkspace ?? removeTempWorkspace)(workspacePath);
  } catch (error) {
    throw new Error(
      `codex_app_server_smoke_cleanup_failed: ${workspacePath}: ${errorMessage(error)}`
    );
  }

  if (operationError) {
    throw operationError;
  }

  return {
    workspacePath,
    cleanedUp: true,
    commandEventCount,
    toolEventCount,
    commandOrToolEventCount: commandEventCount + toolEventCount
  };
}

async function verifySmokeFile(workspacePath: string): Promise<void> {
  const filePath = path.join(workspacePath, CODEX_APP_SERVER_SMOKE_FILE);
  let actual: string;
  try {
    actual = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `codex_app_server_smoke_sandbox_write_failed: expected ${filePath} to be created (${errorMessage(error)})`
    );
  }
  if (actual !== CODEX_APP_SERVER_SMOKE_CONTENT) {
    throw new Error(
      `codex_app_server_smoke_sandbox_write_failed: expected ${filePath} to contain ${JSON.stringify(CODEX_APP_SERVER_SMOKE_CONTENT)}`
    );
  }
}

function classifySmokeError(error: unknown): Error {
  const message = errorMessage(error);
  if (/experimental/i.test(message) && /initialize/i.test(message)) {
    return new Error(
      `codex_app_server_smoke_missing_experimental_api_support: ${message}`
    );
  }
  if (/codex_app_server_closed: initialize|initialize_failed|command not found|exit 127/i.test(message)) {
    return new Error(
      `codex_app_server_smoke_app_server_startup_failed: ${message}`
    );
  }
  return error instanceof Error ? error : new Error(message);
}

async function removeTempWorkspace(workspacePath: string): Promise<void> {
  await rm(workspacePath, { recursive: true, force: true });
}

function makeSmokeInput(command: string, workspacePath: string): CodexRunInput {
  const issue = makeSmokeIssue();
  return {
    config: makeSmokeConfig(command, workspacePath),
    issue,
    workspacePath,
    threadId: null,
    prompt: [
      "This is a Symphony Codex app-server capability smoke test.",
      `In the current working directory, create or overwrite ${CODEX_APP_SERVER_SMOKE_FILE} with exactly this content:`,
      CODEX_APP_SERVER_SMOKE_CONTENT.trimEnd(),
      `Then run a shell command that prints ${CODEX_APP_SERVER_SMOKE_FILE}.`,
      "Do not modify files outside the current working directory."
    ].join("\n")
  };
}

function makeSmokeIssue(): NormalizedIssue {
  return {
    id: "symphony-codex-app-server-smoke",
    identifier: "SMOKE",
    title: "Codex app-server capability smoke test",
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    comments: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null
  };
}

function makeSmokeConfig(command: string, workspacePath: string): EffectiveWorkflowConfig {
  return {
    workflowPath: path.join(workspacePath, "WORKFLOW.md"),
    workflowDir: workspacePath,
    promptTemplate: "Smoke",
    tracker: {
      kind: "linear",
      endpoint: "https://linear.example/graphql",
      apiKey: "lin_smoke",
      projectSlug: "smoke",
      teamKey: null,
      requiredLabels: [],
      repoLabelPrefix: "repo:",
      activeStates: ["Todo"],
      terminalStates: ["Done"],
      handoffState: null
    },
    polling: { intervalMs: 30000 },
    workspace: {
      root: workspacePath,
      repoPath: workspacePath,
      projectsRoot: null,
      repoRoutes: {},
      baseBranch: "main"
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60000
    },
    agent: {
      maxConcurrentAgents: 1,
      maxTurns: 1,
      maxRetryBackoffMs: 300000,
      rateLimitProbeIntervalMs: 300000,
      maxConcurrentAgentsByState: {}
    },
    codex: {
      command,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: null,
      turnTimeoutMs: 120000,
      readTimeoutMs: 5000,
      stallTimeoutMs: 300000,
      model: null
    },
    pullRequest: {
      backend: "github",
      graphiteFallback: "fail"
    }
  };
}

function smokeEventContext(workspacePath: string) {
  return {
    issueId: "symphony-codex-app-server-smoke",
    identifier: "SMOKE",
    repoKey: null,
    workspacePath,
    threadId: null,
    turnId: null
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

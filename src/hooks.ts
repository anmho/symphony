import type { EffectiveWorkflowConfig, NormalizedIssue, WorkspaceInfo } from "./types";
import { runShellCommand } from "./process";

export type HookName = "afterCreate" | "beforeRun" | "afterRun" | "beforeRemove";

export async function runHook(
  config: EffectiveWorkflowConfig,
  hookName: HookName,
  issue: NormalizedIssue,
  workspace: WorkspaceInfo
): Promise<void> {
  const command = config.hooks[hookName];
  if (!command) {
    return;
  }

  const result = await runShellCommand(command, {
    cwd: workspace.path,
    env: {
      ...process.env,
      SYMPHONY_WORKFLOW_PATH: config.workflowPath,
      SYMPHONY_WORKSPACE_PATH: workspace.path,
      SYMPHONY_WORKSPACE_KEY: workspace.workspaceKey,
      SYMPHONY_BRANCH: workspace.branchName,
      SYMPHONY_ISSUE_ID: issue.id,
      SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
      SYMPHONY_ISSUE_TITLE: issue.title,
      SYMPHONY_ISSUE_URL: issue.url ?? ""
    },
    timeoutMs: config.hooks.timeoutMs
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `hook_failed: ${hookName} exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
}

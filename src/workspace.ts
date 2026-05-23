import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { EffectiveWorkflowConfig, NormalizedIssue, WorkspaceInfo } from "./types";
import { branchNameForIssue, sanitizeWorkspaceKey } from "./policy";
import { runCommand } from "./process";

export async function ensureWorkspace(
  config: EffectiveWorkflowConfig,
  issue: NormalizedIssue
): Promise<WorkspaceInfo> {
  const info = workspaceInfoForIssue(config, issue);
  const { workspaceKey, branchName } = info;
  const workspacePath = info.path;

  await mkdir(config.workspace.root, { recursive: true });

  if (await exists(workspacePath)) {
    return {
      path: workspacePath,
      workspaceKey,
      branchName,
      createdNow: false
    };
  }

  const addResult = await runCommand(
    "git",
    ["-C", config.workspace.repoPath, "worktree", "add", "-b", branchName, workspacePath, config.workspace.baseBranch],
    { timeoutMs: 120000 }
  );

  if (addResult.exitCode !== 0 && /already exists|a branch named/.test(addResult.stderr)) {
    const retry = await runCommand(
      "git",
      ["-C", config.workspace.repoPath, "worktree", "add", workspacePath, branchName],
      { timeoutMs: 120000 }
    );
    if (retry.exitCode !== 0) {
      throw new Error(`git_worktree_add_failed: ${retry.stderr || retry.stdout}`);
    }
  } else if (addResult.exitCode !== 0) {
    throw new Error(`git_worktree_add_failed: ${addResult.stderr || addResult.stdout}`);
  }

  return {
    path: workspacePath,
    workspaceKey,
    branchName,
    createdNow: true
  };
}

export function workspaceInfoForIssue(config: EffectiveWorkflowConfig, issue: NormalizedIssue): WorkspaceInfo {
  const workspaceKey = sanitizeWorkspaceKey(issue.identifier);
  return {
    path: path.join(config.workspace.root, workspaceKey),
    workspaceKey,
    branchName: branchNameForIssue(issue.identifier),
    createdNow: false
  };
}

export function workspacePathExists(workspacePath: string): Promise<boolean> {
  return exists(workspacePath);
}

export async function removeWorkspace(config: EffectiveWorkflowConfig, workspace: WorkspaceInfo): Promise<void> {
  assertInsideWorkspaceRoot(config, workspace.path);

  const removeResult = await runCommand(
    "git",
    ["-C", config.workspace.repoPath, "worktree", "remove", "--force", workspace.path],
    { timeoutMs: 120000 }
  );

  if (removeResult.exitCode !== 0 && (await exists(workspace.path))) {
    await rm(workspace.path, { recursive: true, force: true });
  }
}

function assertInsideWorkspaceRoot(config: EffectiveWorkflowConfig, candidate: string): void {
  const root = path.resolve(config.workspace.root);
  const resolved = path.resolve(candidate);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`unsafe_workspace_path: ${candidate}`);
  }
}

async function exists(candidate: string): Promise<boolean> {
  return stat(candidate)
    .then(() => true)
    .catch(() => false);
}

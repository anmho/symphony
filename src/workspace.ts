import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { EffectiveWorkflowConfig, NormalizedIssue, WorkspaceInfo } from "./types";
import { branchNameForIssue, resolveIssueRepoRoute, sanitizeWorkspaceKey } from "./policy";
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
      repoKey: info.repoKey,
      repoPath: info.repoPath,
      createdNow: false
    };
  }

  const addResult = await runCommand(
    "git",
    ["-C", info.repoPath, "worktree", "add", "-b", branchName, workspacePath, config.workspace.baseBranch],
    { timeoutMs: 120000 }
  );

  if (addResult.exitCode !== 0 && /already exists|a branch named/.test(addResult.stderr)) {
    const retry = await runCommand(
      "git",
      ["-C", info.repoPath, "worktree", "add", workspacePath, branchName],
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
    repoKey: info.repoKey,
    repoPath: info.repoPath,
    createdNow: true
  };
}

export function workspaceInfoForIssue(config: EffectiveWorkflowConfig, issue: NormalizedIssue): WorkspaceInfo {
  const route = resolveIssueRepoRoute(issue, config);
  if (!route) {
    throw new Error(`issue_repo_route_unresolved: ${issue.identifier}`);
  }

  const workspaceKey = sanitizeWorkspaceKey(issue.identifier);
  const workspaceRoot = route.repoKey ? path.join(config.workspace.root, route.repoKey) : config.workspace.root;
  return {
    path: path.join(workspaceRoot, workspaceKey),
    workspaceKey,
    branchName: branchNameForIssue(issue.identifier),
    repoKey: route.repoKey,
    repoPath: route.repoPath,
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
    ["-C", workspace.repoPath, "worktree", "remove", "--force", workspace.path],
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
